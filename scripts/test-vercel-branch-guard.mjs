#!/usr/bin/env node
/**
 * scripts/ci/vercel-branch-guard.sh behaviour (DIC-1401).
 *
 * Invariants:
 * - Missing EXPECTED_VERCEL_BRANCH: hard fail, regardless of VERCEL_ENV
 *   (a project must never build without knowing which branch it owns).
 * - VERCEL_ENV != "production" (preview/dev/unset): guard is a no-op — every
 *   branch must still be able to preview-build on either project.
 * - VERCEL_ENV=production + matching VERCEL_GIT_COMMIT_REF: passes.
 * - VERCEL_ENV=production + mismatched ref: hard fail (the exact "wrong
 *   project promoted the wrong branch to Production" scenario this guard
 *   exists to catch).
 * - VERCEL_ENV=production + empty ref: hard fail (unverifiable source).
 *
 * Run: node scripts/test-vercel-branch-guard.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/vercel-branch-guard.sh');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function run(env) {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  return {
    code: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

test('missing EXPECTED_VERCEL_BRANCH fails closed even without VERCEL_ENV', () => {
  const r = run({});
  assert.equal(r.code, 1);
  assert.match(r.out, /EXPECTED_VERCEL_BRANCH is not set/);
});

test('missing EXPECTED_VERCEL_BRANCH fails closed even when VERCEL_ENV=production', () => {
  const r = run({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' });
  assert.equal(r.code, 1);
  assert.match(r.out, /EXPECTED_VERCEL_BRANCH is not set/);
});

test('preview build (VERCEL_ENV=preview) is never gated, even on a foreign branch', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'main',
    VERCEL_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: 'some-feature-branch',
  });
  assert.equal(r.code, 0);
});

test('unset VERCEL_ENV (local/dev shell) is never gated', () => {
  const r = run({ EXPECTED_VERCEL_BRANCH: 'staging' });
  assert.equal(r.code, 0);
});

test('production build on the contracted branch (main) passes', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'main',
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /vercel-branch-guard OK/);
});

test('production build on the contracted branch (staging) passes', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'staging',
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
  });
  assert.equal(r.code, 0);
});

test('production build with a MISMATCHED ref hard-fails (staging content promoted on the prod project)', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'main',
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'staging',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to deploy/);
});

test('production build with a MISMATCHED ref hard-fails (main content promoted on the staging project)', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'staging',
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: 'main',
  });
  assert.equal(r.code, 1);
});

test('production build with an empty commit ref hard-fails (unverifiable source)', () => {
  const r = run({
    EXPECTED_VERCEL_BRANCH: 'main',
    VERCEL_ENV: 'production',
    VERCEL_GIT_COMMIT_REF: '',
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /cannot be verified/);
});

console.log(`\nvercel-branch-guard: ${passed} tests passed`);
