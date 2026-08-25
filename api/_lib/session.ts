/**
 * Self-issued session tokens (DIC-663). A session vouches for the
 * server-resolved internal user id so that link / unlink / delete can act on a
 * server-authoritative identity instead of trusting a client-supplied user id.
 *
 * Format: base64url(JSON payload) + '.' + HMAC-SHA256(payload). Fail-closed:
 * when AUTH_SESSION_SECRET is unset, issue throws and verify returns null.
 *
 * DIC-1189 rework-blocker #3: sessions carry an `env` claim so a token minted
 * on production cannot verify on staging (or vice versa), and staging uses a
 * SEPARATE session secret from production so a compromised staging secret
 * cannot forge production sessions and vice versa.
 */
import crypto from 'crypto';
import { resolveAppEnvStrict, type AppEnv } from '../../src/config/appEnv';

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  sub: string; // internal user id
  iat: number;
  exp: number;
  // Deployment lane that minted this session. Verified against the current
  // deployment's APP_ENV — a session minted on production cannot be presented
  // against the staging deployment, so a staging test account can never be
  // silently accepted by production.
  env: AppEnv;
}

// Per-lane session secret. Staging MUST have its own secret so a leaked
// staging secret cannot forge a production session (and vice versa). Staging
// falls back to null (not the production secret) when
// AUTH_SESSION_SECRET_STAGING is unset — a fail-closed default that makes
// staging sessions unusable rather than sharing the production secret.
function secret(): string | null {
  let appEnv: AppEnv;
  try {
    appEnv = resolveAppEnvStrict();
  } catch {
    // Unattributed environment — no session can be issued or verified.
    return null;
  }
  if (appEnv === 'staging') {
    return process.env.AUTH_SESSION_SECRET_STAGING || null;
  }
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
  // Environment binding — staging cannot mint a production session.
  const env = resolveAppEnvStrict();
  const payload: SessionPayload = { sub: userId, iat: now, exp: now + ttlSeconds, env };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, key)}`;
}

/** Returns the internal user id if the session is valid, unexpired, AND
 * bound to the current deployment lane. All three checks return null on
 * failure so an attacker cannot distinguish "unknown user" from "wrong
 * environment" from "expired". */
export function verifySession(token: string | null | undefined): string | null {
  const key = secret();
  if (!key || !token) return null;
  // Resolve the current deployment lane strictly — an unattributed pod
  // cannot verify a session at all.
  let currentEnv: AppEnv;
  try {
    currentEnv = resolveAppEnvStrict();
  } catch {
    return null;
  }
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
    // Environment binding — reject a token whose `env` claim does not match
    // the current deployment. A missing `env` claim is treated as a legacy
    // token minted before DIC-1189 landed; those verify only on production
    // (they only ever existed there historically).
    const tokenEnv: AppEnv = payload.env === 'staging' ? 'staging' : 'production';
    if (tokenEnv !== currentEnv) return null;
    return payload.sub;
  } catch {
    return null;
  }
}
