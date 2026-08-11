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
 * Production invokes the function under Vercel's classic Node.js runtime, i.e.
 * `(req, res)` with a RELATIVE `req.url` and a pre-parsed `req.body`, NOT the Web
 * `Request`/`Response` signature the handler is authored in (that mismatch is what
 * returned FUNCTION_INVOCATION_FAILED in DIC-893). So each case drives the handler
 * through the real Node boundary — a mock `(req, res)` with a relative url — and
 * inspects what gets written to `res`, exactly as Vercel does.
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
  'api/_lib/token-replay.ts',
  'api/_lib/auth-endpoint.ts',
  'api/_lib/apple-web-oauth.ts',
  'api/_lib/apple-exchange-store.ts',
  'api/_lib/node-adapter.ts',
  'api/auth/[action].ts',
]) {
  compileTs(rel);
}
// The default export is now the Vercel Node `(req, res)` handler (the Web handler
// bridged through node-adapter.ts).
const nodeHandler = require(path.join(outDir, 'api/auth/[action].js')).default;

const HOST = 'holocard-hunter.vercel.app';

// A request descriptor, NOT a Web Request: the Node boundary receives a relative
// url + pre-parsed body, so tests describe intent and `handler()` reconstructs the
// Node req/res that Vercel would hand the function.
function req(method, action, { headers, body } = {}) {
  return { method, action, headers: headers ?? {}, body };
}

// Build the mock Node request Vercel passes: RELATIVE url, lowercased header bag,
// `req.body` pre-parsed by Vercel's JSON body parser (a raw string stands in for a
// body the parser could not parse, so invalid_json still round-trips).
function buildNodeReq({ method, action, headers, body }) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  if (!h.host) h.host = HOST;
  let parsedBody;
  if (body !== undefined) {
    if (typeof body === 'string') {
      parsedBody = body;
    } else {
      parsedBody = body;
      if (!h['content-type']) h['content-type'] = 'application/json';
    }
  }
  return { method, url: `/api/auth/${action}`, headers: h, body: parsedBody, query: { action } };
}

// A mock VercelResponse capturing what the handler writes.
function buildNodeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: '',
    headersSent: false,
    status(code) {
      this._status = code;
      return this;
    },
    setHeader(k, v) {
      this._headers[k.toLowerCase()] = v;
      return this;
    },
    getHeader(k) {
      return this._headers[k.toLowerCase()];
    },
    json(obj) {
      this.setHeader('content-type', 'application/json');
      this._body = JSON.stringify(obj);
      this.headersSent = true;
      return this;
    },
    send(b) {
      this._body = b == null ? '' : String(b);
      this.headersSent = true;
      return this;
    },
    end(b) {
      if (b != null) this._body = String(b);
      this.headersSent = true;
      return this;
    },
  };
}

// Drive the handler through the exact Node `(req, res)` boundary Vercel uses, then
// re-wrap the written result as a Web Response so the assertions below stay simple.
async function handler(descriptor) {
  const res = buildNodeRes();
  await nodeHandler(buildNodeReq(descriptor), res);
  return new Response(res._body, { status: res._status, headers: res._headers });
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

// A syntactically valid (unverifiable) Google JWT so verification reaches JWKS.
function googleJwt() {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'user-1', aud: 'client-abc' })).toString('base64url'),
    Buffer.from('sig').toString('base64url'),
  ].join('.');
}

// The core CR DIC-891 regression: headers (200) arrive immediately but the body
// stalls forever. The abort timer must still fire and abort the body read, so the
// request fails closed with a bounded 503 instead of hanging.
async function testStalledJwksBodyIsBoundedTo503() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  process.env.JWKS_FETCH_TIMEOUT_MS = '50';
  const originalFetch = global.fetch;
  global.fetch = (url, opts) => {
    const signal = opts && opts.signal;
    // Resolve the fetch immediately (headers present) but never resolve the body.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        }),
    });
  };
  const started = Date.now();
  let res;
  try {
    res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: googleJwt() } }));
  } finally {
    global.fetch = originalFetch;
    delete process.env.JWKS_FETCH_TIMEOUT_MS;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  const elapsed = Date.now() - started;
  assert.equal(res.status, 503, 'a stalled JWKS body must fail closed with 503');
  assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
  assert.ok(elapsed < 2000, `stalled body must be bounded by the abort timer, took ${elapsed}ms`);
}

// Malformed provider payload must fail closed via the same structured 503 and
// must NOT be cached — a second attempt fails identically rather than serving a
// poisoned cache entry.
async function testMalformedJwksPayloadFailsClosedAndNotCached() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ keys: 'not-an-array' }) };
  };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: googleJwt() } }));
      assert.equal(res.status, 503, 'malformed JWKS payload fails closed 503');
      assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
    }
  } finally {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  assert.equal(calls, 2, 'malformed payload must not be cached; the provider is re-fetched');
}

// A JWK whose `kid` matches the token header but which carries NO usable key
// material must fail the JWKS shape check (never cached) rather than being cached
// and then throwing generically in crypto.createPublicKey(). Two calls → two
// provider fetches and a structured 503 each time (CR DIC-891).
async function testMatchingKidWithoutKeyMaterialFailsClosedAndNotCached() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    // Matching kid, but no kty / n / e — not constructible.
    return { ok: true, status: 200, json: async () => ({ keys: [{ kid: 'k1' }] }) };
  };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: googleJwt() } }));
      assert.equal(res.status, 503, 'matching-kid-without-key-material must fail closed 503');
      assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
    }
  } finally {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  assert.equal(calls, 2, 'a materialless key must not poison the cache; the provider is re-fetched');
}

// A JWK that passes string-field shape checks but is not actually constructible
// (invalid EC point → ERR_CRYPTO_INVALID_JWK). It must fail closed with a
// structured 503 and, critically, NOT poison the cache: a second request must
// re-fetch the provider rather than reuse the bad key for 10 minutes (CR DIC-891).
async function testUnconstructibleEcKeyFailsClosedAndNotCached() {
  configureBackend();
  process.env.GOOGLE_WEB_CLIENT_ID = 'client-abc';
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ keys: [{ kid: 'k1', kty: 'EC', crv: 'P-256', x: 'a', y: 'a' }] }),
    };
  };
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = await handler(req('POST', 'login', { body: { provider: 'google', idToken: googleJwt() } }));
      assert.equal(res.status, 503, 'an unconstructible EC key must fail closed 503');
      assert.equal((await readJson(res)).error, 'PROVIDER_UNAVAILABLE');
    }
  } finally {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_WEB_CLIENT_ID;
  }
  assert.equal(calls, 2, 'an unconstructible key must not poison the cache; the provider is re-fetched');
}

// The core DIC-893 regression: under Vercel's Node runtime the function is invoked
// as `(req, res)` with a RELATIVE `req.url`. The pre-fix Web-only handler either
// hung (DIC-890) or threw on `new URL('/api/auth/me')` and surfaced as an opaque
// `FUNCTION_INVOCATION_FAILED` text/plain 500. Drive the raw Node handler and prove
// both contract paths now WRITE structured JSON to `res` and never throw.
async function testNodeBoundaryRelativeUrlReturnsStructuredJsonNotCrash() {
  configureBackend();
  // Unauthenticated GET /api/auth/me → 401 JSON written to res.
  let res = buildNodeRes();
  await nodeHandler(
    { method: 'GET', url: '/api/auth/me', headers: { host: HOST }, query: { action: 'me' } },
    res,
  );
  assert.equal(res._status, 401, 'Node-boundary GET /me must write 401, not crash');
  assert.equal(res._headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res._body).error, 'INVALID_TOKEN');

  // Invalid POST /api/auth/login → structured 4xx JSON written to res.
  res = buildNodeRes();
  await nodeHandler(
    {
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: { idToken: 'x' },
      query: { action: 'login' },
    },
    res,
  );
  assert.equal(res._status, 400, 'Node-boundary invalid login must write 4xx, not crash');
  assert.equal(JSON.parse(res._body).error, 'invalid_provider');
}

// The adapter's last line of defense: if anything unexpected throws at the Node
// boundary, the client must still get a structured JSON 500 — never an opaque
// platform FUNCTION_INVOCATION_FAILED. Force a throw by making `req.headers` throw
// on access and assert a structured 500 is written instead of the throw escaping.
async function testNodeBoundaryCatchesUnexpectedThrow() {
  const res = buildNodeRes();
  const hostileReq = {
    method: 'GET',
    url: '/api/auth/me',
    query: { action: 'me' },
    get headers() {
      throw new Error('simulated runtime fault');
    },
  };
  await assert.doesNotReject(nodeHandler(hostileReq, res), 'adapter must swallow the throw');
  assert.equal(res._status, 500, 'an unexpected boundary throw must become a 500');
  assert.equal(res._headers['content-type'], 'application/json');
  assert.equal(JSON.parse(res._body).error, 'internal_error');
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
    testStalledJwksBodyIsBoundedTo503,
    testMalformedJwksPayloadFailsClosedAndNotCached,
    testMatchingKidWithoutKeyMaterialFailsClosedAndNotCached,
    testUnconstructibleEcKeyFailsClosedAndNotCached,
    testNodeBoundaryRelativeUrlReturnsStructuredJsonNotCrash,
    testNodeBoundaryCatchesUnexpectedThrow,
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
