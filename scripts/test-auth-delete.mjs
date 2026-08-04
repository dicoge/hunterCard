/**
 * test-auth-delete.mjs — DIC-665
 *
 * 驗證已驗證、伺服器權威的帳號刪除核心（api/_lib/delete-handler.ts）的 fail-closed 契約，
 * 以注入的假 verify / store 離線驗證各分支：
 *   - AUTH_SESSION_SECRET 未設定 → 501 SESSION_NOT_CONFIGURED（不驗、不刪）
 *   - 缺 Authorization / 非 Bearer → 401 MISSING_ACCESS_TOKEN
 *   - 無效 / 過期 token（verify throw）→ 401 INVALID_ACCESS_TOKEN，不刪
 *   - 非 access（refresh）token → 401，不刪
 *   - **不信任 client userId**：userId 一律取自驗過的 token.sub
 *   - google user → 直接刪 identity/user → 200 deleted
 *   - user 不存在 → idempotent 200 alreadyDeleted，不呼叫 deleteUser
 *   - apple user 且撤銷失敗 → fail-closed（回撤銷的 status/reason），不刪任何資料
 *   - apple user 且撤銷成功 → 刪資料 → 200
 *   - apple user 但未提供 revokeAppleForUser → 501，不刪
 *
 * Run: node --experimental-strip-types scripts/test-auth-delete.mjs
 */
import assert from 'node:assert/strict';
import { handleDeleteAccount } from '../api/_lib/delete-handler.ts';

function googleUser(id = 'u1') {
  return {
    internalId: id, displayName: 'A', primaryEmail: 'a@x.com', photoUrl: null,
    linkedProviders: [{ provider: 'google', providerId: 'sub-a', email: 'a@x.com', displayName: 'A', photoUrl: null, linkedAt: 'T' }],
    createdAt: 'T', lastLoginAt: 'T',
  };
}
function appleUser(id = 'u2') {
  return {
    internalId: id, displayName: 'B', primaryEmail: null, photoUrl: null,
    linkedProviders: [{ provider: 'apple', providerId: 'sub-b', email: null, displayName: 'B', photoUrl: null, linkedAt: 'T' }],
    createdAt: 'T', lastLoginAt: 'T',
  };
}

function baseDeps(overrides = {}) {
  return {
    sessionSecret: 'secret',
    verifyAccessToken: (token) => {
      if (token === 'good-access') return { sub: 'u1', type: 'access', iat: 1, exp: 9e12 };
      if (token === 'good-access-apple') return { sub: 'u2', type: 'access', iat: 1, exp: 9e12 };
      if (token === 'refresh-tok') return { sub: 'u1', type: 'refresh', iat: 1, exp: 9e12 };
      throw new Error('invalid');
    },
    getUser: async (id) => (id === 'u1' ? googleUser() : id === 'u2' ? appleUser() : null),
    deleteUser: async () => ({ existed: true, removedIdentities: 1 }),
    revokeAppleForUser: async () => ({ ok: true }),
    ...overrides,
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('delete-account handler contract (DIC-665)');

await check('session secret unset → 501 (no verify, no delete)', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access' },
    baseDeps({ sessionSecret: null, deleteUser: async () => { deleted = true; return { existed: true, removedIdentities: 1 }; } })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'SESSION_NOT_CONFIGURED');
  assert.equal(deleted, false);
});

await check('missing authorization → 401 MISSING_ACCESS_TOKEN', async () => {
  const r = await handleDeleteAccount({ authorization: null }, baseDeps());
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'MISSING_ACCESS_TOKEN');
});

await check('non-Bearer authorization → 401 MISSING_ACCESS_TOKEN', async () => {
  const r = await handleDeleteAccount({ authorization: 'Basic abc' }, baseDeps());
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'MISSING_ACCESS_TOKEN');
});

await check('invalid token → 401 INVALID_ACCESS_TOKEN (no delete)', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer nope' },
    baseDeps({ deleteUser: async () => { deleted = true; return { existed: true, removedIdentities: 1 }; } })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_ACCESS_TOKEN');
  assert.equal(deleted, false);
});

await check('refresh token rejected → 401 (only access may delete)', async () => {
  const r = await handleDeleteAccount({ authorization: 'Bearer refresh-tok' }, baseDeps());
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_ACCESS_TOKEN');
});

await check('userId comes from verified token.sub, not from client body', async () => {
  let seenId = null;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access' },
    baseDeps({ getUser: async (id) => { seenId = id; return googleUser(id); } })
  );
  assert.equal(r.status, 200);
  assert.equal(seenId, 'u1'); // token.sub, no way for client to override
});

await check('google user → deletes identity+user → 200 deleted', async () => {
  let deletedId = null;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access' },
    baseDeps({ deleteUser: async (id) => { deletedId = id; return { existed: true, removedIdentities: 1 }; } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);
  assert.equal(deletedId, 'u1');
});

await check('user already gone → idempotent 200 alreadyDeleted (deleteUser not called)', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access' },
    baseDeps({ getUser: async () => null, deleteUser: async () => { deleted = true; return { existed: false, removedIdentities: 0 }; } })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyDeleted, true);
  assert.equal(deleted, false);
});

await check('apple user + revoke fails → fail-closed with revoke status/reason, NO delete', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access-apple' },
    baseDeps({
      revokeAppleForUser: async () => ({ ok: false, status: 501, reason: 'apple_deletion_not_implemented' }),
      deleteUser: async () => { deleted = true; return { existed: true, removedIdentities: 1 }; },
    })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'apple_deletion_not_implemented');
  assert.equal(deleted, false);
});

await check('apple user + revoke succeeds → deletes data → 200', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access-apple' },
    baseDeps({
      revokeAppleForUser: async () => ({ ok: true }),
      deleteUser: async () => { deleted = true; return { existed: true, removedIdentities: 1 }; },
    })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);
  assert.equal(deleted, true);
});

await check('apple user but no revoke fn wired → 501, no delete', async () => {
  let deleted = false;
  const r = await handleDeleteAccount(
    { authorization: 'Bearer good-access-apple' },
    baseDeps({
      revokeAppleForUser: undefined,
      deleteUser: async () => { deleted = true; return { existed: true, removedIdentities: 1 }; },
    })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'APPLE_REVOCATION_NOT_CONFIGURED');
  assert.equal(deleted, false);
});

console.log(`\n${passed} checks passed.`);
