/**
 * test-auth-login.mjs — DIC-665
 *
 * 驗證 POST /api/auth/login 核心邏輯（api/_lib/login-handler.ts）的 fail-closed 契約，
 * 以注入的假 verify / reserve / store / signer 離線驗證各分支的 HTTP 狀態：
 *   - provider 非 google → 501
 *   - 缺 id_token（含 null identity token）→ 400，絕不放行
 *   - AUTH_SESSION_SECRET 未設定 → 501
 *   - 無 audience → 501
 *   - id_token 驗證失敗 → 401 INVALID_TOKEN（不佔用、不建立 user、不簽 session）
 *   - id_token 重放（reserveIdTokenOnce=false）→ 401 TOKEN_REPLAYED（不建立 user、不簽 session）
 *   - 成功 → 200，回後端權威 user + session，新/舊 user 標記正確，且以 token 剩餘壽命佔用
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

const NOW_MS = 1_000_000_000_000; // fixed clock
const NOW_SEC = Math.floor(NOW_MS / 1000);

function baseDeps(overrides = {}) {
  return {
    verifyIdToken: async (idToken) => {
      if (idToken === 'good-token') {
        return {
          sub: 'sub-abc', email: 'a@example.com', emailVerified: true,
          name: 'Alice', picture: null, issuedAt: NOW_SEC, expiresAt: NOW_SEC + 3600,
        };
      }
      throw new Error('invalid');
    },
    reserveIdTokenOnce: async () => true,
    resolveOrCreateUser: async () => ({ user: makeUser(), isNewUser: true }),
    signAccessToken: (uid) => `access-${uid}`,
    signRefreshToken: (uid) => `refresh-${uid}`,
    audiences: ['web-client'],
    sessionConfigured: true,
    accessTtlSec: 3600,
    now: () => NOW_MS,
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

await check('session secret unset → 501 (no token signed, token not reserved)', async () => {
  let reserveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({ sessionConfigured: false, reserveIdTokenOnce: async () => { reserveCalled = true; return true; } })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'SESSION_NOT_CONFIGURED');
  assert.equal(reserveCalled, false);
});

await check('no configured audience → 501 (token not reserved)', async () => {
  let reserveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({ audiences: [], reserveIdTokenOnce: async () => { reserveCalled = true; return true; } })
  );
  assert.equal(r.status, 501);
  assert.equal(r.body.error, 'AUTH_NOT_CONFIGURED');
  assert.equal(reserveCalled, false);
});

await check('invalid id_token → 401 (never reserved, no user created, no session)', async () => {
  let reserveCalled = false, resolveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'bad-token' },
    baseDeps({
      reserveIdTokenOnce: async () => { reserveCalled = true; return true; },
      resolveOrCreateUser: async () => { resolveCalled = true; return { user: makeUser(), isNewUser: true }; },
    })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_TOKEN');
  assert.equal(reserveCalled, false);
  assert.equal(resolveCalled, false);
});

await check('replayed id_token → 401 TOKEN_REPLAYED (no user created, no session)', async () => {
  let resolveCalled = false;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({
      reserveIdTokenOnce: async () => false,
      resolveOrCreateUser: async () => { resolveCalled = true; return { user: makeUser(), isNewUser: true }; },
    })
  );
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'TOKEN_REPLAYED');
  assert.equal(resolveCalled, false);
});

await check('reserve uses token remaining lifetime (exp - now) as TTL', async () => {
  let seenTtl = null, seenToken = null;
  const r = await handleLogin(
    { provider: 'google', id_token: 'good-token' },
    baseDeps({ reserveIdTokenOnce: async (idToken, ttl) => { seenToken = idToken; seenTtl = ttl; return true; } })
  );
  assert.equal(r.status, 200);
  assert.equal(seenToken, 'good-token');
  assert.equal(seenTtl, 3600); // (NOW_SEC + 3600) - NOW_SEC
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
