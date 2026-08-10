#!/usr/bin/env node
/**
 * app.config.js fail-closed build-guard tests (DIC-922 blocker 1, + protects
 * the existing Android guard from PR #94 / DIC-665).
 *
 * A native build with a missing Google client id must FAIL LOUDLY at config
 * eval, never silently ship a broken IPA/APK:
 *   - iOS build without EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID  -> throw
 *   - iOS build WITH it -> config has the reversed-client-id URL scheme
 *   - Android build without EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID -> throw (unchanged)
 *   - Non-build eval (local expo start / web export) -> never throws
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const configFactory = require(path.join(ROOT, 'app.config.js'));

const BUILD_ENV_KEYS = [
  'EAS_BUILD_PLATFORM',
  'ASSERT_GOOGLE_WEB_CLIENT',
  'ASSERT_GOOGLE_IOS_CLIENT',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
];

function resetEnv() {
  for (const k of BUILD_ENV_KEYS) delete process.env[k];
}

const IOS_CLIENT_ID = '123-abc.apps.googleusercontent.com';
const EXPECTED_SCHEME = 'com.googleusercontent.apps.123-abc';
const WEB_CLIENT_ID = '999-web.apps.googleusercontent.com';

// DIC-934 CR: malformed iOS client IDs that must fail the build closed.
// (empty/missing is already covered by testIosBuildMissingClientThrows.)
const MALFORMED_IOS_IDS = [
  'not-an-ios-client-id',             // completely wrong structure
  'apps.googleusercontent.com',       // empty prefix
  '123.apps.bad.googleusercontent.com', // wrong domain
  'my-app.apps.googleusercontent',     // missing .com
  '-.apps.googleusercontent.com',      // bare hyphen prefix
  '123$$.apps.googleusercontent.com',  // invalid chars in prefix
];

function hasScheme(config, scheme) {
  const types = config?.expo?.ios?.infoPlist?.CFBundleURLTypes || [];
  return types.some(
    (t) => Array.isArray(t.CFBundleURLSchemes) && t.CFBundleURLSchemes.includes(scheme),
  );
}

function testIosBuildMissingClientThrows() {
  resetEnv();
  process.env.EAS_BUILD_PLATFORM = 'ios';
  assert.throws(() => configFactory(), /EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is required for iOS/);
}

function testIosAssertFlagMissingClientThrows() {
  resetEnv();
  process.env.ASSERT_GOOGLE_IOS_CLIENT = '1';
  assert.throws(() => configFactory(), /EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID is required for iOS/);
}

function testIosBuildWithClientRegistersReversedScheme() {
  resetEnv();
  process.env.EAS_BUILD_PLATFORM = 'ios';
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = IOS_CLIENT_ID;
  const config = configFactory();
  assert.ok(
    hasScheme(config, EXPECTED_SCHEME),
    `expected reversed scheme ${EXPECTED_SCHEME} to be registered`,
  );
}

// DIC-934 CR: a malformed iOS client ID must fail the build closed so an
// invalid CFBundleURLScheme is never registered.
function testIosBuildMalformedClientIdThrows() {
  for (const badId of MALFORMED_IOS_IDS) {
    resetEnv();
    process.env.EAS_BUILD_PLATFORM = 'ios';
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = badId;
    assert.throws(
      () => configFactory(),
      /not a valid iOS OAuth client ID/,
      `malformed client ID ${JSON.stringify(badId)} must fail build closed`,
    );
  }
}

function testAndroidBuildMissingWebClientStillThrows() {
  // Protect PR #94 (DIC-665) behavior — must not regress.
  resetEnv();
  process.env.EAS_BUILD_PLATFORM = 'android';
  assert.throws(() => configFactory(), /EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is required for Android/);
}

function testAndroidBuildWithWebClientPasses() {
  resetEnv();
  process.env.EAS_BUILD_PLATFORM = 'android';
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = WEB_CLIENT_ID;
  // Android build does not require the iOS client; must not throw.
  const config = configFactory();
  assert.ok(config && config.expo, 'expected a valid config for Android build');
}

function testNonBuildEvalNeverThrows() {
  // Local `expo start` / web export: no build platform, no client ids set.
  resetEnv();
  const config = configFactory();
  assert.ok(config && config.expo, 'expected a valid config for non-build eval');
  // No iOS client id -> reversed scheme is simply absent, not an error.
  assert.equal(hasScheme(config, EXPECTED_SCHEME), false);
}

const tests = [
  testIosBuildMissingClientThrows,
  testIosAssertFlagMissingClientThrows,
  testIosBuildWithClientRegistersReversedScheme,
  testIosBuildMalformedClientIdThrows,
  testAndroidBuildMissingWebClientStillThrows,
  testAndroidBuildWithWebClientPasses,
  testNonBuildEvalNeverThrows,
];
try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} ios-build-guard tests passed`);
} finally {
  resetEnv();
}
