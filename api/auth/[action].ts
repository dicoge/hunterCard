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
import { deleteUser, getUser, linkIdentity, loginOrCreate, unlinkIdentity } from '../_lib/identity-store';
import {
  issueSession,
  rebindSessionProvider,
  revokeOtherUserSessions,
  revokeSession,
  revokeSessionsByProvider,
} from '../_lib/session';
import { getAppleConfig, revokeRefreshToken } from '../_lib/apple-auth';
import { deleteStoredAppleRefreshToken, getStoredAppleRefreshToken } from '../_lib/apple-token-store';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionContext,
  sessionUserId,
  verifyProviderToken,
} from '../_lib/auth-endpoint';

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

  // Recoverable caller-session handling (CR round-5 blocker #1). If the caller's
  // own token was minted by the provider being removed, RE-BIND that token to a
  // still-linked provider BEFORE the provider-scoped revoke, instead of revoking
  // it and minting a replacement. Re-binding keeps the SAME token valid, so there
  // is no new credential to deliver and a lost response is harmless — the client
  // keeps using its existing token. The revoke below then skips the caller (its
  // provider no longer matches) and kills every OTHER token the removed provider
  // minted. unlink + re-bind + revoke are each idempotent, so a retry converges
  // and the caller is never left holding a dead token.
  if (ctx.provider === body.provider) {
    const remaining = user.linkedProviders[0]?.provider; // last-method guard ⇒ ≥1 remains
    if (remaining) await rebindSessionProvider(ctx.userId, ctx.jti, remaining);
  }
  await revokeSessionsByProvider(ctx.userId, body.provider);

  // The caller's token is always still valid here (either untouched, or re-bound
  // above), so callerSessionRevoked is false and the client keeps its session.
  return json({ ok: true, user, callerSessionRevoked: false }, 200);
}

async function handleLogout(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  // Idempotent: an already-invalid token is a successful logout.
  if (ctx) await revokeSession(ctx.userId, ctx.jti);
  return json({ ok: true }, 200);
}

async function handleDeleteAccount(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  if (!ctx) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  const userId = ctx.userId;

  const user = await getUser(userId);
  if (!user) {
    // Already deleted, OR a retry after a partial delete whose identity mutation
    // succeeded but a later cleanup step (session revocation / Apple token) did
    // not. Deletion is idempotent (CR round-4/5 blocker #2): re-run the idempotent
    // cleanups and report success so the retry converges instead of returning 404.
    await deleteStoredAppleRefreshToken(userId);
    await revokeOtherUserSessions(userId, ctx.jti);
    return json({ deleted: true, revokedApple: false }, 200);
  }

  const hasApple = user.linkedProviders.some((p) => p.provider === 'apple');
  if (hasApple) {
    // Apple requires the authorization to be revoked (App Store 5.1.1(v)). Fail
    // closed: without confirmed revocation we delete nothing. Apple's revoke
    // endpoint is idempotent, so a retry that re-revokes an already-revoked token
    // still succeeds — safe under convergence.
    const cfg = getAppleConfig();
    if (!cfg) return json({ deleted: false, reason: 'apple_revocation_not_configured' }, 501);
    const refreshToken = await getStoredAppleRefreshToken(userId);
    if (!refreshToken) return json({ deleted: false, reason: 'apple_deletion_not_implemented' }, 501);
    const revoked = await revokeRefreshToken(cfg, refreshToken);
    if (!revoked) return json({ deleted: false, reason: 'revoke_failed' }, 502);
  }

  // Retry-convergent, caller-recoverable ordering (CR round-5 blocker #2). Delete
  // the identity FIRST (the durable commit), THEN discard the Apple token, and
  // revoke every OTHER device's session — but deliberately NOT the caller's own.
  // Keeping the caller's token valid until the response is delivered is what makes
  // this recoverable: if any write here fails, the caller retries with a live
  // token and lands in the already-deleted branch above (which re-runs the
  // idempotent cleanup) rather than being locked out by a dead-token 401 that
  // leaves the UI wrongly claiming the account was not deleted. The caller drops
  // its own token locally on success; that record points at a deleted user, is
  // inert, and expires via TTL.
  const result = await deleteUser(userId);
  if (hasApple) await deleteStoredAppleRefreshToken(userId);
  await revokeOtherUserSessions(userId, ctx.jti);
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
