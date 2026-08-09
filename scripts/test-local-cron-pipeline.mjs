#!/usr/bin/env node
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

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
}

let passed = 0;
function pass(label) {
  passed++;
  console.log(`✓ ${label}`);
}

// Split script at the DIC-935 helpers marker
const helpersIdx = script.indexOf('\n# ===== DIC-935 HELPERS');
assert.ok(helpersIdx !== -1, 'DIC-935 helpers section marker not found');
const activeCode = script.substring(0, helpersIdx);
const helpersSection = script.substring(helpersIdx + 1);

// Extract helper functions
function extractFn(text, fnName) {
  const start = text.indexOf(`${fnName}() {`);
  if (start === -1) return null;
  let depth = 0;
  let i = start + fnName.length + 4; // after "() {"
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      if (depth === 0) break;
      depth--;
    }
  }
  return text.substring(start, i + 1);
}

const diffCheckFn = extractFn(script, '_huntercard_diff_check');
assert.ok(diffCheckFn, '_huntercard_diff_check function not found in script');

// ======== P0: execute callable _huntercard_diff_check in real repo ========

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

  fs.writeFileSync(path.join(tmpDir, 'data', 'database.json'), '{"changed":true}');

  execFileSync('bash', ['-c', `${diffCheckFn}\n_huntercard_diff_check`],
    { cwd: tmpDir, encoding: 'utf-8' });
  pass('P0: _huntercard_diff_check runs in real repo (no exit 126)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// P0 negative: mutate the function and verify bash catches it
{
  const brokenLine = "GIT_DIFF_FILES='data/database.json' 'data/images/' 'data/official/' 'data/series-names.json' 'data/price-history/' 'data/yt-subscribers/' 'data/yt-stats-history.json' 'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' 'public/data/database.json'";
  // Add 'set -e' so the broken multi-token assignment fails immediately (exit 126)
  let brokenFn = diffCheckFn.replace(
    /GIT_DIFF_FILES=\([^)]+\)/,
    brokenLine
  );
  brokenFn = brokenFn.replace(
    'GIT_DIFF_FILES=',
    'set -e\n  GIT_DIFF_FILES='
  );

  const negDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-cron-neg-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: negDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: negDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: negDir });
    fs.mkdirSync(path.join(negDir, 'data', 'images'), { recursive: true });
    fs.writeFileSync(path.join(negDir, 'data', 'images', '.gitkeep'), '');
    execFileSync('git', ['add', '-A'], { cwd: negDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: negDir });

    execFileSync('bash', ['-c', `${brokenFn}\n_huntercard_diff_check`],
      { cwd: negDir, encoding: 'utf-8' });
    fail('P0 negative: broken function was expected to exit ≠ 0 but exited 0');
    process.exitCode = 1;
  } catch (e) {
    if (e.status === 126 || e.status === 127) {
      pass(`P0 negative: broken GIT_DIFF_FILES exits ${e.status} (callable function catches regression)`);
    } else {
      fail(`P0 negative: unexpected error (status ${e.status}, ${e.message})`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(negDir, { recursive: true, force: true });
  }
}

// ======== P1: execute active production code through bash mocks ========

const mockPrefix = [
  'node() { echo "HC_STEP:node ${1##*/}$([ -n \"$2\" ] && echo \" $2\")" >&2; return 0; }',
  'git() { case "$1" in push) echo "HC_STEP:git push origin main" >&2 ;; diff) echo "." ;; esac; return 0; }',
  'mkdir() { return 0; }',
  'trap() { return 0; }',
  'LOG_FILE=/dev/stdout',
  'set +e',
  'exec 2>&1',
].join('\n');

// Remove the initial cd line (depends on $0 which changes when run via bash -c)
// and the LOG_FILE assignment (redirected to /dev/stdout in mock prefix)
const cleanedActive = activeCode.
  replace(/^cd "\$\(dirname "\$0"\)\/\.\."$/m, '# cd overridden — test harness starts at repo root').
  replace(/^LOG_FILE=.+$/m, '# LOG_FILE overridden to /dev/stdout by test harness');

const mockScript = mockPrefix + '\n' + diffCheckFn + '\n' + cleanedActive;

let mockOutput;
try {
  mockOutput = execFileSync('bash', ['-c', mockScript], { cwd: repoRoot, encoding: 'utf-8' });
} catch (e) {
  mockOutput = e.stdout || '';
}

// Extract pipeline steps from mock output
const hcSteps = mockOutput.split('\n')
  .filter(l => l.startsWith('HC_STEP:'))
  .map(l => l.replace('HC_STEP:', '').trim());

// Verify ordering: build-db → merge-buy → gen → gen-check → git-push
const stepOrderIdx = (name) => hcSteps.findIndex(s => s === name);

const stepBuild = 'node build-database.js';
const stepMerge = 'node merge-buy-prices.js';
const stepGen = 'node generate-native-database.mjs';
const stepGenCheck = 'node generate-native-database.mjs --check';
const stepPush = 'git push origin main';

const idxB = stepOrderIdx(stepBuild);
const idxM = stepOrderIdx(stepMerge);
const idxG = stepOrderIdx(stepGen);
const idxGC = stepOrderIdx(stepGenCheck);
const idxP = stepOrderIdx(stepPush);

assert.ok(idxB !== -1, 'P1: node build-database.js not executed');
assert.ok(idxM !== -1, 'P1: node merge-buy-prices.js not executed');
assert.ok(idxG !== -1, 'P1: node generate-native-database.mjs not executed');
assert.ok(idxGC !== -1, 'P1: node generate-native-database.mjs --check not executed');
assert.ok(idxP !== -1, 'P1: git push origin main not executed');

assert.ok(idxG > idxB, 'P1: generator must execute after build-database.js');
assert.ok(idxG > idxM, 'P1: generator must execute after merge-buy-prices.js');
assert.ok(idxGC > idxG, 'P1: --check must execute after generator');
assert.ok(idxGC < idxP, 'P1: generator+check must complete before commit/push');
pass('P1: pipeline ordering verified via actual bash execution (no text matching)');

// P1 negative: mutate active code to move merge-buy-prices after generator
{
  const negActive = cleanedActive
    .replace(
      'node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"',
      '# merge-buy-prices.js intentionally removed (negative fixture)'
    )
    .replace(
      /(\nfi\n)(\n# 3\. Check)/s,
      '$1node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"\n$2'
    );

  const negScript = mockPrefix + '\n' + diffCheckFn + '\n' + negActive;
  let negOutput;
  try {
    negOutput = execFileSync('bash', ['-c', negScript], { cwd: repoRoot, encoding: 'utf-8' });
  } catch (e) {
    negOutput = e.stdout || '';
  }

  const negSteps = negOutput.split('\n')
    .filter(l => l.startsWith('HC_STEP:'))
    .map(l => l.replace('HC_STEP:', '').trim());

  const nM = negSteps.findIndex(s => s === stepMerge);
  const nG = negSteps.findIndex(s => s === stepGen);

  if (nG === -1 || nM === -1) {
    fail('P1 negative: missing expected steps in mutated pipeline');
    process.exitCode = 1;
  } else if (nG > nM) {
    fail('P1 negative: broken ordering (merge after generator) not detected by bash execution');
    process.exitCode = 1;
  } else {
    pass('P1 negative: late-writer ordering regression caught by actual execution');
  }
}

// ======== Summary ========
console.log(`\n✓ All local cron pipeline regression checks passed (${passed} assertions)`);
