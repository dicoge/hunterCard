#!/usr/bin/env node
/**
 * test-local-cron-pipeline.mjs — regression guard for the DIC-923 local cron
 * blockers (strict CR follow-up).
 *
 * scripts/local-scrape-and-push.sh is a bash script driven by local cron, so
 * nothing here exercises it via a JS import — instead this test statically
 * and behaviourally proves the two failure modes the CR flagged can't recur:
 *
 *   1. P0 — GIT_DIFF_FILES used to be written as a bare, unquoted multi-token
 *      variable assignment (`GIT_DIFF_FILES='a' 'b' 'c'`), which bash parses
 *      as "set GIT_DIFF_FILES=a, then RUN the token 'b' as a command". With
 *      `data/images/` as that second token, every invocation failed with
 *      `bash: data/images/: is a directory` (exit 126) before change
 *      detection ever ran, so the daily pipeline could never commit/push.
 *      This test actually runs the assignment + `git diff --stat -- "$@"`
 *      pattern extracted from the script in a real temp git repo and asserts
 *      it exits 0, not 126.
 *   2. P1 — the native-database generator used to run right after
 *      build-database.js, but merge-buy-prices.js (and the buy scrapers
 *      before it) run AFTER that and can still mutate data/database.json,
 *      so the committed public/data/database.json could go stale again.
 *      This test asserts the generator invocation appears strictly after
 *      merge-buy-prices.js (and build-database.js) in the script, and that a
 *      `--check` fail-closed guard follows the regen.
 *
 * Run: node scripts/test-local-cron-pipeline.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(repoRoot, 'scripts', 'local-scrape-and-push.sh');
const script = fs.readFileSync(SCRIPT_PATH, 'utf-8');

// --- P1: pipeline ordering -------------------------------------------------

const idxBuildDatabase = script.indexOf('node build-database.js');
const idxMergeBuyPrices = script.indexOf('node merge-buy-prices.js');
const idxGenerator = script.indexOf('node scripts/generate-native-database.mjs');
const idxGeneratorCheck = script.indexOf('node scripts/generate-native-database.mjs --check');
const idxCommit = script.indexOf('git push origin main');

assert.ok(idxBuildDatabase !== -1, 'build-database.js invocation not found');
assert.ok(idxMergeBuyPrices !== -1, 'merge-buy-prices.js invocation not found');
assert.ok(idxGenerator !== -1, 'generate-native-database.mjs invocation not found');
assert.ok(idxGeneratorCheck !== -1, 'generate-native-database.mjs --check invocation not found');
assert.ok(idxCommit !== -1, 'git push origin main not found');

assert.ok(
  idxGenerator > idxBuildDatabase,
  'generator must run after build-database.js (writer must run before regen)'
);
assert.ok(
  idxGenerator > idxMergeBuyPrices,
  'generator must run after merge-buy-prices.js — otherwise a late DB writer can leave ' +
    'public/data/database.json stale (DIC-923 P1 regression)'
);
assert.ok(
  idxGeneratorCheck > idxGenerator,
  '--check fail-closed guard must run after the regen write'
);
assert.ok(
  idxGeneratorCheck < idxCommit,
  'generator + --check must complete before commit/push, so a stale artifact never ships'
);
console.log('✓ P1: native-database generator runs after every DB writer, --check guards before push');

// --- P0: GIT_DIFF_FILES assignment must not exit 126 -----------------------

const arrayMatch = script.match(/GIT_DIFF_FILES=\(([^)]*)\)/);
assert.ok(
  arrayMatch,
  'GIT_DIFF_FILES must be declared as a bash array `GIT_DIFF_FILES=(...)` — a bare ' +
    "unquoted multi-token assignment (`GIT_DIFF_FILES='a' 'b' 'c'`) runs token 'b' as a " +
    'command and exits 126 (DIC-923 P0 regression)'
);
assert.ok(
  script.includes('git diff --stat -- "${GIT_DIFF_FILES[@]}"'),
  'change detection must expand GIT_DIFF_FILES as a quoted array ("${GIT_DIFF_FILES[@]}")'
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-cron-test-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir });
  fs.mkdirSync(path.join(tmpDir, 'data', 'images'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'public', 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'data', 'database.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'data', 'images', '.gitkeep'), '');
  fs.writeFileSync(path.join(tmpDir, 'public', 'data', 'database.json'), '{}');
  execFileSync('git', ['add', '-A'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });

  // Mutate a tracked file so the diff check has something real to detect.
  fs.writeFileSync(path.join(tmpDir, 'data', 'database.json'), '{"changed":true}');

  const checkScript = `
    ${arrayMatch[0]}
    git diff --stat -- "\${GIT_DIFF_FILES[@]}" | grep -q .
  `;
  const result = execFileSync('bash', ['-c', checkScript], { cwd: tmpDir, encoding: 'utf-8' });
  console.log('✓ P0: GIT_DIFF_FILES array + change detection runs cleanly (no exit 126)');
  void result;
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ All local cron pipeline regression checks passed');
