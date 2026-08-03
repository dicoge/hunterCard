#!/usr/bin/env node
/**
 * Regression tests for provider ID-token audience acceptance (DIC-866).
 *
 * The server-authoritative verify path must accept the audiences that each real
 * client mints:
 *   - Google Web client id (browser) AND Google iOS client id (native).
 *   - Apple native bundle id (iOS Sign in with Apple) with no Apple Developer
 *     setup, while Web Apple (Services ID) stays gated behind
 *     APPLE_WEB_LOGIN_ENABLED and fails closed until enabled.
 *
 * Signs real RS256 JWTs with an ephemeral key and mocks the JWKS fetch, so this
 * exercises the actual signature + issuer + audience + nonce + expiry checks.
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

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

// Mock JWKS fetch: return our single signing key for the provider endpoints.
global.fetch = async (url) => {
  if (url === GOOGLE_JWKS_URL || url === APPLE_JWKS_URL) {
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// verify-token imports identity-store, which pulls in @vercel/kv at module load.
const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv: {} };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiled = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

compileTs('api/_lib/identity-store.ts');
compileTs('api/_lib/verify-token.ts');
const verify = require(path.join(outDir, 'api/_lib/verify-token.js'));

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload) {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function googleToken(aud, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: 'https://accounts.google.com',
    aud,
    sub: 'google-sub-1',
    email: 'a@example.com',
    name: 'Ann',
    exp: now + 3600,
    ...extra,
  });
}

function appleToken(aud, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: 'https://appleid.apple.com',
    aud,
    sub: 'apple-sub-1',
    email: 'relay@privaterelay.appleid.com',
    exp: now + 3600,
    ...extra,
  });
}

function clearAuthEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.includes('GOOGLE') || k.includes('APPLE')) delete process.env[k];
  }
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `expected error code ${code}, got ${err.code} (${err.message})`);
    return;
  }
  throw new Error(`expected ${code} to be thrown, but call resolved`);
}

async function testGoogleWebAudienceAccepted() {
  clearAuthEnv();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  const identity = await verify.verifyGoogleIdToken(
    googleToken('web-client.apps.googleusercontent.com'),
  );
  assert.equal(identity.provider, 'google');
  assert.equal(identity.subject, 'google-sub-1');
}

async function testGoogleIosAudienceAccepted() {
  clearAuthEnv();
  // Only the iOS client id is configured; a native-issued token must still pass.
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
  const identity = await verify.verifyGoogleIdToken(
    googleToken('ios-client.apps.googleusercontent.com'),
  );
  assert.equal(identity.subject, 'google-sub-1');
}

async function testGoogleWrongAudienceRejected() {
  clearAuthEnv();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  await expectError(
    verify.verifyGoogleIdToken(googleToken('attacker-client.apps.googleusercontent.com')),
    'INVALID_TOKEN',
  );
}

async function testAppleNativeBundleIdAcceptedWithoutAppleSetup() {
  clearAuthEnv();
  // No APPLE_* env at all, web path disabled: native bundle-id token still works.
  assert.equal(verify.isAppleVerifyConfigured(), true, 'native audience is always configured');
  const identity = await verify.verifyAppleIdToken(appleToken('com.dicoge.holohunter'));
  assert.equal(identity.provider, 'apple');
  assert.equal(identity.subject, 'apple-sub-1');
}

async function testAppleWebServicesIdRejectedWhenWebDisabled() {
  clearAuthEnv();
  process.env.APPLE_CLIENT_ID = 'com.dicoge.holohunter.web'; // Services ID configured
  // ...but APPLE_WEB_LOGIN_ENABLED not 'true' => web audience must be ignored.
  await expectError(
    verify.verifyAppleIdToken(appleToken('com.dicoge.holohunter.web')),
    'INVALID_TOKEN',
  );
}

async function testAppleWebServicesIdAcceptedWhenWebEnabled() {
  clearAuthEnv();
  process.env.APPLE_CLIENT_ID = 'com.dicoge.holohunter.web';
  process.env.APPLE_WEB_LOGIN_ENABLED = 'true';
  const identity = await verify.verifyAppleIdToken(appleToken('com.dicoge.holohunter.web'));
  assert.equal(identity.subject, 'apple-sub-1');
}

async function testNonceMismatchRejected() {
  clearAuthEnv();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  await expectError(
    verify.verifyGoogleIdToken(
      googleToken('web-client.apps.googleusercontent.com', { nonce: 'real-nonce' }),
      'expected-different-nonce',
    ),
    'INVALID_TOKEN',
  );
}

async function testExpiredTokenRejected() {
  clearAuthEnv();
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  const now = Math.floor(Date.now() / 1000);
  await expectError(
    verify.verifyGoogleIdToken(
      googleToken('web-client.apps.googleusercontent.com', { exp: now - 10 }),
    ),
    'TOKEN_EXPIRED',
  );
}

(async () => {
  const tests = [
    testGoogleWebAudienceAccepted,
    testGoogleIosAudienceAccepted,
    testGoogleWrongAudienceRejected,
    testAppleNativeBundleIdAcceptedWithoutAppleSetup,
    testAppleWebServicesIdRejectedWhenWebDisabled,
    testAppleWebServicesIdAcceptedWhenWebEnabled,
    testNonceMismatchRejected,
    testExpiredTokenRejected,
  ];
  for (const test of tests) {
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
