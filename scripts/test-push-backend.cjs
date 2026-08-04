#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-backend-tests-'));

const kvState = {
  hashes: new Map(),
  sets: new Map(),
  evalCalls: [],
};

function resetKv() {
  kvState.hashes.clear();
  kvState.sets.clear();
  kvState.evalCalls.length = 0;
}

function setFor(key) {
  if (!kvState.sets.has(key)) kvState.sets.set(key, new Set());
  return kvState.sets.get(key);
}

function hashFor(key) {
  if (!kvState.hashes.has(key)) kvState.hashes.set(key, new Map());
  return kvState.hashes.get(key);
}

const kv = {
  async hget(key, field) {
    return hashFor(key).get(field) ?? null;
  },
  async hset(key, patch) {
    const hash = hashFor(key);
    for (const [field, value] of Object.entries(patch)) hash.set(field, value);
    return Object.keys(patch).length;
  },
  async hmget(key, ...fields) {
    const hash = hashFor(key);
    const result = {};
    for (const field of fields) {
      const value = hash.get(field);
      if (value !== undefined) result[field] = value;
    }
    return result;
  },
  async sadd(key, ...members) {
    const set = setFor(key);
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added += 1;
      set.add(member);
    }
    return added;
  },
  async srem(key, ...members) {
    const set = setFor(key);
    let removed = 0;
    for (const member of members) if (set.delete(member)) removed += 1;
    if (set.size === 0) kvState.sets.delete(key);
    return removed;
  },
  async smembers(key) {
    return [...(kvState.sets.get(key) ?? new Set())];
  },
  async eval(script, keys, args) {
    kvState.evalCalls.push({ script, keys, args });
    if (script.includes("redis.call('SREM', KEYS[1], ARGV[1])")) {
      const [setKey, registryKey] = keys;
      const [cardNumber, token] = args;
      await kv.srem(setKey, cardNumber);
      const remaining = kvState.sets.get(setKey)?.size ?? 0;
      if (remaining === 0) await kv.srem(registryKey, token);
      return remaining;
    }
    throw new Error(`Unexpected eval script: ${script}`);
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@vercel/kv') return { kv };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(input, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

for (const rel of ['api/_lib/kv-storage.ts', 'api/push/register.ts', 'api/push/watchlist.ts', 'api/push/notify.ts']) compileTs(rel);

const register = require(path.join(outDir, 'api/push/register.js')).default;
const watchlist = require(path.join(outDir, 'api/push/watchlist.js')).default;
const notify = require(path.join(outDir, 'api/push/notify.js')).default;
const storage = require(path.join(outDir, 'api/_lib/kv-storage.js'));

function req(method, body, headers = {}) {
  return new Request('https://example.test', {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

async function testNotifyAuthFailClosed() {
  resetKv();
  delete process.env.PUSH_NOTIFY_SECRET;
  let res = await json(await notify(req('POST', { alerts: [] })));
  assert.equal(res.status, 401, 'notify must reject when PUSH_NOTIFY_SECRET is unset');

  process.env.PUSH_NOTIFY_SECRET = 'top-secret';
  res = await json(await notify(req('POST', { alerts: [] })));
  assert.equal(res.status, 401, 'notify must reject missing X-Internal-Secret');

  res = await json(await notify(req('POST', { alerts: [] }, { 'X-Internal-Secret': 'wrong' })));
  assert.equal(res.status, 401, 'notify must reject wrong X-Internal-Secret');
}

async function testPushTokenStoredInKv() {
  resetKv();
  const token = 'ExponentPushToken[token-a]';
  const res = await json(await register(req('POST', { token, platform: 'ios' })));
  assert.equal(res.status, 200);
  assert.equal(kvState.hashes.get('push:tokens').get(token).token, token);
  assert.equal(kvState.hashes.get('push:tokens').get(token).platform, 'ios');
}

async function testWatchlistAtomicAddRemoveAndRegistryEnumeration() {
  resetKv();
  const token = 'ExpoPushToken[token-a]';
  await Promise.all(['hBP01-001', 'hBP01-002', 'hBP01-003'].map((cardNumber) =>
    watchlist(req('POST', { token, cardNumber, action: 'add' })),
  ));
  assert.deepEqual(await storage.getWatchlistForToken(token), ['hBP01-001', 'hBP01-002', 'hBP01-003']);
  assert.deepEqual(await storage.getWatchlist(), { [token]: ['hBP01-001', 'hBP01-002', 'hBP01-003'] });

  await Promise.all(['hBP01-001', 'hBP01-003'].map((cardNumber) =>
    watchlist(req('POST', { token, cardNumber, action: 'remove' })),
  ));
  assert.deepEqual(await storage.getWatchlistForToken(token), ['hBP01-002']);
  assert.deepEqual(await storage.getWatchlist(), { [token]: ['hBP01-002'] });
}

async function testRegistryCleanupDoesNotDropRepopulatedToken() {
  resetKv();
  await kv.sadd('push:watchlist-tokens', 'ExpoPushToken[active]', 'ExpoPushToken[empty]');
  await kv.sadd('push:watchlist:ExpoPushToken[active]', 'hBP01-009');

  assert.deepEqual(await storage.getWatchlist(), { 'ExpoPushToken[active]': ['hBP01-009'] });
  assert.equal(kvState.sets.get('push:watchlist-tokens').has('ExpoPushToken[empty]'), true, 'getWatchlist is read-only and leaves cleanup to remove');

  await storage.removeWatchlistCard('ExpoPushToken[active]', 'hBP01-009');
  assert.equal(kvState.sets.get('push:watchlist-tokens').has('ExpoPushToken[active]'), false, 'remove cleans registry only after the set is empty');
  assert.equal(kvState.evalCalls.length, 1, 'registry cleanup should use the atomic remove script');
}

async function testNotifyCooldownOnlyAfterExpoOkTicket() {
  resetKv();
  process.env.PUSH_NOTIFY_SECRET = 'top-secret';
  await kv.sadd('push:watchlist-tokens', 'ExponentPushToken[ok]', 'ExponentPushToken[fail]');
  await kv.sadd('push:watchlist:ExponentPushToken[ok]', 'hBP01-001');
  await kv.sadd('push:watchlist:ExponentPushToken[fail]', 'hBP01-001');

  let fetchCalls = 0;
  global.fetch = async (_url, options) => {
    fetchCalls += 1;
    const batch = JSON.parse(options.body);
    assert.equal(batch.length, fetchCalls === 1 ? 2 : 1);
    return new Response(JSON.stringify({
      data: batch.map((message) => message.to.includes('[ok]') ? { status: 'ok' } : { status: 'error', message: 'DeviceNotRegistered' }),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const alert = { cardNumber: 'hBP01-001', title: 'target price hit', body: 'price is moving' };
  let res = await json(await notify(req('POST', { alerts: [alert] }, { 'X-Internal-Secret': 'top-secret' })));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sent: 1, errors: 1, skipped: 0 });

  const cooldown = kvState.hashes.get('push:last-alert');
  assert.equal(cooldown.has('ExponentPushToken[ok]|hBP01-001'), true, 'ok ticket records cooldown');
  assert.equal(cooldown.has('ExponentPushToken[fail]|hBP01-001'), false, 'failed ticket must not record cooldown');

  res = await json(await notify(req('POST', { alerts: [alert] }, { 'X-Internal-Secret': 'top-secret' })));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sent: 0, errors: 1, skipped: 1 });
  assert.equal(fetchCalls, 2, 'second run should retry only the recipient without cooldown');
}

async function testNotifyBasicTargetPriceFlow() {
  resetKv();
  process.env.PUSH_NOTIFY_SECRET = 'top-secret';
  await kv.sadd('push:watchlist-tokens', 'ExpoPushToken[target]');
  await kv.sadd('push:watchlist:ExpoPushToken[target]', 'hBP07-029');

  let pushedBatch;
  global.fetch = async (_url, options) => {
    pushedBatch = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const alert = { cardNumber: 'hBP07-029', title: '入手時機！', body: 'target price reached' };
  const res = await json(await notify(req('POST', { alerts: [alert] }, { 'X-Internal-Secret': 'top-secret' })));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sent: 1, errors: 0, skipped: 0 });
  assert.deepEqual(pushedBatch, [{ to: 'ExpoPushToken[target]', title: alert.title, body: alert.body, data: { cardNumber: alert.cardNumber } }]);
}

(async () => {
  const tests = [
    testNotifyAuthFailClosed,
    testPushTokenStoredInKv,
    testWatchlistAtomicAddRemoveAndRegistryEnumeration,
    testRegistryCleanupDoesNotDropRepopulatedToken,
    testNotifyCooldownOnlyAfterExpoOkTicket,
    testNotifyBasicTargetPriceFlow,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} push backend tests passed`);
})().finally(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
  Module._load = originalLoad;
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
