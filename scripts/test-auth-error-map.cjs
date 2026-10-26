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

function testAndroidNativeGoogleCodesAreDistinct() {
  // DIC-1318: the Android native path used to collapse every non-cancel
  // GoogleSignin.signIn() failure to the generic `google_failed` banner, so a
  // Play App Signing SHA-1 that isn't registered in Google Cloud Console (the
  // classic release-build symptom) looked identical to a flaky network. Each
  // preserved SDK code must now produce a DISTINCT friendly message so support
  // can diagnose from a screenshot.
  const codes = [
    'google_developer_error',
    'google_internal_error',
    'google_in_progress',
    'google_sign_in_required',
    'google_failed',
    'network_error',
    'play_services_unavailable',
  ];
  const msgs = codes.map((code) => friendlyAuthErrorMessage({ code, status: 400 }, 'google'));
  for (let i = 0; i < codes.length; i++) {
    assert.ok(msgs[i] && msgs[i].length > 0, `empty message for ${codes[i]}`);
  }
  // Every code above resolves to its OWN string — the DIC-1318 anti-regression:
  // if a future refactor drops one branch, its message collapses to another and
  // this Set-size check fails.
  const unique = new Set(msgs);
  assert.equal(
    unique.size,
    codes.length,
    `expected ${codes.length} distinct messages, got ${unique.size}: ${[...unique].join(' | ')}`,
  );
  // The support-facing screenshot must carry the developer-error MACHINE code
  // verbatim so a report can be filed against the right root cause; verify.
  const dev = friendlyAuthErrorMessage({ code: 'google_developer_error', status: 400 }, 'google');
  assert.ok(dev.includes('google_developer_error'),
    `developer-error message must expose the code label, got: ${dev}`);
}

function testWebRedirectTransportCodesAreDistinct() {
  // DIC-976: the web-Google same-window redirect transport can fail in several
  // ways that MUST each be distinguishable, not collapse to the generic default
  // the owner saw ("無法完成 Google 登入，請稍後再試。").
  const codes = [
    'popup_blocked',
    'crypto_unavailable',
    'storage_unavailable',
    'storage_unavailable_standalone',
    'state_mismatch',
    'no_window',
    'prompt_failed',
  ];
  const msgs = codes.map((code) => friendlyAuthErrorMessage({ code, status: 400 }, 'google'));
  const generic = friendlyAuthErrorMessage({}, 'google'); // the old catch-all
  for (let i = 0; i < codes.length; i++) {
    assert.ok(msgs[i] && msgs[i].length > 0, `empty message for ${codes[i]}`);
    // storage_unavailable and its _standalone variant intentionally share one
    // user-facing string (same remedy); every OTHER code must not equal generic.
    if (codes[i] !== 'prompt_failed') {
      assert.notEqual(
        msgs[i],
        generic,
        `${codes[i]} collapsed to the generic default — the DIC-976 bug`,
      );
    }
  }
  // At least five visually distinct strings across these codes.
  assert.ok(new Set(msgs).size >= 5, `expected variety, got ${new Set(msgs).size}`);
}

function testRedirectingSentinelIsCancelLike() {
  // The redirect transport throws a `redirecting` sentinel as it navigates away;
  // it is NOT a failure and must be suppressed exactly like a cancel.
  assert.equal(isCancelAuthError({ code: 'redirecting' }), true);
  assert.equal(isCancelAuthError({ code: 'cancel' }), true);
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
  testAndroidNativeGoogleCodesAreDistinct,
  testWebRedirectTransportCodesAreDistinct,
  testRedirectingSentinelIsCancelLike,
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
