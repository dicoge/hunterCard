/**
 * Shared helpers for the DIC-663 web auth endpoints: JSON responses, fail-closed
 * configuration gating, provider token verification, and session extraction.
 */
import {
  IdentityStoreError,
  Provider,
  VerifiedIdentity,
  isIdentityStoreConfigured,
} from './identity-store';
import {
  SessionContext,
  isSessionConfigured,
  readSessionClaims,
  verifySessionContext,
} from './session';
import {
  isGoogleVerifyConfigured,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from './verify-token';

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof IdentityStoreError) {
    return json({ error: err.code, ...(err.extra ?? {}) }, err.status);
  }
  // Do not leak internals; a thrown write error must surface as a non-2xx so the
  // client fails closed rather than reporting a false success.
  return json({ error: 'internal_error' }, 500);
}

/** Web Apple login/link stays off until the server verify path is enabled. */
export function isAppleWebEnabled(): boolean {
  return process.env.APPLE_WEB_LOGIN_ENABLED === 'true';
}

/**
 * Returns a fail-closed Response if the server backend is not fully configured,
 * else null. Every mutating endpoint calls this first so a missing backend can
 * never be mistaken for success.
 */
export function backendUnavailable(): Response | null {
  if (!isIdentityStoreConfigured()) {
    return json({ error: 'STORE_NOT_CONFIGURED', reason: 'kv_not_configured' }, 501);
  }
  if (!isSessionConfigured()) {
    return json({ error: 'STORE_NOT_CONFIGURED', reason: 'session_secret_not_configured' }, 501);
  }
  return null;
}

export async function verifyProviderToken(
  provider: Provider,
  idToken: string,
  nonce?: string,
): Promise<VerifiedIdentity> {
  if (provider === 'google') {
    if (!isGoogleVerifyConfigured()) {
      throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'google_not_configured');
    }
    return verifyGoogleIdToken(idToken, nonce);
  }
  if (provider === 'apple') {
    if (!isAppleWebEnabled()) {
      throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'apple_web_not_enabled');
    }
    return verifyAppleIdToken(idToken, nonce);
  }
  throw new IdentityStoreError('INVALID_TOKEN', `unsupported provider: ${provider}`);
}

function bearer(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}

/** Resolve the session's { userId, jti }, or null if invalid/revoked. */
export async function sessionContext(req: Request): Promise<SessionContext | null> {
  return verifySessionContext(bearer(req));
}

export async function sessionUserId(req: Request): Promise<string | null> {
  return (await sessionContext(req))?.userId ?? null;
}

/**
 * Decode the bearer's signed claims WITHOUT a revocation/user lookup. Used only by
 * the delete endpoint's response-loss recovery: a caller retrying a completed
 * delete holds a token that sessionContext (correctly) rejects, yet its signed
 * claims still authentically name which user it was — which, paired with the
 * durable deletion receipt, yields the idempotent "already deleted" answer.
 */
export function sessionClaims(req: Request): { sub: string; jti: string } | null {
  return readSessionClaims(bearer(req));
}

export function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'apple';
}
