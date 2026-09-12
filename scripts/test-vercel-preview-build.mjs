#!/usr/bin/env node
/**
 * Mutation tests for scripts/ci/reproduce-vercel-build.mjs (DIC-1401).
 *
 * reproduce-vercel-build runs the LITERAL vercel.json buildCommand and asserts
 * dist/version.json carries the commit under test — the public-CI mirror of a
 * Vercel Preview build. These tests prove the verifier fails closed: a
 * missing buildCommand, a failing command, a missing version.json and a
 * sha/ref mismatch each exit nonzero, and a healthy pipeline exits 0. All run
 * against a hermetic temp root (no expo, no working-tree mutation).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPRODUCE = path.join(__dirname, 'ci', 'reproduce-vercel-build.mjs');
const SHA = '0123456789abcdef0123456789abcdef01234567';

let tested = 0;
function run(tmpRoot, { buildCommand, sha = SHA, expectExit = 0 }) {
  const vercelJson = { buildCommand };
  fs.writeFileSync(path.join(tmpRoot, 'vercel.json'), JSON.stringify(vercelJson), 'utf-8');
  // Never inherit a version.json written by an earlier case in the same temp root.
  fs.rmSync(path.join(tmpRoot, 'dist'), { recursive: true, force: true });
  const env = {
    ...process.env,
    REPRODUCE_VERCEL_ROOT: tmpRoot,
    VERCEL_GIT_COMMIT_SHA: sha,
    VERCEL_GIT_COMMIT_REF: 'ci/dic-1401-test',
    PATH: process.env.PATH,
  };
  try {
    execFileSync(process.execPath, [REPRODUCE], { cwd: tmpRoot, env, stdio: 'pipe' });
  } catch (error) {
    if (expectExit === 0) {
      console.error(`  ✗ expected success, got exit ${error.status}`);
      console.error(String(error.stderr));
      process.exit(1);
    }
    tested += 1;
    console.log(`  ✓ failed closed with exit ${error.status} as expected`);
    return;
  }
  if (expectExit !== 0) {
    console.error(`  ✗ expected exit ${expectExit}, but the script succeeded`);
    process.exit(1);
  }
  tested += 1;
  console.log('  ✓ exited 0 as expected');
}

function withWriteVersionCommand(tmpRoot, { sha }) {
  return [
    'mkdir -p dist',
    `node -e 'require("fs").writeFileSync("dist/version.json", JSON.stringify({ sha: ${JSON.stringify(sha)}, ref: "ci/dic-1401-test", vercelEnv: "preview" }, null, 2))'`,
  ].join(' && ');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reproduce-vercel'));
try {
  console.log('── reproduce-vercel-build mutation tests ──');

  console.log('\n1. healthy pipeline produces version.json for the exact SHA');
  run(tmp, { buildCommand: withWriteVersionCommand(tmp, { sha: SHA }) });

  console.log('\n2. command that exits nonzero fails the verifier');
  run(tmp, { buildCommand: 'echo boom && exit 3', expectExit: 3 });

  console.log('\n3. buildCommand exits 0 but writes NO version.json');
  run(tmp, { buildCommand: 'mkdir -p dist', expectExit: 1 });

  console.log('\n4. version.json carries a DIFFERENT sha than the commit under test');
  run(tmp, {
    buildCommand: withWriteVersionCommand(tmp, { sha: 'ffffffffffffffffffffffffffffffffffffffff' }),
    expectExit: 1,
  });

  console.log('\n5. no buildCommand in vercel.json');
  run(tmp, { buildCommand: undefined, expectExit: 1 });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n✅ ${tested} reproduce-vercel-build mutation cases passed.`);