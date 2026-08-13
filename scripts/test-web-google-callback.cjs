#!/usr/bin/env node
/**
 * Web-Google redirect CALLBACK regressions (DIC-976 post-deploy QA).
 *
 * Production evidence this locks down: after the real Google account chooser +
 * consent, the app landed back on https://holohunter.dicoge.com/ carrying only
 * the non-sensitive `iss` key. No credential reached the app, POST
 * /api/auth/login was never called, and the UI stayed on the login screen.
 *
 * Root cause: the flow requested `response_type=code` and tried to redeem the
 * code IN THE BROWSER. Google's token endpoint advertises only
 * client_secret_post / client_secret_basic (no `none`), so it rejects a
 * secretless redemption outright — verified live against the production client:
 *   {"error":"invalid_request","error_description":"client_secret is missing."}
 * A browser SPA cannot hold that secret, so the code leg was unredeemable by
 * construction. The flow now requests an `id_token`, which needs no exchange.
 *
 * These tests drive the REAL completePendingWebGoogleLogin() against a mocked
 * browser + fetch and assert the two behaviours the QA gate names:
 *   - a valid id_token callback REACHES POST /api/auth/login (and /auth/link)
 *   - the observed `iss`-only callback fails safely and calls NOTHING
 * plus that the credential never survives in the address bar.
 *
 * This proves the CLIENT contract deterministically. It does NOT prove the
 * owner-device E2E, which still needs the real Google round-trip on the device.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

const MOCK_REACT_NATIVE = `export const Platform = { OS: 'web' };`;
// AuthSession is only needed for the OUTBOUND leg here; the callback leg must
// not touch it at all. Any call throws, so a reintroduced browser-side token
// exchange fails this suite loudly instead of silently regressing.
const MOCK_AUTH_SESSION = `
export const ResponseType = { Code: 'code', IdToken: 'id_token', Token: 'token' };
export function makeRedirectUri() { return 'https://holohunter.dicoge.com'; }
export const exchangeCodeAsync = async () => {
  throw new Error('exchangeCodeAsync must never run in the browser callback leg');
};
export class AuthRequest {
  constructor(config) { this.config = config; globalThis.__lastAuthRequest = config; }
  async makeAuthUrlAsync() { this.state = 'mock-state'; return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'; }
}
`;
const MOCK_WEB_BROWSER = `export function maybeCompleteAuthSession() {}`;
const MOCK_CRYPTO = `
export function getRandomBytes(n) { return new Uint8Array(n).fill(7); }
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export async function digestStringAsync() { return 'digest'; }
`;
const MOCK_TYPES = `export const AuthProvider = undefined; export const LinkedIdentity = undefined; export const HoloUser = undefined;`;

Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react-native') return { url: 'mock:///react-native', shortCircuit: true };
    if (specifier === 'expo-auth-session') return { url: 'mock:///expo-auth-session', shortCircuit: true };
    if (specifier === 'expo-web-browser') return { url: 'mock:///expo-web-browser', shortCircuit: true };
    if (specifier === 'expo-crypto') return { url: 'mock:///expo-crypto', shortCircuit: true };
    if (specifier.endsWith('/types/auth')) return { url: 'mock:///types-auth', shortCircuit: true };
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
      const baseDir = path.dirname(new URL(context.parentURL).pathname);
      const candidate = path.resolve(baseDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) return nextResolve(`file://${candidate}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const sources = {
      'mock:///react-native': MOCK_REACT_NATIVE,
      'mock:///expo-auth-session': MOCK_AUTH_SESSION,
      'mock:///expo-web-browser': MOCK_WEB_BROWSER,
      'mock:///expo-crypto': MOCK_CRYPTO,
      'mock:///types-auth': MOCK_TYPES,
    };
    if (sources[url]) return { format: 'module', source: sources[url], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const STORAGE_KEY = 'holohunter-web-google-redirect';
const SERVER_USER = {
  internalId: 'u-1',
  displayName: 'Owner',
  primaryEmail: 'owner@example.com',
  role: 'free_user',
  linkedProviders: [],
  createdAt: '2020-01-01T00:00:00Z',
};

let calls = [];

// Installs a fake browser at the given callback URL with the given pending state.
function setupBrowser({ search, hash, pending }) {
  calls = [];
  const store = {};
  if (pending !== undefined) store[STORAGE_KEY] = JSON.stringify(pending);
  const replaced = [];
  globalThis.window = {
    location: {
      origin: 'https://holohunter.dicoge.com',
      href: `https://holohunter.dicoge.com/${search || ''}${hash || ''}`,
      search: search || '',
      hash: hash || '',
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; },
    },
    history: {
      replaceState: (_s, _t, url) => {
        replaced.push(url);
        globalThis.window.location.href = `https://holohunter.dicoge.com${url}`;
      },
    },
  };
  globalThis.window.location.assign = (url) => { globalThis.__assigned = url; };
  globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: (init && init.headers) || {} });
    return {
      ok: true,
      status: 200,
      json: async () => ({ user: SERVER_USER, session: 'fresh-session', isNew: false }),
    };
  };
  return { replaced, store };
}

function pendingLogin(overrides) {
  return { nonce: 'nonce-abc', state: 'state-xyz', createdAt: Date.now(), operation: 'login', ...overrides };
}

// authService reads the client id into a module-level const at import time, so
// it must be set BEFORE the dynamic import below.
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'test-client.apps.googleusercontent.com';

(async () => {
  const svc = await import(`file://${path.join(ROOT, 'src/services/authService.ts')}`);

  // The valid flow must reach the EXISTING backend with the credential Google
  // returned — the half of the QA gate that previously never happened.
  async function testValidIdTokenCallbackReachesLogin() {
    setupBrowser({
      search: '?iss=https%3A%2F%2Faccounts.google.com',
      hash: '#id_token=header.payload.sig&state=state-xyz',
      pending: pendingLogin(),
    });
    const result = await svc.completePendingWebGoogleLogin();

    assert.equal(calls.length, 1, 'exactly one backend call');
    assert.ok(calls[0].url.endsWith('/api/auth/login'), `expected /api/auth/login, got ${calls[0].url}`);
    assert.equal(calls[0].body.provider, 'google');
    assert.equal(calls[0].body.idToken, 'header.payload.sig', 'the Google credential must be forwarded');
    assert.equal(calls[0].body.nonce, 'nonce-abc', 'the minted nonce must be bound server-side');
    assert.equal(result.operation, 'login');
    assert.equal(result.session, 'fresh-session');
    assert.equal(result.user.internalId, 'u-1');
  }

  // CR blocker (PR #107 review): a malformed OAuth-shaped callback must not just
  // "do nothing". It must fail closed AND still consume the pending state and
  // scrub the URL — otherwise provider material lingers in history and the
  // pending state stays replayable. Covers all three shapes the review named.
  async function testMalformedCallbacksAreCleanedAndConsumed() {
    const cases = [
      {
        name: 'iss-only (the exact production shape)',
        search: '?iss=https%3A%2F%2Faccounts.google.com',
        hash: '',
        leak: 'iss=',
      },
      {
        name: 'code-only (unredeemable in a browser)',
        search: '?code=4%2F0Areal-looking-code&state=state-xyz&iss=https%3A%2F%2Faccounts.google.com',
        hash: '',
        leak: '4%2F0Areal-looking-code',
      },
      {
        name: 'id_token WITHOUT state (no CSRF binding)',
        search: '',
        hash: '#id_token=header.payload.sig',
        leak: 'header.payload.sig',
      },
    ];
    for (const c of cases) {
      const { replaced, store } = setupBrowser({ search: c.search, hash: c.hash, pending: pendingLogin() });
      const outcome = await svc.completePendingWebGoogleLogin().then(
        (r) => ({ ok: true, r }),
        (e) => ({ ok: false, e }),
      );

      // Fail closed: never a backend call, never a session.
      assert.equal(calls.length, 0, `[${c.name}] must NOT call the backend`);
      assert.equal(outcome.ok, false, `[${c.name}] a launched login must surface a failure`);
      assert.equal(outcome.e.code, 'malformed_callback', `[${c.name}] distinguishable safe code`);

      // Pending state consumed exactly once — it must not remain replayable.
      assert.equal(store[STORAGE_KEY], undefined, `[${c.name}] pending state must be consumed`);

      // URL scrubbed — no provider material left in the address bar / history.
      assert.ok(replaced.length > 0, `[${c.name}] the URL must be rewritten`);
      const finalUrl = replaced[replaced.length - 1];
      assert.ok(!finalUrl.includes(c.leak), `[${c.name}] material must be scrubbed: ${finalUrl}`);
      for (const key of ['code=', 'id_token=', 'state=', 'iss=']) {
        assert.ok(!finalUrl.includes(key), `[${c.name}] ${key} must not remain: ${finalUrl}`);
      }

      // A replay of the same URL now finds nothing to consume and stays silent.
      globalThis.window.location.search = c.search;
      globalThis.window.location.hash = c.hash;
      const replay = await svc.completePendingWebGoogleLogin().then(
        (r) => ({ ok: true, r }),
        (e) => ({ ok: false, e }),
      );
      assert.equal(replay.ok, true, `[${c.name}] replay must not throw`);
      assert.equal(replay.r, null, `[${c.name}] replay must not produce a session`);
      assert.equal(calls.length, 0, `[${c.name}] replay must NOT call the backend`);
    }
  }

  // The same malformed URL with NO pending state is a stale bookmark or a
  // crafted link, not a login this app started: clean it up, but stay silent
  // rather than showing the user an error they did not cause.
  async function testMalformedCallbackWithoutPendingIsSilent() {
    const { replaced } = setupBrowser({
      search: '?iss=https%3A%2F%2Faccounts.google.com',
      hash: '#id_token=stray.token.sig',
      pending: undefined,
    });
    const outcome = await svc.completePendingWebGoogleLogin().then(
      (r) => ({ ok: true, r }),
      (e) => ({ ok: false, e }),
    );
    assert.equal(outcome.ok, true, 'no pending state → no user-facing error');
    assert.equal(outcome.r, null);
    assert.equal(calls.length, 0, 'must NOT call the backend');
    // Still scrubbed: a stray credential must never be left in the URL.
    const finalUrl = replaced[replaced.length - 1];
    assert.ok(!finalUrl.includes('stray.token.sig'), `stray credential must be scrubbed: ${finalUrl}`);
    assert.ok(!finalUrl.includes('iss='), `iss must be scrubbed: ${finalUrl}`);
  }

  // An ordinary page load carries no provider keys and must be left completely
  // untouched — no URL rewrite, no storage read, no error.
  async function testOrdinaryPageLoadIsUntouched() {
    const { replaced, store } = setupBrowser({ search: '?tab=deck', hash: '#/settings', pending: pendingLogin() });
    const result = await svc.completePendingWebGoogleLogin();
    assert.equal(result, null, 'ordinary boot returns null');
    assert.equal(calls.length, 0);
    assert.equal(replaced.length, 0, 'an ordinary URL must NOT be rewritten');
    assert.ok(store[STORAGE_KEY], 'an ordinary load must NOT consume a pending login');
  }

  // The link leg must resume against the EXISTING session (never /auth/login,
  // which would switch accounts) — the earlier CR blocker, still intact.
  async function testLinkCallbackReachesLinkWithSession() {
    setupBrowser({
      search: '',
      hash: '#id_token=link.token.sig&state=state-xyz',
      pending: pendingLogin({ operation: 'link', session: 'existing-session' }),
    });
    const result = await svc.completePendingWebGoogleLogin();

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/auth/link'), `expected /api/auth/link, got ${calls[0].url}`);
    assert.equal(calls[0].headers.Authorization, 'Bearer existing-session');
    assert.equal(calls[0].body.idToken, 'link.token.sig');
    assert.equal(result.operation, 'link');
    assert.equal(result.session, 'existing-session', 'link keeps the existing session');
  }

  // CSRF: a callback whose state does not match the persisted one is refused,
  // and the credential is never forwarded.
  async function testStateMismatchIsRefused() {
    setupBrowser({
      search: '',
      hash: '#id_token=attacker.token.sig&state=not-our-state',
      pending: pendingLogin(),
    });
    await assert.rejects(
      () => svc.completePendingWebGoogleLogin(),
      (err) => err.code === 'state_mismatch',
    );
    assert.equal(calls.length, 0, 'state mismatch must not call the backend');
  }

  // The id_token must not survive in the address bar / history / shared links.
  async function testCredentialIsStrippedFromUrl() {
    const { replaced } = setupBrowser({
      search: '?iss=https%3A%2F%2Faccounts.google.com',
      hash: '#id_token=header.payload.sig&state=state-xyz',
      pending: pendingLogin(),
    });
    await svc.completePendingWebGoogleLogin();

    assert.ok(replaced.length > 0, 'the URL must be rewritten after the callback');
    const finalUrl = replaced[replaced.length - 1];
    assert.ok(!finalUrl.includes('id_token'), `id_token must not remain: ${finalUrl}`);
    assert.ok(!finalUrl.includes('header.payload.sig'), `credential must not remain: ${finalUrl}`);
    assert.ok(!finalUrl.includes('state'), `state must not remain: ${finalUrl}`);
    assert.ok(!finalUrl.includes('iss='), `iss must not remain: ${finalUrl}`);
  }

  // A pending state consumed once must not be replayable on reload.
  async function testPendingStateIsConsumedOnce() {
    const { store } = setupBrowser({
      search: '',
      hash: '#id_token=header.payload.sig&state=state-xyz',
      pending: pendingLogin(),
    });
    await svc.completePendingWebGoogleLogin();
    assert.equal(store[STORAGE_KEY], undefined, 'pending state must be deleted after use');
  }

  // The boot-time pending check must SEE a fragment-only callback; if it missed
  // it, boot would race persisted-session validation against the callback.
  async function testHasPendingDetectsFragmentCallback() {
    setupBrowser({ search: '', hash: '#id_token=t&state=state-xyz', pending: pendingLogin() });
    assert.equal(svc.hasPendingWebGoogleRedirectReturn(), true);

    // An OAuth-shaped but malformed return MUST be detected: boot has to route
    // through the callback for the pending state to be consumed and the URL
    // scrubbed. Treating it as an ordinary load is the CR blocker itself.
    setupBrowser({ search: '?iss=https%3A%2F%2Faccounts.google.com', hash: '', pending: pendingLogin() });
    assert.equal(svc.hasPendingWebGoogleRedirectReturn(), true, 'malformed returns need cleanup');

    setupBrowser({ search: '', hash: '', pending: pendingLogin() });
    assert.equal(svc.hasPendingWebGoogleRedirectReturn(), false, 'ordinary boot is unaffected');

    setupBrowser({ search: '?tab=deck', hash: '#/settings', pending: pendingLogin() });
    assert.equal(svc.hasPendingWebGoogleRedirectReturn(), false, 'app params are not a callback');
  }

  // The outbound leg is where the root cause lived: requesting `code` produced a
  // credential the browser could never redeem. Lock the request shape so the
  // unredeemable code flow cannot come back.
  async function testOutboundRequestAsksForIdTokenNotCode() {
    setupBrowser({ search: '', hash: '', pending: undefined });
    globalThis.__lastAuthRequest = null;

    const outcome = await svc.signInWithProvider('google').then(
      () => ({ ok: true }),
      (e) => ({ ok: false, e }),
    );
    // The page navigates away, so the call resolves as the 'redirecting' sentinel.
    assert.equal(outcome.ok, false);
    assert.equal(outcome.e.code, 'redirecting', 'web google login must full-page redirect');

    const cfg = globalThis.__lastAuthRequest;
    assert.ok(cfg, 'an authorize request must have been built');
    assert.equal(cfg.responseType, 'id_token', 'must request an id_token, never a code');
    assert.equal(cfg.usePKCE, false, 'no code means no PKCE verifier to mint');
    assert.equal(cfg.extraParams.response_mode, 'fragment');
    assert.ok(cfg.extraParams.nonce, 'a nonce is mandatory for an id_token response');
    assert.ok(cfg.scopes.includes('openid'), 'openid scope is required for an id_token');
  }

  const tests = [
    testOutboundRequestAsksForIdTokenNotCode,
    testValidIdTokenCallbackReachesLogin,
    testMalformedCallbacksAreCleanedAndConsumed,
    testMalformedCallbackWithoutPendingIsSilent,
    testOrdinaryPageLoadIsUntouched,
    testLinkCallbackReachesLinkWithSession,
    testStateMismatchIsRefused,
    testCredentialIsStrippedFromUrl,
    testPendingStateIsConsumedOnce,
    testHasPendingDetectsFragmentCallback,
  ];
  // Run every case even after a failure: each covers a distinct leg of the flow,
  // and seeing the full set is what makes this suite useful as a regression gate.
  const failures = [];
  for (const test of tests) {
    try {
      await test();
      console.log(`\u2713 ${test.name}`);
    } catch (err) {
      failures.push({ name: test.name, err });
      console.log(`\u2717 ${test.name}: ${err.message}`);
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length}/${tests.length} web-google-callback tests FAILED`);
    process.exit(1);
  }
  console.log(`\n${tests.length} web-google-callback tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
