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

// --- P1: pipeline ordering (executable lines only, ignoring comments) -------

const commands = executableLines(script);

const dbIdx = commands.findIndex(l => l.includes('node build-database.js'));
const mergeIdx = commands.findIndex(l => l.includes('node merge-buy-prices.js'));
const genIdx = commands.findIndex(
  l => l.includes('node scripts/generate-native-database.mjs') && !l.includes('--check')
);
const genCheckIdx = commands.findIndex(
  l => l.includes('node scripts/generate-native-database.mjs --check')
);
const pushIdx = commands.findIndex(l => l.includes('git push origin main'));

assert.ok(dbIdx !== -1, 'build-database.js not found in executable lines');
assert.ok(mergeIdx !== -1, 'merge-buy-prices.js not found in executable lines');
assert.ok(genIdx !== -1, 'generate-native-database.mjs not found in executable lines');
assert.ok(genCheckIdx !== -1, 'generate-native-database.mjs --check not found in executable lines');
assert.ok(pushIdx !== -1, 'git push origin main not found in executable lines');

assert.ok(
  genIdx > dbIdx,
  'generator must run after build-database.js'
);
assert.ok(
  genIdx > mergeIdx,
  'generator must run after merge-buy-prices.js — late DB writer would leave native asset stale (DIC-923 P1)'
);
assert.ok(
  genCheckIdx > genIdx,
  '--check fail-closed guard must run after the regen write'
);
assert.ok(
  genCheckIdx < pushIdx,
  'generator + --check must complete before commit/push'
);
pass('P1: generator runs after every DB writer, --check guards before push');

// P1 negative fixture: swap merge-buy-prices after generator, keep comments correct
{
  const negScript = [
    '#!/bin/bash',
    '# Step 2g: merge buy-prices — must run AFTER build-database AND BEFORE generator',
    '# This comment correctly describes the required ordering.',
    'node build-database.js',
    'wait',
    '# merge-buy-prices.js used to run here (correctly, before the generator)',
    '# BUT the actual invocation has been moved AFTER the generator — the test MUST catch this.',
    'node scripts/generate-native-database.mjs',
    'node scripts/generate-native-database.mjs --check',
    '# merge moved: now runs after generator (BROKEN — late writer regression)',
    'node merge-buy-prices.js',
    'git push origin main',
  ].join('\n');

  const negCommands = executableLines(negScript);
  const nMergeIdx = negCommands.findIndex(l => l.includes('node merge-buy-prices.js'));
  const nGenIdx = negCommands.findIndex(
    l => l.includes('node scripts/generate-native-database.mjs') && !l.includes('--check')
  );

  let caught = false;
  try {
    assert.ok(nGenIdx > nMergeIdx,
      'P1 NEGATIVE: generator after merge-buy-prices — should be true in correct code,'
    );
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') caught = true;
    else throw e;
  }
  if (caught) {
    pass('P1 negative: broken ordering (generator before merge-buy-prices) correctly detected');
  } else {
    fail('P1 negative fixture: late-writer ordering regression NOT detected (false positive!)');
    process.exitCode = 1;
  }
}

// --- P0: GIT_DIFF_FILES exit 126 — execute actual production lines -----------

const scriptLines = script.split('\n');
const assignmentLine = scriptLines.find(l => l.trim().startsWith('GIT_DIFF_FILES=('));
const diffLine = scriptLines.find(l => l.includes('git diff --stat -- "${GIT_DIFF_FILES[@]}"'));

assert.ok(assignmentLine, 'GIT_DIFF_FILES=(...) array assignment not found in production script');
assert.ok(diffLine, 'git diff --stat -- "${GIT_DIFF_FILES[@]}" not found in production script');

// Verify the array syntax is the correct form
assert.ok(
  assignmentLine.trim().startsWith('GIT_DIFF_FILES=('),
  'GIT_DIFF_FILES must be a bash array `GIT_DIFF_FILES=(...)` — bare unquoted multi-token form exits 126 (DIC-923 P0)'
);
assert.ok(
  diffLine.includes('"${GIT_DIFF_FILES[@]}"'),
  'change detection must reference GIT_DIFF_FILES as a quoted array expansion'
);

// Execute the exact production lines in a real git repo
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

  const diffCmd = diffLine.trim()
    .replace(/^if\s+/, '')
    .replace(/;\s*then\s*$/, '');
  const prodSnippet = `${assignmentLine.trim()}\n${diffCmd}`;
  execFileSync('bash', ['-c', prodSnippet], { cwd: tmpDir, encoding: 'utf-8' });
  pass('P0: actual production GIT_DIFF_FILES array + git diff runs (no exit 126)');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// P0 negative fixture: broken unquoted-multi-token form must fail
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
    fail('P0 negative fixture: broken form was expected to fail but exited 0');
    process.exitCode = 1;
  } catch (e) {
    if (e.status === 126 || e.status === 127) {
      pass(`P0 negative: broken unquoted-multi-token GIT_DIFF_FILES exits ${e.status} (regression caught)`);
    } else {
      fail(`P0 negative fixture: unexpected failure (status ${e.status}, ${e.message})`);
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(brokenDir, { recursive: true, force: true });
  }
}

// --- Summary -----------------------------------------------------------------
console.log(`\n✓ All local cron pipeline regression checks passed (${passed} assertions)`);
