/**
 * test-auth-login.mjs — DIC-665
 *
 * 驗證 POST /api/auth/login 核心邏輯（api/_lib/login-handler.ts）的 fail-closed 契約，
 * 以注入的假 verify / store / signer / nonce 離線驗證各分支的 HTTP 狀態：
 *   - provider 非 google → 501
 *   - 缺 id_token（含 null identity token）→ 400，絕不放行
 *   - 缺 nonce（強制）→ 400 MISSING_NONCE
 *   - AUTH_SESSION_SECRET 未設定 → 501
 *   - 無 audience → 501
 *   - nonce 已消費 / 過期 / 偽造（consumeNonce=false）→ 401 NONCE_REPLAYED，不驗 token
 *   - id_token 驗證失敗（含 nonce claim 不符）→ 401 INVALID_TOKEN（不建立 user、不簽 session）
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
    consumeNonce: async () => true,
    // verifyIdToken 模擬後端驗證：token 的 nonce claim 必須等於已消費的 expectedNonce，
    // 否則 throw（對應 google-auth.ts 的 nonce mismatch fail-closed）。
    verifyIdToken: async (idToken, opts) => {
      if (idToken === 'good-token' && opts.expectedNonce === 'n1') {
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
  const r = await handleLogin({ provider: 'facebook', id_token: 'x', nonce: 'n1' }, baseDeps());
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'PROVIDER_NOT_SUPPORTED');
});

await check('missing id_token → 400 (never falls through to session issuance)', async () => {
  const r = await handleLogin({ provider: 'google', nonce: 'n1' }, baseDeps());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'MISSING_ID_TOKEN');
});

await check('null id_token → 400 (null identity token not trusted)', async () => {
  const r = await handleLogin({ provider: 'google', id_token: null, nonce: 'n1' }, baseDeps());
  assert.equal(r.status, 400);
});

await check('missing nonce → 400 MISSING_NONCE (nonce is mandatory, no replay-protection opt-out)', async () => {
  let consumeCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({ consumeNonce: async () => { consumeCalled = true; return true; } })
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'MISSING_NONCE');
  assert.equal(consumeCalled, false);
});

await check('empty-string nonce → 400 MISSING_NONCE', async () => {
  const r = await handleLogin({ provider: 'google', id_token: 'good-token', nonce: '' }, baseDeps());
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'MISSING_NONCE');
});

await check('session secret unset → 501 (no token signed, nonce not consumed)', async () => {
  let consumeCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token', nonce: 'n1' },
    baseDeps({ sessionConfigured: false, consumeNonce: async () => { consumeCalled = true; return true; } })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'SESSION_NOT_CONFIGURED');
  assert.equal(consumeCalled, false);
});

await check('no configured audience → 501 (nonce not consumed)', async () => {
  let consumeCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token', nonce: 'n1' },
    baseDeps({ audiences: [], consumeNonce: async () => { consumeCalled = true; return true; } })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'AUTH_NOT_CONFIGURED');
  assert.equal(consumeCalled, false);
});

await check('replayed / expired / forged nonce → 401 NONCE_REPLAYED (token never verified)', async () => {
  let verifyCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token', nonce: 'n1' },
    baseDeps({
      consumeNonce: async () => false,
      verifyIdToken: async () => { verifyCalled = true; throw new Error('should not run'); },
    })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'NONCE_REPLAYED');
  assert.equal(verifyCalled, false);
});

await check('nonce mismatch (token nonce claim ≠ consumed nonce) → 401 INVALID_TOKEN', async () => {
  let resolveCalled = false;
  const r = await handleLogin(
    // consumeNonce succeeds for 'n2', but verifyIdToken only accepts expectedNonce 'n1' → throws.
    { provider: 'google', id_token: 'good-token', nonce: 'n2' },
    baseDeps({ resolveOrCreateUser: async () => { resolveCalled = true; return { user: makeUser(), isNewUser: true }; } })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_TOKEN');
  assert.equal(resolveCalled, false);
});

await check('invalid id_token → 401 (no user created, no session)', async () => {
  let resolveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'bad-token', nonce: 'n1' },
    baseDeps({ resolveOrCreateUser: async () => { resolveCalled = true; return { user: makeUser(), isNewUser: true }; } })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_TOKEN');
  assert.equal(resolveCalled, false);
});

await check('valid new user → 200 with backend session + is_new_user true', async () => {
  const r = await handleLogin({ provider: 'google', id_token: 'good-token', nonce: 'n1' }, baseDeps());
  assert.equal(r.status, 200);
  assert.equal(r.body.user.id, 'internal-1');
  assert.equal(r.body.session.access_token, 'access-internal-1');
  assert.equal(r.body.session.refresh_token, 'refresh-internal-1');
  assert.equal(r.body.session.expires_in, 3600);
  assert.equal(r.body.is_new_user, true);
});

await check('returning user → 200 with is_new_user false', async () => {
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token', nonce: 'n1' },
    baseDeps({ resolveOrCreateUser: async () => ({ user: makeUser(), isNewUser: false }) })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.is_new_user, false);
});

console.log(`\n${passed} checks passed.`);
