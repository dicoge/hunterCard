/**
 * test-auth-google-verify.mjs — DIC-665
 *
 * 驗證後端 Google id_token 驗證器 api/_lib/google-auth.ts 的 fail-closed 行為：
 * 以本地 RSA 金鑰簽 token、注入假 JWKS 離線驗證，確保簽章 / iss / aud / exp / nonce
 * 任一不符即 throw（呼叫端回 401），未設定 audience 即 throw NotConfigured（→ 501）。
 * 這是「不信任 client 解碼 payload、後端權威驗證」的核心保證。
 *
 * Run: node --experimental-strip-types scripts/test-auth-google-verify.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyGoogleIdToken,
  GoogleTokenInvalidError,
  GoogleAuthNotConfiguredError,
} from '../api/_lib/google-auth.ts';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const fetchJwks = async () => ({ keys: [jwk] });

const AUD = 'web-client.apps.googleusercontent.com';
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const nowSec = Math.floor(NOW_MS / 1000);

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, { alg = 'RS256', kid = KID, key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

function validPayload(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: '1234567890',
    exp: nowSec + 3600,
    iat: nowSec - 10,
    email: 'user@example.com',
    email_verified: true,
    name: 'Test User',
    picture: 'https://example.com/p.png',
    ...overrides,
  };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function expectInvalid(name, token, opts = {}) {
  await check(name, async () => {
    await assert.rejects(
      () => verifyGoogleIdToken(token, { allowedAudiences: [AUD], now, fetchJwks, ...opts }),
      (err) => err instanceof GoogleTokenInvalidError
    );
  });
}

console.log('Google id_token verifier (DIC-665)');

await check('valid token → returns identity (sub is subject, email is not identity)', async () => {
  const id = await verifyGoogleIdToken(signToken(validPayload()), {
    allowedAudiences: [AUD],
    now,
    fetchJwks,
  });
  assert.equal(id.sub, '1234567890');
  assert.equal(id.email, 'user@example.com');
  assert.equal(id.emailVerified, true);
  assert.equal(id.name, 'Test User');
});

await check('accepts bare accounts.google.com issuer', async () => {
  const id = await verifyGoogleIdToken(signToken(validPayload({ iss: 'accounts.google.com' })), {
    allowedAudiences: [AUD],
    now,
    fetchJwks,
  });
  assert.equal(id.sub, '1234567890');
});

await check('empty allowedAudiences → NotConfigured (endpoint 501, never trusts token)', async () => {
  await assert.rejects(
    () => verifyGoogleIdToken(signToken(validPayload()), { allowedAudiences: [], now, fetchJwks }),
    (err) => err instanceof GoogleAuthNotConfiguredError
  );
});

// Tampered signature: re-sign with a DIFFERENT key that isn't in the JWKS.
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
await expectInvalid('bad signature (signed by unknown key) → invalid', signToken(validPayload(), { key: otherKey }));

await expectInvalid('audience mismatch → invalid', signToken(validPayload({ aud: 'attacker-client' })));
await expectInvalid('untrusted issuer → invalid', signToken(validPayload({ iss: 'https://evil.example.com' })));
await expectInvalid('expired token → invalid', signToken(validPayload({ exp: nowSec - 120 })));
await expectInvalid('non-RS256 alg → invalid', signToken(validPayload(), { alg: 'none' }));

await expectInvalid(
  'nonce mismatch → invalid',
  signToken(validPayload({ nonce: 'server-nonce' })),
  { expectedNonce: 'different-nonce' }
);

await check('matching nonce → valid', async () => {
  const id = await verifyGoogleIdToken(signToken(validPayload({ nonce: 'server-nonce' })), {
    allowedAudiences: [AUD],
    now,
    fetchJwks,
    expectedNonce: 'server-nonce',
  });
  assert.equal(id.sub, '1234567890');
});

await expectInvalid('empty id_token → invalid', '');
await expectInvalid('malformed (two segments) → invalid', 'aaa.bbb');

console.log(`\n${passed} checks passed.`);
