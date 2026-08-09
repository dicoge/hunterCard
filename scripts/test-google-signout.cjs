#!/usr/bin/env node
/**
 * Adapter-level tests for native Google Sign-In logout / account switching
 * (DIC-665 / DIC-920 blocker 4).
 *
 * The classic play-services-auth GoogleSignin caches the last account, so logout
 * MUST call GoogleSignin.signOut() — otherwise a returning user can never pick a
 * different Gmail (the second-account flow). These tests compile the real
 * src/services/authService.ts with react-native / expo modules mocked and assert:
 *   - On Android, signOutNativeGoogle() imports the library and calls signOut().
 *   - On iOS/web, it is a no-op and never even imports the native module (so it
 *     stays out of those bundles and cannot crash where the SDK is absent).
 *   - signOut() rejection is swallowed (best-effort, never blocks logout).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-signout-tests-'));

// Mutable platform + spy state the mocks read.
const state = {
  os: 'android',
  signOutCalls: 0,
  googleModuleImports: 0,
  signOutImpl: async () => null,
};

const reactNativeMock = { Platform: { get OS() { return state.os; } } };
const authSessionMock = {
  AuthRequest: class {},
  exchangeCodeAsync: async () => ({}),
  makeRedirectUri: () => 'redirect',
};
const webBrowserMock = { maybeCompleteAuthSession: () => {} };
const cryptoMock = { getRandomBytes: (n) => new Uint8Array(n) };
const googleSigninMock = {
  GoogleSignin: {
    configure() {},
    async hasPlayServices() { return true; },
    async signIn() { return { type: 'success', data: { idToken: 'x' } }; },
    async signOut() {
      state.signOutCalls += 1;
      return state.signOutImpl();
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'react-native') return reactNativeMock;
  if (request === 'expo-auth-session') return authSessionMock;
  if (request === 'expo-web-browser') return webBrowserMock;
  if (request === 'expo-crypto') return cryptoMock;
  if (request === '@react-native-google-signin/google-signin') {
    state.googleModuleImports += 1;
    return googleSigninMock;
  }
  return originalLoad.apply(this, arguments);
};

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

// authService imports types/auth (type-only, erased) and authStrategy (pure).
compileTs('src/services/authStrategy.ts');
const authService = require(compileTs('src/services/authService.ts'));

async function testAndroidLogoutCallsSignOut() {
  state.os = 'android';
  state.signOutCalls = 0;
  state.googleModuleImports = 0;
  await authService.signOutNativeGoogle();
  assert.equal(state.signOutCalls, 1, 'Android logout must call GoogleSignin.signOut()');
  assert.equal(state.googleModuleImports, 1, 'Android logout imports the native module once');
}

async function testIosLogoutIsNoop() {
  state.os = 'ios';
  state.signOutCalls = 0;
  state.googleModuleImports = 0;
  await authService.signOutNativeGoogle();
  assert.equal(state.signOutCalls, 0, 'iOS must not call the Android Google SDK');
  assert.equal(state.googleModuleImports, 0, 'iOS must not import the native module');
}

async function testWebLogoutIsNoop() {
  state.os = 'web';
  state.signOutCalls = 0;
  state.googleModuleImports = 0;
  await authService.signOutNativeGoogle();
  assert.equal(state.signOutCalls, 0, 'web must not call the Android Google SDK');
  assert.equal(state.googleModuleImports, 0, 'web must not import the native module');
}

async function testSignOutRejectionSwallowed() {
  state.os = 'android';
  state.signOutCalls = 0;
  state.signOutImpl = async () => { throw new Error('no cached account'); };
  // Must resolve (not reject) so logout is never blocked by provider SDK state.
  await authService.signOutNativeGoogle();
  assert.equal(state.signOutCalls, 1);
  state.signOutImpl = async () => null;
}

const tests = [
  testAndroidLogoutCallsSignOut,
  testIosLogoutIsNoop,
  testWebLogoutIsNoop,
  testSignOutRejectionSwallowed,
];

(async () => {
  try {
    for (const test of tests) {
      await test();
      console.log(`✓ ${test.name}`);
    }
    console.log(`\n${tests.length} google-signout tests passed`);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
