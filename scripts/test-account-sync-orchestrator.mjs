#!/usr/bin/env node
// DIC-1380 W4 CR — account remote-sync orchestrator regression.
//
// The orchestrator is the piece that turns the pure I/O client into the
// production wiring: it reads the deck / priceAlert / settings stores, hands
// their state to the server, applies the server's authoritative snapshot back
// into those stores, and recovers from a 409 by pulling+hydrating and retrying
// once. The PM handback asked for MUTATION-SENSITIVE tests — removing any of
// pull / hydrate / push / conflict retry / lastKnownRevision tracking must
// fail this suite.
//
// Store hydration under Store MVP would fail the FEATURES gate on the render
// side; the orchestrator itself must run under STORE_MVP=0 so the deck /
// price-alert stores load without the release-flag guard tripping importers.
process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';

// jsdom stubs so react-native-web / zustand storage adapters that reach for
// `window` do not crash on load. The orchestrator itself never touches
// `window`; the stores it imports do through zustand persist.
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const fetchCalls = [];
let responseQueue = [];
globalThis.fetch = async (input, init) => {
  fetchCalls.push({
    url: typeof input === 'string' ? input : String(input),
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  });
  const next = responseQueue.shift();
  if (!next) throw new Error('unexpected fetch call — no response queued');
  return next();
};

const {
  hydrateAccountSyncFromServer,
  pushAccountSyncFromStores,
  snapshotFromLocalStores,
  applyServerSnapshotToStores,
  getLastKnownRevision,
  resetLastKnownRevision,
} = await import('../src/services/accountSyncOrchestrator.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');

let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  responseQueue = [];
  useDeckStore.setState((s) => ({ ...s, decks: [], collection: {}, activeDeckId: null }));
  usePriceAlertStore.setState((s) => ({ ...s, alerts: {}, pending: {} }));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'TWD', preferredLanguage: 'zh' }));
  resetLastKnownRevision();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

const SESSION = 'session-abc';

function jsonResponse(status, body) {
  return () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SNAPSHOT_V7 = {
  schemaVersion: 1,
  revision: 7,
  updatedAt: '2026-09-08T00:00:00.000Z',
  deviceId: 'dev-1',
  favorites: [{ cardNumber: 'hBP04-001', printing: 'BASE', addedAt: '2026-09-01T00:00:00.000Z' }],
  decks: [{
    id: 'deck-server-1',
    name: 'server deck',
    oshi: [],
    main: [],
    yell: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  collection: { 'hBP04-001|BASE': 3, 'hBP04-005|SEC': 1 },
  priceAlerts: [{
    cardNumber: 'hBP04-001', printing: 'BASE',
    name: '博衣こより', currency: 'JPY', lowerPrice: null, upperPrice: 1000,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }],
  settings: { preferredCurrency: 'JPY', preferredLanguage: 'ja' },
};

// ── Empty-session no-op ─────────────────────────────────────────────────
await test('hydrateAccountSyncFromServer(null) does not fetch and does not touch stores', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'test-1|BASE': 2 } }));
  const before = { ...useDeckStore.getState().collection };
  const result = await hydrateAccountSyncFromServer(null);
  assert.equal(result, null);
  assert.equal(fetchCalls.length, 0);
  assert.deepEqual(useDeckStore.getState().collection, before, 'stores untouched');
});

await test('pushAccountSyncFromStores(null) does not fetch and returns null', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'test-1|BASE': 2 } }));
  const result = await pushAccountSyncFromStores(null);
  assert.equal(result, null);
  assert.equal(fetchCalls.length, 0);
});

// ── Hydrate applies snapshot to every store the server describes ────────
await test('hydrate: server snapshot overwrites decks / collection / alerts / settings', async () => {
  responseQueue = [jsonResponse(200, { snapshot: SNAPSHOT_V7 })];
  const applied = await hydrateAccountSyncFromServer(SESSION);
  assert.ok(applied, 'must return the applied snapshot');
  assert.equal(applied.revision, 7);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'GET');
  assert.equal(fetchCalls[0].url, 'https://holohunter.dicoge.com/api/auth/sync');
  const deck = useDeckStore.getState();
  assert.deepEqual(deck.decks.map((d) => d.id), ['deck-server-1'], 'decks hydrated from server');
  assert.deepEqual(deck.collection, { 'hBP04-001|BASE': 3, 'hBP04-005|SEC': 1 }, 'collection hydrated');
  const alerts = usePriceAlertStore.getState().alerts;
  assert.deepEqual(Object.keys(alerts), ['hBP04-001|BASE'], 'alerts hydrated');
  const settings = useSettingsStore.getState();
  assert.equal(settings.preferredCurrency, 'JPY', 'currency hydrated');
  assert.equal(settings.preferredLanguage, 'ja', 'language hydrated');
  assert.equal(getLastKnownRevision(), 7, 'lastKnownRevision tracks server');
});

// ── Push sends the current store contents ───────────────────────────────
await test('push: patch reflects the current deck / collection / alerts / settings', async () => {
  useDeckStore.setState((s) => ({
    ...s,
    decks: [{ id: 'deck-local-1', name: 'local', oshi: [], main: [], yell: [], updatedAt: '2026-09-08T00:00:00.000Z' }],
    collection: { 'hBP04-999|BASE': 5 },
  }));
  usePriceAlertStore.setState((s) => ({
    ...s,
    alerts: {
      'hBP04-999|BASE': {
        cardNumber: 'hBP04-999', printing: 'BASE', name: 'x', currency: 'JPY',
        lowerPrice: null, upperPrice: 500,
        createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
      },
    },
  }));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'USD', preferredLanguage: 'zh' }));
  responseQueue = [jsonResponse(200, { ok: true, snapshot: { ...SNAPSHOT_V7, revision: 8 } })];
  const confirmed = await pushAccountSyncFromStores(SESSION, { deviceId: 'dev-local' });
  assert.equal(confirmed?.revision, 8);
  assert.equal(fetchCalls.length, 1);
  const req = fetchCalls[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, `Bearer ${SESSION}`);
  assert.equal(req.body.baseRevision, 0, 'first push uses the initial lastKnownRevision');
  assert.equal(req.body.deviceId, 'dev-local');
  const patch = req.body.patch;
  assert.deepEqual(patch.decks.map((d) => d.id), ['deck-local-1']);
  assert.deepEqual(patch.collection, { 'hBP04-999|BASE': 5 });
  assert.equal(patch.priceAlerts.length, 1);
  assert.equal(patch.priceAlerts[0].cardNumber, 'hBP04-999');
  assert.equal(patch.settings.preferredCurrency, 'USD');
  assert.equal(patch.settings.preferredLanguage, 'zh');
  // Derived favorites map to collection entries so the server sees ownership.
  assert.equal(patch.favorites.length, 1);
  assert.equal(patch.favorites[0].cardNumber, 'hBP04-999');
  assert.equal(patch.favorites[0].printing, 'BASE');
  assert.equal(getLastKnownRevision(), 8, 'lastKnownRevision advances after successful push');
});

// ── Sequential push carries the confirmed revision forward ──────────────
await test('push: consecutive pushes advance baseRevision to the last server-confirmed revision', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'seq-1|BASE': 1 } }));
  responseQueue = [
    jsonResponse(200, { ok: true, snapshot: { ...SNAPSHOT_V7, revision: 12 } }),
    jsonResponse(200, { ok: true, snapshot: { ...SNAPSHOT_V7, revision: 13 } }),
  ];
  const first = await pushAccountSyncFromStores(SESSION);
  assert.equal(first?.revision, 12);
  useDeckStore.setState((s) => ({ ...s, collection: { 'seq-2|BASE': 2 } }));
  const second = await pushAccountSyncFromStores(SESSION);
  assert.equal(second?.revision, 13);
  assert.equal(fetchCalls[1].body.baseRevision, 12, 'second push uses first push\'s confirmed revision');
});

// ── 409 recovery: pull the server, hydrate stores, retry ONCE ───────────
await test('conflict: 409 triggers pull + hydrate + retry with the fresh baseRevision', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'client-side|BASE': 1 } }));
  const serverAfterConflict = { ...SNAPSHOT_V7, revision: 42, collection: { 'server-side|BASE': 9 } };
  responseQueue = [
    jsonResponse(409, {
      error: 'revision_conflict',
      serverRevision: 42,
      snapshot: serverAfterConflict,
    }),
    jsonResponse(200, { ok: true, snapshot: { ...serverAfterConflict, revision: 43 } }),
  ];
  const confirmed = await pushAccountSyncFromStores(SESSION);
  assert.equal(confirmed?.revision, 43, 'retry succeeded on the second attempt');
  assert.equal(fetchCalls.length, 2, 'exactly one conflict-recovery retry');
  assert.equal(fetchCalls[0].method, 'POST');
  assert.equal(fetchCalls[1].method, 'POST');
  assert.equal(fetchCalls[1].body.baseRevision, 42, 'retry uses the server-reported revision');
  const collection = useDeckStore.getState().collection;
  assert.deepEqual(collection, { 'server-side|BASE': 9 }, 'store hydrated to server-side after 409');
  // The retry ships the merged view (post-hydrate), so favorites derived from
  // collection reflect the server-owned key, not the pre-conflict local one.
  const retryPatch = fetchCalls[1].body.patch;
  assert.deepEqual(retryPatch.collection, { 'server-side|BASE': 9 }, 'retry payload is post-hydrate');
  assert.equal(retryPatch.favorites[0].cardNumber, 'server-side');
  assert.equal(getLastKnownRevision(), 43, 'lastKnownRevision advances after successful retry');
});

// ── Repeated conflict rethrows (a second 409 escapes to the caller) ──────
await test('conflict: a second 409 during retry rethrows so the caller can back off', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'x|BASE': 1 } }));
  const serverSnap = { ...SNAPSHOT_V7, revision: 50 };
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 50, snapshot: serverSnap }),
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 51, snapshot: { ...serverSnap, revision: 51 } }),
  ];
  await assert.rejects(
    () => pushAccountSyncFromStores(SESSION),
    (err) => err?.name === 'AccountSyncConflictError' && err.status === 409,
  );
  assert.equal(fetchCalls.length, 2, 'exactly one retry before rethrow');
});

// ── Hydrate short-circuits on account_deleted ───────────────────────────
await test('hydrate: 410 account_deleted returns null and does not touch stores', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'stay|BASE': 4 } }));
  responseQueue = [jsonResponse(410, { error: 'account_deleted' })];
  const applied = await hydrateAccountSyncFromServer(SESSION);
  assert.equal(applied, null);
  assert.deepEqual(useDeckStore.getState().collection, { 'stay|BASE': 4 }, 'store preserved');
});

// ── applyServerSnapshotToStores is idempotent ───────────────────────────
await test('applyServerSnapshotToStores is idempotent — same snapshot twice yields the same store state', async () => {
  applyServerSnapshotToStores(SNAPSHOT_V7);
  const first = JSON.stringify(useDeckStore.getState().collection);
  applyServerSnapshotToStores(SNAPSHOT_V7);
  const second = JSON.stringify(useDeckStore.getState().collection);
  assert.equal(first, second);
  assert.equal(getLastKnownRevision(), 7);
});

// ── snapshotFromLocalStores is a pure read ──────────────────────────────
await test('snapshotFromLocalStores does not touch the network or mutate stores', async () => {
  useDeckStore.setState((s) => ({ ...s, decks: [{ id: 'deck-x', name: 'x', oshi: [], main: [], yell: [], updatedAt: '2026-09-08T00:00:00.000Z' }] }));
  const dataBefore = {
    decks: JSON.parse(JSON.stringify(useDeckStore.getState().decks)),
    collection: { ...useDeckStore.getState().collection },
    alerts: JSON.parse(JSON.stringify(usePriceAlertStore.getState().alerts)),
    settings: {
      preferredCurrency: useSettingsStore.getState().preferredCurrency,
      preferredLanguage: useSettingsStore.getState().preferredLanguage,
    },
  };
  const patch = snapshotFromLocalStores();
  assert.equal(fetchCalls.length, 0, 'reads are pure');
  assert.deepEqual(useDeckStore.getState().decks, dataBefore.decks, 'decks untouched');
  assert.deepEqual(useDeckStore.getState().collection, dataBefore.collection, 'collection untouched');
  assert.deepEqual(usePriceAlertStore.getState().alerts, dataBefore.alerts, 'alerts untouched');
  assert.equal(useSettingsStore.getState().preferredCurrency, dataBefore.settings.preferredCurrency);
  assert.equal(useSettingsStore.getState().preferredLanguage, dataBefore.settings.preferredLanguage);
  assert.equal(patch.decks[0].id, 'deck-x');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync orchestrator: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync orchestrator failed`);
}
