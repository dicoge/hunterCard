/**
 * test-auth-nonce-store.mjs — DIC-665 CR
 *
 * 驗證 server-bound 一次性 nonce 挑戰 / 消費（api/_lib/nonce-store.ts）的 fail-closed 契約，
 * 以純記憶體假 KV（SET NX+TTL / 原子 GETDEL）離線驗證：
 *   - issueNonce 以 NX + TTL 寫入 auth:nonce:{nonce} 並回傳原文
 *   - consumeNonce 首次消費存在的 nonce → true（GETDEL 刪除）
 *   - 同一 nonce 二次消費（重放）→ false
 *   - 不存在 / 偽造的 nonce → false
 *   - 過期（TTL 到期，模擬 KV 移除）→ false
 *   - 空字串 / null / undefined → false，不打 KV
 *
 * Run: node --experimental-strip-types scripts/test-auth-nonce-store.mjs
 */
import assert from 'node:assert/strict';
import { issueNonce, consumeNonce, NONCE_TTL_SEC } from '../api/_lib/nonce-store.ts';

// 記憶體假 KV：記錄每次 set 的 opts，GETDEL 原子取出並刪除。
function makeKV() {
  const store = new Map();
  const setCalls = [];
  const getdelKeys = [];
  return {
    store,
    setCalls,
    getdelKeys,
    async set(key, value, opts) {
      setCalls.push({ key, value, opts });
      if (opts?.nx && store.has(key)) return null; // NX：已存在則不覆寫
      store.set(key, value);
      return 'OK';
    },
    async getdel(key) {
      getdelKeys.push(key);
      if (!store.has(key)) return null;
      const v = store.get(key);
      store.delete(key);
      return v;
    },
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('nonce store contract (DIC-665 CR)');

await check('issueNonce writes auth:nonce:{nonce} with NX + TTL and returns the nonce', async () => {
  const kv = makeKV();
  const nonce = await issueNonce({ kv, randomNonce: () => 'fixed-nonce' });
  assert.equal(nonce, 'fixed-nonce');
  assert.equal(kv.setCalls.length, 1);
  const call = kv.setCalls[0];
  assert.equal(call.key, 'auth:nonce:fixed-nonce');
  assert.equal(call.opts.nx, true);
  assert.equal(call.opts.ex, NONCE_TTL_SEC);
  assert.ok(kv.store.has('auth:nonce:fixed-nonce'));
});

await check('issueNonce honours injected ttlSec', async () => {
  const kv = makeKV();
  await issueNonce({ kv, randomNonce: () => 'n', ttlSec: 42 });
  assert.equal(kv.setCalls[0].opts.ex, 42);
});

await check('first consume of an issued nonce → true (atomically deleted)', async () => {
  const kv = makeKV();
  const nonce = await issueNonce({ kv, randomNonce: () => 'once' });
  const ok = await consumeNonce({ kv }, nonce);
  assert.equal(ok, true);
  assert.equal(kv.store.has('auth:nonce:once'), false);
});

await check('second consume of the same nonce (replay) → false', async () => {
  const kv = makeKV();
  const nonce = await issueNonce({ kv, randomNonce: () => 'replay' });
  assert.equal(await consumeNonce({ kv }, nonce), true);
  assert.equal(await consumeNonce({ kv }, nonce), false);
});

await check('unknown / forged nonce → false', async () => {
  const kv = makeKV();
  assert.equal(await consumeNonce({ kv }, 'never-issued'), false);
});

await check('expired nonce (TTL evicted from KV) → false', async () => {
  const kv = makeKV();
  const nonce = await issueNonce({ kv, randomNonce: () => 'expired' });
  kv.store.delete('auth:nonce:expired'); // 模擬 TTL 到期後 KV 自動移除
  assert.equal(await consumeNonce({ kv }, nonce), false);
});

await check('empty string / null / undefined → false without touching KV', async () => {
  const kv = makeKV();
  assert.equal(await consumeNonce({ kv }, ''), false);
  assert.equal(await consumeNonce({ kv }, null), false);
  assert.equal(await consumeNonce({ kv }, undefined), false);
  assert.equal(kv.getdelKeys.length, 0);
});

console.log(`\n${passed} checks passed.`);
