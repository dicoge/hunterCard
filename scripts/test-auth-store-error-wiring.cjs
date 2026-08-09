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
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-store-wiring-'));

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiled = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
  return output;
}

// Mock authService: only signInWithProvider matters for these tests; it throws
// whatever the current case configures. The other named exports authStore
// destructures must exist so the module import doesn't blow up.
const MOCK = { signInError: null };
const mockAuthServicePath = path.join(outDir, 'mock-authService.js');
fs.writeFileSync(
  mockAuthServicePath,
  `const MOCK = require(${JSON.stringify(path.join(outDir, 'mock-state.js'))});
module.exports = {
  signInWithProvider: async () => { throw MOCK.signInError; },
  linkProvider: async () => { throw new Error('unused'); },
  unlinkProvider: async () => { throw new Error('unused'); },
  deleteAccount: async () => { throw new Error('unused'); },
  signOutNativeGoogle: async () => {},
  validateSession: async () => { throw new Error('unused'); },
};
`,
);
fs.writeFileSync(
  path.join(outDir, 'mock-state.js'),
  `module.exports = ${JSON.stringify(MOCK)};`,
);
// Re-point MOCK to the live required object so mutations are visible in the mock.
const liveMock = require(path.join(outDir, 'mock-state.js'));

// Mock platform storage: an in-memory no-op is enough; the store never persists
// anything meaningful in this test and rehydration finds nothing.
const mockStoragePath = path.join(outDir, 'mock-storage.js');
fs.writeFileSync(
  mockStoragePath,
  `module.exports = { __esModule: true, default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };`,
);

const authErrorMessagesJs = compileTs('src/services/authErrorMessages.ts');
const authStoreJs = compileTs('src/store/authStore.ts');

// Redirect the store's relative deps to our mocks / compiled pure module, and
// resolve bare deps (zustand, react) from the repo's node_modules since the
// compiled files live in a tmp dir outside the tree.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '../services/authService') return mockAuthServicePath;
  if (request === '../services/authErrorMessages') return authErrorMessagesJs;
  if (request === '../stores/storage') return mockStoragePath;
  if (!request.startsWith('.') && !path.isAbsolute(request)) {
    try {
      return require.resolve(request, { paths: [ROOT] });
    } catch {
      /* fall through to default */
    }
  }
  return origResolve.call(this, request, parent, ...rest);
};

let useAuthStore;
try {
  ({ useAuthStore } = require(authStoreJs));

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
    assert.ok(!/eyJhbGci|id_token|alice@example\.com|secret/.test(shown),
      `error must not echo the raw message, got: ${shown}`);
    // 500 → friendly server-error copy.
    assert.equal(shown, 'Google 登入服務暫時無法使用（伺服器錯誤），請稍後再試。');
  }

  // A raw network TypeError (no code/status, e.g. fetch "Network request failed")
  // maps to the safe default, not the raw string.
  async function testRawNetworkErrorMapped() {
    const shown = await driveLogin('loginWithGoogle', new TypeError('Network request failed'));
    assert.ok(!/Network request failed/.test(shown),
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
    assert.ok(!/raw apple redirect detail/.test(shown), `must not echo raw, got: ${shown}`);
    assert.equal(shown, 'Apple 登入設定不符（redirect 網址未授權），請稍後再試或聯絡我們。');
  }

  // Source-level wiring guard: the safe string is only meaningful if the gate
  // actually renders the store `error`. Assert LoginScreen reads `error` from
  // the store and renders it, does NOT map/echo a raw message itself, and that
  // AppNavigator mounts LoginScreen as the unauthenticated gate.
  function testGateWiringAtSource() {
    const login = fs.readFileSync(path.join(ROOT, 'src/screens/LoginScreen.tsx'), 'utf8');
    assert.ok(/useAuthStore\(\)/.test(login), 'LoginScreen must consume useAuthStore');
    assert.ok(/\berror\b/.test(login) && /\{error\}/.test(login),
      'LoginScreen must render the store error');
    assert.ok(!/err\.message|friendlyAuthErrorMessage/.test(login),
      'LoginScreen must NOT map/echo errors itself — the store owns safe mapping');
    const nav = fs.readFileSync(path.join(ROOT, 'src/navigation/AppNavigator.tsx'), 'utf8');
    assert.ok(/component=\{LoginScreen\}/.test(nav),
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

  (async () => {
    for (const t of asyncTests) { await t(); console.log(`✓ ${t.name}`); }
    for (const t of syncTests) { t(); console.log(`✓ ${t.name}`); }
    console.log(`\n${asyncTests.length + syncTests.length} auth-store error-wiring tests passed`);
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  }).finally(() => {
    Module._resolveFilename = origResolve;
    fs.rmSync(outDir, { recursive: true, force: true });
  });
} catch (e) {
  Module._resolveFilename = origResolve;
  fs.rmSync(outDir, { recursive: true, force: true });
  throw e;
}
