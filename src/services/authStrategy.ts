// Platform → login-surface routing (DIC-665).
//
// Pure functions, no react-native / expo imports, so the routing decision is
// unit-testable in plain Node and cannot silently regress (e.g. Android falling
// back to the browser PKCE path instead of native Google Sign-In). authService
// consumes these to dispatch; identity is always resolved server-side regardless
// of which surface produced the provider ID token.

import { PRODUCTION_ORIGIN } from '../config/apiOrigin';

export type GoogleLoginSurface = 'native-ios' | 'native-android' | 'web';
export type AppleLoginSurface = 'native-ios' | 'web' | 'android-web' | 'disabled';

// Google: native SDK on iOS (dedicated iOS OAuth client) and Android (classic
// play-services-auth Google Sign-In, ID token audienced to the Web/server
// client). Every other platform — web — uses the browser OAuth/PKCE path.
export function googleLoginSurface(os: string): GoogleLoginSurface {
  if (os === 'ios') return 'native-ios';
  if (os === 'android') return 'native-android';
  return 'web';
}

// Apple: native Sign in with Apple on iOS. Web and Android both run the
// server-callback web-OAuth path (DIC-960): the browser / Custom Tabs hit
// /api/auth/apple/web, Apple form_posts the id_token back to that server
// endpoint, and the app is deep-linked back with a one-time exchange code the app
// redeems for a server session. Web and Android are gated behind the
// operator-enabled server-verified Web Apple path (APPLE_WEB_ENABLED) and FAIL
// CLOSED to 'disabled' when it is off.
//
// Android carries an EXTRA gate (androidEnabled). Its return channel MUST be a
// VERIFIED HTTPS App Link — a custom scheme is not app-exclusive and could let
// another installed app intercept the return (CR DIC-961). App Link verification
// depends on a deployed /.well-known/assetlinks.json carrying the real signing-
// cert fingerprint, which is owner-only. Until the operator supplies it and flips
// androidEnabled on, Android Apple stays 'disabled' (never a custom-scheme
// fallback). Android differs from web only in the return surface ('android-web' →
// Custom Tabs + App Link return); both share the same backend contract.
export function appleLoginSurface(
  os: string,
  webEnabled: boolean,
  androidEnabled = false,
): AppleLoginSurface {
  if (os === 'ios') return 'native-ios';
  if (!webEnabled) return 'disabled';
  if (os === 'android') return androidEnabled ? 'android-web' : 'disabled';
  return 'web';
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
const DEFAULT_NATIVE_API_BASE = `${PRODUCTION_ORIGIN}/api`;

// An EXPO_PUBLIC_API_BASE_URL override is only trustworthy if it is an ABSOLUTE
// http(s) URL with a valid host (DIC-928 blocker 4, DIC-934 CR fixes). A
// relative value like '/api' is exactly the bug we fixed — React Native's fetch
// can't resolve it and every auth call dies on-device — and a malformed value
// (scheme-looking garbage, bad IPv6, invalid port, control characters,
// invalid percent-encoding) would silently point auth at the wrong place or
// behave differently across parsers. So we validate with real URL parsing,
// return the parser-CANONICAL form (not the raw input), and FAIL CLOSED: an
// override that isn't a well-formed absolute http(s) URL is ignored and falls
// back to the safe platform default.
function absoluteHttpOverride(raw: string): string | null {
  if (!raw) return null;
  // Reject control characters and backslashes on the RAW input before any
  // normalization like .trim() that would silently drop them (DIC-934 CR).
  if (/[\\\x00-\x1F\x7F]/.test(raw)) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
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
  if (!trimmed.startsWith(url.protocol + '//' + url.hostname)) return null;
  // Return the parser-canonical form — this normalises backslashes, redundant
  // dots, and other edge cases to a single deterministic string that native
  // fetch will resolve consistently. Never return the raw input.
  const normalized = url.href;
  // Reject invalid percent-encoding (% followed by a non-hex byte). Valid
  // percent-encoding is %XX where both X are hex digits (0-9a-fA-F). Invalid
  // encodings like %zz are parser-differential — different runtimes resolve
  // them differently — so we fail closed.
  if (/%(?![0-9a-fA-F]{2})/.test(normalized)) return null;
  // Strip trailing slashes from the pathname only — never from the full href,
  // which would corrupt query values (e.g. ?next=/ → ?next=).
  return url.origin + url.pathname.replace(/\/+$/, '') + url.search + url.hash;
}

export function resolveApiBase(params: {
  platformOS: string;
  webOrigin?: string | null;
  envOverride?: string | null;
}): string {
  const { platformOS, webOrigin, envOverride } = params;
  const override = absoluteHttpOverride(envOverride ?? '');
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

// Web Google login TRANSPORT selection (DIC-976).
//
// The default expo-auth-session web flow opens the provider in a popup
// (WebBrowser.openAuthSessionAsync → window.open) and waits for the popup to
// postMessage the code back to window.opener. That transport is fundamentally
// broken inside an iOS Home-Screen PWA (manifest display:standalone): iOS opens
// the OAuth URL in a SEPARATE Safari process with no opener relationship to the
// standalone webview, so the code is never posted back — window.open either
// returns null (ERR_WEB_BROWSER_BLOCKED, the observed 登入失敗 alert) or opens a
// detached tab whose result the PWA can never read. The owner reproduced exactly
// this on an iPhone standalone Settings page (DIC-976).
//
// The fix is to run the OAuth prompt as a SAME-WINDOW full-page redirect on web:
// navigate the app's own window to Google, let Google 302 back to the app origin
// with ?code&state, and finish the PKCE exchange on the next app load. That has
// no popup and no opener dependency, so it works in standalone PWAs, regular
// mobile Safari, and desktop alike. We therefore use the redirect transport for
// ALL web (never just standalone) — one code path, no UA sniffing, and it is the
// transport Google itself documents for browser OIDC. Native iOS/Android are
// unaffected (they never reach this — they use the native SDK surfaces).
export type WebGoogleTransport = 'redirect' | 'popup';

// `os` is the react-native Platform.OS; only the web platform uses a browser
// transport at all. Kept as a parameter (not a constant) so the decision stays
// pure and unit-testable, and so a future flag could re-enable popup for a
// specific surface without touching authService.
export function webGoogleTransport(os: string): WebGoogleTransport {
  if (os !== 'web') return 'popup'; // native never uses this; value is inert.
  return 'redirect';
}

// Detects an iOS Home-Screen standalone PWA from the two signals a browser
// exposes: navigator.standalone (legacy iOS Safari) and the
// display-mode:standalone media query (installed PWAs on every engine). Pure —
// the caller passes the already-read booleans so this stays testable in Node.
// Not used to GATE the redirect transport (we redirect on all web) but kept for
// diagnostics: it lets us tag a standalone launch in the (safe) error code so a
// future standalone-only regression is distinguishable from a desktop one.
export function isStandalonePwa(params: {
  navigatorStandalone?: boolean | null;
  displayModeStandalone?: boolean | null;
}): boolean {
  return Boolean(params.navigatorStandalone) || Boolean(params.displayModeStandalone);
}

// Serialises the minimal state the redirect flow must survive across the
// full-page navigation to Google and back. Only PKCE verifier + OIDC nonce +
// the CSRF `state` are kept; nothing secret beyond the verifier (which never
// leaves the origin — it is stored in same-origin localStorage and consumed on
// return, exactly like the popup flow held it in memory). Pure JSON, no browser
// APIs, so serialise/parse round-trips are unit-testable.
// The operation the redirect was launched FOR (DIC-976 CR blocker 1). The web
// redirect transport is shared by BOTH sign-in and Settings "link Google", but
// the return leg must dispatch to the RIGHT endpoint: 'login' → /auth/login
// (unauthenticated, may create/switch account), 'link' → /auth/link with the
// caller's EXISTING session (attaches Google to the current account). Losing
// this distinction let a "link Google" silently log the user in as a different
// account — the exact bug the CR flagged.
export type WebRedirectOperation = 'login' | 'link';

export interface WebRedirectPendingState {
  // PKCE verifier. Only present for a legacy authorization-code payload written
  // by a previous build. The web-Google flow no longer mints one: Google's token
  // endpoint advertises only client_secret_post / client_secret_basic (no
  // `none`), so a browser cannot redeem an authorization code without shipping
  // the Web client secret. The flow now requests an id_token directly, which
  // needs no exchange and therefore no verifier (DIC-976).
  codeVerifier?: string;
  nonce: string;
  state: string;
  createdAt: number;
  // Which flow launched the redirect. Persisted so the return leg calls the
  // correct endpoint. Absent in legacy payloads → treated as 'login' on parse.
  operation: WebRedirectOperation;
  // The authenticated session to resume a 'link' with. REQUIRED when
  // operation === 'link' (parse fails closed without it) and MUST be absent for
  // 'login' (a login has no prior session). This is the same session token the
  // auth store already persists in localStorage, so it introduces no new
  // exposure surface.
  session?: string;
}

export function serializeWebRedirectState(s: WebRedirectPendingState): string {
  return JSON.stringify(s);
}

// Parse + validate persisted redirect state. Returns null (never throws) for
// any malformed / incomplete / stale (> maxAgeMs) payload so a corrupt or
// leftover localStorage entry fails CLOSED — the app simply treats it as "no
// pending login" rather than attempting an exchange with half state. A 'link'
// payload MISSING its session is rejected (null): resuming a link without the
// authenticated session would fall back to an unauthenticated /auth/login and
// switch accounts, so we refuse it rather than guess (CR blocker 1, fail closed).
export function parseWebRedirectState(
  raw: string | null | undefined,
  maxAgeMs = 10 * 60 * 1000,
  now = Date.now(),
): WebRedirectPendingState | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  // codeVerifier is optional (legacy authorization-code payload). When present it
  // must still be a non-empty string — a malformed value means a corrupt payload.
  if (o.codeVerifier !== undefined && (typeof o.codeVerifier !== 'string' || !o.codeVerifier)) {
    return null;
  }
  if (typeof o.nonce !== 'string' || !o.nonce) return null;
  if (typeof o.state !== 'string' || !o.state) return null;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return null;
  if (now - o.createdAt > maxAgeMs) return null;

  // Operation defaults to 'login' when absent (legacy / login payloads); any
  // other explicit value than 'login'/'link' is corrupt → fail closed.
  let operation: WebRedirectOperation;
  if (o.operation === undefined || o.operation === 'login') {
    operation = 'login';
  } else if (o.operation === 'link') {
    operation = 'link';
  } else {
    return null;
  }

  let session: string | undefined;
  if (operation === 'link') {
    // A link MUST carry the session to resume; without it we'd silently degrade
    // to an unauthenticated login (account switch). Refuse.
    if (typeof o.session !== 'string' || !o.session) return null;
    session = o.session;
  } else {
    // A login must NOT carry a session; if one is present the payload is
    // malformed/tampered — fail closed rather than trust mixed state.
    if (o.session !== undefined) return null;
  }

  return {
    ...(typeof o.codeVerifier === 'string' && o.codeVerifier ? { codeVerifier: o.codeVerifier } : {}),
    nonce: o.nonce,
    state: o.state,
    createdAt: o.createdAt,
    operation,
    ...(session ? { session } : {}),
  };
}

// Classifies the OAuth return encoded in the app URL after Google redirects
// back. Reads ONLY the short machine params (code / state / error) from the
// query string; never a human error_description (which can carry detail). The
// caller matches `state` against the persisted state before trusting `code`
// (CSRF defence), and surfaces `error` as a safe code. Returns kind 'none' when
// this is an ordinary app load with no OAuth params, so boot stays a no-op.
// Pure: takes the raw search string (e.g. window.location.search), no globals.
export interface WebRedirectReturn {
  // 'malformed' = OAuth-SHAPED but unusable (a credential without its CSRF
  // state, a bare unredeemable code, a lone `iss`). It is deliberately NOT
  // 'none': the caller must still consume the pending state and scrub the URL,
  // or provider material would linger in history and the pending state would
  // stay replayable. 'none' means an ordinary page load we must not touch.
  kind: 'none' | 'success' | 'error' | 'malformed';
  idToken?: string;
  state?: string;
  error?: string;
}

// Every key an OAuth/OIDC provider may put on the return URL. ONE list drives
// both detection and scrubbing, so anything we clean up is also something we
// recognise as a callback — the two can never drift apart.
export const OAUTH_RETURN_KEYS = [
  'code',
  'id_token',
  'access_token',
  'token_type',
  'expires_in',
  'error',
  'error_description',
  'state',
  'scope',
  'authuser',
  'prompt',
  'hd',
  // RFC 9207 issuer identifier.
  'iss',
] as const;

// True when the URL carries ANY provider-owned key, in the query or fragment.
export function hasOAuthReturnKeys(
  search: string | null | undefined,
  hash?: string | null | undefined,
): boolean {
  const query = new URLSearchParams((search ?? '').replace(/^\?/, ''));
  const frag = new URLSearchParams((hash ?? '').replace(/^#/, ''));
  return OAUTH_RETURN_KEYS.some((key) => query.has(key) || frag.has(key));
}

// Google delivers an `id_token` response in the URL FRAGMENT (response_mode
// =fragment), so the fragment is the primary source; the query is still read
// because provider ERRORS and a legacy authorization-code return arrive there.
// A fragment value wins on conflict — it is the leg this flow actually requests.
//
// Note what this deliberately does NOT accept: a bare `code`. A browser cannot
// redeem one (Google requires a client secret at the token endpoint), so a
// code-only callback is not a usable credential and must not be reported as
// success. It falls through to 'none' and the caller fails closed.
export function parseWebRedirectReturn(
  search: string | null | undefined,
  hash?: string | null | undefined,
): WebRedirectReturn {
  const queryRaw = (search ?? '').replace(/^\?/, '');
  const hashRaw = (hash ?? '').replace(/^#/, '');
  if (!queryRaw && !hashRaw) return { kind: 'none' };
  const query = new URLSearchParams(queryRaw);
  const frag = new URLSearchParams(hashRaw);
  const pick = (key: string): string | undefined => frag.get(key) || query.get(key) || undefined;

  const error = pick('error');
  const state = pick('state');
  if (error) return { kind: 'error', error, state };
  const idToken = pick('id_token');
  if (idToken && state) return { kind: 'success', idToken, state };
  // OAuth-shaped but not usable. Reported as 'malformed' (not 'none') so the
  // caller still cleans up: an id_token without state, a bare code, or an
  // `iss`-only return must never be left sitting in the URL/history, and the
  // pending state must not survive to be replayed.
  if (hasOAuthReturnKeys(queryRaw, hashRaw)) return { kind: 'malformed' };
  return { kind: 'none' };
}
