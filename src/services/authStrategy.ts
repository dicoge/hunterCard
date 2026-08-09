// Platform → login-surface routing (DIC-665).
//
// Pure functions, no react-native / expo imports, so the routing decision is
// unit-testable in plain Node and cannot silently regress (e.g. Android falling
// back to the browser PKCE path instead of native Google Sign-In). authService
// consumes these to dispatch; identity is always resolved server-side regardless
// of which surface produced the provider ID token.

export type GoogleLoginSurface = 'native-ios' | 'native-android' | 'web';
export type AppleLoginSurface = 'native-ios' | 'web' | 'disabled';

// Google: native SDK on iOS (dedicated iOS OAuth client) and Android (classic
// play-services-auth Google Sign-In, ID token audienced to the Web/server
// client). Every other platform — web — uses the browser OAuth/PKCE path.
export function googleLoginSurface(os: string): GoogleLoginSurface {
  if (os === 'ios') return 'native-ios';
  if (os === 'android') return 'native-android';
  return 'web';
}

// Apple: native Sign in with Apple on iOS. Android is hard-disabled regardless of
// the Web Apple flag — the Android web-Apple path (Custom Tabs + App Links
// redirect) has no real-device evidence yet (DIC-665 / DIC-920), so we never
// expose it even when APPLE_WEB_ENABLED is on. On web it is offered only when the
// operator enabled the server-verified Web Apple path, otherwise disabled (never
// shown as a nonfunctional button).
export function appleLoginSurface(os: string, webEnabled: boolean): AppleLoginSurface {
  if (os === 'ios') return 'native-ios';
  if (os === 'android') return 'disabled';
  return webEnabled ? 'web' : 'disabled';
}

// Resolves the backend API base URL the auth calls hit (DIC-922 blocker 5).
//
// The critical rule: native iOS/Android MUST use an ABSOLUTE origin. React
// Native's fetch cannot resolve a relative '/api', so a native build that fell
// back to '/api' fails every auth request before it leaves the device. Web, by
// contrast, is served same-origin with the API (holohunter.dicoge.com and any
// Vercel preview both host /api under the page origin), so it uses its own
// origin — which keeps cookies/CORS trivial and works on every deploy URL.
//
// Precedence: an explicit env override wins ONLY if it is an absolute http(s)
// URL (must already include the '/api' path segment, e.g.
// https://staging.example.com/api); then web same-origin; then the canonical
// production base for native. We never return a relative path here. Pure (no
// react-native/expo imports) so it is unit-testable.
const DEFAULT_NATIVE_API_BASE = 'https://holohunter.dicoge.com/api';

// An EXPO_PUBLIC_API_BASE_URL override is only trustworthy if it is an ABSOLUTE
// http(s) URL with a valid host (DIC-928 blocker 4, DIC-934 CR fix). A relative
// value like '/api' is exactly the bug we fixed — React Native's fetch can't
// resolve it and every auth call dies on-device — and a malformed value
// (scheme-looking garbage, bad IPv6, invalid port) would silently point auth at
// the wrong place. So we validate with real URL parsing and FAIL CLOSED: an
// override that isn't a well-formed absolute http(s) URL is ignored, and
// resolution falls back to the safe platform default.
function absoluteHttpOverride(raw: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  // The WHATWG URL parser treats any bracket-wrapped string as a hostname;
  // explicitly reject bare brackets that aren't valid IPv6.
  if (url.hostname.startsWith('[') && !/^\[[0-9a-fA-F:]+\]$/.test(url.hostname)) return null;
  // Guard against quasi-URLs like http:///api where the WHATWG parser
  // synthesises a host from the would-be path.
  if (!raw.startsWith(url.protocol + '//' + url.hostname)) return null;
  return raw.replace(/\/+$/, '');
}

export function resolveApiBase(params: {
  platformOS: string;
  webOrigin?: string | null;
  envOverride?: string | null;
}): string {
  const { platformOS, webOrigin, envOverride } = params;
  const override = absoluteHttpOverride((envOverride ?? '').trim());
  if (override) return override;
  if (platformOS === 'web' && webOrigin) {
    return `${webOrigin.replace(/\/+$/, '')}/api`;
  }
  return DEFAULT_NATIVE_API_BASE;
}

// Deterministic Web Google OAuth redirect URI (DIC-922).
//
// PM hit a hard `400 redirect_uri_mismatch` in production: the app sent exactly
// `https://holohunter.dicoge.com` but Google Console had no matching Authorized
// redirect URI. expo-auth-session's makeRedirectUri() derives the web redirect
// from the CURRENT window.location, so the value silently changes with the page
// path/hash the login was launched from and with the deploy origin (preview
// URLs, localhost) — impossible to keep byte-identical to a single registered
// URI. Expo's own docs say to hard-code the redirect for production web.
//
// We pin it to the bare page ORIGIN — no path, query, or hash — which is
// exactly what production was already observed to send. It is stable per-origin,
// so each origin (prod / preview / localhost) needs registering in Console just
// once, with NO trailing slash. An explicit override wins for atypical hosting.
// Returns '' when no origin is known (e.g. SSR); the caller then falls back to
// makeRedirectUri(). Pure (no react-native/expo imports) so it is unit-testable.
export function resolveWebRedirectUri(params: {
  origin?: string | null;
  override?: string | null;
}): string {
  const override = (params.override ?? '').trim();
  if (override) return override.replace(/\/+$/, '');
  const origin = (params.origin ?? '').trim();
  return origin.replace(/\/+$/, '');
}
