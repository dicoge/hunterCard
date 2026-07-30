/**
 * verify-google-client-selection.mjs
 *
 * Standalone verification for platform-based Google OAuth client selection
 * (DIC-824 CR). Exercises the pure helpers in src/services/googleClientConfig.ts
 * without pulling in React Native — proves iOS/Android/web pick their own client
 * id, that native builds derive a reversed-client-id redirect, and that a missing
 * id resolves to '' (so the UI disables the button instead of failing on tap).
 *
 * Run:  node --experimental-strip-types scripts/verify-google-client-selection.mjs
 * (Node 22.6+; type stripping lets us import the .ts helper directly.)
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

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('platform client-id selection:');

check('iOS prefers the iOS client id', () => {
  assert.equal(
    resolveGoogleClientId('ios', { web: WEB, ios: IOS, android: ANDROID }),
    IOS,
  );
});

check('Android prefers the Android client id', () => {
  assert.equal(
    resolveGoogleClientId('android', { web: WEB, ios: IOS, android: ANDROID }),
    ANDROID,
  );
});

check('web uses the web client id (never iOS/Android)', () => {
  assert.equal(
    resolveGoogleClientId('web', { web: WEB, ios: IOS, android: ANDROID }),
    WEB,
  );
});

check('iOS falls back to generic then web when no iOS id', () => {
  assert.equal(resolveGoogleClientId('ios', { web: WEB, generic: GENERIC }), GENERIC);
  assert.equal(resolveGoogleClientId('ios', { web: WEB }), WEB);
});

check('web never falls back to a native id', () => {
  // Only native ids present -> web has nothing usable -> '' (button disabled).
  assert.equal(resolveGoogleClientId('web', { ios: IOS, android: ANDROID }), '');
});

check('missing id resolves to empty string per platform', () => {
  assert.equal(resolveGoogleClientId('ios', {}), '');
  assert.equal(isGoogleConfigured('ios', {}), false);
  assert.equal(isGoogleConfigured('ios', { ios: IOS }), true);
});

check('whitespace-only env is treated as unset', () => {
  assert.equal(resolveGoogleClientId('ios', { ios: '   ' }), '');
  assert.equal(isGoogleConfigured('web', { web: '  ' }), false);
});

console.log('native redirect derivation:');

check('reverseGoogleClientId strips the googleusercontent suffix', () => {
  assert.equal(reverseGoogleClientId(IOS), 'com.googleusercontent.apps.ios-456');
});

check('nativeGoogleRedirectUri builds the custom-scheme callback', () => {
  assert.equal(
    nativeGoogleRedirectUri(IOS),
    'com.googleusercontent.apps.ios-456:/oauthredirect',
  );
});

check('nativeGoogleRedirectUri returns "" for an empty id (web fallback)', () => {
  assert.equal(nativeGoogleRedirectUri(''), '');
});

console.log(`\nAll ${passed} google-client-selection checks passed.`);
