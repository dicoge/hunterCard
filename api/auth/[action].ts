/**
 * POST /api/auth/{login|link|unlink|logout|delete-account}  (DIC-663)
 *
 * These sibling actions are served by a single Vercel Serverless Function (a
 * dynamic `[action]` route) rather than one function per file. That keeps the
 * project within the platform's per-deployment function budget (CR blocker #5)
 * while the URLs the client calls stay exactly the same.
 *
 * All actions fail closed: if the backend (KV / session secret / provider
 * verify) is not configured the endpoint returns 501 and the client must NOT
 * treat the operation as successful.
 */
import { deleteUser, getUser, linkIdentity, loginOrCreate, unlinkIdentity } from '../lib/identity-store';
import {
  issueSession,
  revokeAllUserSessions,
  revokeSession,
  revokeSessionsByProvider,
} from '../lib/session';
import { getAppleConfig, revokeRefreshToken } from '../lib/apple-auth';
import { deleteStoredAppleRefreshToken, getStoredAppleRefreshToken } from '../lib/apple-token-store';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionContext,
  sessionUserId,
  verifyProviderToken,
} from '../lib/auth-endpoint';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface ProviderBody {
  provider?: unknown;
  idToken?: unknown;
  nonce?: unknown;
}

function actionOf(req: Request): string {
  const path = new URL(req.url).pathname; // e.g. /api/auth/login
  return path.split('/').filter(Boolean).pop() ?? '';
}

async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function handleLogin(req: Request): Promise<Response> {
  const body = await readBody<ProviderBody>(req);
  if (!body) return json({ error: 'invalid_json' }, 400);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) return json({ error: 'missing_id_token' }, 400);
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;

  const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
  const { user, isNew } = await loginOrCreate(identity);
  // Stamp the session with the provider that minted it so a later unlink of that
  // provider can revoke exactly these tokens (CR blocker #2).
  return json({ user, isNew, session: await issueSession(user.internalId, body.provider) }, 200);
}

async function handleLink(req: Request): Promise<Response> {
  const userId = await sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  const body = await readBody<ProviderBody>(req);
  if (!body) return json({ error: 'invalid_json' }, 400);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) return json({ error: 'missing_id_token' }, 400);
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;

  const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
  const { user, alreadyLinked } = await linkIdentity(userId, identity);
  return json({ ok: true, user, alreadyLinked }, 200);
}

async function handleUnlink(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  if (!ctx) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  const body = await readBody<{ provider?: unknown }>(req);
  if (!body) return json({ error: 'invalid_json' }, 400);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);

  const user = await unlinkIdentity(ctx.userId, body.provider);
  // Removing a login method revokes exactly the sessions that provider minted —
  // including the caller's own token if it came from the removed provider — while
  // leaving other still-linked providers' sessions intact (CR blocker #2).
  await revokeSessionsByProvider(ctx.userId, body.provider);
  return json({ ok: true, user }, 200);
}

async function handleLogout(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  // Idempotent: an already-invalid token is a successful logout.
  if (ctx) await revokeSession(ctx.userId, ctx.jti);
  return json({ ok: true }, 200);
}

async function handleDeleteAccount(req: Request): Promise<Response> {
  const userId = await sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);

  const user = await getUser(userId);
  if (!user) return json({ deleted: false, reason: 'user_not_found' }, 404);

  const hasApple = user.linkedProviders.some((p) => p.provider === 'apple');
  if (hasApple) {
    // Apple requires the authorization to be revoked (App Store 5.1.1(v)). Fail
    // closed: without confirmed revocation we delete nothing.
    const cfg = getAppleConfig();
    if (!cfg) return json({ deleted: false, reason: 'apple_revocation_not_configured' }, 501);
    const refreshToken = await getStoredAppleRefreshToken(userId);
    if (!refreshToken) return json({ deleted: false, reason: 'apple_deletion_not_implemented' }, 501);
    const revoked = await revokeRefreshToken(cfg, refreshToken);
    if (!revoked) return json({ deleted: false, reason: 'revoke_failed' }, 502);
    await deleteStoredAppleRefreshToken(userId);
  }

  const result = await deleteUser(userId);
  await revokeAllUserSessions(userId);
  return json({ deleted: result.deletedInternalUser, revokedApple: hasApple }, 200);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  try {
    switch (actionOf(req)) {
      case 'login':
        return await handleLogin(req);
      case 'link':
        return await handleLink(req);
      case 'unlink':
        return await handleUnlink(req);
      case 'logout':
        return await handleLogout(req);
      case 'delete-account':
        return await handleDeleteAccount(req);
      default:
        return json({ error: 'not_found' }, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
