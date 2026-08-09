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
import { isSessionConfigured, verifySession } from './session';
import { consumeIdTokenOnce } from './token-replay';
import {
  isAppleVerifyConfigured,
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
  let identity: VerifiedIdentity;
  if (provider === 'google') {
    if (!isGoogleVerifyConfigured()) {
      throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'google_not_configured');
    }
    identity = await verifyGoogleIdToken(idToken, nonce);
  } else if (provider === 'apple') {
    // Native iOS Apple (bundle-id audience) is always accepted; Web Apple
    // (Services-ID audience) only when the operator enabled it. The audience
    // allow-list in verify-token enforces which one is honored — a web-issued
    // token fails closed while the web path is disabled.
    if (!isAppleVerifyConfigured()) {
      throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'apple_not_configured');
    }
    identity = await verifyAppleIdToken(idToken, nonce);
  } else {
    throw new IdentityStoreError('INVALID_TOKEN', `unsupported provider: ${provider}`);
  }
  // Enforce single use ONLY after signature/claims verification passes, so a
  // malformed or forged token fails fast without ever touching KV. This binds
  // replay protection to the token itself and is what covers the classic Android
  // Google path, which cannot carry an OIDC nonce (DIC-665 / DIC-920).
  if (typeof identity.expiresAt === 'number') {
    await consumeIdTokenOnce(idToken, identity.expiresAt);
  }
  return identity;
}

export function sessionUserId(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return verifySession(auth.slice('Bearer '.length).trim());
}

export function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'apple';
}
