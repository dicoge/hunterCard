/**
 * Self-issued session tokens (DIC-663). A session vouches for the
 * server-resolved internal user id so that link / unlink / delete can act on a
 * server-authoritative identity instead of trusting a client-supplied user id.
 *
 * Format: base64url(JSON payload) + '.' + HMAC-SHA256(payload). Fail-closed:
 * when AUTH_SESSION_SECRET is unset, issue throws and verify returns null.
 */
import crypto from 'crypto';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  sub: string; // internal user id
  iat: number;
  exp: number;
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

export function issueSession(userId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const key = secret();
  if (!key) throw new Error('AUTH_SESSION_SECRET is not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { sub: userId, iat: now, exp: now + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, key)}`;
}

/** Returns the internal user id if the session is valid and unexpired, else null. */
export function verifySession(token: string | null | undefined): string | null {
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
    if (!payload.sub || typeof payload.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
