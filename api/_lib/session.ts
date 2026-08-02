/**
 * Server-authoritative session tokens (DIC-663). A session vouches for the
 * server-resolved internal user id so that link / unlink / delete act on a
 * server identity instead of a client-supplied user id.
 *
 * Token format: base64url(JSON payload) + '.' + HMAC-SHA256(payload), where the
 * payload carries a random `jti`. Fail-closed: when AUTH_SESSION_SECRET is unset,
 * issue throws and verify returns null.
 *
 * Revocation (CR blocker #2): a signed-and-unexpired token is NOT sufficient.
 * Each issued session also has a server record `auth:session:{jti}` -> userId
 * (and is tracked in `auth:user:{userId}:sessions`). verifySession requires that
 * record to still exist, so logout / unlink / delete can revoke a token before
 * its 30-day expiry. A stolen or copied token stops working the moment its
 * record is deleted.
 */
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export type SessionProvider = 'google' | 'apple';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const SESSION_KEY = (jti: string) => `auth:session:${jti}`;
const USER_SESSIONS_KEY = (userId: string) => `auth:user:${userId}:sessions`;
// The identity-store user record (see identity-store.ts USER_KEY). session.ts
// reads it DIRECTLY — not via an import of identity-store — so verifySession can
// reject a token whose backing user has been deleted without creating an
// identity-store ↔ session import cycle (CR round-6 blocker #3).
const USER_KEY = (userId: string) => `auth:user:${userId}`;
// Durable deletion receipt (CR round-6 blocker #3). Written on successful account
// deletion so a retry whose response was lost can be answered idempotently from
// the caller's still-signed (but now revoked) token WITHOUT keeping a live auth
// bearer. TTL matches the session lifetime: once every issued token for the user
// has expired, no retry can present one, so the receipt is no longer needed.
const DELETED_KEY = (userId: string) => `auth:deleted:${userId}`;
const DELETED_TTL_SECONDS = DEFAULT_TTL_SECONDS;

// Each session record stores which internal user it vouches for AND which
// provider identity minted it. The provider is what lets unlink revoke ONLY the
// sessions created by the removed identity (CR blocker #2) instead of the caller
// keeping the removed provider's token while other providers get logged out.
interface SessionRecord {
  sub: string; // internal user id
  provider: SessionProvider;
}

interface SessionPayload {
  sub: string; // internal user id
  jti: string; // session id, the revocation handle
  iat: number;
  exp: number;
}

export interface SessionContext {
  userId: string;
  jti: string;
  provider: SessionProvider;
}

function secret(): string | null {
  return process.env.AUTH_SESSION_SECRET || null;
}

function sign(payload: string, key: string): string {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

export function isSessionConfigured(): boolean {
  return Boolean(secret());
}

export async function issueSession(
  userId: string,
  provider: SessionProvider,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const key = secret();
  if (!key) throw new Error('AUTH_SESSION_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload: SessionPayload = { sub: userId, jti, iat: now, exp: now + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Record first so a token is never handed out that cannot be revoked. The
  // record carries the source provider so unlink can revoke provider-scoped.
  const record: SessionRecord = { sub: userId, provider };
  await kv.set(SESSION_KEY(jti), record, { px: ttlSeconds * 1000 });
  await kv.sadd(USER_SESSIONS_KEY(userId), jti);
  return `${encoded}.${sign(encoded, key)}`;
}

// Older sessions (pre-provider) stored the raw userId string; tolerate both so
// existing tokens keep working across the deploy.
function readRecord(stored: unknown): SessionRecord | null {
  if (typeof stored === 'string') return { sub: stored, provider: 'google' };
  if (stored && typeof stored === 'object' && typeof (stored as SessionRecord).sub === 'string') {
    const r = stored as SessionRecord;
    return { sub: r.sub, provider: r.provider === 'apple' ? 'apple' : 'google' };
  }
  return null;
}

/** HMAC + expiry check only (no revocation lookup). Returns the claims or null. */
function decodeClaims(token: string | null | undefined): SessionPayload | null {
  const key = secret();
  if (!key || !token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(encoded, key);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload.sub || !payload.jti || typeof payload.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Signature + expiry ONLY (no revocation / user lookup). Exposes the claims of a
 * token that may already be revoked, used exclusively by the delete endpoint's
 * response-loss recovery: a caller retrying a completed delete presents a token
 * whose session record is gone, so verifySessionContext rejects it, yet the
 * signed claims still authentically name which user the caller WAS. Pairing that
 * with the durable deletion receipt (wasUserDeleted) lets the retry get the
 * idempotent "already deleted" answer without ever authenticating an action.
 */
export function readSessionClaims(
  token: string | null | undefined,
): { sub: string; jti: string } | null {
  const claims = decodeClaims(token);
  return claims ? { sub: claims.sub, jti: claims.jti } : null;
}

/**
 * Full verification: signature + expiry + the session record still exists + the
 * backing user still exists. The user-existence check (CR round-6 blocker #3) is
 * what makes a successful account deletion revoke EVERY bearer: even if a session
 * record somehow outlived revoke-all, a token for a deleted user must not
 * authenticate (e.g. Apple register). Returns the context or null.
 */
export async function verifySessionContext(
  token: string | null | undefined,
): Promise<SessionContext | null> {
  const claims = decodeClaims(token);
  if (!claims) return null;
  const record = readRecord(await kv.get(SESSION_KEY(claims.jti)));
  if (!record || record.sub !== claims.sub) return null; // revoked, expired-out, or unknown
  if (!(await kv.get(USER_KEY(claims.sub)))) return null; // user deleted / nonexistent
  return { userId: claims.sub, jti: claims.jti, provider: record.provider };
}

/** Returns the internal user id if the session is valid and not revoked. */
export async function verifySession(token: string | null | undefined): Promise<string | null> {
  return (await verifySessionContext(token))?.userId ?? null;
}

async function forget(userId: string, jti: string): Promise<void> {
  await kv.del(SESSION_KEY(jti));
  await kv.srem(USER_SESSIONS_KEY(userId), jti);
}

/** Revoke a single session (logout of the current device). */
export async function revokeSession(userId: string, jti: string): Promise<void> {
  await forget(userId, jti);
}

/**
 * Re-bind an existing session to a different provider WITHOUT minting a new token
 * (CR round-5 blocker #1). Used by unlink: when the caller's own token was minted
 * by the provider being removed, we switch the token's stored provider to a still-
 * linked one instead of revoking it. The token string is unchanged, so nothing has
 * to be delivered back to the client and a lost response is harmless — the client
 * keeps using the SAME, still-valid token. The follow-up provider-scoped revoke
 * then skips this session (its provider no longer matches the removed one).
 *
 * ATOMIC (CR round-6 blocker #1). This is a single `SET ... XX KEEPTTL`: overwrite
 * ONLY IF the session record still exists (XX), preserving its TTL. The prior
 * GET-then-SET had a TOCTOU race — a concurrent logout could DEL the record
 * between our read and write, and the write would RESURRECT the revoked token. XX
 * makes resurrection impossible: if logout already deleted the record, the SET is
 * a no-op and returns null. Returns true iff the record still existed and was
 * re-bound; false means the caller's own token is (already) gone and the handler
 * must report callerSessionRevoked:true so the client drops it. The sub is not
 * re-checked here because callers pass the jti straight from a verified
 * SessionContext whose record.sub already equals userId.
 */
export async function rebindSessionProvider(
  userId: string,
  jti: string,
  provider: SessionProvider,
): Promise<boolean> {
  const record: SessionRecord = { sub: userId, provider };
  const res = await kv.set(SESSION_KEY(jti), record, { xx: true, keepTtl: true });
  return res === 'OK';
}

/** Record a durable deletion receipt so a lost-response delete retry converges. */
export async function markUserDeleted(
  userId: string,
  ttlSeconds = DELETED_TTL_SECONDS,
): Promise<void> {
  await kv.set(DELETED_KEY(userId), Date.now(), { px: ttlSeconds * 1000 });
}

/** True iff a deletion receipt exists for this user (idempotent-delete recovery). */
export async function wasUserDeleted(userId: string): Promise<boolean> {
  return Boolean(await kv.get(DELETED_KEY(userId)));
}

/**
 * Revoke exactly the sessions minted by a given provider identity (used after
 * unlink). CR blocker #2: unlinking a provider must invalidate the tokens that
 * provider created — including the caller's own token if it was minted by the
 * removed provider — and must leave sessions from OTHER, still-linked providers
 * untouched. We look each session's stored provider up rather than trusting the
 * caller token's provider.
 */
export async function revokeSessionsByProvider(
  userId: string,
  provider: SessionProvider,
): Promise<void> {
  const jtis = ((await kv.smembers(USER_SESSIONS_KEY(userId))) as string[] | null) ?? [];
  for (const jti of jtis) {
    const record = readRecord(await kv.get(SESSION_KEY(jti)));
    if (!record) {
      await kv.srem(USER_SESSIONS_KEY(userId), jti); // prune dangling ref
      continue;
    }
    if (record.provider === provider) await forget(userId, jti);
  }
}

/**
 * Revoke EVERY session for a user, INCLUDING the caller's own, used on account
 * deletion (CR round-6 blocker #3). After a successful delete every bearer must
 * fail — the round-5 design that kept the caller's token live to survive a lost
 * response violated the all-session-revocation contract and permitted post-delete
 * authenticated calls. Response-loss recovery is instead provided by a durable
 * deletion receipt (markUserDeleted / wasUserDeleted): the retry proves who it was
 * from its still-signed token and reads the receipt, without any live auth bearer.
 * Idempotent: safe to re-run on a convergent retry. The membership set is deleted
 * last; a concurrent add cannot occur because deletion holds the per-user lock and
 * login (the only session minter) validates the user under that SAME lock, so no
 * new session for a deleted user is ever created (CR round-6 blocker #2).
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  const jtis = ((await kv.smembers(USER_SESSIONS_KEY(userId))) as string[] | null) ?? [];
  for (const jti of jtis) {
    await kv.del(SESSION_KEY(jti));
  }
  await kv.del(USER_SESSIONS_KEY(userId));
}
