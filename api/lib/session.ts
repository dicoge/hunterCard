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

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const SESSION_KEY = (jti: string) => `auth:session:${jti}`;
const USER_SESSIONS_KEY = (userId: string) => `auth:user:${userId}:sessions`;

interface SessionPayload {
  sub: string; // internal user id
  jti: string; // session id, the revocation handle
  iat: number;
  exp: number;
}

export interface SessionContext {
  userId: string;
  jti: string;
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

export async function issueSession(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
  const key = secret();
  if (!key) throw new Error('AUTH_SESSION_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload: SessionPayload = { sub: userId, jti, iat: now, exp: now + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Record first so a token is never handed out that cannot be revoked.
  await kv.set(SESSION_KEY(jti), userId, { px: ttlSeconds * 1000 });
  await kv.sadd(USER_SESSIONS_KEY(userId), jti);
  return `${encoded}.${sign(encoded, key)}`;
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
  const stored = await kv.get<string>(SESSION_KEY(claims.jti));
  if (stored !== claims.sub) return null; // revoked, expired-out, or unknown
  return { userId: claims.sub, jti: claims.jti };
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

/** Revoke every session for a user except one (used after unlink). */
export async function revokeOtherUserSessions(userId: string, keepJti: string): Promise<void> {
  const jtis = ((await kv.smembers(USER_SESSIONS_KEY(userId))) as string[] | null) ?? [];
  for (const jti of jtis) {
    if (jti !== keepJti) await forget(userId, jti);
  }
}

/** Revoke every session for a user (used on account deletion). */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  const jtis = ((await kv.smembers(USER_SESSIONS_KEY(userId))) as string[] | null) ?? [];
  for (const jti of jtis) await kv.del(SESSION_KEY(jti));
  await kv.del(USER_SESSIONS_KEY(userId));
}
