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

/** Full verification: signature + expiry + the session record still exists. */
export async function verifySessionContext(
  token: string | null | undefined,
): Promise<SessionContext | null> {
  const claims = decodeClaims(token);
  if (!claims) return null;
  const record = readRecord(await kv.get(SESSION_KEY(claims.jti)));
  if (!record || record.sub !== claims.sub) return null; // revoked, expired-out, or unknown
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
 * then skips this session (its provider no longer matches the removed one). No-op
 * if the session record is already gone (expired) — we never resurrect it. The TTL
 * is preserved via KEEPTTL so re-binding doesn't extend the session's lifetime.
 */
export async function rebindSessionProvider(
  userId: string,
  jti: string,
  provider: SessionProvider,
): Promise<boolean> {
  const existing = readRecord(await kv.get(SESSION_KEY(jti)));
  if (!existing || existing.sub !== userId) return false;
  const record: SessionRecord = { sub: userId, provider };
  await kv.set(SESSION_KEY(jti), record, { keepTtl: true });
  return true;
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
 * Revoke every session for a user EXCEPT the caller's own (`exceptJti`), used on
 * account deletion (CR round-5 blocker #2). Deliberately leaving the caller's token
 * live until the response is delivered is what makes delete retry-convergent: if
 * any write here fails, the caller can retry with its still-valid token and the
 * retry re-runs this idempotent cleanup, instead of getting a dead-token 401 that
 * strands a half-finished delete. The caller drops its own token locally on
 * success; that record points at a now-deleted user (every authenticated action
 * through it fails closed with USER_NOT_FOUND) and expires via its TTL. The
 * membership set is cleared last only after the caller entry is re-added, so the
 * caller's own record is the single intentional leftover.
 */
export async function revokeOtherUserSessions(userId: string, exceptJti: string): Promise<void> {
  const jtis = ((await kv.smembers(USER_SESSIONS_KEY(userId))) as string[] | null) ?? [];
  for (const jti of jtis) {
    if (jti === exceptJti) continue;
    await kv.del(SESSION_KEY(jti));
  }
  // Rewrite the membership set to contain only the caller (if it is still a
  // member), so a later enumeration doesn't resurrect revoked jtis.
  await kv.del(USER_SESSIONS_KEY(userId));
  if (jtis.includes(exceptJti)) await kv.sadd(USER_SESSIONS_KEY(userId), exceptJti);
}
