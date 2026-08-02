#!/usr/bin/env node
/**
 * Client-side classification tests for the account-delete flow (CR round-7
 * blocker #2). Drives the REAL src/services/authService.ts deleteAccount() against
 * staged HTTP responses and asserts, end to end (endpoint response -> service
 * classification -> UI branch), that:
 *
 *   - a KNOWN pre-commit fail-closed {deleted:false, reason} (501/502) is reported
 *     as `delete_not_deleted` and drives the truthful "not deleted / still signed
 *     in" UI — NOT the ambiguous indeterminate copy, even though it is a 5xx;
 *   - an UNEXPECTED 5xx (could strike after the durable commit) and a network
 *     failure are reported as `delete_indeterminate` and drive the "cannot confirm"
 *     UI.
 *
 * expo-auth-session / expo-web-browser are mocked (unused by deleteAccount but
 * imported at module load), and global fetch is stubbed per case.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-client-tests-'));

// --- Mock the expo modules authService imports at load time. ------------------
const expoAuthSession = {
  makeRedirectUri: () => 'https://example.test',
  AuthRequest: class {},
  exchangeCodeAsync: async () => ({ idToken: 'x' }),
};
const expoWebBrowser = { maybeCompleteAuthSession: () => {} };

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'expo-auth-session') return expoAuthSession;
  if (request === 'expo-web-browser') return expoWebBrowser;
  return originalLoad.apply(this, arguments);
};

// --- Stubbed fetch: each test stages the next outcome. ------------------------
let nextOutcome = null; // { status, body } | { throws: true }
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}
global.fetch = async () => {
  if (nextOutcome && nextOutcome.throws) throw new Error('network down');
  return fakeResponse(nextOutcome.status, nextOutcome.body);
};

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
}

compileTs('src/services/authService.ts');
const authService = require(path.join(outDir, 'src/services/authService.js'));

// Mirror of SettingsScreen.confirmDelete's catch branch (endpoint -> service ->
// UI). Kept in lockstep with src/screens/SettingsScreen.tsx: the alert title is
// the observable UI outcome we assert.
function uiTitleFor(err) {
  return err && err.code === 'delete_indeterminate' ? '尚未確認刪除結果' : '刪除尚未完成';
}

async function callDelete() {
  try {
    await authService.deleteAccount('caller-token');
    return { resolved: true };
  } catch (err) {
    return { resolved: false, code: err.code, message: err.message, title: uiTitleFor(err) };
  }
}

async function testDeletedTrueResolves() {
  nextOutcome = { status: 200, body: { deleted: true, revokedApple: false } };
  const r = await callDelete();
  assert.equal(r.resolved, true, 'deleted:true resolves without throwing');
}

async function testAppleRevocationNotConfiguredIsNotDeleted() {
  nextOutcome = { status: 501, body: { deleted: false, reason: 'apple_revocation_not_configured' } };
  const r = await callDelete();
  assert.equal(r.resolved, false);
  assert.equal(r.code, 'delete_not_deleted', '501 not-configured => fail-closed, not indeterminate');
  assert.equal(r.title, '刪除尚未完成', 'UI shows the truthful not-deleted alert');
  assert.match(r.message, /未刪除/, 'message states the account was not deleted');
}

async function testAppleDeletionNotImplementedIsNotDeleted() {
  nextOutcome = { status: 501, body: { deleted: false, reason: 'apple_deletion_not_implemented' } };
  const r = await callDelete();
  assert.equal(r.code, 'delete_not_deleted', '501 not-implemented => fail-closed');
  assert.equal(r.title, '刪除尚未完成');
}

async function testRevokeFailedIsNotDeleted() {
  nextOutcome = { status: 502, body: { deleted: false, reason: 'revoke_failed' } };
  const r = await callDelete();
  assert.equal(r.code, 'delete_not_deleted', '502 revoke_failed => fail-closed, not indeterminate');
  assert.equal(r.title, '刪除尚未完成', 'UI shows not-deleted, never "cannot confirm"');
}

async function testUnknown5xxIsIndeterminate() {
  // An unexpected server error with no known pre-commit reason: could have struck
  // AFTER the durable commit, so it must stay indeterminate + retryable.
  nextOutcome = { status: 500, body: { error: 'internal_error' } };
  const r = await callDelete();
  assert.equal(r.code, 'delete_indeterminate', 'generic 5xx stays indeterminate');
  assert.equal(r.title, '尚未確認刪除結果', 'UI shows the "cannot confirm" alert');
}

async function testNetworkFailureIsIndeterminate() {
  nextOutcome = { throws: true };
  const r = await callDelete();
  assert.equal(r.code, 'delete_indeterminate', 'network failure is indeterminate');
  assert.equal(r.title, '尚未確認刪除結果');
}

async function testInvalidToken4xxIsNotIndeterminate() {
  nextOutcome = { status: 401, body: { error: 'INVALID_TOKEN', reason: 'invalid_session' } };
  const r = await callDelete();
  assert.notEqual(r.code, 'delete_indeterminate', '401 must not be classified as indeterminate');
  assert.equal(r.title, '刪除尚未完成', '4xx drives the not-deleted UI branch');
}

(async () => {
  const tests = [
    testDeletedTrueResolves,
    testAppleRevocationNotConfiguredIsNotDeleted,
    testAppleDeletionNotImplementedIsNotDeleted,
    testRevokeFailedIsNotDeleted,
    testUnknown5xxIsIndeterminate,
    testNetworkFailureIsIndeterminate,
    testInvalidToken4xxIsNotIndeterminate,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} auth client tests passed`);
})()
  .finally(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    Module._load = originalLoad;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
