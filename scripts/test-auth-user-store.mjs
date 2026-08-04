/**
 * test-auth-user-store.mjs — DIC-665
 *
 * 驗證 (provider, sub) 為身份鍵的 login-or-create（api/_lib/user-store.ts），以純記憶體
 * 假 KV 離線驗證：
 *   - 新使用者建立、internal id 由後端產生（非 client mint）。
 *   - returning user（同一 sub）→ 對應同一 internal id（比對 sub，非 email）。
 *   - provider email 變更（同一 sub）→ 仍同一 user，不造成錯誤歸戶。
 *   - 不同 sub → 不同 user。
 *   - 併發登入（NX 佔用）→ 同一 (provider, sub) 只產生一個 user。
 *
 * Run: node --experimental-strip-types scripts/test-auth-user-store.mjs
 */
import assert from 'node:assert/strict';
import { resolveOrCreateUser } from '../api/_lib/user-store.ts';

/** 最小記憶體 KVLike：get / set（含 nx）。 */
function makeKv() {
  const map = new Map();
  return {
    store: map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value, opts) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, structuredClone(value));
      return 'OK';
    },
  };
}

let counter = 0;
const deps = (kv) => ({
  kv,
  now: () => 1_700_000_000_000,
  newId: () => `internal-${++counter}`,
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('user-store login-or-create (DIC-665)');

await check('new user → created with backend-generated internal id', async () => {
  counter = 0;
  const kv = makeKv();
  const { user, isNewUser } = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-abc',
    email: 'a@example.com',
    name: 'Alice',
    photoUrl: null,
  });
  assert.equal(isNewUser, true);
  assert.equal(user.internalId, 'internal-1');
  assert.equal(user.linkedProviders[0].provider, 'google');
  assert.equal(user.linkedProviders[0].providerId, 'sub-abc');
});

await check('returning user (same sub) → same internal id, not new', async () => {
  counter = 0;
  const kv = makeKv();
  const first = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-abc', email: 'a@example.com', name: 'Alice', photoUrl: null,
  });
  const second = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-abc', email: 'a@example.com', name: 'Alice', photoUrl: null,
  });
  assert.equal(second.isNewUser, false);
  assert.equal(second.user.internalId, first.user.internalId);
});

await check('same sub, CHANGED email → still same user (email is not the identity key)', async () => {
  counter = 0;
  const kv = makeKv();
  const first = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-abc', email: 'old@example.com', name: 'Alice', photoUrl: null,
  });
  const second = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-abc', email: 'new@example.com', name: 'Alice', photoUrl: null,
  });
  assert.equal(second.isNewUser, false);
  assert.equal(second.user.internalId, first.user.internalId);
  assert.equal(second.user.linkedProviders[0].email, 'new@example.com');
});

await check('different sub, SAME email → different users (email never merges identities)', async () => {
  counter = 0;
  const kv = makeKv();
  const a = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-1', email: 'shared@example.com', name: 'A', photoUrl: null,
  });
  const b = await resolveOrCreateUser(deps(kv), 'google', {
    subject: 'sub-2', email: 'shared@example.com', name: 'B', photoUrl: null,
  });
  assert.notEqual(a.user.internalId, b.user.internalId);
  assert.equal(b.isNewUser, true);
});

await check('concurrent first login (NX reservation) → single user for one (provider, sub)', async () => {
  counter = 0;
  const kv = makeKv();
  const profile = { subject: 'sub-race', email: 'r@example.com', name: 'R', photoUrl: null };
  const [r1, r2] = await Promise.all([
    resolveOrCreateUser(deps(kv), 'google', profile),
    resolveOrCreateUser(deps(kv), 'google', profile),
  ]);
  assert.equal(r1.user.internalId, r2.user.internalId);
  // 只有一筆 isNewUser=true，另一筆走既有身份。
  assert.equal([r1.isNewUser, r2.isNewUser].filter(Boolean).length, 1);
});

console.log(`\n${passed} checks passed.`);
