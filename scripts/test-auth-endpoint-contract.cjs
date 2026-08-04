#!/usr/bin/env node
/**
 * Production auth runtime-contract regressions (DIC-891).
 *
 * Exercises the /api/auth/[action] handler end-to-end against a Vercel-KV mock
 * and a stubbed global fetch, asserting the fail-fast contract the production QA
 * (DIC-890) required:
 *
 *   1. GET /api/auth/me without a session → structured JSON 401, and it NEVER
 *      touches KV (so it cannot hang on backend init). HEAD behaves the same.
 *   2. Invalid POST /api/auth/login → structured JSON 4xx, returned before any
 *      KV / provider dependency, even when the backend is unconfigured.
 *   3. A missing backend (no KV env) fails closed with a bounded JSON 501, and a
 *      slow/failing provider JWKS fails closed with a bounded JSON 503 rather
 *      than an unbounded hang.
 *
 * The handler uses the Web Request/Response signature, so each case builds a real
 * Request and inspects the returned Response — the same contract Vercel invokes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-endpoint-contract-'));

// ---- Vercel-KV mock that records whether it was touched at all -------------
const kvState = { touched: false, values: new Map() };
const kv = new Proxy(
  {},
  {
    get() {
      // Any KV method access on the fail-fast paths is a contract violation.
      return async () => {
        kvState.touched = true;
        return null;
      };
    },
  },
);

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv };
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

// Compile the handler and its dependency graph (relative requires resolve
// against the mirrored outDir tree).
for (const rel of [
  'api/_lib/identity-store.ts',
  'api/_lib/session.ts',
  'api/_lib/verify-token.ts',
  'api/_lib/auth-endpoint.ts',
  'api/auth/[action].ts',
]) {
  compileTs(rel);
}
const handler = require(path.join(outDir, 'api/auth/[action].js')).default;

const BASE = 'https://holocard-hunter.vercel.app';

function req(method, action, { headers, body } = {}) {
  const init = { method, headers: headers ?? {} };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json', ...init.headers };
  }
  return new Request(`${BASE}/api/auth/${action}`, init);
}

async function readJson(res) {
  const text = await res.text();
  assert.ok(text.length > 0, 'response body must not be zero bytes');
  return JSON.parse(text);
}

function clearBackendEnv() {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_READ_ONLY_TOKEN;
  delete process.env.AUTH_SESSION_SECRET;
  delete process.env.GOOGLE_WEB_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_IOS_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
}

function configureBackend() {
  process.env.KV_REST_API_URL = 'https://kv.example';
  process.env.KV_REST_API_TOKEN = 'kv-token';
  process.env.AUTH_SESSION_SECRET = 'test-secret';
}

// ---- Tests ----------------------------------------------------------------

async function testGetMeNoSessionReturns401JsonWithoutKv() {
  configureBackend();
  kvState.touched = false;
  const started = Date.now();
  const res = await handler(req('GET', 'me'));
  const elapsed = Date.now() - started;
  assert.equal(res.status, 401, 'GET /me without session must be 401');
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await readJson(res);
  assert.equal(body.error, 'INVALID_TOKEN');
  assert.equal(kvState.touched, false, 'GET /me 401 must not touch KV');
  assert.ok(elapsed < 1000, `GET /me must be fast, took ${elapsed}ms`);
}

async function testHeadMeNoSessionReturns401() {
  configureBackend();
  const res = await handler(req('HEAD', 'me'));
  assert.equal(res.status, 401, 'HEAD /me without session must be 401, not 405');
}

async function testGetMeStillFailsFastWhenBackendUnconfigured() {
  clearBackendEnv();
  kvState.touched = false;
  const res = await handler(req('GET', 'me'));
  assert.equal(res.status, 401, 'GET /me without session is 401 even if backend unset');
  await readJson(res);
  assert.equal(kvState.touched, false);
}

async function testInvalidLoginReturns400WithoutKv() {
  configureBackend();
  kvState.touched = false;
  // Missing provider.
  let res = await handler(req('POST', 'login', { body: { idToken: 'x' } }));
  assert.equal(res.status, 400);
  assert.equal((await readJson(res)).error, 'invalid_provider');
  // Missing idToken.
  res = await handler(req('POST', 'login', { body: { provider: 'google' } }));
  assert.equal(res.status, 400);
  assert.equal((await readJson(res)).error, 'missing_id_token');
  assert.equal(kvState.touched, false, 'invalid login must not touch KV/provider');
}

async function testInvalidLoginReturns400EvenWhenBackendUnconfigured() {
  clearBackendEnv();
  const res = await handler(req('POST', 'login', { body: { provider: 'nope' } }));
  assert.equal(res.status, 400, 'invalid input is a 4xx, not a 501, even with no backend');
  assert.equal((await readJson(res)).error, 'invalid_provider');
}

async function testInvalidJsonBodyReturns400() {
  configureBackend();
  const res = await handler(req('POST', 'login', { body: '{not json', headers: { 'Content-Type': 'application/json' } }));
  assert.equal(res.status, 400);
  assert.equal((await readJson(res)).error, 'invalid_json');
}

async function testValidShapeLoginFailsClosedWhenBackendUnconfigured() {
  clearBackendEnv();
  const res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: 'header.payload.sig' } }));
  assert.equal(res.status, 501, 'well-formed login with no backend fails closed 501');
  assert.equal((await readJson(res)).error, 'STORE_NOT_CONFIGURED');
}

async function testMutatingActionRejectsNonPost() {
  configureBackend();
  const res = await handler(req('GET', 'login'));
  assert.equal(res.status, 405, 'GET /login must be 405');
  assert.equal((await readJson(res)).error, 'method_not_allowed');
}

async function testSlowProviderJwksFailsClosedBounded() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  process.env.JWKS_FETCH_TIMEOUT_MS = '50';
  // A JWKS endpoint that never responds until the abort signal fires.
  const originalFetch = global.fetch;
  global.fetch = (url, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  // A syntactically valid (but unverifiable) JWT so verification reaches JWKS.
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'client-abc' })).toString('base64url'),
    Buffer.from('sig').toString('base64url'),
  ].join('.');
  const started = Date.now();
  let res;
  try {
    res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: jwt } }));
  } finally {
    global.fetch = originalFetch;
    delete process.env.JWKS_FETCH_TIMEOUT_MS;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  const elapsed = Date.now() - started;
  assert.equal(res.status, 503, 'slow provider JWKS must fail closed with 503');
  assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
  assert.ok(elapsed < 2000, `provider timeout must be bounded, took ${elapsed}ms`);
}

async function testFailingProviderJwksFailsClosed() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('nope', { status: 500 });
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'client-abc' })).toString('base64url'),
    Buffer.from('sig').toString('base64url'),
  ].join('.');
  let res;
  try {
    res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: jwt } }));
  } finally {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  assert.equal(res.status, 503, 'a 5xx from the provider JWKS fails closed 503');
  assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
}

(async () => {
  const tests = [
    testGetMeNoSessionReturns401JsonWithoutKv,
    testHeadMeNoSessionReturns401,
    testGetMeStillFailsFastWhenBackendUnconfigured,
    testInvalidLoginReturns400WithoutKv,
    testInvalidLoginReturns400EvenWhenBackendUnconfigured,
    testInvalidJsonBodyReturns400,
    testValidShapeLoginFailsClosedWhenBackendUnconfigured,
    testMutatingActionRejectsNonPost,
    testSlowProviderJwksFailsClosedBounded,
    testFailingProviderJwksFailsClosed,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} auth endpoint contract tests passed`);
})()
  .finally(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    Module._load = originalLoad;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
