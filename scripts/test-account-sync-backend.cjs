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

const kvState = { values: new Map(), sets: new Map(), dels: [], beforeSyncSaveEval: null };

function resetKv() {
  kvState.values.clear();
  kvState.sets.clear();
  kvState.dels = [];
  kvState.beforeSyncSaveEval = null;
}

const kv = {
  async get(key) {
    const raw = kvState.values.get(key);
    if (typeof raw !== 'string') return raw ?? null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  async set(key, value, opts) {
    if (opts && opts.nx && kvState.values.has(key)) return null;
    kvState.values.set(key, value);
    return 'OK';
  },
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) {
      kvState.dels.push(key);
      const had = kvState.values.delete(key) || kvState.sets.delete(key);
      if (had) deleted += 1;
    }
    return deleted;
  },
  async sadd(key, ...members) {
    const set = kvState.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added += 1;
      set.add(m);
    }
    kvState.sets.set(key, set);
    return added;
  },
  async smembers(key) {
    const set = kvState.sets.get(key);
    return set ? [...set] : [];
  },
  async expire() {
    return 1;
  },
  async *scanIterator(options = {}) {
    const prefix = String(options.match || '').replace(/\*$/, '');
    for (const key of kvState.values.keys()) {
      if (!options.match || key.startsWith(prefix)) {
        yield key;
      }
    }
  },
  async eval(script, keys, args) {
    if (script.includes("return 'LOCK_LOST'")) {
      if (kvState.values.get(keys[0]) !== args[0]) return 'LOCK_LOST';
      if (script.includes('-- PUBLISH')) {
        if (kvState.values.has(keys[1])) return 'EXISTS';
        kvState.values.set(keys[1], args[1]);
        return 'OK';
      }
      if (script.includes('-- SET')) {
        kvState.values.set(keys[1], JSON.parse(args[1]));
        return 'OK';
      }
      if (script.includes('-- DELUSER')) {
        const n = Number(args[2]);
        for (let i = 0; i < n; i++) {
          const idxKey = keys[1 + i * 2];
          const detailKey = keys[2 + i * 2];
          const owner = args[3 + i];
          if (kvState.values.get(idxKey) === owner) kvState.values.delete(idxKey);
          kvState.values.delete(detailKey);
        }
        const identitiesKey = keys[1 + n * 2];
        const userKey = keys[2 + n * 2];
        kvState.values.delete(identitiesKey);
        kvState.sets.delete(identitiesKey);
        kvState.values.delete(userKey);
        return 'OK';
      }
      throw new Error(`unexpected fenced eval: ${script}`);
    }
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      if (kvState.values.get(keys[0]) === args[0]) {
        kvState.values.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    if (script.includes('-- ACCOUNT_SYNC_DELETE_BEGIN')) {
      kvState.values.set(keys[0], args[0]);
      return 'OK';
    }
    if (!script.includes('-- ACCOUNT_SYNC_SAVE')) throw new Error(`unexpected eval: ${script}`);
    if (kvState.beforeSyncSaveEval) await kvState.beforeSyncSaveEval();
    const [syncKey, idemKey, idemIndexKey] = keys;
    const [baseRevisionRaw, nextRaw] = args;
    if (kvState.values.has(keys[3])) return ['DELETED', '0', ''];
    const currentRaw = kvState.values.get(syncKey);
    const currentRevision = currentRaw ? JSON.parse(currentRaw).revision : 0;
    const idemRaw = kvState.values.get(idemKey);
    if (idemRaw) return ['IDEMPOTENT', String(currentRevision), idemRaw];
    if (currentRevision !== Number(baseRevisionRaw)) {
      return ['CONFLICT', String(currentRevision), currentRaw || ''];
    }
    kvState.values.set(syncKey, nextRaw);
    kvState.values.set(idemKey, nextRaw);
    await kv.sadd(idemIndexKey, idemKey);
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
  'api/_lib/apple-auth.ts',
  'api/_lib/apple-token-store.ts',
  'api/auth/[action].ts',
  'api/auth/delete-account.ts',
]) compileTs(rel);

const { issueSession } = require(path.join(outDir, 'api/_lib/session.js'));
const nodeHandler = require(path.join(outDir, 'api/auth/[action].js')).default;
const deleteAccountHandler = require(path.join(outDir, 'api/auth/delete-account.js')).default;
const syncStore = require(path.join(outDir, 'api/_lib/account-sync-store.js'));
const identityStore = require(path.join(outDir, 'api/_lib/identity-store.js'));

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

async function requestDeleteAccount(token) {
  const res = buildNodeRes();
  await deleteAccountHandler({
    method: 'POST',
    url: '/api/auth/delete-account',
    headers: {
      host: 'example.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: {},
  }, res);
  const text = res._body;
  return { status: res._status, body: text ? JSON.parse(text) : null };
}

async function createSession(subject) {
  const { user } = await identityStore.loginOrCreate({ provider: 'google', subject, email: `${subject}@example.test` });
  return { user, session: issueSession(user.internalId) };
}

async function testUnauthorizedFailsClosed() {
  resetKv(); configureBackend();
  const res = await request('GET');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_TOKEN');
}

async function testSnapshotRoundTripBySessionUser() {
  resetKv(); configureBackend();
  const { user, session } = await createSession('sync-user-a');
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
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), true);
}

async function testOptimisticConflictAndIdempotentReplay() {
  resetKv(); configureBackend();
  const { session } = await createSession('sync-user-b');
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
  const { session } = await createSession('sync-user-c');
  const res = await request('POST', { baseRevision: 0, idempotencyKey: 'idem-0004', patch: { collection: { 'bad-key': 1 } } }, session);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_request');
}

function validDeckCard(overrides = {}) {
  return {
    id: 'card-1',
    cardNumber: 'hBP01-001',
    name: 'Test Card',
    printing: 'BASE',
    printingLabel: 'BASE',
    series: 'hBP01',
    ...overrides,
  };
}

function validDeck(overrides = {}) {
  return {
    id: 'deck-1',
    name: 'Deck One',
    oshi: [{ card: validDeckCard({ id: 'oshi-1', cardNumber: 'hBP01-999' }), qty: 1 }],
    main: [{ card: validDeckCard(), qty: 4 }],
    yell: [{ card: validDeckCard({ id: 'yell-1', cardNumber: 'hY01-001' }), qty: 5 }],
    updatedAt: '2026-08-24T00:00:00Z',
    ...overrides,
  };
}

function validPriceAlert(overrides = {}) {
  return {
    cardNumber: 'hBP01-001',
    printing: 'BASE',
    printingLabel: 'BASE',
    name: 'Test Card',
    currency: 'JPY',
    lowerPrice: 100,
    upperPrice: 500,
    createdAt: '2026-08-24T00:00:00Z',
    updatedAt: '2026-08-24T00:00:00Z',
    ...overrides,
  };
}

async function assertMalformedRejected(scenario, patch) {
  resetKv(); configureBackend();
  const { user, session } = await createSession(scenario);
  // Seed a real prior snapshot so we can prove the malformed POST changes nothing.
  const seedIdem = `${scenario}-seed`;
  const seed = await request('POST', {
    baseRevision: 0,
    idempotencyKey: seedIdem,
    patch: { settings: { preferredCurrency: 'JPY' } },
  }, session);
  assert.equal(seed.status, 200, `${scenario}: seed request must succeed`);
  const beforeSnapshot = kvState.values.get(`account-sync:user:${user.internalId}`);
  const beforeIdem = kvState.values.get(`account-sync:idempotency:${user.internalId}:${seedIdem}`);
  const beforeIndex = kvState.sets.get(`account-sync:idempotency-index:${user.internalId}`);
  const beforeRevision = JSON.parse(beforeSnapshot).revision;

  const attackIdem = `${scenario}-attack`;
  const res = await request('POST', {
    baseRevision: beforeRevision,
    idempotencyKey: attackIdem,
    patch,
  }, session);
  assert.equal(res.status, 400, `${scenario}: malformed payload must be rejected 400`);
  assert.equal(res.body.error, 'invalid_request', `${scenario}: error must be invalid_request`);

  const afterSnapshot = kvState.values.get(`account-sync:user:${user.internalId}`);
  const afterIndex = kvState.sets.get(`account-sync:idempotency-index:${user.internalId}`);
  assert.equal(afterSnapshot, beforeSnapshot, `${scenario}: snapshot must be unchanged`);
  assert.equal(JSON.parse(afterSnapshot).revision, beforeRevision, `${scenario}: revision must be unchanged`);
  assert.equal(
    kvState.values.get(`account-sync:idempotency:${user.internalId}:${seedIdem}`),
    beforeIdem,
    `${scenario}: seed idempotency snapshot must be untouched`,
  );
  assert.equal(
    kvState.values.has(`account-sync:idempotency:${user.internalId}:${attackIdem}`),
    false,
    `${scenario}: malformed request must not create idempotency key`,
  );
  assert.deepEqual(afterIndex, beforeIndex, `${scenario}: idempotency index must be unchanged`);
}

async function testMalformedDeckRejectedAtRealHandler() {
  const cases = [
    ['deck-not-object', { decks: ['not-an-object'] }],
    ['deck-missing-id', { decks: [validDeck({ id: undefined })] }],
    ['deck-empty-id', { decks: [validDeck({ id: '   ' })] }],
    ['deck-missing-oshi', { decks: [validDeck({ oshi: undefined })] }],
    ['deck-oshi-not-array', { decks: [validDeck({ oshi: {} })] }],
    ['deck-slot-not-object', { decks: [validDeck({ main: ['bad-slot'] })] }],
    ['deck-slot-missing-card', { decks: [validDeck({ main: [{ qty: 4 }] })] }],
    ['deck-slot-qty-not-integer', { decks: [validDeck({ main: [{ card: validDeckCard(), qty: 2.5 }] })] }],
    ['deck-slot-qty-zero', { decks: [validDeck({ main: [{ card: validDeckCard(), qty: 0 }] })] }],
    ['deck-slot-qty-negative', { decks: [validDeck({ main: [{ card: validDeckCard(), qty: -1 }] })] }],
    ['deck-slot-qty-over-max', { decks: [validDeck({ main: [{ card: validDeckCard(), qty: 501 }] })] }],
    ['deck-card-missing-cardNumber', { decks: [validDeck({ main: [{ card: validDeckCard({ cardNumber: undefined }), qty: 1 }] })] }],
    ['deck-card-missing-printing', { decks: [validDeck({ main: [{ card: validDeckCard({ printing: undefined }), qty: 1 }] })] }],
    ['deck-card-printing-not-string', { decks: [validDeck({ main: [{ card: validDeckCard({ printing: 42 }), qty: 1 }] })] }],
    ['deck-card-boolean-field-not-boolean', { decks: [validDeck({ main: [{ card: validDeckCard({ unresolvedPrinting: 'yes' }), qty: 1 }] })] }],
    ['deck-missing-updatedAt', { decks: [validDeck({ updatedAt: undefined })] }],
    ['deck-updatedAt-not-iso', { decks: [validDeck({ updatedAt: 'not-a-timestamp' })] }],
    ['deck-origin-wrong-kind', { decks: [validDeck({ origin: { kind: 'made-up', eventId: 'e', eventName: 'e', sourceDeckId: 's', decklogCode: null, sourceUrl: 'https://x', importedAt: '2026-08-24T00:00:00Z' } })] }],
    ['deck-origin-decklogCode-not-string-or-null', { decks: [validDeck({ origin: { kind: 'tournament', eventId: 'e', eventName: 'e', sourceDeckId: 's', decklogCode: 42, sourceUrl: 'https://x', importedAt: '2026-08-24T00:00:00Z' } })] }],
    ['deck-origin-importedAt-not-iso', { decks: [validDeck({ origin: { kind: 'tournament', eventId: 'e', eventName: 'e', sourceDeckId: 's', decklogCode: null, sourceUrl: 'https://x', importedAt: 'nope' } })] }],
  ];
  for (const [scenario, patch] of cases) {
    await assertMalformedRejected(`deck-user-${scenario}`, patch);
  }
}

async function testMalformedPriceAlertRejectedAtRealHandler() {
  const cases = [
    ['alert-not-object', { priceAlerts: ['nope'] }],
    ['alert-missing-cardNumber', { priceAlerts: [validPriceAlert({ cardNumber: undefined })] }],
    ['alert-empty-printing', { priceAlerts: [validPriceAlert({ printing: '  ' })] }],
    ['alert-printingLabel-not-string', { priceAlerts: [validPriceAlert({ printingLabel: 42 })] }],
    ['alert-name-missing', { priceAlerts: [validPriceAlert({ name: undefined })] }],
    ['alert-currency-invalid-enum', { priceAlerts: [validPriceAlert({ currency: 'EUR' })] }],
    ['alert-currency-not-string', { priceAlerts: [validPriceAlert({ currency: 123 })] }],
    ['alert-upperPrice-missing', { priceAlerts: [validPriceAlert({ upperPrice: null })] }],
    ['alert-upperPrice-not-integer', { priceAlerts: [validPriceAlert({ upperPrice: 500.5 })] }],
    ['alert-upperPrice-negative', { priceAlerts: [validPriceAlert({ upperPrice: -1 })] }],
    ['alert-upperPrice-over-max', { priceAlerts: [validPriceAlert({ upperPrice: 200_000_000 })] }],
    ['alert-lowerPrice-not-integer', { priceAlerts: [validPriceAlert({ lowerPrice: 'cheap' })] }],
    ['alert-lowerPrice-negative', { priceAlerts: [validPriceAlert({ lowerPrice: -10 })] }],
    ['alert-lower-above-upper', { priceAlerts: [validPriceAlert({ lowerPrice: 600, upperPrice: 500 })] }],
    ['alert-createdAt-not-iso', { priceAlerts: [validPriceAlert({ createdAt: 'not-a-timestamp' })] }],
    ['alert-updatedAt-missing', { priceAlerts: [validPriceAlert({ updatedAt: undefined })] }],
  ];
  for (const [scenario, patch] of cases) {
    await assertMalformedRejected(`alert-user-${scenario}`, patch);
  }
}

async function testCollectionQtyCoercionRejectedAtRealHandler() {
  const cases = [
    ['qty-fractional-truncation', { collection: { 'hBP01-001|BASE': 1.9 } }],
    ['qty-string-numeric', { collection: { 'hBP01-001|BASE': '7' } }],
    ['qty-string-empty', { collection: { 'hBP01-001|BASE': '' } }],
    ['qty-null', { collection: { 'hBP01-001|BASE': null } }],
    ['qty-bool-false', { collection: { 'hBP01-001|BASE': false } }],
    ['qty-bool-true', { collection: { 'hBP01-001|BASE': true } }],
    ['qty-unsafe-magnitude', { collection: { 'hBP01-001|BASE': 1e308 } }],
    ['qty-nan', { collection: { 'hBP01-001|BASE': Number.NaN } }],
    ['qty-negative', { collection: { 'hBP01-001|BASE': -5 } }],
    ['qty-over-max', { collection: { 'hBP01-001|BASE': 100_001 } }],
  ];
  for (const [scenario, patch] of cases) {
    await assertMalformedRejected(`collection-user-${scenario}`, patch);
  }
}

async function assertMalformedBaseRevisionRejected(scenario, baseRevisionValue) {
  resetKv(); configureBackend();
  const { user, session } = await createSession(`baseRev-user-${scenario}`);
  const seedIdem = `${scenario}-seed`;
  const seed = await request('POST', {
    baseRevision: 0,
    idempotencyKey: seedIdem,
    patch: { settings: { preferredCurrency: 'JPY' } },
  }, session);
  assert.equal(seed.status, 200, `${scenario}: seed request must succeed`);
  const beforeSnapshot = kvState.values.get(`account-sync:user:${user.internalId}`);
  const beforeIndex = kvState.sets.get(`account-sync:idempotency-index:${user.internalId}`);
  const beforeRevision = JSON.parse(beforeSnapshot).revision;
  assert.equal(beforeRevision, 1, `${scenario}: seed must land at revision 1`);

  const attackIdem = `${scenario}-attack`;
  const res = await request('POST', {
    baseRevision: baseRevisionValue,
    idempotencyKey: attackIdem,
    patch: { settings: { preferredCurrency: 'USD' } },
  }, session);
  assert.equal(res.status, 400, `${scenario}: coerced baseRevision must be rejected`);
  assert.equal(res.body.error, 'invalid_request', `${scenario}: error must be invalid_request`);

  const afterSnapshot = kvState.values.get(`account-sync:user:${user.internalId}`);
  const afterIndex = kvState.sets.get(`account-sync:idempotency-index:${user.internalId}`);
  assert.equal(afterSnapshot, beforeSnapshot, `${scenario}: snapshot must be unchanged`);
  assert.equal(JSON.parse(afterSnapshot).revision, beforeRevision, `${scenario}: revision must be unchanged`);
  assert.equal(
    kvState.values.has(`account-sync:idempotency:${user.internalId}:${attackIdem}`),
    false,
    `${scenario}: malformed baseRevision must not create idempotency key`,
  );
  assert.deepEqual(afterIndex, beforeIndex, `${scenario}: idempotency index must be unchanged`);
}

async function testBaseRevisionCoercionRejectedAtRealHandler() {
  const cases = [
    ['null', null],
    ['bool-false', false],
    ['bool-true', true],
    ['string-empty', ''],
    ['string-numeric', '3'],
    ['string-non-numeric', 'zero'],
    ['fractional', 1.5],
    ['negative', -1],
    ['unsafe-magnitude', Number.MAX_SAFE_INTEGER + 2],
    ['nan', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['object', { valueOf: () => 0 }],
    ['array', [0]],
  ];
  for (const [scenario, value] of cases) {
    await assertMalformedBaseRevisionRejected(scenario, value);
  }
}

async function testWellFormedDeckAndAlertAccepted() {
  resetKv(); configureBackend();
  const { user, session } = await createSession('sync-user-happy-path');
  const res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-happy',
    patch: {
      decks: [validDeck()],
      priceAlerts: [validPriceAlert(), validPriceAlert({ lowerPrice: null, upperPrice: 1000, printing: 'PARALLEL' })],
    },
  }, session);
  assert.equal(res.status, 200, 'well-formed payload must succeed');
  assert.equal(res.body.snapshot.revision, 1);
  assert.equal(res.body.snapshot.decks.length, 1);
  assert.equal(res.body.snapshot.decks[0].main.length, 1);
  assert.equal(res.body.snapshot.decks[0].main[0].qty, 4);
  assert.equal(res.body.snapshot.priceAlerts.length, 2);
  assert.equal(res.body.snapshot.priceAlerts[1].lowerPrice, null);
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), true);
}

async function testAccountDeleteCascadeHook() {
  resetKv(); configureBackend();
  kvState.values.set('account-sync:user:holo_user_d', JSON.stringify({ revision: 1 }));
  kvState.values.set('account-sync:idempotency:holo_user_d:idem-old-0001', JSON.stringify({ revision: 1, settings: { preferredCurrency: 'JPY' } }));
  kvState.values.set('account-sync:idempotency:holo_user_d:idem-old-0002', JSON.stringify({ revision: 1, settings: { preferredCurrency: 'USD' } }));
  kvState.sets.set('account-sync:idempotency-index:holo_user_d', new Set([
    'account-sync:idempotency:holo_user_d:idem-old-0001',
  ]));
  await syncStore.deleteAccountSyncData('holo_user_d');
  assert.equal(kvState.values.has('account-sync:deleted:holo_user_d'), true, 'delete must install server-side commit fence first');
  assert.equal(kvState.values.has('account-sync:user:holo_user_d'), false);
  assert.equal(kvState.values.has('account-sync:idempotency:holo_user_d:idem-old-0001'), false);
  assert.equal(kvState.values.has('account-sync:idempotency:holo_user_d:idem-old-0002'), false);
  assert.equal(kvState.sets.has('account-sync:idempotency-index:holo_user_d'), false);
  assert.deepEqual(kvState.dels, [
    'account-sync:user:holo_user_d',
    'account-sync:idempotency:holo_user_d:idem-old-0001',
    'account-sync:idempotency:holo_user_d:idem-old-0002',
    'account-sync:idempotency-index:holo_user_d',
  ]);
}

async function testAuthorizedSyncCannotCommitAfterDeletionFence() {
  resetKv(); configureBackend();
  const { user, session } = await createSession('sync-delete-race');
  const { user: otherUser, session: otherSession } = await createSession('sync-delete-race-other');

  let armed = true;
  kvState.beforeSyncSaveEval = async () => {
    if (!armed) return;
    armed = false;
    const delRes = await requestDeleteAccount(session);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);
  };

  let res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-race-0001',
    patch: { settings: { preferredCurrency: 'JPY' } },
  }, session);
  kvState.beforeSyncSaveEval = null;
  assert.equal(res.status, 410, 'already-authorized sync commit must fail after deletion fence');
  assert.equal(res.body.error, 'account_deleted');
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), false, 'deleted user snapshot must not be recreated after delete 200');
  assert.equal(kvState.values.has(`account-sync:idempotency:${user.internalId}:idem-race-0001`), false, 'blocked commit must not create idempotency snapshot');
  assert.equal(kvState.sets.has(`account-sync:idempotency-index:${user.internalId}`), false, 'blocked commit must not create idempotency index');

  res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-race-0001',
    patch: { settings: { preferredCurrency: 'JPY' } },
  }, session);
  assert.equal(res.status, 401, 'retry after account deletion remains fail-closed through active-user check');
  assert.equal(res.body.error, 'USER_NOT_FOUND');

  res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-other-0001',
    patch: { settings: { preferredCurrency: 'USD' } },
  }, otherSession);
  assert.equal(res.status, 200, 'another user remains unaffected by deletion fence');
  assert.equal(kvState.values.has(`account-sync:user:${otherUser.internalId}`), true);
}

async function testDeletedAccountTokenCannotReadWriteOrRecreateSyncData() {
  resetKv(); configureBackend();
  const { user, session } = await createSession('sync-user-deleted');

  let res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-delete-0001',
    patch: { settings: { preferredCurrency: 'JPY' } },
  }, session);
  assert.equal(res.status, 200);
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), true);
  assert.equal(kvState.values.has(`account-sync:idempotency:${user.internalId}:idem-delete-0001`), true);
  assert.deepEqual(kvState.sets.get(`account-sync:idempotency-index:${user.internalId}`), new Set([
    `account-sync:idempotency:${user.internalId}:idem-delete-0001`,
  ]));

  res = await requestDeleteAccount(session);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);

  assert.equal(kvState.values.has(`account-sync:idempotency:${user.internalId}:idem-delete-0001`), false, 'account deletion must remove pre-existing idempotency snapshots');
  assert.equal(kvState.sets.has(`account-sync:idempotency-index:${user.internalId}`), false, 'account deletion must remove idempotency index');

  res = await request('GET', undefined, session);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'USER_NOT_FOUND');
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), false, 'stale token must not read or recreate sync data on GET');

  res = await request('POST', {
    baseRevision: 0,
    idempotencyKey: 'idem-delete-0002',
    patch: { settings: { preferredCurrency: 'USD' } },
  }, session);
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'USER_NOT_FOUND');
  assert.equal(kvState.values.has(`account-sync:user:${user.internalId}`), false, 'stale token must not write or recreate sync data on POST');
  assert.equal(kvState.values.has(`account-sync:idempotency:${user.internalId}:idem-delete-0002`), false, 'stale token must not create idempotency data');
}

(async () => {
  await testUnauthorizedFailsClosed();
  await testSnapshotRoundTripBySessionUser();
  await testOptimisticConflictAndIdempotentReplay();
  await testValidationRejectsBadCollection();
  await testMalformedDeckRejectedAtRealHandler();
  await testMalformedPriceAlertRejectedAtRealHandler();
  await testCollectionQtyCoercionRejectedAtRealHandler();
  await testBaseRevisionCoercionRejectedAtRealHandler();
  await testWellFormedDeckAndAlertAccepted();
  await testAccountDeleteCascadeHook();
  await testAuthorizedSyncCannotCommitAfterDeletionFence();
  await testDeletedAccountTokenCannotReadWriteOrRecreateSyncData();
  console.log('account sync backend tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
