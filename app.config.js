// Dynamic Expo config.
//
// Purpose: register the Google **iOS OAuth client** reversed-client-id custom URL
// scheme in the native iOS `CFBundleURLTypes`, so `expo-auth-session` can receive
// the OAuth redirect (`com.googleusercontent.apps.XXXX:/oauthredirect`) on iOS.
//
// The client id lives in an env var (EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID), so the
// scheme can only be computed at config-eval time — a static app.json cannot embed
// it. This dynamic config is the single Expo config source: the static base values
// live in app.base.json (not app.json, so Expo doesn't load two configs), and we
// augment the iOS section here (CR DIC-855 #3/#6).
const base = require('./app.base.json');

function reversedGoogleIosScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  if (!clientId) return null;
  // com.googleusercontent.apps.123-abc  ->  reversed dotted string
  return clientId.split('.').reverse().join('.');
}

module.exports = () => {
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
