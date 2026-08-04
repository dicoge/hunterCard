/**
 * test-auth-replay-guard.mjs — DIC-665
 *
 * 驗證已驗證 id_token 的一次性消費（api/_lib/replay-guard.ts），以純記憶體假 KV
 * （SET NX + TTL 語意）離線驗證反重放合約：
 *   - 首次消費同一 token → true（放行）。
 *   - 同一 token 再次消費（重放）→ false（拒絕）。
 *   - 不同 token → 各自首次消費為 true（互不影響）。
 *   - TTL 綁 token 剩餘壽命，並夾在 [1, REPLAY_TTL_CAP_SEC]。
 *   - 空 / 非字串 token → false（fail-closed）。
 *
 * Run: node --experimental-strip-types scripts/test-auth-replay-guard.mjs
 */
import assert from 'node:assert/strict';
import {
  reserveIdTokenOnce,
  fingerprintIdToken,
  REPLAY_TTL_CAP_SEC,
} from '../api/_lib/replay-guard.ts';

/** 記憶體 KV，實作 SET NX + 記錄每鍵 TTL。 */
function makeKv() {
  const map = new Map();
  const ttls = new Map();
  return {
    ttls,
    async set(key, value, opts) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, value);
      if (opts?.ex != null) ttls.set(key, opts.ex);
      return 'OK';
    },
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('replay-guard one-time id_token consumption (DIC-665)');

await check('first consume → true, replay → false', async () => {
  const kv = makeKv();
  const deps = { kv, now: () => 1_700_000_000_000 };
  const first = await reserveIdTokenOnce(deps, 'token-A', 3600);
  const replay = await reserveIdTokenOnce(deps, 'token-A', 3600);
  assert.equal(first, true);
  assert.equal(replay, false);
});

await check('distinct tokens are independent', async () => {
  const kv = makeKv();
  const deps = { kv };
  assert.equal(await reserveIdTokenOnce(deps, 'token-A', 3600), true);
  assert.equal(await reserveIdTokenOnce(deps, 'token-B', 3600), true);
});

await check('key is the SHA-256 fingerprint, TTL bound to remaining lifetime', async () => {
  const kv = makeKv();
  await reserveIdTokenOnce({ kv }, 'token-C', 1800);
  const key = `auth:used_idtoken:${fingerprintIdToken('token-C')}`;
  assert.equal(kv.ttls.get(key), 1800);
});

await check('TTL clamped to >= 1 (non-positive remaining lifetime)', async () => {
  const kv = makeKv();
  await reserveIdTokenOnce({ kv }, 'token-D', -10);
  const key = `auth:used_idtoken:${fingerprintIdToken('token-D')}`;
  assert.equal(kv.ttls.get(key), 1);
});

await check('TTL clamped to REPLAY_TTL_CAP_SEC', async () => {
  const kv = makeKv();
  await reserveIdTokenOnce({ kv }, 'token-E', REPLAY_TTL_CAP_SEC * 10);
  const key = `auth:used_idtoken:${fingerprintIdToken('token-E')}`;
  assert.equal(kv.ttls.get(key), REPLAY_TTL_CAP_SEC);
});

await check('empty / non-string token → false (fail-closed)', async () => {
  const kv = makeKv();
  assert.equal(await reserveIdTokenOnce({ kv }, '', 3600), false);
  assert.equal(await reserveIdTokenOnce({ kv }, null, 3600), false);
});

console.log(`\n${passed} checks passed.`);
