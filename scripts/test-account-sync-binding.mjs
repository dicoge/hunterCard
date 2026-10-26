#!/usr/bin/env node
// DIC-1380 W4 CR — account remote-sync binding regression.
//
// The binding turns the orchestrator into the reactive glue App.tsx installs
// at boot. This suite pins the subscription contract:
//   * a session adoption triggers a hydrate GET
//   * a deck / collection / priceAlert / settings mutation triggers a
//     debounced push POST
//   * a session logout clears the last-known revision (a subsequent session
//     re-hydrates without borrowing the old device's revision)
//   * installing twice is a no-op (hot-reload safety)
//
// Removing any one of those subscriptions must fail this suite.

process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';
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
  if (!next) return new Response('{}', { status: 500 });
  return next();
};

const {
  installAccountSyncBinding,
  __resetAccountSyncBindingForTesting,
  __getAccountSyncBindingPendingPushMs,
  __getAccountSyncBindingQueuedPushSession,
} = await import('../src/services/accountSyncBinding.ts');
const { useAuthStore } = await import('../src/store/authStore.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
const { resetLastKnownRevision, getLastKnownRevision } = await import('../src/services/accountSyncOrchestrator.ts');

function jsonResponse(status, body) {
  return () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const DEBOUNCE = __getAccountSyncBindingPendingPushMs();
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  responseQueue = [];
  __resetAccountSyncBindingForTesting();
  useAuthStore.setState((s) => ({ ...s, session: null, isAuthenticated: false, isGuest: false }));
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

async function waitForPush() {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE + 50));
}

const BASE_SNAPSHOT = {
  schemaVersion: 1,
  revision: 3,
  updatedAt: '2026-09-08T00:00:00.000Z',
  deviceId: 'dev-1',
  favorites: [],
  decks: [],
  collection: {},
  priceAlerts: [],
  settings: { preferredCurrency: 'TWD', preferredLanguage: 'zh' },
};

// ── Session adoption triggers a hydrate GET ─────────────────────────────
await test('session adoption triggers hydrate GET', async () => {
  responseQueue = [jsonResponse(200, { snapshot: BASE_SNAPSHOT })];
  installAccountSyncBinding();
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(fetchCalls.length >= 1, 'at least one GET fired');
  assert.equal(fetchCalls[0].method, 'GET');
  assert.equal(fetchCalls[0].headers.Authorization, `Bearer ${SESSION_A}`);
});

// ── Session logout resets lastKnownRevision so the next session hydrates fresh ──
await test('logout clears lastKnownRevision so the next session hydrates fresh', async () => {
  responseQueue = [
    jsonResponse(200, { snapshot: { ...BASE_SNAPSHOT, revision: 9 } }),
    jsonResponse(200, { snapshot: { ...BASE_SNAPSHOT, revision: 0 } }),
  ];
  installAccountSyncBinding();
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(getLastKnownRevision(), 9, 'first session set the revision');
  useAuthStore.setState((s) => ({ ...s, session: null, isAuthenticated: false }));
  await new Promise((r) => setImmediate(r));
  assert.equal(getLastKnownRevision(), 0, 'logout cleared the revision');
  useAuthStore.setState((s) => ({ ...s, session: SESSION_B, isAuthenticated: true }));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(getLastKnownRevision(), 0, 'second session hydrated from revision 0');
});

// ── Deck-collection edit triggers a debounced push POST ─────────────────
await test('collection change under an active session triggers a debounced push POST', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { ok: true, snapshot: { ...BASE_SNAPSHOT, revision: 4 } }),
  ];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const beforeMutation = fetchCalls.length;
  useDeckStore.setState((s) => ({ ...s, collection: { 'hBP04-999|BASE': 3 } }));
  // Debounce is in flight; nothing new yet.
  assert.equal(fetchCalls.length, beforeMutation, 'no push before debounce completes');
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 1, 'a POST fired after debounce');
  const push = posts[posts.length - 1];
  assert.deepEqual(push.body.patch.collection, { 'hBP04-999|BASE': 3 });
  assert.equal(push.headers.Authorization, `Bearer ${SESSION_A}`);
});

// ── PriceAlert edit triggers a push ─────────────────────────────────────
await test('priceAlert change triggers a push', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { ok: true, snapshot: { ...BASE_SNAPSHOT, revision: 4 } }),
  ];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  usePriceAlertStore.setState((s) => ({
    ...s,
    alerts: {
      'x|BASE': {
        cardNumber: 'x', printing: 'BASE', name: 'x', currency: 'JPY',
        lowerPrice: null, upperPrice: 999,
        createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z',
      },
    },
  }));
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 1, 'priceAlert push fired');
  assert.equal(posts[posts.length - 1].body.patch.priceAlerts.length, 1);
});

// ── Settings edit triggers a push ───────────────────────────────────────
await test('settings change (preferredCurrency) triggers a push', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { ok: true, snapshot: { ...BASE_SNAPSHOT, revision: 4 } }),
  ];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  useSettingsStore.setState((s) => ({ ...s, preferredCurrency: 'USD' }));
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 1, 'settings push fired');
  assert.equal(posts[posts.length - 1].body.patch.settings.preferredCurrency, 'USD');
});

// ── Store change with NO session does not push ──────────────────────────
await test('store change without an active session does not push', async () => {
  installAccountSyncBinding();
  useDeckStore.setState((s) => ({ ...s, collection: { 'x|BASE': 1 } }));
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchCalls.length, 0, 'no fetch fired for a signed-out mutation');
});

// ── Double-install is a no-op ───────────────────────────────────────────
await test('installAccountSyncBinding is a no-op on the second call (hot-reload safety)', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { ok: true, snapshot: BASE_SNAPSHOT }),
  ];
  installAccountSyncBinding();
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const gets = fetchCalls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 1, 'second install did not double-subscribe the auth store');
  useDeckStore.setState((s) => ({ ...s, collection: { 'y|BASE': 1 } }));
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1, 'exactly one POST for the mutation (no duplicate subscription)');
});

// ── Favorites store change triggers a push ──────────────────────────────
await test('favorites change under an active session triggers a debounced push', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { ok: true, snapshot: { ...BASE_SNAPSHOT, revision: 4 } }),
  ];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  useFavoritesStore.getState().addFavorite({
    cardNumber: 'wishlist',
    printing: 'PARALLEL',
    now: '2026-09-08T00:00:00Z',
  });
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.ok(posts.length >= 1, 'favorites push fired');
  const patch = posts[posts.length - 1].body.patch;
  assert.equal(patch.favorites.length, 1);
  assert.equal(patch.favorites[0].cardNumber, 'wishlist');
  assert.equal(patch.favorites[0].printing, 'PARALLEL');
});

// ── DIC-1380 W5: logout MUST cancel a queued push AND clear account state ──
await test('logout: cancels the pending debounced push before it can fire', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [jsonResponse(200, { snapshot: BASE_SNAPSHOT })];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Queue a push and IMMEDIATELY log out.
  useDeckStore.setState((s) => ({ ...s, collection: { 'about-to-be-cancelled|BASE': 1 } }));
  assert.equal(
    __getAccountSyncBindingQueuedPushSession(),
    SESSION_A,
    'binding shows a push queued for session A',
  );
  useAuthStore.setState((s) => ({ ...s, session: null, isAuthenticated: false }));
  assert.equal(
    __getAccountSyncBindingQueuedPushSession(),
    null,
    'logout must clear the queued-push session marker',
  );
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 0, 'the queued push must not fire after logout');
});

await test('logout: clears account-scoped stores (decks / collection / alerts / favorites)', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [jsonResponse(200, { snapshot: BASE_SNAPSHOT })];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  useDeckStore.setState((s) => ({ ...s, decks: [{ id: 'stay-away', name: 'A', oshi: [], main: [], yell: [], updatedAt: 'z' }], collection: { 'a|BASE': 1 } }));
  useFavoritesStore.getState().addFavorite({ cardNumber: 'a', printing: 'BASE' });
  useAuthStore.setState((s) => ({ ...s, session: null, isAuthenticated: false }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(useDeckStore.getState().decks, [], 'decks cleared on logout');
  assert.deepEqual(useDeckStore.getState().collection, {}, 'collection cleared on logout');
  assert.deepEqual(useFavoritesStore.getState().favorites, [], 'favorites cleared on logout');
  assert.equal(useSettingsStore.getState().preferredCurrency, 'TWD', 'settings survive logout (UI preference)');
});

// ── Account switch A → B: same guard as logout applies ──────────────────
await test('account switch: queued push for A does not fire against B, and A\'s stores are cleared', async () => {
  useAuthStore.setState((s) => ({ ...s, session: SESSION_A, isAuthenticated: true }));
  responseQueue = [
    jsonResponse(200, { snapshot: BASE_SNAPSHOT }),
    jsonResponse(200, { snapshot: { ...BASE_SNAPSHOT, revision: 5, collection: { 'account-b|BASE': 7 } } }),
  ];
  installAccountSyncBinding();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  useDeckStore.setState((s) => ({ ...s, collection: { 'account-a-secret|BASE': 3 } }));
  useFavoritesStore.getState().addFavorite({ cardNumber: 'account-a-fav', printing: 'BASE' });
  useAuthStore.setState((s) => ({ ...s, session: SESSION_B, isAuthenticated: true }));
  await waitForPush();
  await new Promise((r) => setImmediate(r));
  // Only the hydrate GETs should have fired (one per session); no POST that
  // could have leaked account-A state into account B.
  const posts = fetchCalls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 0, 'the queued push for account A must not fire after switching to B');
  const gets = fetchCalls.filter((c) => c.method === 'GET');
  assert.equal(gets.length, 2, 'both sessions hydrated (one GET each)');
  assert.equal(gets[1].headers.Authorization, `Bearer ${SESSION_B}`, 'the second hydrate is for account B');
  // Account A's stores were cleared before the account-B hydrate applied.
  assert.equal(
    useDeckStore.getState().collection['account-a-secret|BASE'],
    undefined,
    'account A collection cleared before account B hydrates',
  );
  assert.deepEqual(
    useFavoritesStore.getState().favorites.filter((f) => f.cardNumber === 'account-a-fav'),
    [],
    'account A favorites cleared',
  );
  // Account B's hydrate DID apply.
  assert.equal(useDeckStore.getState().collection['account-b|BASE'], 7, 'account B collection hydrated');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync binding: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync binding failed`);
}
