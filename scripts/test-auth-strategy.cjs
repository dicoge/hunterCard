#!/usr/bin/env node
/**
 * Platform → login-surface routing tests (DIC-665).
 *
 * Guards the explicit Android native dispatch: Android must route to native
 * Google Sign-In, NOT fall back to the browser PKCE path, while iOS and web keep
 * their existing surfaces. Compiles the pure src/services/authStrategy.ts (no
 * react-native/expo imports) and asserts the mapping directly.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-strategy-tests-'));

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

const strategy = require(compileTs('src/services/authStrategy.ts'));

function testGoogleSurfaces() {
  assert.equal(strategy.googleLoginSurface('ios'), 'native-ios');
  assert.equal(strategy.googleLoginSurface('android'), 'native-android');
  assert.equal(strategy.googleLoginSurface('web'), 'web');
  // Any non-native platform (e.g. an unexpected OS string) must use the browser
  // path, never accidentally the Android native path.
  assert.equal(strategy.googleLoginSurface('windows'), 'web');
}

function testAndroidNeverFallsBackToWeb() {
  // The regression this whole issue exists to prevent: Android silently using the
  // browser PKCE fallback instead of native Google Sign-In.
  assert.notEqual(strategy.googleLoginSurface('android'), 'web');
}

function testAppleSurfaces() {
  // iOS always native, regardless of the web flag.
  assert.equal(strategy.appleLoginSurface('ios', false), 'native-ios');
  assert.equal(strategy.appleLoginSurface('ios', true), 'native-ios');
  // Web Apple is disabled unless the server-verified web path is on.
  assert.equal(strategy.appleLoginSurface('web', false), 'disabled');
  assert.equal(strategy.appleLoginSurface('web', true), 'web');
}

function testAndroidAppleServerCallbackWhenEnabled() {
  // DIC-960 / CR DIC-961: Android Apple runs the server-callback web-OAuth path
  // (Custom Tabs → /api/auth/apple/web → VERIFIED HTTPS App Link return) ONLY when
  // BOTH the web Apple path is on AND the Android gate (androidEnabled) is on. The
  // Android gate must stay off until a verified App Link is deployed, since a
  // custom scheme is not app-exclusive and could be intercepted. When both gates
  // are on it routes to 'android-web' (NOT 'web') so dispatch launches Custom Tabs
  // with the App Link return rather than the browser page-origin return.
  assert.equal(strategy.appleLoginSurface('android', true, true), 'android-web');
  assert.notEqual(strategy.appleLoginSurface('android', true, true), 'web');
}

function testAndroidFailsClosedWithoutAppLinkGate() {
  // The CR DIC-961 blocker: even with the web Apple path ON, Android must FAIL
  // CLOSED to 'disabled' until the App Link gate is explicitly turned on. It must
  // NEVER fall back to the custom-scheme 'android-web' surface on the gate alone.
  assert.equal(strategy.appleLoginSurface('android', true, false), 'disabled');
  // The gate also defaults to off when omitted (fail-closed by default).
  assert.equal(strategy.appleLoginSurface('android', true), 'disabled');
}

function testAppleFailClosedWhenWebDisabled() {
  // Fail-closed: with the web Apple path OFF, both web and Android are disabled —
  // never surfaced as a nonfunctional button (DIC-866 acceptance #5). This is the
  // single gate that keeps a half-configured deploy from exposing Apple login.
  assert.equal(strategy.appleLoginSurface('android', false), 'disabled');
  assert.equal(strategy.appleLoginSurface('web', false), 'disabled');
  // An unexpected OS string also fails closed when web is off.
  assert.equal(strategy.appleLoginSurface('windows', false), 'disabled');
}

const tests = [
  testGoogleSurfaces,
  testAndroidNeverFallsBackToWeb,
  testAppleSurfaces,
  testAndroidAppleServerCallbackWhenEnabled,
  testAndroidFailsClosedWithoutAppLinkGate,
  testAppleFailClosedWhenWebDisabled,
];
try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} auth-strategy tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
