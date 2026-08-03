/**
 * Server-side provider ID token verification (DIC-663).
 *
 * The web client cannot safely establish identity on its own: an ID token must
 * be verified against the provider's public keys (signature), issuer, audience,
 * expiry and — when supplied — nonce. Doing this on the server is what makes the
 * resulting internal-user ownership trustworthy (CR DIC-854 blocker #1).
 *
 * Uses Node's built-in `crypto` + JWKS fetch (no extra dependency). JWKS are
 * cached briefly in-process.
 */
import crypto from 'crypto';
import { IdentityStoreError, VerifiedIdentity } from './identity-store';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

const JWKS_TTL_MS = 10 * 60 * 1000;

// Minimum spacing between outbound JWKS fetches to the same provider. A cached
// keyset that missed a token's `kid` triggers at most one refresh per this
// window, so an attacker spraying `/api/auth/login` with tokens carrying random
// unknown `kid`s cannot turn the endpoint into a JWKS request amplifier
// (CR DIC-854 round-10 P2 #1) — the second and later unknown-kid requests reuse
// the just-fetched keyset instead of hitting upstream again. It is short enough
// that a genuine provider key rotation still refreshes on the next attempt.
const JWKS_MIN_REFRESH_MS = 60 * 1000;

// Allowed clock skew between our host and the provider when checking time
// claims. 300s (5 min) is the conventional OIDC leeway and matches Google's and
// Apple's own tolerance, so a slightly skewed but otherwise valid token is not
// spuriously rejected — while still failing closed on anything outside it.
const CLOCK_SKEW_SEC = 300;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
// Per-URL in-flight network fetch, so a burst of concurrent requests that all
// miss the cache share a single upstream fetch (single-flight) rather than each
// firing its own.
const jwksInflight = new Map<string, Promise<Jwk[]>>();

// Test-only: clear the in-process JWKS cache so regression tests can assert
// force-refresh behaviour deterministically. Not used in production paths.
export function __resetJwksCache(): void {
  jwksCache.clear();
  jwksInflight.clear();
}

// Test-only: backdate a cached keyset's fetch time so tests can exercise the
// refresh cooldown without sleeping. Not used in production paths.
export function __ageJwksCache(url: string, ms: number): void {
  const cached = jwksCache.get(url);
  if (cached) cached.fetchedAt -= ms;
}

// Single-flight network fetch: hits the provider, updates the cache, and
// collapses concurrent callers onto one outbound request.
async function fetchJwksNetwork(url: string): Promise<Jwk[]> {
  const existing = jwksInflight.get(url);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new IdentityStoreError('INVALID_TOKEN', `JWKS fetch failed: ${res.status}`);
    const data = (await res.json()) as { keys: Jwk[] };
    jwksCache.set(url, { keys: data.keys, fetchedAt: Date.now() });
    return data.keys;
  })();
  jwksInflight.set(url, p);
  try {
    return await p;
  } finally {
    jwksInflight.delete(url);
  }
}

// Fetch keys honouring the TTL cache. `fresh` reports whether this call hit the
// network (so the caller knows the keyset is already up to date and a refresh
// on a `kid` miss would be pointless — avoids the cold-cache double fetch).
async function getJwks(url: string): Promise<{ keys: Jwk[]; fresh: boolean }> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return { keys: cached.keys, fresh: false };
  }
  return { keys: await fetchJwksNetwork(url), fresh: true };
}

// Force one refresh after a cached-keyset `kid` miss, rate-limited by
// JWKS_MIN_REFRESH_MS. Returns the refreshed keys, or null when a refresh
// happened too recently (the amplification / negative-kid guard) so the caller
// rejects without hitting upstream again.
async function refreshJwks(url: string): Promise<Jwk[] | null> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_MIN_REFRESH_MS) {
    return null;
  }
  return fetchJwksNetwork(url);
}

interface JwtParts {
  header: { kid?: string; alg?: string };
  payload: Record<string, any>;
  signingInput: string;
  signature: Buffer;
}

function decodeJwt(idToken: string): JwtParts {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new IdentityStoreError('INVALID_TOKEN', 'Malformed JWT');
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    throw new IdentityStoreError('INVALID_TOKEN', 'Undecodable JWT segment');
  }
}

// Both Google- and Apple-issued ID tokens are signed with RS256 (RSA). ES256
// only applies to the Apple client_secret we mint ourselves, never to an
// Apple-issued ID token. Pin the expected alg and reject any token or JWKS key
// that deviates, so a forged token cannot downgrade us to an unexpected
// algorithm/key type (alg-confusion hardening).
const EXPECTED_ALG = 'RS256';
const EXPECTED_KTY = 'RSA';

function verifySignature(jwt: JwtParts, jwk: Jwk): void {
  if (jwt.header.alg !== EXPECTED_ALG) {
    throw new IdentityStoreError('INVALID_TOKEN', `Unexpected token alg: ${jwt.header.alg} (expected ${EXPECTED_ALG})`);
  }
  if (jwk.kty !== EXPECTED_KTY) {
    throw new IdentityStoreError('INVALID_TOKEN', `Unexpected JWKS key type: ${jwk.kty} (expected ${EXPECTED_KTY})`);
  }
  if (jwk.alg && jwk.alg !== EXPECTED_ALG) {
    throw new IdentityStoreError('INVALID_TOKEN', `Unexpected JWKS key alg: ${jwk.alg} (expected ${EXPECTED_ALG})`);
  }
  const keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(jwt.signingInput), keyObject, jwt.signature);
  if (!ok) throw new IdentityStoreError('INVALID_TOKEN', 'Signature verification failed');
}

function assertClaims(
  payload: Record<string, any>,
  { issuers, audience, nonce }: { issuers: string[]; audience: string[]; nonce?: string },
): void {
  const now = Math.floor(Date.now() / 1000);

  // Fail closed on time claims: a missing or malformed `exp`/`iat` must be
  // rejected outright, never treated as "no expiry" (the previous check only
  // rejected a numeric-and-expired exp, so a token with no exp sailed through).
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new IdentityStoreError('INVALID_TOKEN', 'Missing or malformed exp claim');
  }
  if (now > payload.exp + CLOCK_SKEW_SEC) {
    throw new IdentityStoreError('TOKEN_EXPIRED', 'ID token expired');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new IdentityStoreError('INVALID_TOKEN', 'Missing or malformed iat claim');
  }
  if (payload.iat - CLOCK_SKEW_SEC > now) {
    throw new IdentityStoreError('INVALID_TOKEN', 'ID token issued in the future');
  }
  if (!issuers.includes(payload.iss)) {
    throw new IdentityStoreError('INVALID_TOKEN', `Bad issuer: ${payload.iss}`);
  }
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.some((a) => a && auds.includes(a))) {
    throw new IdentityStoreError('INVALID_TOKEN', `Bad audience: ${payload.aud}`);
  }
  if (nonce && payload.nonce !== nonce) {
    throw new IdentityStoreError('INVALID_TOKEN', 'Nonce mismatch');
  }
  if (!payload.sub) throw new IdentityStoreError('INVALID_TOKEN', 'Missing subject');
}

async function verify(
  idToken: string,
  jwksUrl: string,
  claims: { issuers: string[]; audience: string[]; nonce?: string },
): Promise<Record<string, any>> {
  const jwt = decodeJwt(idToken);
  const { keys, fresh } = await getJwks(jwksUrl);
  let jwk = keys.find((k) => k.kid === jwt.header.kid);
  if (!jwk && !fresh) {
    // We served a cached keyset and it did not contain this token's `kid`. The
    // provider may have rotated keys, so force one refresh (rate-limited) before
    // rejecting, so a valid token signed with a freshly rotated key is not
    // turned away for the full cache TTL (CR DIC-854 blocker #2). We only reach
    // here when the keyset actually came from cache — a fresh network keyset is
    // already current, so re-fetching it would be pointless (round-10 P2 #1:
    // no cold-cache double fetch, and refreshJwks caps the outbound rate).
    const refreshed = await refreshJwks(jwksUrl);
    if (refreshed) jwk = refreshed.find((k) => k.kid === jwt.header.kid);
  }
  if (!jwk) throw new IdentityStoreError('INVALID_TOKEN', 'No matching JWKS key');
  verifySignature(jwt, jwk);
  assertClaims(jwt.payload, claims);
  return jwt.payload;
}

function googleAudiences(): string[] {
  return [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
  ].filter((v): v is string => Boolean(v));
}

export function isGoogleVerifyConfigured(): boolean {
  return googleAudiences().length > 0;
}

export async function verifyGoogleIdToken(idToken: string, nonce?: string): Promise<VerifiedIdentity> {
  const audience = googleAudiences();
  if (audience.length === 0) {
    throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'Google client id not configured');
  }
  const payload = await verify(idToken, GOOGLE_JWKS_URL, { issuers: GOOGLE_ISSUERS, audience, nonce });
  return {
    provider: 'google',
    subject: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

function appleAudiences(): string[] {
  return [process.env.APPLE_CLIENT_ID, process.env.EXPO_PUBLIC_APPLE_SERVICE_ID].filter(
    (v): v is string => Boolean(v),
  );
}

export function isAppleVerifyConfigured(): boolean {
  return appleAudiences().length > 0;
}

export async function verifyAppleIdToken(idToken: string, nonce?: string): Promise<VerifiedIdentity> {
  const audience = appleAudiences();
  if (audience.length === 0) {
    throw new IdentityStoreError('STORE_NOT_CONFIGURED', 'Apple service id not configured');
  }
  const payload = await verify(idToken, APPLE_JWKS_URL, { issuers: [APPLE_ISSUER], audience, nonce });
  return {
    provider: 'apple',
    subject: payload.sub,
    email: payload.email,
    name: payload.name,
  };
}
