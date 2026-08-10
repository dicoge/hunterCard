#!/usr/bin/env node
/**
 * Friendly auth error mapping tests (DIC-922 blocker 4).
 *
 * Guards two things at once:
 *   1. Diagnostics — client-missing / redirect-mismatch / cancel / network /
 *      backend HTTP each produce a DISTINCT message, not one catch-all.
 *   2. Security — the mapper never echoes a raw provider/SDK/backend message,
 *      so an ID token / email accidentally in err.message can't leak to the UI.
 * Compiles the pure src/services/authErrorMessages.ts.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-error-map-tests-'));

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
  return output;
}

const { friendlyAuthErrorMessage, isCancelAuthError } = require(
  compileTs('src/services/authErrorMessages.ts'),
);

function testDistinctCausesGiveDistinctMessages() {
  const cases = [
    { code: 'client_id_missing', status: 500 },
    { code: 'redirect_uri_mismatch', status: 400 },
    { code: 'access_denied', status: 400 },
    { code: 'play_services_unavailable', status: 400 },
    { code: 'no_id_token', status: 400 },
    { code: 'network_error', status: 0 },
    { code: 'cancel', status: 400 },
    { status: 503 }, // unmapped backend 5xx
    { status: 401 }, // unmapped backend 4xx
  ];
  const messages = cases.map((c) => friendlyAuthErrorMessage(c, 'google'));
  const unique = new Set(messages);
  // Config, redirect, denied, play-services, no-token, network, cancel, 5xx, 4xx
  // must not all collapse to the same string (the pre-DIC-922 bug).
  assert.ok(unique.size >= 7, `expected diagnostic variety, got ${unique.size}: ${[...unique].join(' | ')}`);
  for (const m of messages) assert.ok(m && m.length > 0);
}

function testClientMissingIsRecognisable() {
  const m = friendlyAuthErrorMessage({ code: 'client_id_missing', status: 500 }, 'google');
  assert.match(m, /設定/);
}

function testCancelDetection() {
  assert.equal(isCancelAuthError({ code: 'cancel' }), true);
  assert.equal(isCancelAuthError({ code: 'access_denied' }), false);
  assert.equal(isCancelAuthError(null), false);
  assert.equal(isCancelAuthError(undefined), false);
}

function testNeverEchoesRawMessage() {
  // A hostile/leaky message must never appear in the friendly output.
  const secret = 'eyJhbGciOiJSUzI1NiJ9.SUPERSECRET.tokenpart user@example.com';
  const variants = [
    { message: secret },
    { code: 'weird_unmapped_code', message: secret, status: 418 },
    { code: 'client_id_missing', message: secret, status: 500 },
    { status: 500, message: secret },
    { status: 400, message: secret },
  ];
  for (const v of variants) {
    for (const provider of ['google', 'apple']) {
      const m = friendlyAuthErrorMessage(v, provider);
      assert.ok(!m.includes('SUPERSECRET'), `leaked token for ${JSON.stringify(v)}`);
      assert.ok(!m.includes('user@example.com'), `leaked email for ${JSON.stringify(v)}`);
      assert.ok(!m.includes('eyJ'), `leaked JWT header for ${JSON.stringify(v)}`);
    }
  }
}

function testProviderLabelApplied() {
  assert.match(friendlyAuthErrorMessage({ status: 401 }, 'apple'), /Apple/);
  assert.match(friendlyAuthErrorMessage({ status: 401 }, 'google'), /Google/);
}

function testNullishSafe() {
  assert.ok(friendlyAuthErrorMessage(null).length > 0);
  assert.ok(friendlyAuthErrorMessage(undefined).length > 0);
  assert.ok(friendlyAuthErrorMessage({}).length > 0);
}

const tests = [
  testDistinctCausesGiveDistinctMessages,
  testClientMissingIsRecognisable,
  testCancelDetection,
  testNeverEchoesRawMessage,
  testProviderLabelApplied,
  testNullishSafe,
];
try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} auth-error-map tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
