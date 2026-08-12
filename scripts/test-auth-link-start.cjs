#!/usr/bin/env node
/**
 * Settings "link Google" START-LEG regression (DIC-976 CR).
 *
 * The web-Google link flow full-page-navigates to Google and throws the
 * 'redirecting' sentinel (an AuthRedirectPendingError). Before this fix,
 * store.linkNewProvider stored err.message ("正在導向 Google 登入…") into `error`
 * and SettingsScreen.handleLinkProvider displayed a blocking "綁定失敗 / 正在導向
 * Google 登入…" alert — a FALSE failure shown while the browser was still
 * navigating. This asserts the START leg:
 *   - the redirect/cancel sentinel sets NO error banner and is treated as a
 *     non-failure (so the CTA shows no alert),
 *   - a REAL link error still sets a friendly-but-SAFE `error` (never the raw
 *     err.message), so true failures remain visible,
 *   - SettingsScreen wires the CTA to suppress the sentinel and route real
 *     errors through friendlyAuthErrorMessage (never err.message).
 *
 * Drives the REAL src/store/authStore.ts (authService + storage + types mocked)
 * via Node type-stripping + module hooks — same mechanism as
 * test-auth-store-error-wiring.cjs, no `typescript` compiler pulled in.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// Control box the mocked linkProvider throws from.
globalThis.__linkStartMock = { linkError: null };

// A pre-seeded authenticated user/session so linkNewProvider passes its guard.
const SEED_USER = {
  internalId: 'me', displayName: 'me', primaryEmail: 'me@example.com',
  role: 'free_user', linkedProviders: [], createdAt: '2020-01-01T00:00:00Z',
};

const MOCK_AUTH_SERVICE = `
export const signInWithProvider = async () => { throw new Error('unused'); };
export const linkProvider = async () => { throw globalThis.__linkStartMock.linkError; };
export const unlinkProvider = async () => { throw new Error('unused'); };
export const deleteAccount = async () => { throw new Error('unused'); };
export const signOutNativeGoogle = async () => {};
export const validateSession = async () => { throw new Error('unused'); };
export const completePendingWebGoogleLogin = async () => null;
export const hasPendingWebGoogleRedirectReturn = () => false;
`;
const MOCK_STORAGE = `export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };`;
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

const m = globalThis.__linkStartMock;

(async () => {
  const { useAuthStore } = await import(`file://${path.join(ROOT, 'src/store/authStore.ts')}`);
  const { isCancelAuthError } = await import(`file://${path.join(ROOT, 'src/services/authErrorMessages.ts')}`);

  function seedAuthed() {
    useAuthStore.setState({
      user: SEED_USER, session: 'sess-abc', isAuthenticated: true, isGuest: false,
      isLoading: false, error: null, role: 'free_user', hasHydrated: true,
      redirectPending: false,
    });
  }

  async function driveLink(linkError) {
    m.linkError = linkError;
    seedAuthed();
    let thrown = null;
    try {
      await useAuthStore.getState().linkNewProvider('google');
    } catch (e) {
      thrown = e;
    }
    return { thrown, state: useAuthStore.getState() };
  }

  // The redirect sentinel (web-Google link full-page navigating to Google) must
  // NOT set an error banner and must be recognisable as cancel-like, so the CTA
  // suppresses it. It still rethrows so the caller's catch runs.
  async function testRedirectSentinelSetsNoErrorBanner() {
    const sentinel = { name: 'AuthRedirectPendingError', code: 'redirecting', status: 0,
      message: '正在導向 Google 登入…' };
    const { thrown, state } = await driveLink(sentinel);
    assert.ok(thrown, 'sentinel must propagate so the CTA catch runs');
    assert.equal(state.error, null, 'redirect sentinel must NOT set an error banner');
    assert.equal(state.isLoading, false, 'loading cleared');
    assert.equal(isCancelAuthError(thrown), true, 'sentinel is cancel-like → CTA suppresses alert');
  }

  // A plain user cancel behaves the same (no banner, suppressed).
  async function testCancelSetsNoErrorBanner() {
    const { thrown, state } = await driveLink({ name: 'AuthError', code: 'cancel', status: 400, message: '已取消登入' });
    assert.equal(state.error, null);
    assert.equal(isCancelAuthError(thrown), true);
  }

  // A REAL link error still surfaces a friendly-but-SAFE banner (visible failure),
  // and NEVER echoes the raw err.message.
  async function testRealLinkErrorSetsSafeBanner() {
    const leaky = { name: 'AuthError', code: 'IDENTITY_ALREADY_LINKED', status: 409,
      message: 'raw backend detail id_token=eyJabc user=victim@example.com' };
    const { thrown, state } = await driveLink(leaky);
    assert.ok(thrown, 'real error propagates');
    assert.equal(isCancelAuthError(thrown), false);
    assert.ok(state.error && state.error.length > 0, 'real link error must set a visible banner');
    for (const secret of ['eyJabc', 'id_token', 'victim@example.com', 'raw backend detail']) {
      assert.ok(!state.error.includes(secret), `banner leaked "${secret}": ${state.error}`);
    }
    // Specific collision guidance preserved (mapped, not the generic fallback).
    assert.ok(state.error.includes('已綁定到另一個'), `expected specific link message, got: ${state.error}`);
  }

  // An unmapped real error still yields a non-empty SAFE banner (no raw echo).
  async function testUnmappedRealErrorStillSafe() {
    const { thrown, state } = await driveLink({ name: 'AuthError', status: 500,
      message: 'secret-leak token=eyJZZZ' });
    assert.ok(thrown);
    assert.ok(state.error && state.error.length > 0);
    assert.ok(!state.error.includes('eyJZZZ') && !state.error.includes('secret-leak'),
      `unmapped error leaked raw message: ${state.error}`);
  }

  // Source-level wiring guard: SettingsScreen's link CTA must suppress the
  // sentinel and route real errors through the safe mapper, never err.message.
  function testSettingsLinkWiringAtSource() {
    const src = fs.readFileSync(path.join(ROOT, 'src/screens/SettingsScreen.tsx'), 'utf8');
    // Isolate handleLinkProvider so we don't accidentally match other handlers.
    const start = src.indexOf('handleLinkProvider');
    assert.ok(start >= 0, 'handleLinkProvider must exist');
    const body = src.slice(start, src.indexOf('confirmUnlinkProvider'));
    assert.ok(body.includes('isCancelAuthError(err)'),
      'link CTA must suppress the cancel/redirect sentinel');
    assert.ok(body.includes('friendlyAuthErrorMessage(err'),
      'link CTA must map real errors via the safe mapper');
    assert.ok(!body.includes('err?.message') && !body.includes('err.message'),
      'link CTA must NOT echo the raw err.message');
  }

  const asyncTests = [
    testRedirectSentinelSetsNoErrorBanner,
    testCancelSetsNoErrorBanner,
    testRealLinkErrorSetsSafeBanner,
    testUnmappedRealErrorStillSafe,
  ];
  const syncTests = [testSettingsLinkWiringAtSource];
  for (const t of asyncTests) { await t(); console.log(`\u2713 ${t.name}`); }
  for (const t of syncTests) { t(); console.log(`\u2713 ${t.name}`); }
  console.log(`\n${asyncTests.length + syncTests.length} auth-link-start tests passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
