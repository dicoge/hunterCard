#!/usr/bin/env node
/**
 * Malformed-callback session recovery (PR #107 CR blocker).
 *
 * A malformed OAuth-shaped return (`?iss=…` only, code-only, or an id_token with
 * no state) routes boot through completeWebRedirectLogin so the pending state is
 * consumed and the URL scrubbed. That leg fails closed and surfaces a safe error
 * — but the surfaced error must NOT also count as "the auth outcome for this
 * launch". isAuthenticated is never restored from disk, so treating a failure as
 * final skipped validateSession() and left an already-signed-in (or mid-link)
 * user unauthenticated after landing on such a URL.
 *
 * Unlike test-auth-redirect-race.cjs (which mocks authService to isolate the
 * store's ordering), this suite wires the REAL store to the REAL authService
 * over a mocked browser + fetch, so the four properties the review named are
 * proven together on shipping code: URL scrubbed, pending state consumed, zero
 * backend callback calls, valid persisted session restored — with the callback
 * diagnostic still visible.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

const MOCK_REACT_NATIVE = `export const Platform = { OS: 'web' };`;
// The callback leg must never touch AuthSession; any use throws so a
// reintroduced browser-side exchange fails loudly here too.
const MOCK_AUTH_SESSION = `
export const ResponseType = { Code: 'code', IdToken: 'id_token', Token: 'token' };
export function makeRedirectUri() { return 'https://holohunter.dicoge.com'; }
export const exchangeCodeAsync = async () => {
  throw new Error('exchangeCodeAsync must never run in the browser callback leg');
};
export class AuthRequest {
  constructor(config) { this.config = config; }
  async makeAuthUrlAsync() { return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'; }
}
`;
const MOCK_WEB_BROWSER = `export function maybeCompleteAuthSession() {}`;
const MOCK_CRYPTO = `
export function getRandomBytes(n) { return new Uint8Array(n).fill(7); }
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export async function digestStringAsync() { return 'digest'; }
`;
const MOCK_TYPES = `export const AuthProvider = undefined; export const LinkedIdentity = undefined; export const HoloUser = undefined; export const UserRole = undefined; export const AuthSession = undefined;`;
// The store's persisted layer: in-memory, so a scenario can start from a saved
// session exactly as a returning user would.
const MOCK_STORAGE = `
let store = {};
export function __seed(obj){ store = obj; }
export default {
  getItem: async (k) => (k in store ? store[k] : null),
  setItem: async (k,v) => { store[k]=v; },
  removeItem: async (k) => { delete store[k]; },
};
`;

Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react-native') return { url: 'mock:///react-native', shortCircuit: true };
    if (specifier === 'expo-auth-session') return { url: 'mock:///expo-auth-session', shortCircuit: true };
    if (specifier === 'expo-web-browser') return { url: 'mock:///expo-web-browser', shortCircuit: true };
    if (specifier === 'expo-crypto') return { url: 'mock:///expo-crypto', shortCircuit: true };
    if (specifier.endsWith('/types/auth')) return { url: 'mock:///types-auth', shortCircuit: true };
    if (specifier.endsWith('/stores/storage')) return { url: 'mock:///storage', shortCircuit: true };
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
      'mock:///storage': MOCK_STORAGE,
    };
    if (sources[url]) return { format: 'module', source: sources[url], shortCircuit: true };
    return nextLoad(url, context);
  },
});

const REDIRECT_KEY = 'holohunter-web-google-redirect';
const PERSISTED_SESSION = 'persisted-session';
const PERSISTED_USER = {
  internalId: 'u-owner',
  displayName: 'Owner',
  primaryEmail: 'owner@example.com',
  role: 'subscriber',
  linkedProviders: [],
  createdAt: '2020-01-01T00:00:00Z',
};
const CREDENTIAL = 'header.payload.sig';

// The three shapes the review named, each with the material that must not
// survive in the address bar.
const MALFORMED_SHAPES = [
  {
    name: 'iss-only (the production shape)',
    search: '?iss=https%3A%2F%2Faccounts.google.com',
    hash: '',
    leak: 'iss=',
  },
  {
    name: 'code-only (unredeemable in a browser)',
    search: '?code=4%2F0Areal-looking-code&state=state-xyz',
    hash: '',
    leak: '4%2F0Areal-looking-code',
  },
  {
    name: 'id_token without state (no CSRF binding)',
    search: '',
    hash: `#id_token=${CREDENTIAL}`,
    leak: CREDENTIAL,
  },
];

let calls = [];
let replaced = [];
let redirectStore = {};
let meMode = 'ok';

function setupBrowser({ search, hash, pending }) {
  calls = [];
  replaced = [];
  redirectStore = {};
  if (pending !== undefined) redirectStore[REDIRECT_KEY] = JSON.stringify(pending);
  globalThis.window = {
    location: {
      origin: 'https://holohunter.dicoge.com',
      href: `https://holohunter.dicoge.com/${search || ''}${hash || ''}`,
      search: search || '',
      hash: hash || '',
      assign: (url) => { globalThis.__assigned = url; },
    },
    localStorage: {
      getItem: (k) => (k in redirectStore ? redirectStore[k] : null),
      setItem: (k, v) => { redirectStore[k] = v; },
      removeItem: (k) => { delete redirectStore[k]; },
    },
    history: {
      replaceState: (_s, _t, url) => {
        replaced.push(url);
        globalThis.window.location.href = `https://holohunter.dicoge.com${url}`;
      },
    },
  };
}

globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body, headers: (init && init.headers) || {} });
  if (String(url).endsWith('/api/auth/me')) {
    if (meMode === 'reject401') {
      return { ok: false, status: 401, json: async () => ({ error: 'INVALID_SESSION' }) };
    }
    if (meMode === 'network') throw new Error('offline');
    return { ok: true, status: 200, json: async () => ({ user: PERSISTED_USER }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ user: PERSISTED_USER, session: 'fresh-session', isNew: false }),
  };
};

const callsTo = (suffix) => calls.filter((c) => c.url.endsWith(suffix));
const pendingLogin = (overrides) => ({
  nonce: 'nonce-abc',
  state: 'state-xyz',
  createdAt: Date.now(),
  operation: 'login',
  ...overrides,
});

// authService reads the client id at import time.
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'test-client.apps.googleusercontent.com';

(async () => {
  // Import under an ordinary (non-callback) URL so the store's own boot
  // hydration is a plain no-op and cannot bleed into a scenario.
  setupBrowser({ search: '', hash: '', pending: undefined });
  const svc = await import(`file://${path.join(ROOT, 'src/services/authService.ts')}`);
  const { useAuthStore } = await import(`file://${path.join(ROOT, 'src/store/authStore.ts')}`);
  await new Promise((r) => setImmediate(r));

  // Mirrors onRehydrateStorage's redirect branch: a rehydrated session plus the
  // redirectPending guard, then the callback owns this launch.
  function bootFromPersistedSession(session) {
    useAuthStore.setState({
      user: null,
      session: session ?? null,
      isAuthenticated: false,
      isGuest: false,
      isLoading: false,
      hasHydrated: false,
      error: null,
      role: 'guest',
      redirectPending: true,
    });
  }

  function assertCallbackCleanedUp(label, shape) {
    assert.equal(redirectStore[REDIRECT_KEY], undefined, `[${label}] pending state must be consumed`);
    assert.ok(replaced.length > 0, `[${label}] the URL must be rewritten`);
    const finalUrl = replaced[replaced.length - 1];
    assert.ok(!finalUrl.includes(shape.leak), `[${label}] material must be scrubbed: ${finalUrl}`);
    for (const key of ['code=', 'id_token=', 'state=', 'iss=']) {
      assert.ok(!finalUrl.includes(key), `[${label}] ${key} must not remain: ${finalUrl}`);
    }
    assert.equal(callsTo('/api/auth/login').length, 0, `[${label}] must NOT call /auth/login`);
    assert.equal(callsTo('/api/auth/link').length, 0, `[${label}] must NOT call /auth/link`);
  }

  function assertSafeDiagnostic(label, error) {
    assert.ok(error, `[${label}] the callback failure must stay visible`);
    assert.equal(typeof error, 'string');
    assert.ok(!error.includes(CREDENTIAL), `[${label}] the diagnostic must not leak the credential`);
    assert.ok(!error.includes('nonce-abc'), `[${label}] the diagnostic must not leak the nonce`);
    assert.ok(!error.includes(PERSISTED_SESSION), `[${label}] the diagnostic must not leak the session`);
  }

  // THE BLOCKER: an already signed-in user lands on a malformed OAuth return.
  // The failure is surfaced, but their valid session must be validated and
  // restored — not silently dropped because a failure ended the launch.
  async function testSignedInUserKeepsSessionAcrossMalformedCallback() {
    for (const shape of MALFORMED_SHAPES) {
      meMode = 'ok';
      setupBrowser({ search: shape.search, hash: shape.hash, pending: pendingLogin() });
      assert.equal(
        svc.hasPendingWebGoogleRedirectReturn(), true,
        `[${shape.name}] boot must route through the callback`,
      );
      bootFromPersistedSession(PERSISTED_SESSION);

      await useAuthStore.getState().completeWebRedirectLogin();

      const s = useAuthStore.getState();
      assertCallbackCleanedUp(shape.name, shape);
      assertSafeDiagnostic(shape.name, s.error);
      assert.equal(callsTo('/api/auth/me').length, 1, `[${shape.name}] the persisted session must be validated`);
      assert.equal(s.isAuthenticated, true, `[${shape.name}] a valid persisted session must be restored`);
      assert.equal(s.session, PERSISTED_SESSION, `[${shape.name}] the session must be unchanged`);
      assert.equal(s.user.internalId, PERSISTED_USER.internalId);
      assert.equal(s.role, PERSISTED_USER.role, `[${shape.name}] the server role must be applied`);
      assert.equal(s.redirectPending, false);
      assert.equal(s.hasHydrated, true);
    }
  }

  // Same for a user mid-"link Google" from Settings: they were signed in when
  // they started, so a malformed return must not sign them out either.
  async function testLinkingUserKeepsSessionAcrossMalformedCallback() {
    for (const shape of MALFORMED_SHAPES) {
      meMode = 'ok';
      setupBrowser({
        search: shape.search,
        hash: shape.hash,
        pending: pendingLogin({ operation: 'link', session: PERSISTED_SESSION }),
      });
      bootFromPersistedSession(PERSISTED_SESSION);

      await useAuthStore.getState().completeWebRedirectLogin();

      const label = `link/${shape.name}`;
      const s = useAuthStore.getState();
      assertCallbackCleanedUp(label, shape);
      assertSafeDiagnostic(label, s.error);
      assert.equal(s.isAuthenticated, true, `[${label}] the linking user must stay signed in`);
      assert.equal(s.session, PERSISTED_SESSION, `[${label}] link must not switch or drop the session`);
      assert.equal(s.user.internalId, PERSISTED_USER.internalId);
      assert.equal(s.hasHydrated, true);
    }
  }

  // No pending state = a stale bookmark or crafted link, not a login this app
  // started: clean up, restore the session, and do not blame the user for it.
  async function testStaleOauthUrlRestoresSessionSilently() {
    meMode = 'ok';
    const shape = MALFORMED_SHAPES[0];
    setupBrowser({ search: shape.search, hash: shape.hash, pending: undefined });
    bootFromPersistedSession(PERSISTED_SESSION);

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assertCallbackCleanedUp('no-pending', shape);
    assert.equal(s.error, null, 'an unstarted login must not show an error');
    assert.equal(s.isAuthenticated, true, 'the persisted session must be restored');
    assert.equal(s.session, PERSISTED_SESSION);
  }

  // A signed-OUT user gets the diagnostic and nothing else — no session to
  // restore means no backend traffic at all.
  async function testSignedOutUserSeesDiagnosticOnly() {
    meMode = 'ok';
    const shape = MALFORMED_SHAPES[0];
    setupBrowser({ search: shape.search, hash: shape.hash, pending: pendingLogin() });
    bootFromPersistedSession(null);

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assertCallbackCleanedUp('signed-out', shape);
    assertSafeDiagnostic('signed-out', s.error);
    assert.equal(calls.length, 0, 'no session means no backend call at all');
    assert.equal(s.isAuthenticated, false, 'a failed callback must not authenticate anyone');
    assert.equal(s.user, null);
    assert.equal(s.hasHydrated, true);
  }

  // The fallback still fails CLOSED: a server-rejected session is dropped rather
  // than admitted, and the callback diagnostic survives that too.
  async function testRejectedSessionIsStillDropped() {
    meMode = 'reject401';
    const shape = MALFORMED_SHAPES[0];
    setupBrowser({ search: shape.search, hash: shape.hash, pending: pendingLogin() });
    bootFromPersistedSession(PERSISTED_SESSION);

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assertSafeDiagnostic('rejected-session', s.error);
    assert.equal(s.isAuthenticated, false, 'a 401 session must not be admitted');
    assert.equal(s.session, null, 'a definitively rejected session must be dropped');
    assert.equal(s.user, null);
    meMode = 'ok';
  }

  // A transient failure keeps the session but stays unauthenticated (fail
  // closed, not open) — unchanged by the fallback.
  async function testTransientValidationKeepsSessionUnauthenticated() {
    meMode = 'network';
    const shape = MALFORMED_SHAPES[0];
    setupBrowser({ search: shape.search, hash: shape.hash, pending: pendingLogin() });
    bootFromPersistedSession(PERSISTED_SESSION);

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assert.equal(s.isAuthenticated, false, 'a transient failure must not admit the session');
    assert.equal(s.session, PERSISTED_SESSION, 'a transient failure must not drop the session');
    meMode = 'ok';
  }

  // No regression on the happy path: a valid callback adopts the FRESH session
  // and does not re-validate over it (that race was an earlier CR blocker).
  async function testValidCallbackAdoptsFreshSessionWithoutRevalidating() {
    meMode = 'ok';
    setupBrowser({
      search: '?iss=https%3A%2F%2Faccounts.google.com',
      hash: `#id_token=${CREDENTIAL}&state=state-xyz`,
      pending: pendingLogin(),
    });
    bootFromPersistedSession(PERSISTED_SESSION);

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assert.equal(callsTo('/api/auth/login').length, 1, 'the credential must reach /auth/login');
    assert.equal(callsTo('/api/auth/me').length, 0, 'an adopted session must not be re-validated');
    assert.equal(s.session, 'fresh-session', 'the fresh session must be adopted');
    assert.equal(s.isAuthenticated, true);
    assert.equal(s.error, null, 'a successful login shows no error');
    assert.equal(redirectStore[REDIRECT_KEY], undefined, 'pending state consumed');
  }

  const tests = [
    testSignedInUserKeepsSessionAcrossMalformedCallback,
    testLinkingUserKeepsSessionAcrossMalformedCallback,
    testStaleOauthUrlRestoresSessionSilently,
    testSignedOutUserSeesDiagnosticOnly,
    testRejectedSessionIsStillDropped,
    testTransientValidationKeepsSessionUnauthenticated,
    testValidCallbackAdoptsFreshSessionWithoutRevalidating,
  ];
  // Run every case even after a failure: each covers a distinct boot state, and
  // the full picture is what makes this suite useful as a regression gate.
  const failures = [];
  for (const test of tests) {
    try {
      await test();
      console.log(`✓ ${test.name}`);
    } catch (err) {
      failures.push(test.name);
      console.log(`✗ ${test.name}: ${err.message}`);
    }
  }
  if (failures.length) {
    console.error(`\n${failures.length}/${tests.length} auth-callback-session-recovery tests FAILED`);
    process.exit(1);
  }
  console.log(`\n${tests.length} auth-callback-session-recovery tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
