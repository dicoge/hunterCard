/**
 * GET/POST /api/auth/apple/web  (DIC-960)
 *
 * The server-callback Sign in with Apple path for Web AND Android. One
 * Serverless Function serves both roles (keeping within the Vercel Hobby
 * 12-function cap) via filesystem routing on a single URL:
 *
 *   - GET  (start)    — mint nonce + signed state, 302-redirect the browser to
 *                       Apple's authorize endpoint (`response_mode=form_post`).
 *                       `?platform=web|android` and `?return=<allow-listed app
 *                       target>` decide where the callback bounces back to.
 *   - POST (callback) — the URL registered with Apple as the return URL. Apple
 *                       form_posts the id_token/code/state here; we verify the
 *                       state signature (recovering the expected nonce), verify
 *                       the id_token (issuer/audience/exp/signature/nonce) on the
 *                       SAME server verify path as native iOS, resolve identity
 *                       by (provider=apple, sub), issue the SAME server session,
 *                       and return HTML that deep-links back into the app with
 *                       the session in the URL fragment.
 *
 * Fail-closed: when the Apple web config is absent the start returns 501 and the
 * callback renders a terminal error page — a half-configured flow never runs.
 * No Apple secrets/domains/return URLs are committed; all come from env.
 */
import { loginOrCreate } from '../../_lib/identity-store';
import { issueSession } from '../../_lib/session';
import { backendUnavailable, verifyProviderToken } from '../../_lib/auth-endpoint';
import { toNodeHandler } from '../../_lib/node-adapter';
import {
  buildAppleAuthorizeUrl,
  buildAppleErrorHtml,
  buildAppleReturnHtml,
  getAppleWebOAuthConfig,
  parseAppleFormPost,
  parseAppleUserName,
  randomToken,
  resolveReturnTarget,
  signAppleState,
  verifyAppleState,
  type AppleWebPlatform,
} from '../../_lib/apple-web-oauth';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

const STATE_TTL_SECONDS = 600; // a login round-trip must complete within 10 min

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code ? code : 'apple_failed';
}

async function handleStart(req: Request): Promise<Response> {
  const cfg = getAppleWebOAuthConfig();
  if (!cfg) return json({ error: 'STORE_NOT_CONFIGURED', reason: 'apple_web_not_configured' }, 501);

  const url = new URL(req.url);
  const platform: AppleWebPlatform =
    url.searchParams.get('platform') === 'android' ? 'android' : 'web';
  const target = resolveReturnTarget(url.searchParams.get('return'), cfg);
  if (!target) return json({ error: 'invalid_return' }, 400);

  const nonce = randomToken();
  const state = signAppleState(
    { nonce, platform, ret: target, csrf: randomToken(), exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
    cfg.secret,
  );
  const authorizeUrl = buildAppleAuthorizeUrl({
    clientId: cfg.serviceId,
    redirectUri: cfg.redirectUri,
    state,
    nonce,
  });
  return new Response(null, { status: 302, headers: { Location: authorizeUrl } });
}

async function handleCallback(req: Request): Promise<Response> {
  const cfg = getAppleWebOAuthConfig();
  // Without config we cannot even trust the state to know where to bounce, so
  // render a terminal error page rather than an open redirect.
  if (!cfg) return html(buildAppleErrorHtml(null, 'apple_web_not_configured'), 501);

  const rawBody = await req.text();
  const { idToken, state, user, error } = parseAppleFormPost(rawBody);

  const parsed = verifyAppleState(state, cfg.secret);
  if (!parsed) return html(buildAppleErrorHtml(null, 'invalid_state'), 400);
  const target = parsed.ret;

  // Apple reported a user-facing failure/cancel: bounce it back to the app.
  if (error) return html(buildAppleErrorHtml(target, error), 200);
  if (!idToken) return html(buildAppleErrorHtml(target, 'no_id_token'), 200);

  const unavailable = backendUnavailable();
  if (unavailable) return html(buildAppleErrorHtml(target, 'backend_unavailable'), 200);

  let session: string;
  let isNew: boolean;
  try {
    // Same server verify path as native iOS: RS256 signature + issuer + audience
    // (Services ID, allow-listed only while APPLE_WEB_LOGIN_ENABLED) + exp +
    // nonce (bound to the signed state), plus single-use replay consumption.
    const identity = await verifyProviderToken('apple', idToken, parsed.nonce);
    // First-login-only name from the `user` field enriches display name; identity
    // stays keyed by (provider=apple, sub), never email or this field.
    const name = parseAppleUserName(user);
    const enriched = name && !identity.name ? { ...identity, name } : identity;
    const result = await loginOrCreate(enriched);
    session = issueSession(result.user.internalId);
    isNew = result.isNew;
  } catch (err) {
    return html(buildAppleErrorHtml(target, errorCodeOf(err)), 200);
  }

  return html(buildAppleReturnHtml(target, { session, isNew }), 200);
}

async function webHandler(req: Request): Promise<Response> {
  try {
    if (req.method === 'GET') return await handleStart(req);
    if (req.method === 'POST') return await handleCallback(req);
    return json({ error: 'method_not_allowed' }, 405);
  } catch {
    return json({ error: 'internal_error' }, 500);
  }
}

export default toNodeHandler(webHandler);
