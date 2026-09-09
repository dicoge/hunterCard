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
  mergeLocalOntoServer,
  clearAccountScopedStores,
} = await import('../src/services/accountSyncOrchestrator.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');

let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  responseQueue = [];
  useDeckStore.setState((s) => ({ ...s, decks: [], collection: {}, activeDeckId: null }));
  usePriceAlertStore.setState((s) => ({ ...s, alerts: {}, pending: {} }));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'TWD', preferredLanguage: 'zh' }));
  useFavoritesStore.getState().clearAll();
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
  // Favorites are their own independent store — nothing was bookmarked
  // in this test case, so the pushed favorites list is empty.
  assert.equal(patch.favorites.length, 0);
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

// ── 409 recovery: MERGE local on top of server + retry ONCE ─────────────
// DIC-1380 W5 handback repair: the retry must NEVER silently discard the
// local pre-conflict edits. The recovery merges union / MAX / newer-wins
// per field so both sides survive.
await test('conflict: 409 MERGES local ontop of server (union / MAX per key) — no local loss', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'client-side|BASE': 3, 'shared|BASE': 4 } }));
  const serverAfterConflict = {
    ...SNAPSHOT_V7,
    revision: 42,
    collection: { 'server-side|BASE': 9, 'shared|BASE': 1 },
  };
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
  assert.deepEqual(
    collection,
    { 'client-side|BASE': 3, 'server-side|BASE': 9, 'shared|BASE': 4 },
    'store carries the union; MAX wins for `shared|BASE` (4 > 1)',
  );
  const retryPatch = fetchCalls[1].body.patch;
  assert.deepEqual(
    retryPatch.collection,
    { 'client-side|BASE': 3, 'server-side|BASE': 9, 'shared|BASE': 4 },
    'retry ships the merged collection, never a bare server-only overwrite',
  );
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

// ── Favorites are independently round-tripped ──────────────────────────
await test('favorites: pushed independently of collection (no derivation from ownership)', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'owned|BASE': 1 } }));
  useFavoritesStore.getState().addFavorite({
    cardNumber: 'wishlist',
    printing: 'PARALLEL',
    now: '2026-09-08T00:00:00.000Z',
  });
  responseQueue = [jsonResponse(200, { ok: true, snapshot: { ...SNAPSHOT_V7, revision: 20 } })];
  await pushAccountSyncFromStores(SESSION);
  const patch = fetchCalls[0].body.patch;
  const favKeys = patch.favorites.map((f) => `${f.cardNumber}|${f.printing}`).sort();
  assert.deepEqual(favKeys, ['wishlist|PARALLEL'], 'favorites is the exact wishlist entry, not derived from collection');
  assert.deepEqual(patch.collection, { 'owned|BASE': 1 }, 'collection is independent of favorites');
});

await test('favorites: server hydrate replaces the local favorites list (no leak from previous user)', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'stale', printing: 'BASE', now: '2026-09-01T00:00:00.000Z' });
  const snap = {
    ...SNAPSHOT_V7,
    favorites: [
      { cardNumber: 'server-a', printing: 'BASE', addedAt: '2026-09-05T00:00:00.000Z' },
      { cardNumber: 'server-b', printing: 'PARALLEL', addedAt: '2026-09-06T00:00:00.000Z' },
    ],
  };
  responseQueue = [jsonResponse(200, { snapshot: snap })];
  await hydrateAccountSyncFromServer(SESSION);
  const favs = useFavoritesStore.getState().favorites.map((f) => `${f.cardNumber}|${f.printing}`).sort();
  assert.deepEqual(favs, ['server-a|BASE', 'server-b|PARALLEL'], 'local favorites replaced by server hydrate');
});

// ── mergeLocalOntoServer is unit-verifiable and mutation-sensitive ──────
await test('merge: favorites union preserves both sides, earliest addedAt wins', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, favorites: [
      { cardNumber: 'A', printing: 'BASE', addedAt: '2026-01-01T00:00:00Z' },
      { cardNumber: 'B', printing: 'BASE', addedAt: '2026-05-01T00:00:00Z' },
    ] },
    { favorites: [
      { cardNumber: 'A', printing: 'BASE', addedAt: '2025-01-01T00:00:00Z' },
      { cardNumber: 'C', printing: 'PARALLEL', addedAt: '2026-08-01T00:00:00Z' },
    ] },
  );
  const keys = merged.favorites.map((f) => `${f.cardNumber}|${f.printing}`);
  assert.deepEqual(keys, ['A|BASE', 'B|BASE', 'C|PARALLEL'], 'union of both sides');
  const a = merged.favorites.find((f) => f.cardNumber === 'A');
  assert.equal(a.addedAt, '2025-01-01T00:00:00Z', 'earliest addedAt wins for A');
});

await test('merge: collection uses MAX per key (never lose ownership)', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, collection: { 'a|BASE': 1, 'b|BASE': 5 } },
    { collection: { 'a|BASE': 3, 'c|BASE': 2 } },
  );
  assert.deepEqual(merged.collection, { 'a|BASE': 3, 'b|BASE': 5, 'c|BASE': 2 });
});

await test('merge: decks newer updatedAt wins; local wins on tie', () => {
  const serverDeck = { id: 'x', name: 'server', updatedAt: '2026-09-01T00:00:00Z', oshi: [], main: [], yell: [] };
  const localDeckOlder = { id: 'x', name: 'local-older', updatedAt: '2026-08-01T00:00:00Z', oshi: [], main: [], yell: [] };
  const localDeckSame = { id: 'x', name: 'local-tie', updatedAt: '2026-09-01T00:00:00Z', oshi: [], main: [], yell: [] };
  const localDeckNewer = { id: 'x', name: 'local-newer', updatedAt: '2026-09-08T00:00:00Z', oshi: [], main: [], yell: [] };

  const olderMerge = mergeLocalOntoServer({ ...SNAPSHOT_V7, decks: [serverDeck] }, { decks: [localDeckOlder] });
  assert.equal(olderMerge.decks[0].name, 'server', 'server wins when local is older');

  const tieMerge = mergeLocalOntoServer({ ...SNAPSHOT_V7, decks: [serverDeck] }, { decks: [localDeckSame] });
  assert.equal(tieMerge.decks[0].name, 'local-tie', 'local wins on tie');

  const newerMerge = mergeLocalOntoServer({ ...SNAPSHOT_V7, decks: [serverDeck] }, { decks: [localDeckNewer] });
  assert.equal(newerMerge.decks[0].name, 'local-newer', 'local newer wins');
});

await test('merge: priceAlerts newer updatedAt wins; keys union', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, priceAlerts: [
      { cardNumber: 'p1', printing: 'BASE', upperPrice: 10, updatedAt: '2026-09-01T00:00:00Z' },
    ] },
    { priceAlerts: [
      { cardNumber: 'p1', printing: 'BASE', upperPrice: 20, updatedAt: '2026-09-08T00:00:00Z' },
      { cardNumber: 'p2', printing: 'BASE', upperPrice: 5, updatedAt: '2026-09-05T00:00:00Z' },
    ] },
  );
  const keys = merged.priceAlerts.map((a) => `${a.cardNumber}|${a.printing}`).sort();
  assert.deepEqual(keys, ['p1|BASE', 'p2|BASE']);
  const p1 = merged.priceAlerts.find((a) => a.cardNumber === 'p1');
  assert.equal(p1.upperPrice, 20, 'newer local wins for p1');
});

await test('merge: settings local wins (the client is the authority for currency/language)', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, settings: { preferredCurrency: 'USD', preferredLanguage: 'ja' } },
    { settings: { preferredCurrency: 'TWD', preferredLanguage: 'zh' } },
  );
  assert.deepEqual(merged.settings, { preferredCurrency: 'TWD', preferredLanguage: 'zh' });
});

await test('clearAccountScopedStores wipes favorites / decks / collection / alerts (settings survive)', () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'a', printing: 'BASE' });
  useDeckStore.setState((s) => ({ ...s, decks: [{ id: 'd', name: 'x', oshi: [], main: [], yell: [], updatedAt: 'z' }], collection: { 'x|BASE': 1 } }));
  usePriceAlertStore.setState((s) => ({ ...s, alerts: { 'x|BASE': { cardNumber: 'x', printing: 'BASE', upperPrice: 1, updatedAt: 'z' } } }));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'USD', preferredLanguage: 'ja' }));
  clearAccountScopedStores();
  assert.deepEqual(useFavoritesStore.getState().favorites, [], 'favorites cleared');
  assert.deepEqual(useDeckStore.getState().decks, [], 'decks cleared');
  assert.deepEqual(useDeckStore.getState().collection, {}, 'collection cleared');
  assert.deepEqual(usePriceAlertStore.getState().alerts, {}, 'alerts cleared');
  assert.equal(useSettingsStore.getState().preferredCurrency, 'USD', 'settings survive logout (UI preference)');
  assert.equal(useSettingsStore.getState().preferredLanguage, 'ja', 'settings survive logout');
  assert.equal(getLastKnownRevision(), 0, 'lastKnownRevision reset');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync orchestrator: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync orchestrator failed`);
}
