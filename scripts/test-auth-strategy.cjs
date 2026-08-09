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
  assert.equal(strategy.appleLoginSurface('ios', false), 'native-ios');
  assert.equal(strategy.appleLoginSurface('ios', true), 'native-ios');
  // Web Apple is disabled unless the server-verified web path is on.
  assert.equal(strategy.appleLoginSurface('web', false), 'disabled');
  assert.equal(strategy.appleLoginSurface('web', true), 'web');
}

function testAndroidAppleAlwaysDisabled() {
  // DIC-665 / DIC-920: Android Apple is hard-disabled regardless of the Web Apple
  // flag. The Android web-Apple path (Custom Tabs + App Links redirect) has no
  // real-device evidence yet, so enabling APPLE_WEB_ENABLED must NOT surface an
  // Apple button on Android.
  assert.equal(strategy.appleLoginSurface('android', false), 'disabled');
  assert.equal(strategy.appleLoginSurface('android', true), 'disabled');
}

const tests = [
  testGoogleSurfaces,
  testAndroidNeverFallsBackToWeb,
  testAppleSurfaces,
  testAndroidAppleAlwaysDisabled,
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
