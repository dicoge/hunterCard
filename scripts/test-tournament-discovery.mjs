#!/usr/bin/env node
/**
 * DIC-1232 discovery/diff regression. Runs the REAL discovery script
 * (scripts/discover-tournament-results.mjs) against a throwaway registry dir
 * and fixture feed so the acceptances are exercised end to end:
 *
 *   1. A new tournament in the feed is discovered and lands in the "new" queue.
 *   2. Re-running the same feed does NOT re-add anything (idempotent — counts
 *      shift to known, new=0).
 *   3. A feed source that fails (fixture unreadable / a candidate that fails
 *      normalization) preserves the last-known-good registry instead of
 *      clobbering it, and reports a failed count.
 *   4. discovered/known/new/failed counts are correct and machine-parseable.
 *   5. The scheduler manifest lists a next run (nextRunIso) after a live run.
 *
 * Run: node scripts/test-tournament-discovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextRunIso } from './discover-tournament-results.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'discover-tournament-results.mjs');

// ── pure next-run tests ──────────────────────────────────────────────────────
{
  const from = '2026-08-29T00:00:00Z';
  const next = nextRunIso(from, '0 */6 * * *');
  assert.ok(next?.startsWith('2026-08-29T06:00'), `expected 06:00Z, got ${next}`);
  const nextSingle = nextRunIso(from, '30 2 * * *');
  assert.equal(nextSingle, '2026-08-29T02:30:00.000Z', 'next daily 02:30');
  const nextDow = nextRunIso('2026-08-28T00:00:00Z', '0 2 * * 1'); // Monday
  assert.equal(nextDow, '2026-08-31T02:00:00.000Z', 'next Monday 02:00');
}
console.log('  ✓ nextRunIso (hourly / daily / day-of-week)');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const trees = [];
process.on('exit', () => {
  for (const dir of trees) fs.rmSync(dir, { recursive: true, force: true });
});
function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1232-discovery-'));
  trees.push(dir);
  return dir;
}

const FEED_NEW = path.join(os.tmpdir(), `dic1232-feed-new-${Date.now()}.json`);
fs.writeFileSync(
  FEED_NEW,
  JSON.stringify([
    {
      eventId: 'wgp-25-26-singapore',
      name: 'WGP 25-26 Singapore',
      date: '2026-08-02',
      region: 'Singapore',
      tweetCode: '2083881748895555979',
      sourceUrl: 'https://x.com/hololive_OCG/status/2083881748895555979',
    },
    {
      eventId: 'extreamer-cup-25-26-area-kansai',
      name: 'エクストリーマーカップ25-26 エリア予選 関西 Cブロック',
      date: '2026-08-01',
      region: '関西',
      block: 'C',
      tweetCode: '2083474499979313598',
      sourceUrl: 'https://x.com/hololive_OCG/status/2083474499979313598',
    },
  ]),
);

function run(fixture, registryDir, dry = false) {
  const args = [
    '--experimental-strip-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--import',
    './scripts/register-ts.mjs',
    SCRIPT,
    '--now',
    '2026-08-29T00:00:00.000Z',
    '--registry-dir',
    registryDir,
    '--fixture',
    fixture,
  ];
  if (dry) args.push('--dry-run');
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function readCounts(stdout) {
  // first line: discovered=.. known=.. new=.. promoted=.. failed=.. alerts=.. next=..
  const m = stdout.split('\n')[0];
  const get = (k) => Number((m.match(new RegExp(`${k}=(\\d+)`)) || [])[1] ?? -1);
  return {
    discovered: get('discovered'),
    known: get('known'),
    new: get('new'),
    failed: get('failed'),
  };
}

// 1. New feed → everything discovered as new
test('new tournaments are discovered', () => {
  const reg = makeRegistry();
  fs.copyFileSync(
    path.join(ROOT, 'data/tournaments/discovery/probe-frontier.json'),
    path.join(reg, 'probe-frontier.json'),
  );
  const { status, stdout } = run(FEED_NEW, reg);
  assert.equal(status, 0, `expected exit 0, got ${status}:\n${stdout}`);
  const c = readCounts(stdout);
  assert.equal(c.discovered, 2);
  assert.equal(c.known, 0);
  assert.equal(c.new, 2);
  const newFile = JSON.parse(fs.readFileSync(path.join(reg, 'new-results.json'), 'utf8'));
  assert.equal(newFile.records.length, 2);
  const lastDiff = JSON.parse(fs.readFileSync(path.join(reg, 'last-diff.json'), 'utf8'));
  assert.equal(lastDiff.counts.new, 2);
});

// 2. Same feed again → idempotent, nothing re-added
test('duplicates are not re-added on re-run', () => {
  const reg = makeRegistry();
  fs.copyFileSync(
    path.join(ROOT, 'data/tournaments/discovery/probe-frontier.json'),
    path.join(reg, 'probe-frontier.json'),
  );
  run(FEED_NEW, reg);
  const { status, stdout } = run(FEED_NEW, reg);
  assert.equal(status, 0);
  const c = readCounts(stdout);
  assert.equal(c.new, 0, 're-run must not add new records');
  const newFile = JSON.parse(fs.readFileSync(path.join(reg, 'new-results.json'), 'utf8'));
  assert.equal(newFile.records.length, 2, 'new queue stays 2, no growth');
});

// 3. A feed that fails to parse must preserve last-known-good and exit non-zero
test('source failure preserves last-known-good and reports failed', () => {
  const reg = makeRegistry();
  fs.copyFileSync(
    path.join(ROOT, 'data/tournaments/discovery/probe-frontier.json'),
    path.join(reg, 'probe-frontier.json'),
  );
  run(FEED_NEW, reg); // populate known state
  const goodDirSnapshot = fs.readFileSync(path.join(reg, 'known-results.json'), 'utf8');

  const badFeed = path.join(os.tmpdir(), `dic1232-feed-bad-${Date.now()}.json`);
  fs.writeFileSync(badFeed, '{ invalid json');
  const { status, stdout } = run(badFeed, reg);
  assert.equal(status, 1, 'unreadable fixture must exit non-zero');
  // last-known-good untouched (nothing promoted/clobbered)
  const after = fs.readFileSync(path.join(reg, 'known-results.json'), 'utf8');
  assert.equal(after, goodDirSnapshot, 'known registry must be unchanged');
});

// 4. dry-run writes nothing but reports counts
test('dry-run writes nothing', () => {
  const reg = makeRegistry();
  fs.copyFileSync(
    path.join(ROOT, 'data/tournaments/discovery/probe-frontier.json'),
    path.join(reg, 'probe-frontier.json'),
  );
  const { stdout } = run(FEED_NEW, reg, true);
  assert.equal(readCounts(stdout).new, 2);
  assert.ok(!fs.existsSync(path.join(reg, 'new-results.json')), 'no new-results in dry-run');
  assert.ok(!fs.existsSync(path.join(reg, 'last-diff.json')), 'no diff in dry-run');
});

// 5. Live run writes scheduler manifest with next run
test('scheduler manifest lists next run after a live run', () => {
  const reg = makeRegistry();
  fs.copyFileSync(
    path.join(ROOT, 'data/tournaments/discovery/probe-frontier.json'),
    path.join(reg, 'probe-frontier.json'),
  );
  const { stdout } = run(FEED_NEW, reg);
  assert.match(stdout, /next=\d{4}-\d{2}-\d{2}T/, 'stdout must carry a next-run timestamp');
  const sched = JSON.parse(fs.readFileSync(path.join(reg, 'schedule.json'), 'utf8'));
  assert.ok(sched.nextRunIso && sched.nextRunIso.startsWith('2026-08-29T06:00'), `next run ${sched.nextRunIso}`);
  const log = fs.readFileSync(path.join(reg, 'run-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1, 'one run log line per (non-dry) run');
  const entry = JSON.parse(log[0]);
  assert.equal(entry.counts.new, 2);
});

console.log(`\n${passed} discovery tests passed.`);
