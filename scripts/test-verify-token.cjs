#!/usr/bin/env node
/**
 * Regression tests for server-side provider ID token verification (DIC-663,
 * CR DIC-854 blocker #3).
 *
 * These tests actually execute api/_lib/verify-token.ts: they transpile it
 * (like the auth-backend harness), inject an in-memory @vercel/kv mock so its
 * identity-store import loads, replace globalThis.fetch with a stub that serves
 * JWKS built from locally generated RSA keys, and mint signed tokens on the fly.
 *
 * Coverage: RS256 Google + Apple success; alg/kty/jwk-alg confusion rejection;
 * missing/malformed/expired exp; missing/malformed/future iat; bad iss/aud/nonce;
 * and cached-old-key → new-kid rotation (force one JWKS refresh before reject).
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-token-tests-'));

// --- @vercel/kv mock (verify-token imports identity-store, which imports kv) ---
const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv: {} };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(input, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

// Audiences/issuers verify-token reads from env. Set before loading the module
// so googleAudiences()/appleAudiences() are configured.
const GOOGLE_AUD = 'google-web-client-id.apps.googleusercontent.com';
const APPLE_AUD = 'com.holohunter.service';
process.env.GOOGLE_WEB_CLIENT_ID = GOOGLE_AUD;
process.env.APPLE_CLIENT_ID = APPLE_AUD;

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const GOOGLE_ISS = 'https://accounts.google.com';
const APPLE_ISS = 'https://appleid.apple.com';

compileTs('api/_lib/identity-store.ts');
compileTs('api/_lib/verify-token.ts');
const verifier = require(path.join(outDir, 'api/_lib/verify-token.js'));

// --- local RSA keys + JWKS fetch stub ---
function makeRsaKey(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { kid, publicKey, privateKey, jwk };
}

const googleKey = makeRsaKey('google-key-1');
const appleKey = makeRsaKey('apple-key-1');

// The keyset each URL currently serves. Tests mutate this to simulate rotation.
const jwksByUrl = {
  [GOOGLE_JWKS_URL]: [googleKey.jwk],
  [APPLE_JWKS_URL]: [appleKey.jwk],
};

const fetchCalls = { count: 0, byUrl: new Map() };

globalThis.fetch = async (url) => {
  fetchCalls.count += 1;
  fetchCalls.byUrl.set(url, (fetchCalls.byUrl.get(url) ?? 0) + 1);
  const keys = jwksByUrl[url];
  if (!keys) {
    return { ok: false, status: 404, async json() { return {}; } };
  }
  return { ok: true, status: 200, async json() { return { keys }; } };
};

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken({ key, header, payload }) {
  const fullHeader = { alg: 'RS256', kid: key.kid, typ: 'JWT', ...header };
  const signingInput = `${b64url(JSON.stringify(fullHeader))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

const NOW = Math.floor(Date.now() / 1000);

function googlePayload(overrides = {}) {
  return {
    iss: GOOGLE_ISS,
    aud: GOOGLE_AUD,
    sub: 'google-sub-123',
    email: 'user@example.com',
    name: 'Test User',
    picture: 'https://example.com/p.png',
    iat: NOW - 10,
    exp: NOW + 3600,
    ...overrides,
  };
}

function applePayload(overrides = {}) {
  return {
    iss: APPLE_ISS,
    aud: APPLE_AUD,
    sub: 'apple-sub-123',
    email: 'relay@privaterelay.appleid.com',
    iat: NOW - 10,
    exp: NOW + 3600,
    ...overrides,
  };
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `expected error code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`expected ${code} to be thrown, but call resolved`);
}

// --- tests ---
async function testGoogleRs256Success() {
  const token = signToken({ key: googleKey, payload: googlePayload() });
  const identity = await verifier.verifyGoogleIdToken(token);
  assert.equal(identity.provider, 'google');
  assert.equal(identity.subject, 'google-sub-123');
  assert.equal(identity.email, 'user@example.com');
  assert.equal(identity.name, 'Test User');
}

async function testAppleRs256Success() {
  const token = signToken({ key: appleKey, payload: applePayload() });
  const identity = await verifier.verifyAppleIdToken(token);
  assert.equal(identity.provider, 'apple');
  assert.equal(identity.subject, 'apple-sub-123');
  assert.equal(identity.email, 'relay@privaterelay.appleid.com');
}

async function testNonceMatchSucceeds() {
  const token = signToken({ key: googleKey, payload: googlePayload({ nonce: 'n-123' }) });
  const identity = await verifier.verifyGoogleIdToken(token, 'n-123');
  assert.equal(identity.subject, 'google-sub-123');
}

async function testHeaderAlgConfusionRejected() {
  // A token whose header claims ES256 must be rejected before any signature math.
  const token = signToken({ key: googleKey, header: { alg: 'ES256' }, payload: googlePayload() });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testJwkKtyConfusionRejected() {
  // Serve a JWK that claims EC kty for the token's kid.
  const original = jwksByUrl[GOOGLE_JWKS_URL];
  jwksByUrl[GOOGLE_JWKS_URL] = [{ ...googleKey.jwk, kty: 'EC' }];
  try {
    const token = signToken({ key: googleKey, payload: googlePayload() });
    await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
  } finally {
    jwksByUrl[GOOGLE_JWKS_URL] = original;
    verifier.__resetJwksCache();
  }
}

async function testJwkAlgConfusionRejected() {
  const original = jwksByUrl[GOOGLE_JWKS_URL];
  jwksByUrl[GOOGLE_JWKS_URL] = [{ ...googleKey.jwk, alg: 'RS384' }];
  try {
    const token = signToken({ key: googleKey, payload: googlePayload() });
    await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
  } finally {
    jwksByUrl[GOOGLE_JWKS_URL] = original;
    verifier.__resetJwksCache();
  }
}

async function testWrongSignatureRejected() {
  // Sign with apple's key but present it as the google kid → signature fails.
  const token = signToken({ key: { ...appleKey, kid: googleKey.kid }, payload: googlePayload() });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testMissingExpRejected() {
  const p = googlePayload();
  delete p.exp;
  const token = signToken({ key: googleKey, payload: p });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testMalformedExpRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ exp: 'later' }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testExpiredBeyondSkewRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ exp: NOW - 3600 }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'TOKEN_EXPIRED');
}

async function testJustExpiredWithinSkewSucceeds() {
  // exp is 60s in the past — inside the 300s clock-skew leeway, so still valid.
  const token = signToken({ key: googleKey, payload: googlePayload({ exp: NOW - 60 }) });
  const identity = await verifier.verifyGoogleIdToken(token);
  assert.equal(identity.subject, 'google-sub-123');
}

async function testMissingIatRejected() {
  const p = googlePayload();
  delete p.iat;
  const token = signToken({ key: googleKey, payload: p });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testMalformedIatRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ iat: 'now' }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testFutureIatRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ iat: NOW + 3600 }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testBadIssuerRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ iss: 'https://evil.example.com' }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testBadAudienceRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ aud: 'someone-elses-client-id' }) });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

async function testBadNonceRejected() {
  const token = signToken({ key: googleKey, payload: googlePayload({ nonce: 'other' }) });
  await expectError(verifier.verifyGoogleIdToken(token, 'expected'), 'INVALID_TOKEN');
}

async function testKidRotationForcesOneRefresh() {
  // Prime the cache with the current google keyset.
  verifier.__resetJwksCache();
  const warm = signToken({ key: googleKey, payload: googlePayload() });
  await verifier.verifyGoogleIdToken(warm);
  const afterWarm = fetchCalls.byUrl.get(GOOGLE_JWKS_URL) ?? 0;

  // Provider rotates: new key, new kid. Cache still holds the old keyset.
  const rotatedKey = makeRsaKey('google-key-2');
  jwksByUrl[GOOGLE_JWKS_URL] = [rotatedKey.jwk];
  const rotatedToken = signToken({ key: rotatedKey, payload: googlePayload() });

  const identity = await verifier.verifyGoogleIdToken(rotatedToken);
  assert.equal(identity.subject, 'google-sub-123');

  // The cache miss on the new kid must have forced exactly one extra fetch.
  const afterRotation = fetchCalls.byUrl.get(GOOGLE_JWKS_URL) ?? 0;
  assert.equal(afterRotation, afterWarm + 1, 'expected one forced JWKS refresh on kid miss');

  // Restore for any later test + leave cache holding the rotated keyset.
  jwksByUrl[GOOGLE_JWKS_URL] = [googleKey.jwk];
  verifier.__resetJwksCache();
}

async function testUnknownKidStillRejectedAfterRefresh() {
  verifier.__resetJwksCache();
  const token = signToken({ key: { ...googleKey, kid: 'never-served' }, payload: googlePayload() });
  await expectError(verifier.verifyGoogleIdToken(token), 'INVALID_TOKEN');
}

(async () => {
  const tests = [
    testGoogleRs256Success,
    testAppleRs256Success,
    testNonceMatchSucceeds,
    testHeaderAlgConfusionRejected,
    testJwkKtyConfusionRejected,
    testJwkAlgConfusionRejected,
    testWrongSignatureRejected,
    testMissingExpRejected,
    testMalformedExpRejected,
    testExpiredBeyondSkewRejected,
    testJustExpiredWithinSkewSucceeds,
    testMissingIatRejected,
    testMalformedIatRejected,
    testFutureIatRejected,
    testBadIssuerRejected,
    testBadAudienceRejected,
    testBadNonceRejected,
    testKidRotationForcesOneRefresh,
    testUnknownKidStillRejectedAfterRefresh,
  ];
  for (const test of tests) {
    verifier.__resetJwksCache();
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} verify-token tests passed`);
})()
  .finally(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    Module._load = originalLoad;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
