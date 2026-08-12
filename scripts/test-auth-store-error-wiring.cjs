#!/usr/bin/env node
/**
 * Auth store → login-gate error-wiring regression (DIC-928 blocker 1).
 *
 * The earlier fix only wired friendlyAuthErrorMessage into AuthScreen/
 * SettingsScreen. But the ACTUAL root login gate is `authStore` +
 * `LoginScreen`, which AppNavigator mounts when unauthenticated: LoginScreen
 * renders `useAuthStore().error` VERBATIM and its own catch block is empty. So
 * whatever `loginWithGoogle`/`loginWithApple` store in `error` is exactly what
 * the user sees — and before this fix the store put the RAW provider/SDK/
 * network/backend `err.message` there (id_token / email / internal detail could
 * leak, and every failure looked identical).
 *
 * This is an integration test of the REAL store (not the mapper in isolation):
 * it loads the actual src/store/authStore.ts with authService + storage mocked,
 * drives login failures through it, and asserts the resulting `error` is the
 * friendly-but-safe string and NEVER echoes the raw message. It also asserts the
 * store→gate wiring at the source level (LoginScreen renders the store error;
 * AppNavigator mounts LoginScreen) so a future refactor can't silently reroute
 * the gate around the safe mapping.
 *
 * IMPLEMENTATION NOTE (DIC-934): this test loads the real .ts modules via Node's
 * built-in type stripping + synchronous module hooks, NOT the standalone
 * `typescript` transpiler. The earlier `ts.transpileModule` variant pulled the
 * whole `typescript` compiler into this process, and on the CI Linux runner its
 * regexp compilation aborted the process (`RegExpCompiler Allocation failed`,
 * exit 134) before any assertion ran. The stripping path here compiles no such
 * regexp and keeps the process bounded, while still exercising the real store.
 * The test's own assertions use plain string checks (no `RegExp`) on purpose.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// Mutable box the mocked authService throws from. Kept on globalThis because the
// mock module bodies below are provided to the loader as source strings and run
// in this same realm — they read the live value at throw time.
globalThis.__authStoreWiringMock = { signInError: null };

// Mock authService: only signInWithProvider matters (login failure path); the
// other named exports the store destructures must exist so its import resolves.
const MOCK_AUTH_SERVICE = `
export const signInWithProvider = async () => { throw globalThis.__authStoreWiringMock.signInError; };
export const linkProvider = async () => { throw new Error('unused'); };
export const unlinkProvider = async () => { throw new Error('unused'); };
export const deleteAccount = async () => { throw new Error('unused'); };
export const signOutNativeGoogle = async () => {};
export const validateSession = async () => { throw new Error('unused'); };
export const completePendingWebGoogleLogin = async () => null;
export const hasPendingWebGoogleRedirectReturn = () => false;
`;

// Mock platform storage: in-memory no-op. persist reads getItem once on init and
// finds nothing, so the store starts unauthenticated and never persists here.
const MOCK_STORAGE = `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`;

// Mock the types module: authStore imports { HoloUser, AuthProvider, UserRole }
// as VALUES-looking bindings, but they are type-only. Node's type stripping
// leaves the import in place, so the referenced names must exist as (unused)
// runtime exports or the ESM binding check fails. They are never read.
const MOCK_TYPES = `export const HoloUser = undefined; export const AuthProvider = undefined; export const UserRole = undefined;`;

// Synchronous resolve/load hooks (Node >=22.15): redirect the store's relative
// deps to the in-memory mocks, resolve the remaining extensionless relative
// imports (e.g. ../services/authErrorMessages) to their real .ts files, and let
// bare deps (zustand) fall through to normal node_modules resolution.
Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/services/authService')) {
      return { url: 'mock:///authService', shortCircuit: true };
    }
    if (specifier.endsWith('/stores/storage')) {
      return { url: 'mock:///storage', shortCircuit: true };
    }
    if (specifier.endsWith('/types/auth')) {
      return { url: 'mock:///types-auth', shortCircuit: true };
    }
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
      const baseDir = path.dirname(new URL(context.parentURL).pathname);
      const candidate = path.resolve(baseDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return nextResolve(`file://${candidate}`, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'mock:///authService') return { format: 'module', source: MOCK_AUTH_SERVICE, shortCircuit: true };
    if (url === 'mock:///storage') return { format: 'module', source: MOCK_STORAGE, shortCircuit: true };
    if (url === 'mock:///types-auth') return { format: 'module', source: MOCK_TYPES, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const liveMock = globalThis.__authStoreWiringMock;

(async () => {
  const { useAuthStore } = await import(`file://${path.join(ROOT, 'src/store/authStore.ts')}`);

  async function driveLogin(method, signInError) {
    liveMock.signInError = signInError;
    useAuthStore.getState().clearError();
    try {
      await useAuthStore.getState()[method]();
    } catch {
      /* the store rethrows after storing error; that's expected */
    }
    return useAuthStore.getState().error;
  }

  // A raw backend/provider error carrying a secret must NEVER reach `error`.
  async function testLoginNeverLeaksRawSecret() {
    const leaky = {
      name: 'AuthError',
      message: 'id_token=eyJhbGciOiJSUzI1NiJ9.secret.sig user=alice@example.com',
      status: 500,
    };
    const shown = await driveLogin('loginWithGoogle', leaky);
    assert.ok(shown, 'a backend 500 must still surface SOME error banner');
    for (const secret of ['eyJhbGci', 'id_token', 'alice@example.com', 'secret']) {
      assert.ok(!shown.includes(secret),
        `error must not echo the raw message (leaked "${secret}"), got: ${shown}`);
    }
    // 500 → friendly server-error copy.
    assert.equal(shown, 'Google 登入服務暫時無法使用（伺服器錯誤），請稍後再試。');
  }

  // A raw network TypeError (no code/status, e.g. fetch "Network request failed")
  // maps to the safe default, not the raw string.
  async function testRawNetworkErrorMapped() {
    const shown = await driveLogin('loginWithGoogle', new TypeError('Network request failed'));
    assert.ok(!shown.includes('Network request failed'),
      `error must not echo the raw network message, got: ${shown}`);
    assert.equal(shown, '無法完成 Google 登入，請稍後再試。');
  }

  // A known code is surfaced as its specific friendly message.
  async function testClientMissingMapped() {
    const shown = await driveLogin('loginWithGoogle', {
      name: 'AuthError', code: 'client_id_missing', status: 500,
      message: 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID missing',
    });
    assert.equal(shown, 'Google 登入尚未設定完成（缺少登入服務設定），請稍後再試或聯絡我們。');
  }

  // A user cancel is not a failure — no error banner.
  async function testCancelShowsNoError() {
    const shown = await driveLogin('loginWithGoogle', {
      name: 'AuthError', code: 'cancel', message: '已取消登入', status: 400,
    });
    assert.equal(shown, null, `cancel must clear the error, got: ${shown}`);
  }

  // Apple path is mapped with the Apple label (proves both gate buttons wired).
  async function testAppleLabelMapped() {
    const shown = await driveLogin('loginWithApple', {
      name: 'AuthError', code: 'redirect_uri_mismatch', status: 400,
      message: 'raw apple redirect detail',
    });
    assert.ok(!shown.includes('raw apple redirect detail'), `must not echo raw, got: ${shown}`);
    assert.equal(shown, 'Apple 登入設定不符（redirect 網址未授權），請稍後再試或聯絡我們。');
  }

  // Source-level wiring guard: the safe string is only meaningful if the gate
  // actually renders the store `error`. Assert LoginScreen reads `error` from
  // the store and renders it, does NOT map/echo a raw message itself, and that
  // AppNavigator mounts LoginScreen as the unauthenticated gate. Plain string
  // checks — deliberately no RegExp.
  function testGateWiringAtSource() {
    const login = fs.readFileSync(path.join(ROOT, 'src/screens/LoginScreen.tsx'), 'utf8');
    assert.ok(login.includes('useAuthStore()'), 'LoginScreen must consume useAuthStore');
    assert.ok(login.includes('error') && login.includes('{error}'),
      'LoginScreen must render the store error');
    assert.ok(!login.includes('err.message') && !login.includes('friendlyAuthErrorMessage'),
      'LoginScreen must NOT map/echo errors itself — the store owns safe mapping');
    const nav = fs.readFileSync(path.join(ROOT, 'src/navigation/AppNavigator.tsx'), 'utf8');
    assert.ok(nav.includes('component={LoginScreen}'),
      'AppNavigator must mount LoginScreen as the unauthenticated gate');
  }

  const asyncTests = [
    testLoginNeverLeaksRawSecret,
    testRawNetworkErrorMapped,
    testClientMissingMapped,
    testCancelShowsNoError,
    testAppleLabelMapped,
  ];
  const syncTests = [testGateWiringAtSource];

  for (const t of asyncTests) { await t(); console.log(`✓ ${t.name}`); }
  for (const t of syncTests) { t(); console.log(`✓ ${t.name}`); }
  console.log(`\n${asyncTests.length + syncTests.length} auth-store error-wiring tests passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
