/**
 * Single-use replay guard for provider ID tokens (DIC-665 / DIC-920 blocker 2).
 *
 * The classic play-services-auth Google Sign-In used on Android cannot bind an
 * OIDC nonce into the ID token, so a captured Android ID token would otherwise be
 * replayable against /api/auth/login until it expires. We close that window on
 * the server: the FIRST successful verification of a given ID token atomically
 * claims a marker keyed by SHA-256(idToken); any later submission of the same
 * token is rejected as TOKEN_REPLAYED. The marker's TTL is bounded to the token's
 * own `exp`, so it self-cleans and never outlives the token it protects.
 *
 * This is transparent to the happy path on every platform: each legitimate
 * login/link mints a fresh token (new iat/exp), so single-use only ever blocks an
 * actual replay, never a normal sign-in or retry. The atomic SET NX also makes it
 * safe under concurrency — two simultaneous submissions of one token race for the
 * key and exactly one wins.
 */
import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { IdentityStoreError } from './identity-store';

const REPLAY_PREFIX = 'idtoken:replay:';

function replayKey(idToken: string): string {
  // Hash the token so we never persist the raw credential, and so the key length
  // is bounded regardless of token size.
  return REPLAY_PREFIX + crypto.createHash('sha256').update(idToken).digest('hex');
}

/**
 * Atomically claim single use of `idToken`. Resolves on the first claim; throws
 * TOKEN_REPLAYED (401) if the token was already consumed. `expiresAt` is the
 * token's `exp` in epoch seconds — the marker lives only until then.
 *
 * A verified token always has a finite, future `exp` (assertClaims enforces it),
 * so the TTL is always >= 1s; we clamp defensively so a marker is never written
 * without an expiry (which would leak keys forever).
 */
export async function consumeIdTokenOnce(idToken: string, expiresAt: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(expiresAt) ? Math.max(1, Math.ceil(expiresAt - now)) : 1;
  const result = await kv.set(replayKey(idToken), 1, { nx: true, ex: ttl });
  // Vercel KV returns 'OK' when the key was set and null when NX found an
  // existing key. Treat anything other than a confirmed set as a replay.
  if (result !== 'OK') {
    throw new IdentityStoreError('TOKEN_REPLAYED', 'ID token already used');
  }
}
