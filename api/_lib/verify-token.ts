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

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

async function fetchJwks(url: string): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(url);
  if (!res.ok) throw new IdentityStoreError('INVALID_TOKEN', `JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(url, { keys: data.keys, fetchedAt: Date.now() });
  return data.keys;
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

function verifySignature(jwt: JwtParts, jwk: Jwk): void {
  const keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' });
  const data = Buffer.from(jwt.signingInput);
  let ok = false;
  if (jwt.header.alg === 'RS256') {
    ok = crypto.verify('RSA-SHA256', data, keyObject, jwt.signature);
  } else if (jwt.header.alg === 'ES256') {
    ok = crypto.verify('SHA256', data, { key: keyObject, dsaEncoding: 'ieee-p1363' }, jwt.signature);
  } else {
    throw new IdentityStoreError('INVALID_TOKEN', `Unsupported alg: ${jwt.header.alg}`);
  }
  if (!ok) throw new IdentityStoreError('INVALID_TOKEN', 'Signature verification failed');
}

function assertClaims(
  payload: Record<string, any>,
  { issuers, audience, nonce }: { issuers: string[]; audience: string[]; nonce?: string },
): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new IdentityStoreError('TOKEN_EXPIRED', 'ID token expired');
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
  const keys = await fetchJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === jwt.header.kid);
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
