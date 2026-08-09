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

function stripFunctions(text) {
  const lines = text.split('\n');
  const out = [];
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (depth === 0 && /^\w[\w_-]*\s*\(\s*\)\s*\{/.test(t)) {
      depth = 1;
      continue;
    }
    if (depth > 0) {
      depth += (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length;
      if (depth <= 0) { depth = 0; }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function executableLines(text) {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'));
}

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
}

let passed = 0;
function pass(label) {
  passed++;
  console.log(`✓ ${label}`);
}

function assertOrdering(commands, label) {
  const dbIdx = commands.findIndex(l => l.includes('node build-database.js'));
  const mergeIdx = commands.findIndex(l => l.includes('node merge-buy-prices.js'));
  const genIdx = commands.findIndex(
    l => l.includes('node scripts/generate-native-database.mjs') && !l.includes('--check')
  );
  const genCheckIdx = commands.findIndex(
    l => l.includes('node scripts/generate-native-database.mjs --check')
  );
  const pushIdx = commands.findIndex(l => l.includes('git push origin main'));

  assert.ok(dbIdx !== -1, `${label}: build-database.js not found`);
  assert.ok(mergeIdx !== -1, `${label}: merge-buy-prices.js not found`);
  assert.ok(genIdx !== -1, `${label}: generate-native-database.mjs not found`);
  assert.ok(genCheckIdx !== -1, `${label}: generate-native-database.mjs --check not found`);
  assert.ok(pushIdx !== -1, `${label}: git push origin main not found`);
  assert.ok(genIdx > dbIdx, `${label}: generator must run after build-database.js`);
  assert.ok(genIdx > mergeIdx, `${label}: generator must run after merge-buy-prices.js`);
  assert.ok(genCheckIdx > genIdx, `${label}: --check must run after generator`);
  assert.ok(genCheckIdx < pushIdx, `${label}: generator+check must complete before push`);
}

// ======== P1: pipeline ordering (top-level active code only) ========

const activeScript = stripFunctions(script);
const commands = executableLines(activeScript);
assertOrdering(commands, 'P1');
pass('P1: generator runs after every DB writer, --check before push (active path only)');

// P1 negative: dead function with correct ordering + broken active path
{
  const deadOrderFn = [
    '_dead_order_ref() {',
    '  node build-database.js',
    '  node merge-buy-prices.js',
    '  node scripts/generate-native-database.mjs',
    '  node scripts/generate-native-database.mjs --check',
    '  git push origin main',
    '}',
  ].join('\n');

  const p1mut = script.replace(
    'node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"',
    '# merge-buy-prices.js INTENTIONALLY REMOVED (negative fixture: moved after generator)'
  );

  const p1final = p1mut.replace(
    /(\nfi\n)(\n# 3\. Check)/s,
    '$1node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"\n$2'
  );

  const mutatedScript = deadOrderFn + '\n' + p1final;
  const mutatedActive = stripFunctions(mutatedScript);
  const mutatedCmds = executableLines(mutatedActive);

  let caught = false;
  try {
    assertOrdering(mutatedCmds, 'P1 NEGATIVE');
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') caught = true;
    else throw e;
  }

  if (caught) {
    pass('P1 negative: broken active ordering detected (dead function with correct strings ignored)');
  } else {
    fail('P1 negative: false positive — dead function fooled ordering check');
    process.exitCode = 1;
  }
}

// ======== P0: GIT_DIFF_FILES exit 126 (top-level active code only) ========

const activeLines = activeScript.split('\n');
const assignmentLine = activeLines.find(l => l.trim().startsWith('GIT_DIFF_FILES=('));
const diffLineRaw = activeLines.find(l => l.includes('git diff --stat -- "${GIT_DIFF_FILES[@]}"'));

assert.ok(assignmentLine, 'GIT_DIFF_FILES=(...) array assignment not found in active (top-level) code');
assert.ok(diffLineRaw, 'git diff --stat -- "${GIT_DIFF_FILES[@]}" not found in active code');
assert.ok(
  assignmentLine.trim().startsWith('GIT_DIFF_FILES=('),
  'GIT_DIFF_FILES must be a bash array — bare unquoted multi-token form exits 126 (DIC-923 P0)'
);
assert.ok(
  diffLineRaw.includes('"${GIT_DIFF_FILES[@]}"'),
  'change detection must use quoted array expansion'
);

// Execute the exact production lines from the active path
const diffCmd = diffLineRaw.trim()
  .replace(/^if\s+/, '')
  .replace(/;\s*then\s*$/, '');
const prodSnippet = `${assignmentLine.trim()}\n${diffCmd}`;

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
  execFileSync('bash', ['-c', prodSnippet], { cwd: tmpDir, encoding: 'utf-8' });
  pass('P0: production GIT_DIFF_FILES array + git diff runs in real repo (no exit 126)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// P0 negative: dead function with correct array + broken active form
{
  const deadDiffFn = [
    '_dead_diff_ref() {',
    '  GIT_DIFF_FILES=(data/database.json data/images/ data/official/ data/series-names.json data/price-history/ data/yt-subscribers/ data/yt-stats-history.json data/news-sentiment/ data/trends/ data/buy-prices/ public/data/database.json)',
    '  git diff --stat -- "${GIT_DIFF_FILES[@]}" | grep -q .',
    '}',
  ].join('\n');

  const brokenLine = "GIT_DIFF_FILES='data/database.json' 'data/images/' 'data/official/' 'data/series-names.json' 'data/price-history/' 'data/yt-subscribers/' 'data/yt-stats-history.json' 'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' 'public/data/database.json'";
  const p0mut = script.replace(/GIT_DIFF_FILES=\([^)]+\)/, brokenLine);
  const mutatedScript = deadDiffFn + '\n' + p0mut;

  const mutatedActive = stripFunctions(mutatedScript);
  const ml = mutatedActive.split('\n');
  const foundLine = ml.find(l => l.trim().startsWith('GIT_DIFF_FILES='));

  let caught = false;
  try {
    assert.ok(
      foundLine && foundLine.trim().startsWith('GIT_DIFF_FILES=('),
      'P0 NEGATIVE: GIT_DIFF_FILES must be array form (dead function must not satisfy this)'
    );
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') caught = true;
    else throw e;
  }

  if (caught) {
    pass('P0 negative: broken active array form detected (dead function with correct form ignored)');
  } else {
    fail('P0 negative: false positive — dead function satisfied the array-form check');
    process.exitCode = 1;
  }
}

// P0 execution-level negative: broken form actually fails at runtime
{
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-cron-neg-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: brokenDir });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: brokenDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: brokenDir });
    fs.mkdirSync(path.join(brokenDir, 'data', 'images'), { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'data', 'images', '.gitkeep'), '');
    execFileSync('git', ['add', '-A'], { cwd: brokenDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: brokenDir });

    const brokenSnippet = "GIT_DIFF_FILES='data/database.json' 'data/images/' 'data/official/'";
    execFileSync('bash', ['-c', brokenSnippet], { cwd: brokenDir, encoding: 'utf-8' });
    fail('P0 execution negative: broken form was expected to exit ≠ 0 but exited 0');
    process.exitCode = 1;
  } catch (e) {
    if (e.status === 126 || e.status === 127) {
      pass(`P0 execution negative: broken unquoted-multi-token form exits ${e.status} (regression confirmed)`);
    } else {
      fail(`P0 execution negative: unexpected error (status ${e.status}, ${e.message})`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }
}

// ======== Summary ========
console.log(`\n✓ All local cron pipeline regression checks passed (${passed} assertions)`);
