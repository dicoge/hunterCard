#!/usr/bin/env node
/**
 * Web-Google same-window redirect transport tests (DIC-976).
 *
 * The owner hit a hard "無法完成 Google 登入" alert on an iPhone Home-Screen PWA
 * (manifest display:standalone). Root cause: expo-auth-session's web popup
 * transport (window.open + postMessage-to-opener) cannot work inside an iOS
 * standalone PWA — the OAuth URL opens in a detached Safari process with no
 * opener, so the code never returns, and window.open() often returns null →
 * ERR_WEB_BROWSER_BLOCKED, which collapsed to the generic alert.
 *
 * The fix runs the web-Google prompt as a SAME-WINDOW full-page redirect and
 * finishes the PKCE exchange on the next app load. These tests lock the PURE
 * decision/serialisation helpers that make that flow correct and CSRF-safe:
 *   - web uses the redirect transport (never popup); native is unaffected
 *   - standalone-PWA detection folds both browser signals
 *   - pending-state round-trips and fails CLOSED on malformed / stale payloads
 *   - the OAuth return is classified (success / error / none) from the URL
 *
 * NOTE: like the DIC-922 redirect-URI test, this proves the CLIENT contract is
 * deterministic. It does NOT and CANNOT prove the owner-iPhone E2E — that needs
 * the real Google account round-trip on the device (the issue's acceptance gate).
 * Compiles the pure src/services/authStrategy.ts (no react-native/expo imports).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-google-redirect-tests-'));

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

const strategy = require(compileTs('src/services/authStrategy.ts'));

function testWebUsesRedirectTransport() {
  // The whole point of DIC-976: web must NOT use the popup transport.
  assert.equal(strategy.webGoogleTransport('web'), 'redirect');
}

function testNativeTransportIsInert() {
  // Native never reaches this path; the value is inert but must not be 'redirect'
  // (which would imply the web full-page flow on a native platform).
  assert.equal(strategy.webGoogleTransport('ios'), 'popup');
  assert.equal(strategy.webGoogleTransport('android'), 'popup');
  assert.equal(strategy.webGoogleTransport('windows'), 'popup');
}

function testStandaloneDetection() {
  assert.equal(strategy.isStandalonePwa({ navigatorStandalone: true }), true);
  assert.equal(strategy.isStandalonePwa({ displayModeStandalone: true }), true);
  assert.equal(
    strategy.isStandalonePwa({ navigatorStandalone: true, displayModeStandalone: true }),
    true,
  );
  assert.equal(
    strategy.isStandalonePwa({ navigatorStandalone: false, displayModeStandalone: false }),
    false,
  );
  assert.equal(strategy.isStandalonePwa({}), false);
  assert.equal(strategy.isStandalonePwa({ navigatorStandalone: null, displayModeStandalone: null }), false);
}

function testPendingStateRoundTrip() {
  // A login payload round-trips with operation:'login' and no session.
  const login = {
    codeVerifier: 'verifier-123',
    nonce: 'nonce-abc',
    state: 'state-xyz',
    createdAt: 1000,
    operation: 'login',
  };
  const parsedLogin = strategy.parseWebRedirectState(
    strategy.serializeWebRedirectState(login),
    10 * 60 * 1000,
    1000,
  );
  assert.deepEqual(parsedLogin, login);

  // A link payload round-trips WITH operation:'link' and its session preserved.
  const link = {
    codeVerifier: 'v2',
    nonce: 'n2',
    state: 's2',
    createdAt: 1000,
    operation: 'link',
    session: 'sess-token-abc',
  };
  const parsedLink = strategy.parseWebRedirectState(
    strategy.serializeWebRedirectState(link),
    10 * 60 * 1000,
    1000,
  );
  assert.deepEqual(parsedLink, link);
}

function testOperationDefaultsToLoginForLegacyPayload() {
  // Legacy payload (pre-DIC-976-CR) has no `operation`; it must parse as 'login'
  // so old in-flight logins still complete, never accidentally as a link.
  const legacy = JSON.stringify({ codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000 });
  const parsed = strategy.parseWebRedirectState(legacy, 10 * 60 * 1000, 1000);
  assert.ok(parsed);
  assert.equal(parsed.operation, 'login');
  assert.equal(parsed.session, undefined);
}

function testLinkWithoutSessionFailsClosed() {
  // CR blocker 1: a 'link' payload MISSING its session must be rejected (null) —
  // resuming without the authenticated session would degrade to /auth/login and
  // switch accounts. Refuse rather than guess.
  const linkNoSession = JSON.stringify({
    codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000, operation: 'link',
  });
  assert.equal(strategy.parseWebRedirectState(linkNoSession, 10 * 60 * 1000, 1000), null);

  const linkEmptySession = JSON.stringify({
    codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000, operation: 'link', session: '',
  });
  assert.equal(strategy.parseWebRedirectState(linkEmptySession, 10 * 60 * 1000, 1000), null);
}

function testLoginWithSessionFailsClosed() {
  // A 'login' carrying a session is malformed/tampered mixed state — fail closed.
  const loginWithSession = JSON.stringify({
    codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000, operation: 'login', session: 'x',
  });
  assert.equal(strategy.parseWebRedirectState(loginWithSession, 10 * 60 * 1000, 1000), null);
}

function testUnknownOperationFailsClosed() {
  const bad = JSON.stringify({
    codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000, operation: 'delete',
  });
  assert.equal(strategy.parseWebRedirectState(bad, 10 * 60 * 1000, 1000), null);
}

function testPendingStateFailsClosed() {
  const maxAge = 10 * 60 * 1000;
  // Missing / malformed payloads all become null (never throw, never partial).
  assert.equal(strategy.parseWebRedirectState(null), null);
  assert.equal(strategy.parseWebRedirectState(''), null);
  assert.equal(strategy.parseWebRedirectState('not json'), null);
  assert.equal(strategy.parseWebRedirectState('{}'), null);
  assert.equal(strategy.parseWebRedirectState('{"codeVerifier":"v"}'), null); // missing nonce/state/createdAt
  assert.equal(
    strategy.parseWebRedirectState(
      JSON.stringify({ codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 'x' }),
    ),
    null,
  );
  assert.equal(
    strategy.parseWebRedirectState(
      JSON.stringify({ codeVerifier: '', nonce: 'n', state: 's', createdAt: 1 }),
    ),
    null,
  );
}

function testPendingStateExpires() {
  const maxAge = 10 * 60 * 1000;
  const fresh = JSON.stringify({ codeVerifier: 'v', nonce: 'n', state: 's', createdAt: 1000 });
  // Within window: parses.
  assert.ok(strategy.parseWebRedirectState(fresh, maxAge, 1000 + maxAge));
  // Just past window: fails closed.
  assert.equal(strategy.parseWebRedirectState(fresh, maxAge, 1000 + maxAge + 1), null);
}

function testParseReturnSuccess() {
  const r = strategy.parseWebRedirectReturn('?code=abc123&state=st-42&scope=email');
  assert.equal(r.kind, 'success');
  assert.equal(r.code, 'abc123');
  assert.equal(r.state, 'st-42');
}

function testParseReturnError() {
  const r = strategy.parseWebRedirectReturn('?error=access_denied&state=st-42');
  assert.equal(r.kind, 'error');
  assert.equal(r.error, 'access_denied');
  // error path never yields a usable code.
  assert.equal(r.code, undefined);
}

function testParseReturnNone() {
  assert.equal(strategy.parseWebRedirectReturn('').kind, 'none');
  assert.equal(strategy.parseWebRedirectReturn(null).kind, 'none');
  assert.equal(strategy.parseWebRedirectReturn('?foo=bar').kind, 'none');
  // code without state is NOT a trusted success (CSRF: state is mandatory).
  assert.equal(strategy.parseWebRedirectReturn('?code=abc').kind, 'none');
}

function testParseReturnLeadingQuestionMarkOptional() {
  const a = strategy.parseWebRedirectReturn('?code=x&state=y');
  const b = strategy.parseWebRedirectReturn('code=x&state=y');
  assert.deepEqual(a, b);
}

const tests = [
  testWebUsesRedirectTransport,
  testNativeTransportIsInert,
  testStandaloneDetection,
  testPendingStateRoundTrip,
  testOperationDefaultsToLoginForLegacyPayload,
  testLinkWithoutSessionFailsClosed,
  testLoginWithSessionFailsClosed,
  testUnknownOperationFailsClosed,
  testPendingStateFailsClosed,
  testPendingStateExpires,
  testParseReturnSuccess,
  testParseReturnError,
  testParseReturnNone,
  testParseReturnLeadingQuestionMarkOptional,
];
try {
  for (const test of tests) {
    test();
    console.log(`\u2713 ${test.name}`);
  }
  console.log(`\n${tests.length} web-google-redirect tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
