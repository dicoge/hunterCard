#!/usr/bin/env node
/**
 * scripts/ci/vercel-branch-guard.sh behaviour (DIC-1401).
 *
 * The guard MUST bind the allowed branch to a TRUSTED project identity that
 * Vercel injects at build time (VERCEL_PROJECT_ID or
 * VERCEL_PROJECT_PRODUCTION_URL). Both are per-PROJECT and do not travel
 * with the branch's committed content, so a misconfigured Vercel project
 * building the wrong branch can never resolve to a self-consistent
 * expected==actual.
 *
 * Invariants exercised below:
 * - Registry file missing: hard fail (guard cannot resolve without it).
 * - VERCEL_ENV != "production" (preview/dev/unset): guard is a no-op — every
 *   branch must still be able to preview-build on either project. This
 *   holds even when identity env vars are entirely absent.
 * - VERCEL_ENV=production + no identity env vars set at all: hard fail
 *   (identity absent).
 * - VERCEL_ENV=production + identity that isn't in the registry: hard fail
 *   (unknown project).
 * - VERCEL_ENV=production + registered identity + matching commit ref:
 *   passes and logs the resolution source.
 * - VERCEL_ENV=production + registered identity + empty ref: hard fail
 *   (unverifiable source).
 * - MUTATION: holocard-hunter (production_url=holohunter.dicoge.com) built
 *   with VERCEL_GIT_COMMIT_REF=staging → hard fail. This is the exact
 *   "prod project promoted the wrong branch" scenario the previous round's
 *   branch-self-declared guard could not catch, because on staging the
 *   branch's own vercel.json would have said EXPECTED=staging.
 * - MUTATION: holohunter-staging (production_url=test.holohunter.dicoge.com)
 *   built with VERCEL_GIT_COMMIT_REF=main → hard fail. The mirror image of
 *   the mutation above.
 * - MUTATION: default vercel.app fallback domain for either project also
 *   binds correctly (each project has two entries in the registry — custom
 *   domain plus default fallback — because Vercel returns whichever is
 *   configured as the project's primary Production domain).
 * - project_id takes priority over production_url when both are present in
 *   the registry AND both env vars are set (belt-and-suspenders test).
 *
 * Run: node scripts/test-vercel-branch-guard.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/vercel-branch-guard.sh');
const DEFAULT_REGISTRY = path.join(ROOT, 'scripts/ci/vercel-project-registry.tsv');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function run(env, { registryPath } = {}) {
  const finalEnv = { PATH: process.env.PATH, ...env };
  if (registryPath !== undefined) {
    finalEnv.VERCEL_PROJECT_REGISTRY_PATH = registryPath;
  }
  const result = spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    env: finalEnv,
    encoding: 'utf8',
  });
  return {
    code: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

// --- Sanity: registry file exists on disk and includes the expected entries ---
test('registry file ships in-repo with both projects mapped to their branches', () => {
  const contents = fs.readFileSync(DEFAULT_REGISTRY, 'utf8');
  const dataRows = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  // Every non-comment row must have exactly 4 tab-separated fields.
  for (const row of dataRows) {
    const cols = row.split('\t');
    assert.equal(
      cols.length,
      4,
      `Registry row must have 4 tab-separated fields (identity_kind, identity_value, allowed_branch, label); got ${cols.length} in row: ${JSON.stringify(row)}`,
    );
  }
  // Both projects must have at least one production_url entry each, and the
  // branch it maps to must be correct.
  const findRow = (identityValue) =>
    dataRows
      .map((r) => r.split('\t'))
      .find(([, value]) => value === identityValue);
  const prodProd = findRow('holohunter.dicoge.com');
  const prodFallback = findRow('holocard-hunter.vercel.app');
  const stagingProd = findRow('test.holohunter.dicoge.com');
  const stagingFallback = findRow('holohunter-staging.vercel.app');
  assert.ok(prodProd, 'registry must include holohunter.dicoge.com');
  assert.equal(prodProd[2], 'main');
  assert.ok(prodFallback, 'registry must include holocard-hunter.vercel.app');
  assert.equal(prodFallback[2], 'main');
  assert.ok(stagingProd, 'registry must include test.holohunter.dicoge.com');
  assert.equal(stagingProd[2], 'staging');
  assert.ok(stagingFallback, 'registry must include holohunter-staging.vercel.app');
  assert.equal(stagingFallback[2], 'staging');
});

test('missing registry file fails closed even in non-production contexts', () => {
  const r = run({}, { registryPath: 'scripts/ci/does-not-exist.tsv' });
  assert.equal(r.code, 1);
  assert.match(r.out, /project registry is missing/i);
});

// --- Non-production contexts are unconditionally a no-op ---
test('preview build (VERCEL_ENV=preview) is never gated, even with no identity env vars', () => {
  const r = run({
    VERCEL_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: 'some-feature-branch',
  });
  assert.equal(r.code, 0);
});

test('unset VERCEL_ENV (local/dev shell) is never gated', () => {
  const r = run({});
  assert.equal(r.code, 0);
});

test('development VERCEL_ENV is never gated', () => {
  const r = run({ VERCEL_ENV: 'development', VERCEL_GIT_COMMIT_REF: 'main' });
  assert.equal(r.code, 0);
});

// --- Production requires identity + branch ---
test('production with no VERCEL_PROJECT_ID and no VERCEL_PROJECT_PRODUCTION_URL fails closed', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot bind this Production build to a Vercel project identity/);
});

test('production with an empty VERCEL_GIT_COMMIT_REF fails closed even when the identity is registered', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: '',
    VERCEL_PROJECT_PRODUCTION_URL: 'holohunter.dicoge.com',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot be verified/);
});

test('production with an unknown VERCEL_PROJECT_PRODUCTION_URL (project not in registry) fails closed', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_PRODUCTION_URL: 'random-attacker-project.vercel.app',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /not present in/);
});

test('production with an unknown VERCEL_PROJECT_ID (project not in registry) fails closed', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /not present in/);
});

// --- Happy paths: registered identity + correct branch ---
test('production build for holocard-hunter (canonical domain) on main passes', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_PRODUCTION_URL: 'holohunter.dicoge.com',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /vercel-branch-guard OK/);
  assert.match(r.out, /production_url\(holocard-hunter/);
  assert.match(r.out, /matches contracted branch 'main'/);
});

test('production build for holocard-hunter (default vercel.app domain) on main passes', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_PRODUCTION_URL: 'holocard-hunter.vercel.app',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /matches contracted branch 'main'/);
});

test('production build for holohunter-staging (canonical domain) on staging passes', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
    VERCEL_PROJECT_PRODUCTION_URL: 'test.holohunter.dicoge.com',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /matches contracted branch 'staging'/);
});

test('production build for holohunter-staging (default vercel.app domain) on staging passes', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
    VERCEL_PROJECT_PRODUCTION_URL: 'holohunter-staging.vercel.app',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /matches contracted branch 'staging'/);
});

// --- MUTATION: the exact scenarios Mac-Codex's blocker required proof for ---
test('MUTATION: holocard-hunter Production project misconfigured to build staging → hard fail (canonical domain)', () => {
  // Pre-fix (branch-self-declared) behaviour: staging's vercel.json would
  // have declared EXPECTED_VERCEL_BRANCH=staging, so expected==actual and
  // the guard would have passed. This test locks in that the trusted
  // production_url identity now catches the misconfiguration.
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
    VERCEL_PROJECT_PRODUCTION_URL: 'holohunter.dicoge.com',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /contracted to Production branch 'main'/);
  assert.match(r.out, /triggered for 'staging'/);
  assert.match(r.out, /Refusing to deploy/);
});

test('MUTATION: holocard-hunter Production project misconfigured to build staging → hard fail (default vercel.app fallback)', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
    VERCEL_PROJECT_PRODUCTION_URL: 'holocard-hunter.vercel.app',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to deploy/);
});

test('MUTATION: holohunter-staging project misconfigured to build main → hard fail (canonical domain)', () => {
  // Mirror of the mutation above: pre-fix, main's own vercel.json would
  // have declared EXPECTED_VERCEL_BRANCH=main and the guard would have
  // passed on a staging project building main.
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_PRODUCTION_URL: 'test.holohunter.dicoge.com',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /contracted to Production branch 'staging'/);
  assert.match(r.out, /triggered for 'main'/);
  assert.match(r.out, /Refusing to deploy/);
});

test('MUTATION: holohunter-staging project misconfigured to build main → hard fail (default vercel.app fallback)', () => {
  const r = run({
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
    VERCEL_PROJECT_PRODUCTION_URL: 'holohunter-staging.vercel.app',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to deploy/);
});

// --- Registry semantics ---
test('project_id takes priority over production_url when both env vars match different registry entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-'));
  const registryPath = path.join(tmp, 'registry.tsv');
  fs.writeFileSync(
    registryPath,
    [
      '# priority test registry',
      // Same env values map to CONFLICTING branches under different identity_kinds.
      'project_id\tproj-uuid-main\tmain\tholocard-hunter',
      'production_url\ttest.holohunter.dicoge.com\tstaging\tholohunter-staging',
      '',
    ].join('\n'),
    'utf8',
  );
  try {
    // Both identity values resolve to a registry entry, but they claim
    // different allowed branches. project_id must win, so the build is
    // gated to main. The ref is main → pass, and the resolution log must
    // say project_id.
    const r = run(
      {
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_PROJECT_ID: 'proj-uuid-main',
        VERCEL_PROJECT_PRODUCTION_URL: 'test.holohunter.dicoge.com',
      },
      { registryPath },
    );
    assert.equal(r.code, 0);
    assert.match(r.out, /project_id\(holocard-hunter\)/);

    // And the mirror: if the trusted project_id says main, a staging ref
    // (which is what production_url would have permitted) must still fail.
    const bad = run(
      {
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'staging',
        VERCEL_PROJECT_ID: 'proj-uuid-main',
        VERCEL_PROJECT_PRODUCTION_URL: 'test.holohunter.dicoge.com',
      },
      { registryPath },
    );
    assert.equal(bad.code, 1);
    assert.match(bad.out, /project_id\(holocard-hunter\)/);
    assert.match(bad.out, /contracted to Production branch 'main'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('registry with an unknown identity_kind fails closed rather than silently ignoring the row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbg-'));
  const registryPath = path.join(tmp, 'registry.tsv');
  fs.writeFileSync(
    registryPath,
    [
      'production_url\tholohunter.dicoge.com\tmain\tholocard-hunter',
      'branch_name\tmain\tmain\tbogus-kind-that-should-not-parse',
      '',
    ].join('\n'),
    'utf8',
  );
  try {
    const r = run(
      {
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_REF: 'main',
        VERCEL_PROJECT_PRODUCTION_URL: 'holohunter.dicoge.com',
      },
      { registryPath },
    );
    assert.equal(r.code, 1);
    assert.match(r.out, /unknown identity kind 'branch_name'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\nvercel-branch-guard: ${passed} tests passed`);
