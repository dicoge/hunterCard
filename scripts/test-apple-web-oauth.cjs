#!/usr/bin/env node
/**
 * Web + Android server-callback Sign in with Apple tests (DIC-960).
 *
 * Exercises the pure, security-critical pieces of api/_lib/apple-web-oauth.ts in
 * plain Node with no live Apple / KV dependency: fail-closed config gating,
 * signed-state creation/verification (tamper, expiry, nonce binding), authorize
 * URL shape (response_mode=form_post), form_post body parsing, first-login-only
 * name extraction, open-redirect defence on the return target, and the
 * return/error HTML contract (session in fragment, </script>-safe embedding).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-web-oauth-tests-'));

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

const m = require(compileTs('api/_lib/apple-web-oauth.ts'));

const SECRET = 'test-session-secret-please-ignore';

function fullEnv(overrides = {}) {
  return {
    APPLE_WEB_LOGIN_ENABLED: 'true',
    APPLE_CLIENT_ID: 'com.dicoge.holohunter.web',
    APPLE_WEB_REDIRECT_URI: 'https://example.test/api/auth/apple/web',
    AUTH_SESSION_SECRET: SECRET,
    APPLE_WEB_ALLOWED_RETURNS: 'https://example.test,holohunter://auth/apple/return',
    ...overrides,
  };
}

function testConfigFailsClosed() {
  // Flag off → null even if everything else is present.
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_WEB_LOGIN_ENABLED: 'false' })), null);
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_WEB_LOGIN_ENABLED: undefined })), null);
  // Any single missing field → null (fail closed).
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_CLIENT_ID: '', EXPO_PUBLIC_APPLE_SERVICE_ID: '' })), null);
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_WEB_REDIRECT_URI: '' })), null);
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ AUTH_SESSION_SECRET: '' })), null);
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_WEB_ALLOWED_RETURNS: '' })), null);
  // A whitespace-only allow-list collapses to zero entries → null.
  assert.equal(m.getAppleWebOAuthConfig(fullEnv({ APPLE_WEB_ALLOWED_RETURNS: ' , ,' })), null);
}

function testConfigSuccess() {
  const cfg = m.getAppleWebOAuthConfig(fullEnv());
  assert.ok(cfg);
  assert.equal(cfg.serviceId, 'com.dicoge.holohunter.web');
  assert.equal(cfg.redirectUri, 'https://example.test/api/auth/apple/web');
  assert.equal(cfg.secret, SECRET);
  assert.deepEqual(cfg.allowedReturns, ['https://example.test', 'holohunter://auth/apple/return']);
  // Services ID can also come from the EXPO_PUBLIC alias.
  const cfg2 = m.getAppleWebOAuthConfig(
    fullEnv({ APPLE_CLIENT_ID: '', EXPO_PUBLIC_APPLE_SERVICE_ID: 'svc.id' }),
  );
  assert.equal(cfg2.serviceId, 'svc.id');
}

function makeState(overrides = {}) {
  return {
    nonce: 'nonce-abc',
    platform: 'web',
    ret: 'https://example.test',
    csrf: 'csrf-xyz',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function testStateRoundTrip() {
  const state = makeState();
  const signed = m.signAppleState(state, SECRET);
  const parsed = m.verifyAppleState(signed, SECRET);
  assert.ok(parsed);
  assert.equal(parsed.nonce, 'nonce-abc');
  assert.equal(parsed.platform, 'web');
  assert.equal(parsed.ret, 'https://example.test');
}

function testStateTamperFailsClosed() {
  const signed = m.signAppleState(makeState(), SECRET);
  // Wrong secret.
  assert.equal(m.verifyAppleState(signed, 'other-secret'), null);
  // Tampered signature.
  assert.equal(m.verifyAppleState(signed.slice(0, -2) + 'xx', SECRET), null);
  // Tampered payload (re-encode a mutated nonce, keep the old signature).
  const [enc, sig] = signed.split('.');
  const mutated = Buffer.from(
    JSON.stringify(makeState({ nonce: 'attacker-nonce' })),
  ).toString('base64url');
  assert.equal(m.verifyAppleState(`${mutated}.${sig}`, SECRET), null);
  // Malformed blobs.
  assert.equal(m.verifyAppleState('', SECRET), null);
  assert.equal(m.verifyAppleState('no-dot', SECRET), null);
  assert.equal(m.verifyAppleState(null, SECRET), null);
  // No secret → null even for a syntactically valid token.
  assert.equal(m.verifyAppleState(signed, ''), null);
}

function testStateExpiry() {
  const expired = m.signAppleState(makeState({ exp: 1000 }), SECRET);
  // Well past exp.
  assert.equal(m.verifyAppleState(expired, SECRET, 2000), null);
  // Before exp it verifies.
  assert.ok(m.verifyAppleState(expired, SECRET, 500));
}

function testStateFieldValidation() {
  // Bad platform value fails closed even with a valid signature.
  const badPlatform = m.signAppleState(makeState({ platform: 'ios' }), SECRET);
  assert.equal(m.verifyAppleState(badPlatform, SECRET), null);
  const emptyNonce = m.signAppleState(makeState({ nonce: '' }), SECRET);
  assert.equal(m.verifyAppleState(emptyNonce, SECRET), null);
  const emptyRet = m.signAppleState(makeState({ ret: '' }), SECRET);
  assert.equal(m.verifyAppleState(emptyRet, SECRET), null);
}

function testSignStateRequiresSecret() {
  assert.throws(() => m.signAppleState(makeState(), ''));
}

function testAuthorizeUrl() {
  const url = m.buildAppleAuthorizeUrl({
    clientId: 'svc.id',
    redirectUri: 'https://example.test/api/auth/apple/web',
    state: 'signed-state',
    nonce: 'nonce-abc',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://appleid.apple.com/auth/authorize');
  assert.equal(parsed.searchParams.get('response_type'), 'code id_token');
  assert.equal(parsed.searchParams.get('response_mode'), 'form_post');
  assert.equal(parsed.searchParams.get('client_id'), 'svc.id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://example.test/api/auth/apple/web');
  assert.equal(parsed.searchParams.get('state'), 'signed-state');
  assert.equal(parsed.searchParams.get('nonce'), 'nonce-abc');
  assert.equal(parsed.searchParams.get('scope'), 'name email');
}

function testParseFormPost() {
  const body = new URLSearchParams({
    id_token: 'tok',
    code: 'auth-code',
    state: 'st',
    user: '{"name":{"firstName":"A"}}',
  }).toString();
  const parsed = m.parseAppleFormPost(body);
  assert.equal(parsed.idToken, 'tok');
  assert.equal(parsed.code, 'auth-code');
  assert.equal(parsed.state, 'st');
  assert.equal(parsed.user, '{"name":{"firstName":"A"}}');
  assert.equal(parsed.error, undefined);
  // Error passthrough + empty body yields all-undefined.
  assert.equal(m.parseAppleFormPost('error=user_cancelled_authorize').error, 'user_cancelled_authorize');
  const empty = m.parseAppleFormPost('');
  assert.equal(empty.idToken, undefined);
  assert.equal(empty.state, undefined);
}

function testParseUserName() {
  assert.equal(
    m.parseAppleUserName('{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"x@y"}'),
    'Ada Lovelace',
  );
  assert.equal(m.parseAppleUserName('{"name":{"firstName":"Ada"}}'), 'Ada');
  assert.equal(m.parseAppleUserName(undefined), undefined);
  assert.equal(m.parseAppleUserName('not json'), undefined);
  assert.equal(m.parseAppleUserName('{"name":{}}'), undefined);
}

function testResolveReturnTarget() {
  const cfg = m.getAppleWebOAuthConfig(fullEnv());
  // Allow-listed exact match honoured.
  assert.equal(m.resolveReturnTarget('holohunter://auth/apple/return', cfg), 'holohunter://auth/apple/return');
  // Empty falls back to the first allow-listed entry.
  assert.equal(m.resolveReturnTarget('', cfg), 'https://example.test');
  assert.equal(m.resolveReturnTarget(null, cfg), 'https://example.test');
  // NOT allow-listed → null (open-redirect defence).
  assert.equal(m.resolveReturnTarget('https://evil.example', cfg), null);
  assert.equal(m.resolveReturnTarget('javascript:alert(1)', cfg), null);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function testReturnHtml() {
  const htmlOut = m.buildAppleReturnHtml('https://example.test', { session: 'sess ion/+=', isNew: true });
  // Session goes in the FRAGMENT, url-encoded, and isNew is flagged.
  assert.ok(htmlOut.includes('#session=sess%20ion%2F%2B%3D&isNew=1'));
  assert.ok(htmlOut.includes('location.replace('));
  // Exactly one legitimate </script> closing tag — no breakout from the embedded
  // literal. A crafted target carrying a </script> must stay escaped (<), so
  // the count remains one even then.
  assert.equal(countOccurrences(htmlOut.toLowerCase(), '</script>'), 1);
  const crafted = m.buildAppleReturnHtml('https://example.test/</script><script>x', { session: 's', isNew: false });
  assert.equal(countOccurrences(crafted.toLowerCase(), '</script>'), 1);
  assert.equal(countOccurrences(crafted.toLowerCase(), '<script>'), 1);
  const notNew = m.buildAppleReturnHtml('https://example.test', { session: 's', isNew: false });
  assert.ok(notNew.includes('isNew=0'));
}

function testErrorHtml() {
  // With a trusted target: bounce back with error in the fragment.
  const withTarget = m.buildAppleErrorHtml('holohunter://auth/apple/return', 'invalid_grant');
  assert.ok(withTarget.includes('#error=invalid_grant'));
  assert.ok(withTarget.includes('location.replace('));
  // With NO target (forged/invalid state): terminal page, never an open redirect.
  const noTarget = m.buildAppleErrorHtml(null, 'invalid_state');
  assert.ok(!noTarget.includes('location.replace('));
  assert.ok(noTarget.includes('invalid_state'));
}

const tests = [
  testConfigFailsClosed,
  testConfigSuccess,
  testStateRoundTrip,
  testStateTamperFailsClosed,
  testStateExpiry,
  testStateFieldValidation,
  testSignStateRequiresSecret,
  testAuthorizeUrl,
  testParseFormPost,
  testParseUserName,
  testResolveReturnTarget,
  testReturnHtml,
  testErrorHtml,
];

try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} apple-web-oauth tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
