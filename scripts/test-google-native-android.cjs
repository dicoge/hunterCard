#!/usr/bin/env node
/**
 * Native Android Google Sign-In error-code mapping regression (DIC-1318).
 *
 * v21 Closed Test failed with "Google login cannot complete" and the previous
 * handler collapsed EVERY non-cancel signIn() failure to the generic
 * `google_failed` banner — so the classic Play App Signing SHA-1 mismatch (the
 * release-build symptom `GoogleSignInStatusCodes.DEVELOPER_ERROR` / code 10)
 * looked identical to a network hiccup on the on-screen banner. This test
 * loads the REAL src/services/authService.ts with react-native / expo /
 * google-signin mocked, then drives obtainGoogleNativeIdTokenAndroid via
 * signInWithProvider('google') and asserts:
 *
 *   1. Happy path returns the idToken to /auth/login unchanged.
 *   2. Each SDK failure produces a DISTINCT AuthError.code — DEVELOPER_ERROR
 *      → google_developer_error, NETWORK_ERROR → network_error, IN_PROGRESS
 *      → google_in_progress, INTERNAL_ERROR → google_internal_error,
 *      SIGN_IN_REQUIRED → google_sign_in_required, PLAY_SERVICES_NOT_AVAILABLE
 *      → play_services_unavailable, and unknown codes fall through to
 *      google_failed (the previous generic fallback).
 *   3. Numeric variants ('10', '8', '4') map to the same codes as their string
 *      counterparts — some library builds surface the underlying
 *      GoogleSignInStatusCodes numeric instead of the string constant.
 *   4. A user cancellation (SIGN_IN_CANCELLED / 12501 / -5, and v13+ value form
 *      { type: 'cancelled' }) always throws AuthError.code === 'cancel'.
 *   5. hasPlayServices() rejection maps to play_services_unavailable.
 *   6. Missing idToken in the success response maps to no_id_token.
 *   7. Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID maps to client_id_missing.
 *   8. The mapNativeAndroidGoogleError helper is exported and mutation-sensitive:
 *      each SDK code produces its own machine label, and swapping any branch
 *      would collapse two labels into one and fail this test.
 *
 * A mutation that removes any branch, swaps two codes, or falls through to
 * google_failed for a known code fails at least one of the assertions here.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-native-android-tests-'));

// Mutable platform + spy state the mocks read at throw time.
const state = {
  os: 'android',
  webClientId: 'web-client.apps.googleusercontent.com',
  hasPlayServicesImpl: async () => true,
  signInImpl: async () => ({ type: 'success', data: { idToken: 'ID_TOKEN_FIXTURE' } }),
  fetchImpl: async () => new Response(JSON.stringify({
    user: {
      internalId: 'u1',
      displayName: 'Test',
      role: 'free_user',
      linkedProviders: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    session: 'sess',
    isNew: false,
  }), { status: 200 }),
  lastFetchBody: null,
  configureCalls: [],
};

const reactNativeMock = { Platform: { get OS() { return state.os; } } };
const authSessionMock = {
  AuthRequest: class {},
  exchangeCodeAsync: async () => ({}),
  makeRedirectUri: () => 'redirect',
  ResponseType: { IdToken: 'id_token' },
};
const webBrowserMock = { maybeCompleteAuthSession: () => {}, openAuthSessionAsync: async () => ({ type: 'cancel' }) };
const cryptoMock = {
  getRandomBytes: (n) => new Uint8Array(n),
  digestStringAsync: async () => 'digest',
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  CryptoEncoding: { BASE64: 'base64' },
};
const googleSigninMock = {
  GoogleSignin: {
    configure(opts) { state.configureCalls.push(opts); },
    async hasPlayServices(opts) { return state.hasPlayServicesImpl(opts); },
    async signIn() { return state.signInImpl(); },
    async signOut() { return null; },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'react-native') return reactNativeMock;
  if (request === 'expo-auth-session') return authSessionMock;
  if (request === 'expo-web-browser') return webBrowserMock;
  if (request === 'expo-crypto') return cryptoMock;
  if (request === '@react-native-google-signin/google-signin') return googleSigninMock;
  return originalLoad.apply(this, arguments);
};

// Global fetch spy so signInWithProvider('google')'s POST /auth/login lands
// somewhere observable. Every test replaces state.fetchImpl for its own path.
globalThis.fetch = async (input, init) => {
  state.lastFetchBody = init && init.body ? JSON.parse(String(init.body)) : null;
  return state.fetchImpl(input, init);
};

// EXPO_PUBLIC_* is inlined at build time; the tested module reads
// process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID once at module-import. Set it
// BEFORE require so the module captures a non-empty value; tests that need to
// exercise the missing-client-id branch import a SECOND time with it unset
// (Node's require cache is bypassed via a fresh compile path).
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = state.webClientId;

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

compileTs('src/config/apiOrigin.ts');
compileTs('src/services/authStrategy.ts');
const authService = require(compileTs('src/services/authService.ts'));

// Helper: reset per-test state to defaults.
function resetState() {
  state.os = 'android';
  state.hasPlayServicesImpl = async () => true;
  state.signInImpl = async () => ({ type: 'success', data: { idToken: 'ID_TOKEN_FIXTURE' } });
  state.fetchImpl = async () => new Response(JSON.stringify({
    user: {
      internalId: 'u1',
      displayName: 'Test',
      role: 'free_user',
      linkedProviders: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    session: 'sess',
    isNew: false,
  }), { status: 200 }),
  state.lastFetchBody = null;
  state.configureCalls = [];
}

// Drives signInWithProvider('google') and returns { ok, err, result }. Never
// throws — the caller asserts on the outcome, not on control flow.
async function driveSignIn() {
  try {
    const result = await authService.signInWithProvider('google');
    return { ok: true, result, err: null };
  } catch (err) {
    return { ok: false, result: null, err };
  }
}

// ─── 1. Happy path ──────────────────────────────────────────────────────────
async function testAndroidHappyPath() {
  resetState();
  const outcome = await driveSignIn();
  assert.ok(outcome.ok, `happy path must resolve, got: ${outcome.err && outcome.err.message}`);
  assert.equal(outcome.result.session, 'sess');
  // The library must be configured with the Web client id — that is what makes
  // the returned ID token's aud verifiable server-side (see
  // docs/Android-Google-Native-Login.md "Client id 的角色").
  assert.equal(state.configureCalls.length, 1);
  assert.equal(state.configureCalls[0].webClientId, state.webClientId);
  // The idToken must reach /auth/login unchanged.
  assert.equal(state.lastFetchBody && state.lastFetchBody.idToken, 'ID_TOKEN_FIXTURE');
  assert.equal(state.lastFetchBody.provider, 'google');
}

// ─── 2. SDK failures each get a distinct AuthError.code ─────────────────────
async function drivenFailureCode(sdkError) {
  resetState();
  state.signInImpl = async () => { throw sdkError; };
  const outcome = await driveSignIn();
  assert.ok(!outcome.ok, `expected failure for ${JSON.stringify(sdkError)}`);
  return outcome.err.code;
}

async function testDeveloperErrorMapsToDistinctCode() {
  // The Play App Signing SHA-1 mismatch symptom — the top-suspect v21 cause.
  assert.equal(await drivenFailureCode({ code: 'DEVELOPER_ERROR', message: 'raw' }),
    'google_developer_error');
  // Some library builds surface the underlying GoogleSignInStatusCodes numeric.
  assert.equal(await drivenFailureCode({ code: '10', message: 'raw' }),
    'google_developer_error');
}

async function testNetworkErrorMapsToNetworkCode() {
  assert.equal(await drivenFailureCode({ code: 'NETWORK_ERROR', message: 'raw' }),
    'network_error');
}

async function testInProgressMapsToOwnCode() {
  assert.equal(await drivenFailureCode({ code: 'IN_PROGRESS', message: 'raw' }),
    'google_in_progress');
}

async function testInternalErrorMapsToOwnCode() {
  assert.equal(await drivenFailureCode({ code: 'INTERNAL_ERROR', message: 'raw' }),
    'google_internal_error');
  assert.equal(await drivenFailureCode({ code: '8', message: 'raw' }),
    'google_internal_error');
}

async function testSignInRequiredMapsToOwnCode() {
  assert.equal(await drivenFailureCode({ code: 'SIGN_IN_REQUIRED', message: 'raw' }),
    'google_sign_in_required');
  assert.equal(await drivenFailureCode({ code: '4', message: 'raw' }),
    'google_sign_in_required');
}

async function testPlayServicesNotAvailableMapsToOwnCode() {
  assert.equal(await drivenFailureCode({ code: 'PLAY_SERVICES_NOT_AVAILABLE', message: 'raw' }),
    'play_services_unavailable');
}

async function testUnknownCodeFallsThroughToGoogleFailed() {
  // Preserves the previous generic default so no ordinary failure regresses.
  assert.equal(await drivenFailureCode({ code: 'SOME_UNKNOWN_CODE', message: 'raw' }),
    'google_failed');
  assert.equal(await drivenFailureCode(new Error('opaque')), 'google_failed');
}

// ─── 3. All mapped codes are pairwise distinct (mutation-sensitive) ─────────
async function testAllMappedCodesArePairwiseDistinct() {
  // If a future refactor collapses any branch, this Set size shrinks and the
  // assertion fails — the DIC-1318 anti-regression: the whole point of this
  // work is that these SDK conditions are NOT the same banner anymore.
  const sdkCodes = [
    'DEVELOPER_ERROR',
    'NETWORK_ERROR',
    'IN_PROGRESS',
    'INTERNAL_ERROR',
    'SIGN_IN_REQUIRED',
    'PLAY_SERVICES_NOT_AVAILABLE',
    'SOME_UNKNOWN_CODE', // → google_failed (generic fallback bucket, distinct)
  ];
  const authCodes = new Set();
  for (const code of sdkCodes) {
    authCodes.add(await drivenFailureCode({ code, message: 'raw' }));
  }
  assert.equal(authCodes.size, sdkCodes.length,
    `expected ${sdkCodes.length} distinct codes, got ${authCodes.size}: ${[...authCodes].join(' | ')}`);
}

// ─── 4. Cancellations always map to 'cancel' ────────────────────────────────
async function testCancellationVariantsAllMapToCancel() {
  // Legacy throw form: string SIGN_IN_CANCELLED and its numeric variants.
  for (const code of ['SIGN_IN_CANCELLED', '12501', '-5']) {
    assert.equal(await drivenFailureCode({ code, message: 'raw' }), 'cancel',
      `throw-form ${code} must map to cancel`);
  }
  // v13+ value form — returned, not thrown.
  resetState();
  state.signInImpl = async () => ({ type: 'cancelled' });
  const outcome = await driveSignIn();
  assert.ok(!outcome.ok);
  assert.equal(outcome.err.code, 'cancel');
}

// ─── 5. hasPlayServices() rejection ─────────────────────────────────────────
async function testHasPlayServicesRejectionMaps() {
  resetState();
  state.hasPlayServicesImpl = async () => { throw new Error('play services missing'); };
  const outcome = await driveSignIn();
  assert.ok(!outcome.ok);
  assert.equal(outcome.err.code, 'play_services_unavailable');
}

// ─── 6. Missing idToken ─────────────────────────────────────────────────────
async function testMissingIdTokenMaps() {
  resetState();
  state.signInImpl = async () => ({ type: 'success', data: { idToken: null } });
  const outcome = await driveSignIn();
  assert.ok(!outcome.ok);
  assert.equal(outcome.err.code, 'no_id_token');
}

// ─── 7. Missing Web client id ───────────────────────────────────────────────
async function testMissingWebClientIdMaps() {
  // Toggle module-level GOOGLE_CLIENT_ID by re-compiling the source with the
  // env unset. Rewrite the read expression to a compile-time '' so we don't
  // depend on Node's require cache invalidation.
  const alt = compileTs('src/services/authService.ts');
  const src = fs.readFileSync(alt, 'utf8').replace(
    /process\.env\.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID\s*\|\|\s*process\.env\.EXPO_PUBLIC_GOOGLE_CLIENT_ID\s*\|\|\s*''/g,
    '""',
  );
  const altPath = alt.replace(/authService\.js$/, 'authService_noclient.js');
  fs.writeFileSync(altPath, src);
  const svc = require(altPath);
  resetState();
  try {
    await svc.signInWithProvider('google');
    assert.fail('expected client_id_missing failure');
  } catch (err) {
    assert.equal(err.code, 'client_id_missing');
    // 500 status: this is a config gap, not a user-facing 4xx.
    assert.equal(err.status, 500);
  }
}

// ─── 8. Pure helper mapping is exported and stable ──────────────────────────
function testMapHelperIsExportedAndStable() {
  const map = authService.mapNativeAndroidGoogleError;
  assert.equal(typeof map, 'function', 'mapNativeAndroidGoogleError must be exported');
  const dev = map({ code: 'DEVELOPER_ERROR' });
  assert.equal(dev.code, 'google_developer_error');
  assert.ok(dev.message.includes('google_developer_error'),
    'developer-error message must expose the machine code for support screenshots');
  // The map function must never echo the raw provider message.
  const leaky = map({ code: 'DEVELOPER_ERROR', message: 'id_token=eyJsecret user@x' });
  assert.ok(!leaky.message.includes('eyJsecret'));
  assert.ok(!leaky.message.includes('user@x'));
  // Unknown -> google_failed (generic fallback).
  assert.equal(map({ code: 'anything_else' }).code, 'google_failed');
  assert.equal(map({}).code, 'google_failed');
  assert.equal(map(null).code, 'google_failed');
}

const asyncTests = [
  testAndroidHappyPath,
  testDeveloperErrorMapsToDistinctCode,
  testNetworkErrorMapsToNetworkCode,
  testInProgressMapsToOwnCode,
  testInternalErrorMapsToOwnCode,
  testSignInRequiredMapsToOwnCode,
  testPlayServicesNotAvailableMapsToOwnCode,
  testUnknownCodeFallsThroughToGoogleFailed,
  testAllMappedCodesArePairwiseDistinct,
  testCancellationVariantsAllMapToCancel,
  testHasPlayServicesRejectionMaps,
  testMissingIdTokenMaps,
  testMissingWebClientIdMaps,
];
const syncTests = [testMapHelperIsExportedAndStable];

(async () => {
  try {
    for (const t of asyncTests) { await t(); console.log(`✓ ${t.name}`); }
    for (const t of syncTests) { t(); console.log(`✓ ${t.name}`); }
    console.log(`\n${asyncTests.length + syncTests.length} google-native-android tests passed`);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
