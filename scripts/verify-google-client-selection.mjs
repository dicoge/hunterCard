/**
 * verify-google-client-selection.mjs
 *
 * Standalone verification for platform-based Google OAuth client selection
 * (DIC-824 / DIC-835 CR). Exercises the pure helpers in
 * src/services/googleClientConfig.ts without pulling in React Native — proves:
 *   - iOS/Android/web each pick their own client id,
 *   - production native builds do NOT fall back to a generic/web id (would ship
 *     a button that fails on tap); only explicit dev mode may fall back,
 *   - native builds derive a reversed-client-id redirect,
 *   - a missing id resolves to '' so the UI disables the button.
 *
 * Runtime note: this imports the .ts helper directly. On Node >= 22.6 that needs
 * --experimental-strip-types; on Node >= 23 type stripping is on by default. The
 * npm script passes the flag, and CI pins Node 22 so this actually runs there.
 *
 * Run:  node --experimental-strip-types scripts/verify-google-client-selection.mjs
 */
import assert from 'node:assert/strict';
import {
  resolveGoogleClientId,
  isGoogleConfigured,
  reverseGoogleClientId,
  nativeGoogleRedirectUri,
} from '../src/services/googleClientConfig.ts';

const WEB = 'web-123.apps.googleusercontent.com';
const IOS = 'ios-456.apps.googleusercontent.com';
const ANDROID = 'and-789.apps.googleusercontent.com';
const GENERIC = 'gen-000.apps.googleusercontent.com';

const PROD = {};                // production: no dev fallback
const DEV = { dev: true };      // development: fallback allowed

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('platform client-id selection (production, no dev fallback):');

check('iOS uses the iOS client id', () => {
  assert.equal(resolveGoogleClientId('ios', { web: WEB, ios: IOS, android: ANDROID }, PROD), IOS);
});

check('Android uses the Android client id', () => {
  assert.equal(resolveGoogleClientId('android', { web: WEB, ios: IOS, android: ANDROID }, PROD), ANDROID);
});

check('web uses the web client id (never iOS/Android)', () => {
  assert.equal(resolveGoogleClientId('web', { web: WEB, ios: IOS, android: ANDROID }, PROD), WEB);
});

check('web falls back to generic (same client type)', () => {
  assert.equal(resolveGoogleClientId('web', { generic: GENERIC }, PROD), GENERIC);
});

check('PROD: iOS does NOT fall back to generic/web -> "" (disabled)', () => {
  assert.equal(resolveGoogleClientId('ios', { web: WEB, generic: GENERIC }, PROD), '');
  assert.equal(isGoogleConfigured('ios', { web: WEB, generic: GENERIC }, PROD), false);
});

check('PROD: Android does NOT fall back to generic/web -> "" (disabled)', () => {
  assert.equal(resolveGoogleClientId('android', { web: WEB, generic: GENERIC }, PROD), '');
  assert.equal(isGoogleConfigured('android', { web: WEB, generic: GENERIC }, PROD), false);
});

check('default options behave as production (no fallback)', () => {
  // No opts arg at all must be as safe as explicit production.
  assert.equal(resolveGoogleClientId('ios', { web: WEB }), '');
  assert.equal(isGoogleConfigured('ios', { web: WEB }), false);
});

console.log('platform client-id selection (development, fallback allowed):');

check('DEV: iOS falls back to generic then web when no iOS id', () => {
  assert.equal(resolveGoogleClientId('ios', { web: WEB, generic: GENERIC }, DEV), GENERIC);
  assert.equal(resolveGoogleClientId('ios', { web: WEB }, DEV), WEB);
});

check('DEV: Android falls back to generic then web when no Android id', () => {
  assert.equal(resolveGoogleClientId('android', { web: WEB, generic: GENERIC }, DEV), GENERIC);
  assert.equal(resolveGoogleClientId('android', { web: WEB }, DEV), WEB);
});

check('DEV: iOS still prefers its own id over the fallback', () => {
  assert.equal(resolveGoogleClientId('ios', { web: WEB, ios: IOS }, DEV), IOS);
});

console.log('shared edge cases:');

check('web never falls back to a native id (either mode)', () => {
  assert.equal(resolveGoogleClientId('web', { ios: IOS, android: ANDROID }, PROD), '');
  assert.equal(resolveGoogleClientId('web', { ios: IOS, android: ANDROID }, DEV), '');
});

check('missing id resolves to empty string', () => {
  assert.equal(resolveGoogleClientId('ios', {}, PROD), '');
  assert.equal(resolveGoogleClientId('ios', {}, DEV), '');
  assert.equal(isGoogleConfigured('ios', { ios: IOS }, PROD), true);
});

check('whitespace-only env is treated as unset', () => {
  assert.equal(resolveGoogleClientId('ios', { ios: '   ' }, PROD), '');
  assert.equal(isGoogleConfigured('web', { web: '  ' }, PROD), false);
});

console.log('native redirect derivation:');

check('reverseGoogleClientId strips the googleusercontent suffix', () => {
  assert.equal(reverseGoogleClientId(IOS), 'com.googleusercontent.apps.ios-456');
});

check('nativeGoogleRedirectUri builds the custom-scheme callback', () => {
  assert.equal(nativeGoogleRedirectUri(IOS), 'com.googleusercontent.apps.ios-456:/oauthredirect');
});

check('nativeGoogleRedirectUri returns "" for an empty id (web fallback)', () => {
  assert.equal(nativeGoogleRedirectUri(''), '');
});

console.log(`\nAll ${passed} google-client-selection checks passed.`);
