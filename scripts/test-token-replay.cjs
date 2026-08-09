#!/usr/bin/env node
/**
 * Integration tests for server-side single-use ID-token replay protection
 * (DIC-665 / DIC-920 blocker 2).
 *
 * The classic Android Google path cannot bind an OIDC nonce, so the backend must
 * make each verified ID token single-use. These tests drive the REAL
 * verifyProviderToken() choke point (auth-endpoint.ts → verify-token.ts →
 * token-replay.ts) with real RS256 tokens, a mocked JWKS fetch, and a stateful KV
 * mock that implements SET NX / EX semantics, and assert:
 *   - First verification of a token succeeds.
 *   - Replaying the SAME token is rejected as TOKEN_REPLAYED (401).
 *   - A different, freshly-minted token still succeeds (happy path unaffected).
 *   - A forged/invalid token fails on signature BEFORE the replay marker is ever
 *     written (fail-fast, no KV pollution).
 *   - The replay marker is written with a TTL bounded to the token's exp.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-replay-tests-'));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

global.fetch = async (url) => {
  if (url === GOOGLE_JWKS_URL) {
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

// Stateful KV mock implementing just the SET NX/EX semantics token-replay needs.
const kvStore = new Map(); // key -> { setAt }
const kvSets = []; // record of { key, ttl } for TTL assertions
const kvMock = {
  async set(key, _value, opts) {
    if (opts && opts.nx && kvStore.has(key)) return null;
    kvStore.set(key, true);
    kvSets.push({ key, ttl: opts ? opts.ex : undefined });
    return 'OK';
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv: kvMock };
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

['api/_lib/identity-store.ts', 'api/_lib/verify-token.ts', 'api/_lib/token-replay.ts',
 'api/_lib/session.ts', 'api/_lib/auth-endpoint.ts'].forEach(compileTs);
const endpoint = require(path.join(outDir, 'api/_lib/auth-endpoint.js'));

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function signJwt(payload) {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}
const AUD = 'web-client.apps.googleusercontent.com';
function googleToken(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: 'google-sub-1',
    email: 'a@example.com',
    name: 'Ann',
    exp: now + 3600,
    ...extra,
  });
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`expected ${code} to be thrown, but call resolved`);
}

process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = AUD;

async function testFirstUseSucceedsReplayRejected() {
  kvStore.clear();
  kvSets.length = 0;
  const token = googleToken({ sub: 'replay-sub' });
  const identity = await endpoint.verifyProviderToken('google', token);
  assert.equal(identity.subject, 'replay-sub');
  // Second submission of the SAME token must be rejected as a replay.
  await expectError(endpoint.verifyProviderToken('google', token), 'TOKEN_REPLAYED');
}

async function testDistinctTokenStillWorks() {
  kvStore.clear();
  kvSets.length = 0;
  await endpoint.verifyProviderToken('google', googleToken({ jti: 'a', iat: 1 }));
  // A different token (distinct bytes) is independent — happy path unaffected.
  const identity = await endpoint.verifyProviderToken('google', googleToken({ jti: 'b', iat: 2 }));
  assert.equal(identity.provider, 'google');
  assert.equal(kvStore.size, 2, 'two distinct tokens claim two distinct markers');
}

async function testForgedTokenNeverTouchesKv() {
  kvStore.clear();
  kvSets.length = 0;
  // Valid structure but signed with a different key → signature check fails.
  const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT' };
  const payload = { iss: 'https://accounts.google.com', aud: AUD, sub: 's', exp: now + 3600 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const forged = `${signingInput}.${b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), otherKey))}`;
  await expectError(endpoint.verifyProviderToken('google', forged), 'INVALID_TOKEN');
  assert.equal(kvSets.length, 0, 'a forged token must never write a replay marker');
}

async function testMarkerTtlBoundedToExp() {
  kvStore.clear();
  kvSets.length = 0;
  const now = Math.floor(Date.now() / 1000);
  await endpoint.verifyProviderToken('google', googleToken({ sub: 'ttl-sub', exp: now + 120 }));
  assert.equal(kvSets.length, 1);
  const ttl = kvSets[0].ttl;
  assert.ok(ttl > 0 && ttl <= 120, `marker TTL must be bounded to token exp, got ${ttl}`);
}

const tests = [
  testFirstUseSucceedsReplayRejected,
  testDistinctTokenStillWorks,
  testForgedTokenNeverTouchesKv,
  testMarkerTtlBoundedToExp,
];

(async () => {
  try {
    for (const test of tests) {
      await test();
      console.log(`✓ ${test.name}`);
    }
    console.log(`\n${tests.length} token-replay tests passed`);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
