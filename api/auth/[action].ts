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
  markUserDeleted,
  rebindSessionProvider,
  revokeAllUserSessions,
  revokeSession,
  revokeSessionsByProvider,
  wasUserDeleted,
} from '../_lib/session';
import { getAppleConfig, revokeRefreshToken } from '../_lib/apple-auth';
import { deleteStoredAppleRefreshToken, getStoredAppleRefreshToken } from '../_lib/apple-token-store';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionClaims,
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
  // Mint the session INSIDE login-or-create's per-user lock (CR round-6 blocker
  // #2): a concurrent unlink/delete cannot finish between validating the user and
  // issuing its token, so we never hand out a valid session for an unlinked
  // provider or a deleted user. The session is stamped with the minting provider
  // so a later unlink of that provider can revoke exactly these tokens.
  const { user, isNew, session } = await loginOrCreate(identity, (uid) =>
    issueSession(uid, body.provider as 'google' | 'apple'),
  );
  return json({ user, isNew, session }, 200);
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

  // Recoverable caller-session handling (CR round-5 blocker #1, made atomic in
  // round-6 blocker #1). If the caller's own token was minted by the provider
  // being removed, RE-BIND that token to a still-linked provider BEFORE the
  // provider-scoped revoke, instead of revoking it and minting a replacement.
  // Re-binding keeps the SAME token valid, so there is no new credential to
  // deliver and a lost response is harmless. The revoke below then skips the
  // caller (its provider no longer matches) and kills every OTHER token the
  // removed provider minted.
  //
  // The rebind is a single atomic SET XX KEEPTTL and reports whether it succeeded.
  // If it returns false — a concurrent logout already revoked the caller's token —
  // we do NOT claim the session survived: callerSessionRevoked reflects the real
  // outcome so the client drops a dead token instead of keeping it (round-6 #1).
  let callerSessionRevoked = false;
  if (ctx.provider === body.provider) {
    const remaining = user.linkedProviders[0]?.provider; // last-method guard ⇒ ≥1 remains
    const rebound = remaining
      ? await rebindSessionProvider(ctx.userId, ctx.jti, remaining)
      : false;
    callerSessionRevoked = !rebound;
  }
  await revokeSessionsByProvider(ctx.userId, body.provider);

  return json({ ok: true, user, callerSessionRevoked }, 200);
}

async function handleLogout(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  // Idempotent: an already-invalid token is a successful logout.
  if (ctx) await revokeSession(ctx.userId, ctx.jti);
  return json({ ok: true }, 200);
}

async function handleDeleteAccount(req: Request): Promise<Response> {
  const ctx = await sessionContext(req);
  if (!ctx) {
    // The full session check failed. Distinguish "already deleted" from a plain
    // bad token via the durable deletion receipt (CR round-6 blocker #3): a
    // successful delete revokes EVERY bearer, so a retry after a lost response
    // arrives here with a token sessionContext rejects. Its signed claims still
    // authentically name which user it was; if that user has a deletion receipt,
    // answer the idempotent "already deleted" WITHOUT authenticating any action,
    // and re-run the idempotent cleanups so a delete whose later steps were lost
    // still converges. No receipt ⇒ a genuinely invalid/expired token ⇒ 401.
    const claims = sessionClaims(req);
    if (claims && (await wasUserDeleted(claims.sub))) {
      await deleteStoredAppleRefreshToken(claims.sub);
      await revokeAllUserSessions(claims.sub);
      return json({ deleted: true, revokedApple: false }, 200);
    }
    return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  }
  const userId = ctx.userId;

  const user = await getUser(userId);
  if (!user) {
    // The session verified but the user record is gone: a delete committed in the
    // narrow window since verifySessionContext read the user. Converge idempotently
    // — write the receipt (so a later revoked-token retry recovers), then re-run
    // cleanup — instead of returning 404.
    await markUserDeleted(userId);
    await deleteStoredAppleRefreshToken(userId);
    await revokeAllUserSessions(userId);
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

  // Retry-convergent ordering (CR round-6 blocker #3). Delete the identity FIRST
  // (the durable commit), THEN write the deletion receipt BEFORE revoking sessions
  // — the receipt is what lets a caller whose token we are about to revoke recover
  // from a lost response. Then discard the Apple token and revoke EVERY session
  // including the caller's own, so after a successful delete no bearer authenticates
  // (the all-session-revocation contract). If any write here fails, the caller
  // retries with its (now revoked) token and lands in the receipt-recovery branch
  // above, which re-runs this idempotent cleanup.
  const result = await deleteUser(userId);
  await markUserDeleted(userId);
  if (hasApple) await deleteStoredAppleRefreshToken(userId);
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
