/**
 * test-auth-login.mjs — DIC-665
 *
 * 驗證 POST /api/auth/login 核心邏輯（api/_lib/login-handler.ts）的 fail-closed 契約，
 * 以注入的假 verify / store / signer 離線驗證各分支的 HTTP 狀態：
 *   - provider 非 google → 501
 *   - 缺 id_token（含 null identity token）→ 400，絕不放行
 *   - AUTH_SESSION_SECRET 未設定 → 501
 *   - 無 audience → 501
 *   - id_token 驗證失敗 → 401（不建立 user、不簽 session）
 *   - 成功 → 200，回後端權威 user + session，新/舊 user 標記正確
 *
 * Run: node --experimental-strip-types scripts/test-auth-login.mjs
 */
import assert from 'node:assert/strict';
import { handleLogin } from '../api/_lib/login-handler.ts';

function makeUser(overrides = {}) {
  return {
    internalId: 'internal-1',
    displayName: 'Alice',
    primaryEmail: 'a@example.com',
    photoUrl: null,
    linkedProviders: [
      { provider: 'google', providerId: 'sub-abc', email: 'a@example.com', displayName: 'Alice', photoUrl: null, linkedAt: 'T' },
    ],
    createdAt: 'T',
    lastLoginAt: 'T',
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    verifyIdToken: async (idToken) => {
      if (idToken === 'good-token') {
        return { sub: 'sub-abc', email: 'a@example.com', emailVerified: true, name: 'Alice', picture: null };
      }
      throw new Error('invalid');
    },
    resolveOrCreateUser: async () => ({ user: makeUser(), isNewUser: true }),
    signAccessToken: (uid) => `access-${uid}`,
    signRefreshToken: (uid) => `refresh-${uid}`,
    audiences: ['web-client'],
    sessionConfigured: true,
    accessTtlSec: 3600,
    ...overrides,
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('login handler contract (DIC-665)');

await check('unsupported provider → 501', async () => {
  const r = await handleLogin({ provider: 'facebook', id_token: 'x' }, baseDeps());
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'PROVIDER_NOT_SUPPORTED');
});

await check('missing id_token → 400 (never falls through to session issuance)', async () => {
  const r = await handleLogin({ provider: 'google' }, baseDeps());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'MISSING_ID_TOKEN');
});

await check('null id_token → 400 (null identity token not trusted)', async () => {
  const r = await handleLogin({ provider: 'google', id_token: null }, baseDeps());
  assert.equal(r.status, 400);
});

await check('session secret unset → 501 (no token signed)', async () => {
  const r = await handleLogin({ provider: 'google', id_token: 'good-token' }, baseDeps({ sessionConfigured: false }));
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'SESSION_NOT_CONFIGURED');
});

await check('no configured audience → 501', async () => {
  const r = await handleLogin({ provider: 'google', id_token: 'good-token' }, baseDeps({ audiences: [] }));
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'AUTH_NOT_CONFIGURED');
});

await check('invalid id_token → 401 (no user created, no session)', async () => {
  let resolveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'bad-token' },
    baseDeps({ resolveOrCreateUser: async () => { resolveCalled = true; return { user: makeUser(), isNewUser: true }; } })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_TOKEN');
  assert.equal(resolveCalled, false);
});

await check('valid new user → 200 with backend session + is_new_user true', async () => {
  const r = await handleLogin({ provider: 'google', id_token: 'good-token' }, baseDeps());
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, 'internal-1');
  assert.equal(r.body.session.access_token, 'access-internal-1');
  assert.equal(r.body.session.refresh_token, 'refresh-internal-1');
  assert.equal(r.body.session.expires_in, 3600);
  assert.equal(r.body.is_new_user, true);
});

await check('returning user → 200 with is_new_user false', async () => {
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({ resolveOrCreateUser: async () => ({ user: makeUser(), isNewUser: false }) })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.is_new_user, false);
});

console.log(`\n${passed} checks passed.`);
