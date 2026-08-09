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
// A provider JWKS endpoint must never be able to hang the function: bound the
// fetch and surface a slow/unreachable provider as a structured 503 fail-closed
// error instead of an unbounded wait (DIC-891). Overridable via env so tests can
// exercise the timeout deterministically; production keeps the 5s default.
function jwksFetchTimeoutMs(): number {
  const raw = Number(process.env.JWKS_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  [k: string]: unknown;
}

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

// Actual constructibility is the ONLY reliable JWK validation: string-field
// shape checks pass entries such as an invalid EC point
// `{ kty:'EC', crv:'P-256', x:'a', y:'a' }` that still throw
// `ERR_CRYPTO_INVALID_JWK` in `crypto.createPublicKey()`. Every returned key is
// built here so any un-constructible key fails closed with a structured 503
// BEFORE the set is cached — a bad set must never poison the 10-minute cache and
// starve a retry after the provider recovers (CR DIC-891).
function assertConstructibleJwks(value: unknown): asserts value is Jwk[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IdentityStoreError('PROVIDER_UNAVAILABLE', 'JWKS payload malformed');
  }
  for (const k of value) {
    if (k === null || typeof k !== 'object' || typeof (k as Jwk).kid !== 'string' || !(k as Jwk).kid) {
      throw new IdentityStoreError('PROVIDER_UNAVAILABLE', 'JWKS entry missing kid');
    }
    try {
      crypto.createPublicKey({ key: k as crypto.JsonWebKeyInput['key'], format: 'jwk' });
    } catch (err) {
      throw new IdentityStoreError(
        'PROVIDER_UNAVAILABLE',
        `JWKS key construction failed: ${(err as Error)?.name ?? 'unknown'}`,
      );
    }
  }
}

async function fetchJwks(url: string): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), jwksFetchTimeoutMs());
  // Keep the abort timer armed across the WHOLE exchange — status check AND the
  // response-body read. fetch() resolves after headers arrive, so a body that
  // then stalls would hang unbounded if the timer were cleared here; instead the
  // timer stays live until `res.json()` completes and aborts a stalled body too
  // (CR DIC-891). Any fetch / body-read / construction failure fails closed with
  // a bounded structured 503, and only a fully-constructible set is cached.
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new IdentityStoreError('PROVIDER_UNAVAILABLE', `JWKS fetch failed: ${res.status}`);
    const data = (await res.json()) as { keys?: unknown };
    assertConstructibleJwks(data?.keys);
    jwksCache.set(url, { keys: data.keys, fetchedAt: Date.now() });
    return data.keys;
  } catch (err) {
    if (err instanceof IdentityStoreError) throw err;
    // AbortError (timeout, including a stalled body) or a network / JSON-parse
    // failure: fail closed with a bounded 503 rather than letting the request
    // hang until the platform kills it.
    throw new IdentityStoreError('PROVIDER_UNAVAILABLE', `JWKS fetch error: ${(err as Error)?.name ?? 'unknown'}`);
  } finally {
    clearTimeout(timer);
  }
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
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' });
  } catch (err) {
    // Defense-in-depth behind the JWKS shape check: a provider key that passes
    // shape validation but still cannot be constructed is a dependency fault, not
    // a client token error — surface it as a structured 503, never a generic 500.
    throw new IdentityStoreError(
      'PROVIDER_UNAVAILABLE',
      `JWKS key construction failed: ${(err as Error)?.name ?? 'unknown'}`,
    );
  }
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
  // Require a finite numeric exp: a missing / non-numeric / NaN / Infinity exp
  // must fail closed, not skip the expiry check and accept a never-expiring token.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new IdentityStoreError('INVALID_TOKEN', 'Missing or non-numeric exp');
  }
  if (now >= payload.exp) {
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
  // A Google ID token's `aud` is the OAuth client that obtained it: the Web
  // client for browser sign-in, the iOS client for native iOS sign-in. Native
  // Android Google Sign-In (Credential Manager) is configured with the Web
  // (server) client id, so an Android-issued token also carries the Web-client
  // aud and is already covered above. The dedicated Android OAuth client id is
  // additionally accepted as defense-in-depth in case a build ever mints a token
  // audienced directly to it. Accepting all so one backend verifies web + native
  // iOS + native Android logins.
  return [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
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

// Native iOS Sign in with Apple mints an ID token whose `aud` is the app's
// bundle identifier, NOT the web Services ID. The bundle id is public (it ships
// in every build), so we can accept it without any Apple Developer / secret
// setup — that is what lets native iOS Apple login work while Web Apple stays
// gated. Overridable via env for other build targets.
const APPLE_NATIVE_BUNDLE_ID = 'com.dicoge.holohunter';

function appleNativeAudiences(): string[] {
  return [
    process.env.APPLE_NATIVE_CLIENT_ID,
    process.env.EXPO_PUBLIC_APPLE_BUNDLE_ID,
    APPLE_NATIVE_BUNDLE_ID,
  ].filter((v): v is string => Boolean(v));
}

// Web Apple (Services ID audience) is only accepted once the operator has
// configured the Services ID AND explicitly enabled the web path. Otherwise a
// web-issued Apple token fails the audience check and login fails closed.
function appleWebAudiences(): string[] {
  if (process.env.APPLE_WEB_LOGIN_ENABLED !== 'true') return [];
  return [process.env.APPLE_CLIENT_ID, process.env.EXPO_PUBLIC_APPLE_SERVICE_ID].filter(
    (v): v is string => Boolean(v),
  );
}

function appleAudiences(): string[] {
  return [...appleNativeAudiences(), ...appleWebAudiences()];
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
