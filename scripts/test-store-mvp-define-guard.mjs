#!/usr/bin/env node
/**
 * EXPO_PUBLIC_STORE_MVP per-deploy-profile define guard (DIC-1401 correction).
 *
 * Two layers:
 * 1. Pure-function unit tests for scripts/ci/store-mvp-define-guard.mjs
 *    (missing/blank/invalid/mismatched-policy inputs).
 * 2. Real-config assertions against THIS repo's committed vercel.json and
 *    eas.json — so a future PR that removes the explicit define (reverting
 *    to the fallback) fails CI immediately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateVercelBuildCommand,
  evaluateEasProductionProfile,
  BRANCH_STORE_MVP_POLICY,
} from './ci/store-mvp-define-guard.mjs';
import { resolveEasProfileEnv } from './ci/eas-profile-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// --------------------------------------------------------- pure-function unit tests

test('missing EXPO_PUBLIC_STORE_MVP in buildCommand fails (the exact bug this guard exists to catch)', () => {
  const r = evaluateVercelBuildCommand('expo export --platform web --clear && node scripts/fix-html.js');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not explicitly set/);
});

test('blank EXPO_PUBLIC_STORE_MVP fails', () => {
  const r = evaluateVercelBuildCommand('EXPO_PUBLIC_STORE_MVP= expo export --platform web');
  assert.equal(r.ok, false);
});

test('invalid EXPO_PUBLIC_STORE_MVP value (not 0/1) fails', () => {
  const r = evaluateVercelBuildCommand('EXPO_PUBLIC_STORE_MVP=true expo export --platform web');
  assert.equal(r.ok, false);
  assert.match(r.reason, /neither "0" nor "1"/);
});

test('explicit "0" with no EXPECTED_VERCEL_BRANCH declaration passes (no policy to check against)', () => {
  const r = evaluateVercelBuildCommand('EXPO_PUBLIC_STORE_MVP=0 expo export --platform web');
  assert.equal(r.ok, true);
  assert.equal(r.value, '0');
});

test('staging branch declaration requires "0" and passes when matching', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=staging bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=0 expo export --platform web',
  );
  assert.equal(r.ok, true);
});

test('staging branch declaration with "1" (wrong direction) fails', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=staging bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=1 expo export --platform web',
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /requires EXPO_PUBLIC_STORE_MVP=0/);
});

test('main branch declaration requires "1" and passes when matching', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=main bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=1 expo export --platform web',
  );
  assert.equal(r.ok, true);
});

test('main branch declaration with "0" (wrong direction) fails', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=main bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=0 expo export --platform web',
  );
  assert.equal(r.ok, false);
});

// --- mutation-sensitivity regression (DIC-1401 exact-head CR, Mac-Codex) ---
// The guard must bind EXPO_PUBLIC_STORE_MVP to the `expo export` command
// itself, not just find the literal somewhere in the buildCommand string.

test('MUTATION: define set AFTER expo export (in a later &&-link) fails — never reaches the web bundle', () => {
  const r = evaluateVercelBuildCommand('expo export --platform web && EXPO_PUBLIC_STORE_MVP=1 true');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

test('MUTATION: define set on an unrelated earlier command fails — POSIX scopes it to that command only', () => {
  const r = evaluateVercelBuildCommand('EXPO_PUBLIC_STORE_MVP=1 npm run unrelated && expo export --platform web');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

test('MUTATION: a non-prefix assignment on the SAME line as expo export (after the command name) still fails', () => {
  const r = evaluateVercelBuildCommand('expo export --platform web EXPO_PUBLIC_STORE_MVP=1');
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
});

// --- branch/flag integration mutation (DIC-1401 CR round 2, Mac-Codex) ---
// The branch policy cross-check must bind EXPECTED_VERCEL_BRANCH to the
// vercel-branch-guard.sh invocation itself. A decoy `main` assignment that is
// POSIX-scoped to an unrelated earlier command must not satisfy the guard —
// otherwise the runtime deploys under `staging` policy while the static guard
// believes `main`, breaking the "only main may deploy Web Production" contract.

test('MUTATION: decoy EXPECTED_VERCEL_BRANCH=main on an unrelated earlier command cannot override the branch-guard binding', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=main true && ' +
      'EXPECTED_VERCEL_BRANCH=staging bash scripts/ci/vercel-branch-guard.sh && ' +
      'EXPO_PUBLIC_STORE_MVP=1 expo export --platform web',
  );
  // The guard sees the REAL binding (staging) on the branch-guard invocation,
  // so the define/1 vs branch/staging mismatch must fail closed — and the
  // declaredBranch reported must be 'staging', not the decoy 'main'.
  assert.equal(r.ok, false);
  assert.equal(r.declaredBranch, 'staging');
  assert.equal(r.value, '1');
});

test('MUTATION: a stray earlier EXPECTED_VERCEL_BRANCH with no later binding reports no declared branch', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=main npm run unrelated && EXPO_PUBLIC_STORE_MVP=0 expo export --platform web',
  );
  // No vercel-branch-guard.sh invocation exists at all: no binding, so no
  // policy cross-check can pass — treat the buildCommand as branch-unguarded.
  assert.equal(r.declaredBranch, null);
});

test('a branch with no defined policy only requires a valid literal, not a specific value', () => {
  const r = evaluateVercelBuildCommand(
    'EXPECTED_VERCEL_BRANCH=some-feature-branch bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=1 expo export --platform web',
  );
  assert.equal(r.ok, true);
});

test('BRANCH_STORE_MVP_POLICY pins the exact two-branch contract', () => {
  assert.deepEqual(BRANCH_STORE_MVP_POLICY, { main: '1', staging: '0' });
});

test('evaluateEasProductionProfile: "1" passes', () => {
  const r = evaluateEasProductionProfile({ EXPO_PUBLIC_STORE_MVP: '1' }, 'production');
  assert.equal(r.ok, true);
});

test('evaluateEasProductionProfile: missing env fails', () => {
  const r = evaluateEasProductionProfile({}, 'production');
  assert.equal(r.ok, false);
});

test('evaluateEasProductionProfile: "0" (wrong value for a production profile) fails', () => {
  const r = evaluateEasProductionProfile({ EXPO_PUBLIC_STORE_MVP: '0' }, 'production');
  assert.equal(r.ok, false);
});

// --------------------------------------------------------- real-config assertions

const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('THIS REPO: committed vercel.json buildCommand explicitly injects a valid, policy-consistent EXPO_PUBLIC_STORE_MVP', () => {
  const r = evaluateVercelBuildCommand(vercelJson.buildCommand);
  assert.equal(r.ok, true, r.reason);
});

for (const profileName of ['production', 'production-apk']) {
  test(`THIS REPO: eas.json build.${profileName} (resolved) sets EXPO_PUBLIC_STORE_MVP="1"`, () => {
    const resolved = resolveEasProfileEnv(ROOT, profileName);
    const r = evaluateEasProductionProfile(resolved, profileName);
    assert.equal(r.ok, true, r.reason);
  });
}

console.log(`\nstore-mvp-define-guard: ${passed} tests passed`);
