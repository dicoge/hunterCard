#!/usr/bin/env node
/**
 * Web-Google redirect callback vs persisted-session-validation race regressions
 * (DIC-976 CR blocker 2).
 *
 * The bug: on a redirect-return boot, App.tsx kicked off completeWebRedirectLogin
 * while the auth store's onRehydrateStorage independently kicked off
 * validateSession against the OLD persisted session. Depending on scheduling, a
 * late /auth/me could either (a) OVERWRITE the fresh callback user with the old
 * account, or (b) on a late 401/403 CLEAR the freshly-minted callback session —
 * silently logging the user out right after a successful login.
 *
 * The fix serializes the two flows: when this boot is a redirect return, boot
 * routes hydration THROUGH completeWebRedirectLogin only (validateSession
 * defers), and validateSession additionally session-guards its result so a stale
 * landing can never overwrite/clear a newer session. This test drives the REAL
 * store (authService + storage mocked) and asserts BOTH orderings and BOTH
 * failure codes leave the callback result intact.
 *
 * Loads the real .ts via Node type-stripping + module hooks (same mechanism as
 * test-auth-store-error-wiring.cjs) so no `typescript` compiler is pulled in.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// Mutable control box the mocks read at call time.
globalThis.__redirectRaceMock = {
  // completePendingWebGoogleLogin resolves with this (or null).
  completion: null,
  // validateSession behaviour: 'ok' resolves a user, 'reject401'/'reject403'
  // throw an AuthError-like with that status, 'network' throws status 0.
  validateMode: 'ok',
  validateUser: null,
  // A deferred latch so the test can control WHEN validateSession resolves,
  // forcing the "stale validation lands AFTER the callback" ordering.
  validateGate: null,
  hasPendingReturn: false,
  // When true, completePendingWebGoogleLogin throws a typed non-cancel failure.
  throwOnComplete: false,
};

function makeUser(id, role) {
  return {
    internalId: id,
    displayName: id,
    primaryEmail: id + '@example.com',
    role: role || 'free_user',
    linkedProviders: [],
    createdAt: '2020-01-01T00:00:00Z',
  };
}
globalThis.__mkUser = makeUser;

const MOCK_AUTH_SERVICE = `
export const signInWithProvider = async () => { throw new Error('unused'); };
export const linkProvider = async () => { throw new Error('unused'); };
export const unlinkProvider = async () => { throw new Error('unused'); };
export const deleteAccount = async () => { throw new Error('unused'); };
export const signOutNativeGoogle = async () => {};
export const validateSession = async (session) => {
  const m = globalThis.__redirectRaceMock;
  if (m.validateGate) { await m.validateGate; }
  if (m.validateMode === 'ok') return m.validateUser;
  const err = new Error('validate failed');
  err.status = m.validateMode === 'reject401' ? 401
             : m.validateMode === 'reject403' ? 403 : 0;
  throw err;
};
export const completePendingWebGoogleLogin = async () => {
  const m = globalThis.__redirectRaceMock;
  if (m.throwOnComplete) {
    const err = new Error('callback failed');
    err.code = 'malformed_callback';
    err.status = 400;
    throw err;
  }
  return m.completion;
};
export const hasPendingWebGoogleRedirectReturn = () => globalThis.__redirectRaceMock.hasPendingReturn;
`;

// In-memory storage; we control the persisted session by pre-seeding it.
const MOCK_STORAGE = `
let store = {};
export function __seed(obj){ store = obj; }
export default {
  getItem: async (k) => (k in store ? store[k] : null),
  setItem: async (k,v) => { store[k]=v; },
  removeItem: async (k) => { delete store[k]; },
};
`;

const MOCK_TYPES = `export const HoloUser = undefined; export const AuthProvider = undefined; export const UserRole = undefined;`;

Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/services/authService')) return { url: 'mock:///authService', shortCircuit: true };
    if (specifier.endsWith('/stores/storage')) return { url: 'mock:///storage', shortCircuit: true };
    if (specifier.endsWith('/types/auth')) return { url: 'mock:///types-auth', shortCircuit: true };
    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
      const baseDir = path.dirname(new URL(context.parentURL).pathname);
      const candidate = path.resolve(baseDir, `${specifier}.ts`);
      if (fs.existsSync(candidate)) return nextResolve(`file://${candidate}`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'mock:///authService') return { format: 'module', source: MOCK_AUTH_SERVICE, shortCircuit: true };
    if (url === 'mock:///storage') return { format: 'module', source: MOCK_STORAGE, shortCircuit: true };
    if (url === 'mock:///types-auth') return { format: 'module', source: MOCK_TYPES, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const m = globalThis.__redirectRaceMock;

(async () => {
  const { useAuthStore } = await import(`file://${path.join(ROOT, 'src/store/authStore.ts')}`);

  function resetStore() {
    useAuthStore.setState({
      user: null, session: null, isAuthenticated: false, isGuest: false,
      isLoading: false, hasHydrated: false, error: null, role: 'guest',
      redirectPending: false,
    });
  }

  // Scenario A: redirect callback yields a fresh login; a STALE validateSession
  // (success on the OLD session) lands AFTER — must NOT overwrite the new user,
  // because the store deferred validation (redirectPending) and/or the session
  // guard rejects the stale result.
  async function testStaleValidateSuccessDoesNotOverwrite() {
    resetStore();
    const newUser = makeUser('new-user', 'subscriber');
    const oldUser = makeUser('old-user', 'free_user');
    m.completion = { operation: 'login', user: newUser, session: 'new-session', isNewUser: false };
    m.validateMode = 'ok';
    m.validateUser = oldUser;

    // Simulate boot: redirect return is pending → store routes through callback.
    m.hasPendingReturn = true;
    useAuthStore.setState({ redirectPending: true });
    // Kick BOTH, mirroring the old racy boot: callback + a stray validateSession.
    const cb = useAuthStore.getState().completeWebRedirectLogin();
    const val = useAuthStore.getState().validateSession(); // must DEFER (no-op)
    await Promise.all([cb, val]);

    const s = useAuthStore.getState();
    assert.equal(s.session, 'new-session', 'callback session must survive');
    assert.equal(s.user.internalId, 'new-user', 'stale validate must not overwrite new user');
    assert.equal(s.isAuthenticated, true);
    assert.equal(s.role, 'subscriber');
    assert.equal(s.hasHydrated, true, 'callback must flip hasHydrated');
    assert.equal(s.redirectPending, false, 'guard cleared after callback');
  }

  // Scenario B: redirect callback yields a fresh login; a late validateSession
  // 401 (rejecting the OLD session) lands AFTER — must NOT clear the NEW session.
  async function testStaleValidate401DoesNotClearNewSession() {
    for (const mode of ['reject401', 'reject403']) {
      resetStore();
      const newUser = makeUser('new-user', 'free_user');
      m.completion = { operation: 'login', user: newUser, session: 'new-session', isNewUser: true };
      m.validateMode = mode;
      m.hasPendingReturn = true;
      useAuthStore.setState({ redirectPending: true });

      const cb = useAuthStore.getState().completeWebRedirectLogin();
      const val = useAuthStore.getState().validateSession(); // deferred no-op
      await Promise.all([cb, val]);

      const s = useAuthStore.getState();
      assert.equal(s.session, 'new-session', `[${mode}] new session must not be cleared`);
      assert.equal(s.isAuthenticated, true, `[${mode}] must stay authenticated`);
      assert.equal(s.user.internalId, 'new-user');
    }
  }

  // Scenario C: the session guard itself — even if validateSession is NOT
  // deferred (redirectPending already false) but the session changes WHILE
  // /auth/me is in flight, the stale result is discarded. This proves the guard
  // independently of the deferral, covering interleavings the deferral misses.
  async function testSessionGuardDiscardsStaleValidation() {
    resetStore();
    // Seed an OLD session and let validateSession block on a gate.
    useAuthStore.setState({ session: 'old-session', redirectPending: false });
    let release;
    m.validateGate = new Promise((res) => { release = res; });
    m.validateMode = 'ok';
    m.validateUser = makeUser('old-user', 'free_user');

    const val = useAuthStore.getState().validateSession(); // captures 'old-session', then awaits gate
    // While it's in flight, a callback adopts a NEW session+user.
    useAuthStore.setState({ session: 'new-session', user: makeUser('new-user', 'subscriber'),
      isAuthenticated: true, role: 'subscriber' });
    release(); // now the stale validate resolves for old-session
    await val;

    const s = useAuthStore.getState();
    assert.equal(s.session, 'new-session', 'stale validate must not revert session');
    assert.equal(s.user.internalId, 'new-user', 'stale validate must not overwrite user');
    assert.equal(s.role, 'subscriber');
    m.validateGate = null;
  }

  // Scenario D: the guard also protects the FAILURE path mid-flight — a late 401
  // for old-session must not clear a new-session adopted while it was in flight.
  async function testSessionGuardDiscardsStaleFailure() {
    resetStore();
    useAuthStore.setState({ session: 'old-session', redirectPending: false });
    let release;
    m.validateGate = new Promise((res) => { release = res; });
    m.validateMode = 'reject401';

    const val = useAuthStore.getState().validateSession(); // captures old-session
    useAuthStore.setState({ session: 'new-session', user: makeUser('new-user', 'free_user'),
      isAuthenticated: true });
    release();
    await val;

    const s = useAuthStore.getState();
    assert.equal(s.session, 'new-session', 'late 401 for old-session must not clear new-session');
    assert.equal(s.isAuthenticated, true);
    m.validateGate = null;
  }

  // Scenario E: NON-redirect boot still validates normally (no regression).
  async function testNormalBootStillValidates() {
    resetStore();
    useAuthStore.setState({ session: 'persisted-session', redirectPending: false });
    m.validateMode = 'ok';
    m.validateUser = makeUser('persisted-user', 'subscriber');
    m.hasPendingReturn = false;
    await useAuthStore.getState().validateSession();
    const s = useAuthStore.getState();
    assert.equal(s.isAuthenticated, true);
    assert.equal(s.user.internalId, 'persisted-user');
    assert.equal(s.role, 'subscriber');
    assert.equal(s.hasHydrated, true);
  }

  // Scenario F: a link callback keeps the existing session and only updates user.
  async function testLinkCallbackKeepsSession() {
    resetStore();
    const linkedUser = makeUser('me', 'free_user');
    linkedUser.linkedProviders = [{ provider: 'google', providerId: 'g1', email: 'me@example.com',
      displayName: 'me', linkedAt: '2020-01-01T00:00:00Z' }];
    m.completion = { operation: 'link', user: linkedUser, session: 'existing-session' };
    m.hasPendingReturn = true;
    useAuthStore.setState({ redirectPending: true });
    await useAuthStore.getState().completeWebRedirectLogin();
    const s = useAuthStore.getState();
    assert.equal(s.session, 'existing-session', 'link keeps the existing session');
    assert.equal(s.user.linkedProviders.length, 1, 'link updates the user');
    assert.equal(s.isAuthenticated, true);
    assert.equal(s.redirectPending, false);
    assert.equal(s.hasHydrated, true);
  }

  // Scenario G (PR #107 CR): a malformed / stale OAuth-shaped URL now routes boot
  // through the callback so the pending state is consumed and the URL scrubbed.
  // That must NOT cost the user their session: when the callback yields no
  // outcome, ordinary session validation still has to run. isAuthenticated is
  // never restored from disk, so skipping it would silently log the user out.
  async function testNoOutcomeFallsBackToValidateSession() {
    resetStore();
    useAuthStore.setState({ session: 'persisted-session', redirectPending: true });
    m.completion = null;            // malformed callback: cleaned up, no login
    m.hasPendingReturn = true;
    m.validateMode = 'ok';
    m.validateUser = makeUser('persisted-user', 'subscriber');

    await useAuthStore.getState().completeWebRedirectLogin();

    const s = useAuthStore.getState();
    assert.equal(s.isAuthenticated, true, 'a valid persisted session must survive');
    assert.equal(s.user.internalId, 'persisted-user');
    assert.equal(s.session, 'persisted-session');
    assert.equal(s.redirectPending, false);
    assert.equal(s.hasHydrated, true);
  }

  // ...but a callback that DID surface an error must not be papered over by a
  // follow-up validation: the user needs to see why their login failed.
  async function testCallbackErrorIsNotOverwrittenByValidation() {
    resetStore();
    useAuthStore.setState({ redirectPending: true });
    m.hasPendingReturn = true;
    m.completion = null;
    m.validateMode = 'ok';
    m.validateUser = makeUser('other-user', 'free_user');
    m.throwOnComplete = true;
    try {
      await useAuthStore.getState().completeWebRedirectLogin();
    } finally {
      m.throwOnComplete = false;
    }
    const s = useAuthStore.getState();
    assert.ok(s.error, 'the failure must remain visible to the user');
    assert.equal(s.isAuthenticated, false, 'a failed callback must not silently authenticate');
    assert.equal(s.user, null, 'no user may be adopted from a failed callback');
    assert.equal(s.hasHydrated, true);
  }

  const tests = [
    testNoOutcomeFallsBackToValidateSession,
    testCallbackErrorIsNotOverwrittenByValidation,
    testStaleValidateSuccessDoesNotOverwrite,
    testStaleValidate401DoesNotClearNewSession,
    testSessionGuardDiscardsStaleValidation,
    testSessionGuardDiscardsStaleFailure,
    testNormalBootStillValidates,
    testLinkCallbackKeepsSession,
  ];
  for (const t of tests) { await t(); console.log(`\u2713 ${t.name}`); }
  console.log(`\n${tests.length} auth-redirect-race tests passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
