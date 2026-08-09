// Platform → login-surface routing (DIC-665).
//
// Pure functions, no react-native / expo imports, so the routing decision is
// unit-testable in plain Node and cannot silently regress (e.g. Android falling
// back to the browser PKCE path instead of native Google Sign-In). authService
// consumes these to dispatch; identity is always resolved server-side regardless
// of which surface produced the provider ID token.

export type GoogleLoginSurface = 'native-ios' | 'native-android' | 'web';
export type AppleLoginSurface = 'native-ios' | 'web' | 'disabled';

// Google: native SDK on iOS (dedicated iOS OAuth client) and Android (Credential
// Manager, ID token audienced to the Web/server client). Every other platform —
// web — uses the browser OAuth/PKCE path.
export function googleLoginSurface(os: string): GoogleLoginSurface {
  if (os === 'ios') return 'native-ios';
  if (os === 'android') return 'native-android';
  return 'web';
}

// Apple: native Sign in with Apple on iOS; on every other platform it is offered
// only when the operator has enabled the server-verified Web Apple path,
// otherwise it is hidden/disabled (never shown as a nonfunctional button).
export function appleLoginSurface(os: string, webEnabled: boolean): AppleLoginSurface {
  if (os === 'ios') return 'native-ios';
  return webEnabled ? 'web' : 'disabled';
}
