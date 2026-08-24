#!/usr/bin/env node
/** Regression tests for DIC-1156 Phase 1 account sync backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-sync-tests-'));

const kvState = { values: new Map(), dels: [] };

function resetKv() {
  kvState.values.clear();
  kvState.dels = [];
}

const kv = {
  async get(key) {
    const raw = kvState.values.get(key);
    if (typeof raw !== 'string') return raw ?? null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  async del(key) {
    kvState.dels.push(key);
    return kvState.values.delete(key) ? 1 : 0;
  },
  async eval(script, keys, args) {
    if (!script.includes('-- ACCOUNT_SYNC_SAVE')) throw new Error(`unexpected eval: ${script}`);
    const [syncKey, idemKey] = keys;
    const [baseRevisionRaw, nextRaw] = args;
    const currentRaw = kvState.values.get(syncKey);
    const currentRevision = currentRaw ? JSON.parse(currentRaw).revision : 0;
    const idemRaw = kvState.values.get(idemKey);
    if (idemRaw) return ['IDEMPOTENT', String(currentRevision), idemRaw];
    if (currentRevision !== Number(baseRevisionRaw)) {
      return ['CONFLICT', String(currentRevision), currentRaw || ''];
    }
    kvState.values.set(syncKey, nextRaw);
    kvState.values.set(idemKey, nextRaw);
    return ['OK', String(currentRevision + 1), nextRaw];
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(input, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

for (const rel of [
  'api/_lib/session.ts',
  'api/_lib/identity-store.ts',
  'api/_lib/token-replay.ts',
  'api/_lib/verify-token.ts',
  'api/_lib/apple-web-oauth.ts',
  'api/_lib/apple-exchange-store.ts',
  'api/_lib/auth-endpoint.ts',
  'api/_lib/node-adapter.ts',
  'api/_lib/account-sync-store.ts',
  'api/auth/[action].ts',
]) compileTs(rel);

const { issueSession } = require(path.join(outDir, 'api/_lib/session.js'));
const nodeHandler = require(path.join(outDir, 'api/auth/[action].js')).default;
const syncStore = require(path.join(outDir, 'api/_lib/account-sync-store.js'));

function configureBackend() {
  process.env.KV_REST_API_URL = 'https://kv.example';
  process.env.KV_REST_API_TOKEN = 'kv-token';
  process.env.AUTH_SESSION_SECRET = 'test-secret';
}

function buildNodeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: '',
    headersSent: false,
    status(code) { this._status = code; return this; },
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    send(b) { this._body = b == null ? '' : String(b); this.headersSent = true; return this; },
    end(b) { if (b != null) this._body = String(b); this.headersSent = true; return this; },
  };
}

async function request(method, body, token) {
  const res = buildNodeRes();
  await nodeHandler({
    method,
    url: '/api/auth/sync',
    headers: {
      host: 'example.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body,
  }, res);
  const text = res._body;
  return { status: res._status, body: text ? JSON.parse(text) : null };
}

async function testUnauthorizedFailsClosed() {
  resetKv(); configureBackend();
  const res = await request('GET');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_TOKEN');
}

async function testSnapshotRoundTripBySessionUser() {
  resetKv(); configureBackend();
  const session = issueSession('holo_user_a');
  let res = await request('GET', undefined, session);
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.revision, 0);
  res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-0001',
    deviceId: 'web-profile-a',
    userId: 'attacker_ignored',
    patch: {
      favorites: [{ cardNumber: 'hBP01-001', printing: 'BASE', cardId: 'card-1', addedAt: '2026-08-24T00:00:00Z' }],
      collection: { 'hBP01-001|BASE': 2 },
      settings: { preferredCurrency: 'JPY', preferredLanguage: 'ja' },
    },
  }, session);
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.revision, 1);
  assert.equal(res.body.snapshot.deviceId, 'web-profile-a');
  assert.equal(res.body.snapshot.favorites.length, 1);
  assert.equal(res.body.snapshot.collection['hBP01-001|BASE'], 2);
  assert.equal(kvState.values.has('account-sync:user:attacker_ignored'), false, 'client userId must never be used as a KV key');
  assert.equal(kvState.values.has('account-sync:user:holo_user_a'), true);
}

async function testOptimisticConflictAndIdempotentReplay() {
  resetKv(); configureBackend();
  const session = issueSession('holo_user_b');
  let res = await request('POST', { baseRevision: 0, idempotencyKey: 'idem-0002', patch: { settings: { preferredCurrency: 'USD' } } }, session);
  assert.equal(res.status, 200);
  const first = res.body.snapshot;
  res = await request('POST', { baseRevision: 0, idempotencyKey: 'idem-0002', patch: { settings: { preferredCurrency: 'JPY' } } }, session);
  assert.equal(res.status, 200, 'idempotency replay returns original success');
  assert.deepEqual(res.body.snapshot, first);
  res = await request('POST', { baseRevision: 0, idempotencyKey: 'idem-0003', patch: { settings: { preferredCurrency: 'JPY' } } }, session);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'revision_conflict');
  assert.equal(res.body.currentRevision, 1);
}

async function testValidationRejectsBadCollection() {
  resetKv(); configureBackend();
  const session = issueSession('holo_user_c');
  const res = await request('POST', { baseRevision: 0, idempotencyKey: 'idem-0004', patch: { collection: { 'bad-key': 1 } } }, session);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_request');
}

async function testAccountDeleteCascadeHook() {
  resetKv(); configureBackend();
  kvState.values.set('account-sync:user:holo_user_d', JSON.stringify({ revision: 1 }));
  await syncStore.deleteAccountSyncData('holo_user_d');
  assert.equal(kvState.values.has('account-sync:user:holo_user_d'), false);
  assert.deepEqual(kvState.dels, ['account-sync:user:holo_user_d']);
}

(async () => {
  await testUnauthorizedFailsClosed();
  await testSnapshotRoundTripBySessionUser();
  await testOptimisticConflictAndIdempotentReplay();
  await testValidationRejectsBadCollection();
  await testAccountDeleteCascadeHook();
  console.log('account sync backend tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
