/**
 * Web + Android Sign in with Apple, server-callback path (DIC-960).
 *
 * Apple's web OAuth uses `response_mode=form_post`: after the user authorizes,
 * Apple POSTs the `id_token` / `code` / `state` (and, on first login only, a
 * `user` JSON) as `application/x-www-form-urlencoded` to the registered return
 * URL. A pure SPA cannot receive that cross-origin POST, so both the browser and
 * the Android Custom Tabs flow must land on a SERVER endpoint that receives the
 * POST, verifies it, resolves the server-authoritative identity/session, and then
 * bounces the browser back into the app.
 *
 * This module holds the pure, unit-testable pieces of that endpoint so the
 * security-critical logic (state signing, nonce binding, form_post parsing,
 * open-redirect defence, fail-closed config gating) is exercised in plain Node
 * without a live Apple / KV dependency. The thin serverless wiring lives in
 * api/auth/apple/web.ts.
 *
 * NO Apple secrets, Team IDs, Service IDs, domains, or return URLs are baked in
 * here: every value comes from env and a missing/blank value FAILS CLOSED (the
 * endpoint returns 501 and never emits a half-configured authorize request).
 */
import crypto from 'crypto';

export const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';

// The public config the server-callback flow needs. `serviceId` is the Apple
// Services ID (the web/android OAuth client_id == id_token `aud`); `redirectUri`
// is the HTTPS return URL registered with Apple that Apple form_posts back to
// (== this endpoint's own URL); `allowedReturns` is the allow-list of in-app
// return targets we are willing to bounce the browser to after login (open-
// redirect defence); `secret` signs the stateless `state` blob.
export interface AppleWebOAuthConfig {
  serviceId: string;
  redirectUri: string;
  allowedReturns: string[];
  secret: string;
}

/**
 * Read the Web/Android Apple config from env, FAIL CLOSED (null) if the operator
 * has not fully configured it. Gated behind the same `APPLE_WEB_LOGIN_ENABLED`
 * flag the token-verify audience allow-list uses, so a token issued while the
 * path is disabled also fails the audience check — defence in depth. Every field
 * is an operator-supplied placeholder; none is committed.
 */
export function getAppleWebOAuthConfig(env: NodeJS.ProcessEnv = process.env): AppleWebOAuthConfig | null {
  if (env.APPLE_WEB_LOGIN_ENABLED !== 'true') return null;
  const serviceId = env.APPLE_CLIENT_ID || env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';
  const redirectUri = env.APPLE_WEB_REDIRECT_URI || '';
  const secret = env.AUTH_SESSION_SECRET || '';
  const allowedReturns = (env.APPLE_WEB_ALLOWED_RETURNS || '')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (!serviceId || !redirectUri || !secret || allowedReturns.length === 0) return null;
  return { serviceId, redirectUri, allowedReturns, secret };
}

// ---------------------------------------------------------------------------
// Stateless signed state
// ---------------------------------------------------------------------------
//
// Apple POSTs back to the SERVER, not into the SPA's JS context, so the expected
// OIDC nonce cannot live in browser memory across the redirect. We instead carry
// it inside a signed `state` blob (HMAC-SHA256 with AUTH_SESSION_SECRET, the same
// primitive as session.ts): the start endpoint mints nonce+state and hands both
// to Apple; the callback verifies the state signature to recover the EXPECTED
// nonce, then checks the id_token's `nonce` claim against it. Tampering with the
// nonce (or the return target) breaks the signature and fails closed. No server
// storage / KV is needed, which keeps the flow stateless and horizontally safe.

export type AppleWebPlatform = 'web' | 'android';

export interface AppleWebState {
  nonce: string;
  platform: AppleWebPlatform;
  // The already-allow-listed in-app return target, pinned at start time so the
  // callback bounces exactly where the start request was authorised to.
  ret: string;
  // Anti-CSRF random; bound into the signature so a state cannot be spliced.
  csrf: string;
  // PKCE-style code challenge = base64url(SHA-256(verifier)). The app mints a
  // verifier at start, sends ONLY the challenge (through the TLS start request
  // and, signed, through Apple), and later presents the verifier to redeem the
  // one-time exchange code. The raw session therefore never rides the (on
  // Android, potentially interceptable) return channel — an interceptor of the
  // returned code cannot redeem it without the verifier, which never left the app.
  chal: string;
  // Epoch seconds. A stale authorize round-trip must not be replayable forever.
  exp: number;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(payload: string, key: string): string {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function signAppleState(state: AppleWebState, secret: string): string {
  if (!secret) throw new Error('AUTH_SESSION_SECRET is not configured');
  const encoded = base64url(JSON.stringify(state));
  return `${encoded}.${hmac(encoded, secret)}`;
}

/**
 * Verify a signed state and return its payload, or null when the signature is
 * wrong, the blob is malformed, a field is missing/invalid, or it has expired.
 * Constant-time signature compare (timingSafeEqual) mirrors verifySession.
 */
export function verifyAppleState(
  token: string | null | undefined,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): AppleWebState | null {
  if (!secret || !token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = hmac(encoded, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AppleWebState;
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.nonce !== 'string' || !payload.nonce) return null;
    if (payload.platform !== 'web' && payload.platform !== 'android') return null;
    if (typeof payload.ret !== 'string' || !payload.ret) return null;
    if (typeof payload.chal !== 'string' || !payload.chal) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    if (nowSec >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---------------------------------------------------------------------------
// PKCE-style exchange-code binding
// ---------------------------------------------------------------------------
//
// The callback never emits the raw session on the return channel; it emits a
// one-time exchange code and stores the session under it server-side, bound to
// the code challenge from the signed state. The app redeems the code by
// presenting the verifier; the server recomputes SHA-256(verifier) and compares
// it to the stored challenge. So even if the returned code leaks (a not-yet-
// verified Android App Link, a race), it is unredeemable without the verifier.

export function codeChallengeOf(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Constant-time check that `verifier` hashes to `challenge`. Returns false for
 * any empty input or length mismatch, mirroring verifyAppleState's timing-safe
 * compare so a redemption attempt cannot be distinguished by timing.
 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const expected = Buffer.from(codeChallengeOf(verifier));
  const provided = Buffer.from(challenge);
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export function buildAppleAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  scope?: string;
}): string {
  const url = new URL(APPLE_AUTHORIZE_URL);
  // `code id_token` + form_post is Apple's documented web contract; the id_token
  // arrives directly in the POST so the server can verify it without a code
  // exchange (the code is still forwarded for optional refresh-token capture).
  url.searchParams.set('response_type', 'code id_token');
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope ?? 'name email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  return url.toString();
}

// ---------------------------------------------------------------------------
// form_post parsing
// ---------------------------------------------------------------------------

export interface AppleFormPost {
  idToken?: string;
  code?: string;
  state?: string;
  user?: string;
  error?: string;
}

export function parseAppleFormPost(rawBody: string): AppleFormPost {
  const params = new URLSearchParams(rawBody ?? '');
  const pick = (k: string): string | undefined => {
    const v = params.get(k);
    return v == null || v === '' ? undefined : v;
  };
  return {
    idToken: pick('id_token'),
    code: pick('code'),
    state: pick('state'),
    user: pick('user'),
    error: pick('error'),
  };
}

/**
 * Apple sends the user's name/email ONLY on the very first authorization, as a
 * `user` JSON form field (not in the id_token). Parse it best-effort into a
 * display name; identity itself is always (provider=apple, sub) from the verified
 * id_token, never this field. Malformed JSON yields no name (never throws).
 */
export function parseAppleUserName(userField: string | undefined): string | undefined {
  if (!userField) return undefined;
  try {
    const parsed = JSON.parse(userField) as { name?: { firstName?: string; lastName?: string } };
    const first = parsed?.name?.firstName?.trim() ?? '';
    const last = parsed?.name?.lastName?.trim() ?? '';
    const full = `${first} ${last}`.trim();
    return full || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Return-target allow-list (open-redirect defence)
// ---------------------------------------------------------------------------

/**
 * Resolve the in-app return target the browser will be bounced to after login.
 * A requested target is honoured ONLY when it exactly matches an allow-listed
 * entry (open-redirect defence). A missing requested target falls back to the
 * FIRST allow-listed entry. Anything not on the list fails closed (null). This
 * runs both at start (to pin `ret` into the signed state) and is implicitly
 * re-validated at callback because `ret` was signed.
 */
export function resolveReturnTarget(
  requested: string | null | undefined,
  cfg: AppleWebOAuthConfig,
): string | null {
  const allow = cfg.allowedReturns;
  if (allow.length === 0) return null;
  const req = (requested ?? '').trim();
  if (!req) return allow[0];
  return allow.includes(req) ? req : null;
}

// ---------------------------------------------------------------------------
// Return-to-app HTML
// ---------------------------------------------------------------------------
//
// The callback cannot hand the session back as JSON (Apple drove the browser
// here via a top-level POST). It returns a tiny HTML page that navigates the
// browser to the in-app return target with a ONE-TIME EXCHANGE CODE (never the
// session itself) in the URL FRAGMENT. Fragment (not query): fragments are never
// sent to a server and are kept out of access logs / Referer. The app reads the
// fragment, POSTs the code + its PKCE verifier to /api/auth/apple-exchange to
// redeem the actual session, then validates it against /api/auth/me before
// entering authenticated UI. Putting a code (not the bearer session) on the
// return channel is what keeps a not-yet-verified Android App Link fail-closed:
// an intercepted code is useless without the verifier held only by the real app.

// Encode a value safely for embedding inside a <script> string literal: JSON
// escapes quotes/backslashes/control chars, and we additionally neutralise `<`
// so a `</script>` sequence can never break out of the script context.
function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function htmlDoc(redirectUrl: string): string {
  const literal = jsStringLiteral(redirectUrl);
  const noscriptHref = redirectUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"></head><body><script>location.replace(${literal});</script><noscript><a href="${noscriptHref}">Continue</a></noscript></body></html>`;
}

export function buildAppleReturnHtml(target: string, result: { code: string }): string {
  const frag = `code=${encodeURIComponent(result.code)}`;
  return htmlDoc(`${target}#${frag}`);
}

export function buildAppleErrorHtml(target: string | null, errorCode: string): string {
  const code = encodeURIComponent(errorCode || 'apple_failed');
  // With no trustworthy return target (invalid/forged state) we cannot safely
  // bounce anywhere — render a terminal error page instead of an open redirect.
  if (!target) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"></head><body>Apple 登入失敗（${code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}）</body></html>`;
  }
  return htmlDoc(`${target}#error=${code}`);
}
