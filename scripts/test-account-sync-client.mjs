#!/usr/bin/env node
// DIC-1380 account remote-sync client regression.
//
// The Phase-1 server contract is exhaustively tested by
// `scripts/test-account-sync-backend.cjs`. This suite pins the client
// boundary: pullAccountSnapshot / pushAccountSnapshot must talk to
// `/api/auth/sync` with the bearer session, must refuse to fire when the
// session is empty (guest / not yet rehydrated), must surface a 409 as
// `AccountSyncConflictError` carrying the server snapshot, and must
// swallow the "no state to sync" responses (401 / 404 / account_deleted /
// 410) as `null` so wiring code can safely branch on the return without
// try/catch on the happy path.
//
// The client is dependency-free apart from `getApiBase` (from
// pushNotificationService) and `fetch`. `getApiBase` on web returns
// `window.location.origin`; a minimal `window` stub is enough to load it
// without pulling in react-native-web.

import assert from 'node:assert/strict';

globalThis.window = { location: { origin: 'https://holohunter.dicoge.com' } };

const fetchCalls = [];
let nextResponse = () => new Response(null, { status: 500 });
globalThis.fetch = async (input, init) => {
  fetchCalls.push({
    url: typeof input === 'string' ? input : String(input),
    method: init?.method ?? 'GET',
    headers: init?.headers ?? {},
    body: init?.body,
  });
  return nextResponse();
};

const {
  pullAccountSnapshot,
  pushAccountSnapshot,
  newIdempotencyKey,
  AccountSyncClientError,
  AccountSyncConflictError,
  ACCOUNT_SYNC_CLIENT_SCHEMA_VERSION,
} = await import('../src/services/accountSyncClient.ts');

let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

assert.equal(ACCOUNT_SYNC_CLIENT_SCHEMA_VERSION, 1, 'client schema pins the DIC-1156 Phase-1 shape');

// ── Empty-session fast path ─────────────────────────────────────────────
await test('pullAccountSnapshot(null) returns null without hitting the network', async () => {
  const result = await pullAccountSnapshot(null);
  assert.equal(result, null);
  assert.equal(fetchCalls.length, 0, 'no request must go out for an empty session');
});
await test('pullAccountSnapshot("") returns null without hitting the network', async () => {
  const result = await pullAccountSnapshot('');
  assert.equal(result, null);
  assert.equal(fetchCalls.length, 0);
});
await test('pushAccountSnapshot with empty session returns null and does not POST', async () => {
  const result = await pushAccountSnapshot(undefined, {
    baseRevision: 0,
    idempotencyKey: newIdempotencyKey(),
    patch: {},
  });
  assert.equal(result, null);
  assert.equal(fetchCalls.length, 0);
});

// ── Happy-path GET ──────────────────────────────────────────────────────
const HAPPY_SNAPSHOT = {
  schemaVersion: 1,
  revision: 7,
  updatedAt: '2026-09-08T00:00:00.000Z',
  deviceId: 'dev-1',
  favorites: [
    { cardNumber: 'hBP04-001', printing: 'BASE', addedAt: '2026-09-01T00:00:00.000Z' },
  ],
  decks: [],
  collection: { 'hBP04-001|BASE': 2 },
  priceAlerts: [],
  settings: { preferredCurrency: 'TWD', preferredLanguage: 'zh' },
};

await test('pullAccountSnapshot GETs /api/auth/sync with the bearer session', async () => {
  nextResponse = () => jsonResponse(200, { snapshot: HAPPY_SNAPSHOT });
  const snap = await pullAccountSnapshot('session-token-abc');
  assert.deepEqual(snap, HAPPY_SNAPSHOT);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].method, 'GET');
  assert.equal(fetchCalls[0].url, 'https://holohunter.dicoge.com/api/auth/sync');
  assert.equal(fetchCalls[0].headers.Authorization, 'Bearer session-token-abc');
});

// ── "No state to sync" responses collapse to null ───────────────────────
for (const status of [401, 404]) {
  await test(`pullAccountSnapshot swallows ${status} as null`, async () => {
    nextResponse = () => jsonResponse(status, { error: 'INVALID_TOKEN' });
    assert.equal(await pullAccountSnapshot('session-token-abc'), null);
  });
}
await test('pullAccountSnapshot swallows account_deleted (410) as null', async () => {
  nextResponse = () => jsonResponse(410, { error: 'account_deleted' });
  assert.equal(await pullAccountSnapshot('session-token-abc'), null);
});
await test('pullAccountSnapshot throws AccountSyncClientError on 500', async () => {
  nextResponse = () => jsonResponse(500, { error: 'internal' });
  await assert.rejects(
    () => pullAccountSnapshot('session-token-abc'),
    (err) => err instanceof AccountSyncClientError && err.status === 500,
  );
});
await test('pullAccountSnapshot wraps a network error into AccountSyncClientError(status=0)', async () => {
  nextResponse = () => { throw new TypeError('network fetch failed'); };
  await assert.rejects(
    () => pullAccountSnapshot('session-token-abc'),
    (err) => err instanceof AccountSyncClientError && err.status === 0,
  );
});

// ── Happy-path POST ─────────────────────────────────────────────────────
await test('pushAccountSnapshot POSTs the patch with idempotency + base revision', async () => {
  nextResponse = () => jsonResponse(200, { ok: true, snapshot: { ...HAPPY_SNAPSHOT, revision: 8 } });
  const key = newIdempotencyKey();
  const patch = { favorites: [{ cardNumber: 'hBP04-002', printing: 'BASE', addedAt: '2026-09-08T00:00:00.000Z' }] };
  const snap = await pushAccountSnapshot('session-token-abc', {
    baseRevision: 7,
    idempotencyKey: key,
    deviceId: 'dev-1',
    patch,
  });
  assert.equal(snap?.revision, 8);
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://holohunter.dicoge.com/api/auth/sync');
  assert.equal(call.headers.Authorization, 'Bearer session-token-abc');
  assert.equal(call.headers['Idempotency-Key'], key);
  const body = JSON.parse(call.body);
  assert.equal(body.baseRevision, 7);
  assert.equal(body.idempotencyKey, key);
  assert.equal(body.deviceId, 'dev-1');
  assert.deepEqual(body.patch, patch);
});

// ── 409 revision conflict must surface as AccountSyncConflictError ──────
await test('pushAccountSnapshot raises AccountSyncConflictError on 409 with the server snapshot', async () => {
  nextResponse = () => jsonResponse(409, {
    error: 'revision_conflict',
    serverRevision: 12,
    snapshot: { ...HAPPY_SNAPSHOT, revision: 12 },
  });
  await assert.rejects(
    () => pushAccountSnapshot('session-token-abc', {
      baseRevision: 7,
      idempotencyKey: newIdempotencyKey(),
      patch: { favorites: [] },
    }),
    (err) => {
      assert.ok(err instanceof AccountSyncConflictError, 'must be AccountSyncConflictError');
      assert.equal(err.status, 409);
      assert.equal(err.serverRevision, 12);
      assert.equal(err.serverSnapshot?.revision, 12);
      return true;
    },
  );
});

await test('pushAccountSnapshot swallows account_deleted (410) as null', async () => {
  nextResponse = () => jsonResponse(410, { error: 'account_deleted' });
  const snap = await pushAccountSnapshot('session-token-abc', {
    baseRevision: 7,
    idempotencyKey: newIdempotencyKey(),
    patch: {},
  });
  assert.equal(snap, null);
});
await test('pushAccountSnapshot throws AccountSyncClientError on 500', async () => {
  nextResponse = () => jsonResponse(500, { error: 'internal' });
  await assert.rejects(
    () => pushAccountSnapshot('session-token-abc', {
      baseRevision: 7,
      idempotencyKey: newIdempotencyKey(),
      patch: {},
    }),
    (err) => err instanceof AccountSyncClientError && err.status === 500,
  );
});

// ── newIdempotencyKey shape ─────────────────────────────────────────────
await test('newIdempotencyKey emits unique, non-empty strings', async () => {
  const keys = new Set();
  for (let i = 0; i < 32; i++) keys.add(newIdempotencyKey());
  assert.equal(keys.size, 32, 'each call must return a distinct key');
  for (const k of keys) assert.ok(k.length > 4, 'key must have real entropy');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ account remote-sync client: ${passed} checks passed`);
} else {
  console.error(`\n❌ account remote-sync client failed`);
}
