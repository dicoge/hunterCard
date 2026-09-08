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
} = await import('../src/services/accountSyncBinding.ts');
const { useAuthStore } = await import('../src/store/authStore.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
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

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync binding: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync binding failed`);
}
