// Dynamic Expo config (DIC-866).
//
// Purpose: register the Google **iOS OAuth client** reversed-client-id custom URL
// scheme in the native iOS `CFBundleURLTypes`, so `expo-auth-session` can receive
// the native Google OAuth redirect (`com.googleusercontent.apps.XXXX:/oauthredirect`).
//
// The client id lives in an env var (EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID), so the
// scheme can only be computed at config-eval time — a static app.json cannot embed
// it. This dynamic config is the single Expo config source: the static base values
// live in app.base.json (not app.json, so Expo doesn't load two configs), and we
// augment the iOS section here.
const base = require('./app.base.json');

function reversedGoogleIosScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  if (!clientId) return null;
  // 123-abc.apps.googleusercontent.com  ->  com.googleusercontent.apps.123-abc
  return clientId.split('.').reverse().join('.');
}

// Build-time fail-closed guard (DIC-665 / DIC-920 blocker 1). Native Android
// Google Sign-In configures the library with the Web (server) client id so the
// returned ID token's `aud` is the audience the backend verifies; without
// EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID the APK ships and every Google login fails at
// runtime with `client_id_missing`. We turn that silent runtime failure into a
// loud build failure — but ONLY for Android native builds, so iOS/web export and
// local `expo start` are never affected. `EAS_BUILD_PLATFORM` is set by EAS;
// `ASSERT_GOOGLE_WEB_CLIENT` is set by the Android CI build workflow.
function assertAndroidGoogleClientConfigured() {
  const isAndroidBuild =
    process.env.EAS_BUILD_PLATFORM === 'android' ||
    process.env.ASSERT_GOOGLE_WEB_CLIENT === '1';
  if (!isAndroidBuild) return;
  const webClientId =
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  if (!webClientId) {
    throw new Error(
      'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID is required for Android builds: native Google ' +
        'Sign-In needs the Web/server client id so the backend can verify the ID token ' +
        'audience. Set it in the EAS build profile env (or the Android build workflow) ' +
        'before building — refusing to produce an APK that would fail login at runtime.',
    );
  }
}

module.exports = () => {
  assertAndroidGoogleClientConfigured();
  const expo = { ...base.expo };
  const scheme = reversedGoogleIosScheme();

  if (scheme) {
    const ios = { ...(expo.ios || {}) };
    const infoPlist = { ...(ios.infoPlist || {}) };
    const existing = Array.isArray(infoPlist.CFBundleURLTypes)
      ? infoPlist.CFBundleURLTypes
      : [];
    const alreadyRegistered = existing.some(
      (entry) => Array.isArray(entry?.CFBundleURLSchemes) && entry.CFBundleURLSchemes.includes(scheme)
    );
    if (!alreadyRegistered) {
      infoPlist.CFBundleURLTypes = [
        ...existing,
        { CFBundleURLSchemes: [scheme] },
      ];
    }
    ios.infoPlist = infoPlist;
    expo.ios = ios;
  }

  return { expo };
};
