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
const { useAuthStore } = await import('../src/store/authStore.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');

const SESSION = 'session-abc';

let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  responseQueue = [];
  useDeckStore.setState((s) => ({
    ...s, decks: [], collection: {}, activeDeckId: null,
    deletedDeckIds: {}, collectionChangedKeys: {},
  }));
  usePriceAlertStore.setState((s) => ({ ...s, alerts: {}, pending: {}, removals: {} }));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'TWD', preferredLanguage: 'zh' }));
  useFavoritesStore.getState().clearAll();
  // DIC-1380 W6: the orchestrator now reads the auth session through
  // useAuthStore to guard against a stale in-flight response. Default the
  // session to the test-fixture bearer; individual tests override to
  // simulate an account switch or logout mid-flight.
  useAuthStore.setState((s) => ({ ...s, session: SESSION }));
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

// ── DIC-1380 W6: tombstones — the 409 merge preserves LOCAL deletions ──
await test('W6 merge: favorites — local removal tombstone drops the server add', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, favorites: [
      { cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-05T00:00:00Z' },
      { cardNumber: 'keep', printing: 'BASE', addedAt: '2026-09-05T00:00:00Z' },
    ] },
    { favorites: [
      // local unfavorited `gone` — it is absent from the local list;
      // the tombstone (below) is what carries the delete signal.
      { cardNumber: 'keep', printing: 'BASE', addedAt: '2026-09-05T00:00:00Z' },
    ] },
    { favoritesRemovedAt: { 'gone|BASE': '2026-09-08T00:00:00Z' } },
  );
  const keys = merged.favorites.map((f) => `${f.cardNumber}|${f.printing}`).sort();
  assert.deepEqual(keys, ['keep|BASE'], 'local removal tombstone drops the server add');
});

await test('W6 merge: favorites — server add newer than tombstone wins (re-add wins over stale delete)', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, favorites: [
      { cardNumber: 'x', printing: 'BASE', addedAt: '2026-09-10T00:00:00Z' },
    ] },
    { favorites: [] },
    { favoritesRemovedAt: { 'x|BASE': '2026-09-05T00:00:00Z' } },
  );
  const keys = merged.favorites.map((f) => `${f.cardNumber}|${f.printing}`);
  assert.deepEqual(keys, ['x|BASE'], 'server add stamped AFTER local removal survives');
});

await test('W6 merge: collection — local decrease survives (ownership can go down)', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, collection: { 'a|BASE': 5, 'b|BASE': 3 } },
    { collection: { 'a|BASE': 1, 'b|BASE': 3 } },
    { collectionChangedKeys: { 'a|BASE': '2026-09-08T00:00:00Z' } },
  );
  assert.equal(merged.collection['a|BASE'], 1, 'local decrease respected because local WROTE the key');
  assert.equal(merged.collection['b|BASE'], 3, 'untouched key falls back to MAX');
});

await test('W6 merge: collection — local delete (missing key) survives when the local device wrote it', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, collection: { 'a|BASE': 5 } },
    { collection: {} },
    { collectionChangedKeys: { 'a|BASE': '2026-09-08T00:00:00Z' } },
  );
  assert.equal(merged.collection['a|BASE'], undefined, 'local delete (setOwned to 0) survives the merge');
});

await test('W6 merge: collection — untouched key still MAX-wins (never regresses silently)', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, collection: { 'a|BASE': 5 } },
    { collection: { 'a|BASE': 1 } },
    { collectionChangedKeys: {} },
  );
  assert.equal(merged.collection['a|BASE'], 5, 'local never touched the key — MAX(5,1)=5');
});

await test('W6 merge: decks — local delete tombstone drops the server deck', () => {
  const serverDeck = { id: 'd', name: 'server', updatedAt: '2026-09-05T00:00:00Z', oshi: [], main: [], yell: [] };
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, decks: [serverDeck] },
    { decks: [] },
    { deletedDeckIds: { d: '2026-09-08T00:00:00Z' } },
  );
  assert.equal(merged.decks.length, 0, 'local delete tombstone drops server deck');
});

await test('W6 merge: decks — server update newer than delete wins (recreate beats stale delete)', () => {
  const serverDeck = { id: 'd', name: 'server-fresh', updatedAt: '2026-09-10T00:00:00Z', oshi: [], main: [], yell: [] };
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, decks: [serverDeck] },
    { decks: [] },
    { deletedDeckIds: { d: '2026-09-05T00:00:00Z' } },
  );
  assert.equal(merged.decks.length, 1, 'server update AFTER local delete wins');
  assert.equal(merged.decks[0].name, 'server-fresh');
});

await test('W6 merge: priceAlerts — local removal tombstone drops the server alert', () => {
  const merged = mergeLocalOntoServer(
    { ...SNAPSHOT_V7, priceAlerts: [
      { cardNumber: 'p1', printing: 'BASE', upperPrice: 10, updatedAt: '2026-09-05T00:00:00Z' },
      { cardNumber: 'p2', printing: 'BASE', upperPrice: 20, updatedAt: '2026-09-05T00:00:00Z' },
    ] },
    { priceAlerts: [
      { cardNumber: 'p2', printing: 'BASE', upperPrice: 20, updatedAt: '2026-09-05T00:00:00Z' },
    ] },
    { priceAlertsRemovedAt: { 'p1|BASE': '2026-09-08T00:00:00Z' } },
  );
  const keys = merged.priceAlerts.map((a) => `${a.cardNumber}|${a.printing}`).sort();
  assert.deepEqual(keys, ['p2|BASE'], 'local removal drops server alert');
});

await test('W6 push: 409 recovery honors favorites tombstone end-to-end (retry patch does not include the deleted key)', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'kept', printing: 'BASE', now: '2026-09-08T00:00:00.000Z' });
  // Locally the user unfavorited `gone` — the tombstone records that.
  useFavoritesStore.getState().addFavorite({ cardNumber: 'gone', printing: 'BASE', now: '2026-09-08T00:00:00.000Z' });
  useFavoritesStore.getState().removeFavorite('gone', 'BASE', '2026-09-09T00:00:00.000Z');
  const serverSnap = {
    ...SNAPSHOT_V7,
    revision: 100,
    favorites: [
      { cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' },
      { cardNumber: 'kept', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' },
    ],
  };
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 100, snapshot: serverSnap }),
    jsonResponse(200, { ok: true, snapshot: { ...serverSnap, revision: 101 } }),
  ];
  const confirmed = await pushAccountSyncFromStores(SESSION);
  assert.equal(confirmed?.revision, 101);
  const retryFavs = fetchCalls[1].body.patch.favorites.map((f) => `${f.cardNumber}|${f.printing}`).sort();
  assert.deepEqual(retryFavs, ['kept|BASE'], 'retry patch drops the tombstoned key — server union does NOT resurrect it');
});

await test('W6 push: successful push CLEARS favorites/decks/alerts tombstones', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'x', printing: 'BASE' });
  useFavoritesStore.getState().removeFavorite('x', 'BASE');
  useDeckStore.setState((s) => ({ ...s, decks: [{ id: 'd', name: 'x', oshi: [], main: [], yell: [], updatedAt: 'z' }] }));
  useDeckStore.getState().deleteDeck('d');
  usePriceAlertStore.setState((s) => ({ ...s, alerts: { 'a|BASE': { cardNumber: 'a', printing: 'BASE', upperPrice: 1, updatedAt: 'z' } } }));
  usePriceAlertStore.getState().removeAlert('a', 'BASE');
  assert.notDeepEqual(useFavoritesStore.getState().removals, {}, 'precondition: favorites tombstone exists');
  responseQueue = [jsonResponse(200, { ok: true, snapshot: { ...SNAPSHOT_V7, revision: 200 } })];
  await pushAccountSyncFromStores(SESSION);
  assert.deepEqual(useFavoritesStore.getState().removals, {}, 'favorites tombstones cleared post-push');
  assert.deepEqual(useDeckStore.getState().deletedDeckIds, {}, 'deck delete tombstones cleared post-push');
  assert.deepEqual(useDeckStore.getState().collectionChangedKeys, {}, 'collection-change stamps cleared post-push');
  assert.deepEqual(usePriceAlertStore.getState().removals, {}, 'alert tombstones cleared post-push');
});

// ── DIC-1380 W6: stale-response race — session change during network wait ─
await test('W6 race: hydrate whose session changed mid-flight does NOT apply', async () => {
  useDeckStore.setState((s) => ({ ...s, collection: { 'account-B|BASE': 42 } }));
  // Response resolves only AFTER we flip the auth session away.
  responseQueue = [() => {
    // Simulate an account switch that landed while the network was
    // in flight (typical: logout → the fetch resolves a moment later).
    useAuthStore.setState((s) => ({ ...s, session: 'session-B-different' }));
    return new Response(JSON.stringify({ snapshot: SNAPSHOT_V7 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }];
  const applied = await hydrateAccountSyncFromServer(SESSION);
  assert.equal(applied, null, 'stale hydrate returns null');
  assert.deepEqual(
    useDeckStore.getState().collection,
    { 'account-B|BASE': 42 },
    'account B stores were NOT overwritten by account A snapshot',
  );
});

await test('W6 race: push whose session changed mid-conflict does NOT reapply merged patch', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'A-only', printing: 'BASE', now: '2026-09-08T00:00:00Z' });
  const serverSnap = {
    ...SNAPSHOT_V7, revision: 300,
    favorites: [{ cardNumber: 'server-only', printing: 'BASE', addedAt: '2026-09-05T00:00:00Z' }],
  };
  responseQueue = [() => {
    // 409 first; we swap the session before the retry can fire.
    useAuthStore.setState((s) => ({ ...s, session: 'session-B-different' }));
    return new Response(JSON.stringify({ error: 'revision_conflict', serverRevision: 300, snapshot: serverSnap }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    });
  }];
  const result = await pushAccountSyncFromStores(SESSION);
  assert.equal(result, null, 'stale conflict returns null instead of applying account A merge onto account B');
  // Local favorites (account A's queue) untouched by the stale conflict
  // — the switch to account B will trigger its own clearAccountScopedStores
  // through the binding, not through this stale response.
  const favKeys = useFavoritesStore.getState().favorites.map((f) => f.cardNumber).sort();
  assert.deepEqual(favKeys, ['A-only'], 'account A local state left alone; the stale response did NOT merge server data onto it');
  assert.equal(fetchCalls.length, 1, 'no retry after session change — the whole operation bailed');
});

// ── DIC-1380 W7: tombstones survive REPEATED 409 retries ──────────────
// Mac-Codex W7 evidence: `replaceAll()` on the merge-apply path was
// clearing the removals tombstone map. That worked when the retry
// succeeded on the first attempt, but if the caller re-scheduled after a
// rethrow (or the merge itself produced a second 409) the retry patch
// went out WITHOUT the tombstone → the deleted favorite resurrected.
// The fix routes the merge-apply through `replaceAllPreservingTombstones`
// and only clears the tombstones after a server-ACKed push. This test
// pins the whole cycle.
await test('W7 push: tombstones SURVIVE a mid-cycle 409 merge apply so a subsequent push retry still honors the delete', async () => {
  // Local user unfavorited `gone`; `kept` stays.
  useFavoritesStore.getState().addFavorite({ cardNumber: 'kept', printing: 'BASE', now: '2026-09-08T00:00:00Z' });
  useFavoritesStore.getState().addFavorite({ cardNumber: 'gone', printing: 'BASE', now: '2026-09-08T00:00:00Z' });
  useFavoritesStore.getState().removeFavorite('gone', 'BASE', '2026-09-09T00:00:00Z');
  assert.ok(useFavoritesStore.getState().removals['gone|BASE'], 'precondition: tombstone stamped');
  const serverSnap = {
    ...SNAPSHOT_V7, revision: 500,
    favorites: [
      { cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' },
      { cardNumber: 'kept', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' },
    ],
  };
  // First push: 409 (conflict); merge apply lands; second push: 409 again;
  // rethrow. After the rethrow, we assert the tombstone STILL EXISTS in
  // the store so the caller's follow-up push (or a fresh binding-driven
  // schedule) will still honor the delete.
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 500, snapshot: serverSnap }),
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 501, snapshot: { ...serverSnap, revision: 501 } }),
  ];
  await assert.rejects(
    () => pushAccountSyncFromStores(SESSION),
    (err) => err?.name === 'AccountSyncConflictError' && err.status === 409,
  );
  // The bug pre-W7: replaceAll cleared removals during the merge apply,
  // so after the rethrow the tombstone was gone. The fix: the merge
  // apply preserves tombstones.
  assert.ok(
    useFavoritesStore.getState().removals['gone|BASE'],
    'W7 CR: tombstone SURVIVES the mid-cycle 409 merge apply so a future retry still honors the delete',
  );
  // Also: local favorites should NOT contain `gone` (the app never sees
  // the deletion reversed on-screen either).
  const favKeys = useFavoritesStore.getState().favorites.map((f) => f.cardNumber).sort();
  assert.deepEqual(favKeys, ['kept'], 'local favorites list still excludes the tombstoned entry after the merge apply');
});

await test('W7 push: on server-ACKed success (following 409 recovery) tombstones ARE cleared exactly once', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'gone', printing: 'BASE', now: '2026-09-08T00:00:00Z' });
  useFavoritesStore.getState().removeFavorite('gone', 'BASE', '2026-09-09T00:00:00Z');
  const serverSnap = {
    ...SNAPSHOT_V7, revision: 600,
    favorites: [{ cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' }],
  };
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 600, snapshot: serverSnap }),
    jsonResponse(200, { ok: true, snapshot: { ...serverSnap, revision: 601, favorites: [] } }),
  ];
  const confirmed = await pushAccountSyncFromStores(SESSION);
  assert.equal(confirmed?.revision, 601);
  assert.deepEqual(useFavoritesStore.getState().removals, {}, 'tombstones cleared after the server ACK, not before');
});

// A second push that follows a rethrown 409 (binding re-schedule) must
// send a patch WITHOUT `gone` — because the tombstone survived the first
// cycle. This is the end-to-end proof for the CR item.
await test('W7 push: re-scheduled push after 409 rethrow STILL drops the tombstoned key from the outgoing patch', async () => {
  useFavoritesStore.getState().addFavorite({ cardNumber: 'gone', printing: 'BASE', now: '2026-09-08T00:00:00Z' });
  useFavoritesStore.getState().removeFavorite('gone', 'BASE', '2026-09-09T00:00:00Z');
  const serverSnap = {
    ...SNAPSHOT_V7, revision: 700,
    favorites: [{ cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' }],
  };
  // Cycle 1: 409, merge apply, 409, rethrow.
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 700, snapshot: serverSnap }),
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 701, snapshot: { ...serverSnap, revision: 701 } }),
  ];
  await assert.rejects(() => pushAccountSyncFromStores(SESSION));
  const cycle1Calls = fetchCalls.length;
  // Cycle 2: caller re-schedules a push. The tombstone should still be
  // honored; the outgoing patch should NOT include `gone`.
  fetchCalls.length = 0;
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 702, snapshot: { ...serverSnap, revision: 702 } }),
    jsonResponse(200, { ok: true, snapshot: { ...serverSnap, revision: 703, favorites: [] } }),
  ];
  const confirmed = await pushAccountSyncFromStores(SESSION);
  assert.equal(confirmed?.revision, 703);
  const cycle2Retry = fetchCalls[1];
  const retryFavs = (cycle2Retry.body.patch.favorites ?? []).map((f) => `${f.cardNumber}|${f.printing}`).sort();
  assert.deepEqual(retryFavs, [], 'W7: re-scheduled push retry patch drops the tombstoned key — the delete survived the whole cycle');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync orchestrator: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync orchestrator failed`);
}
