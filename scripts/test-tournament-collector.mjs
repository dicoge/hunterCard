#!/usr/bin/env node
/**
 * DIC-979 collector process regression. Spawns the REAL collector
 * (scripts/collect-tournament-reports.mjs) against a throwaway fixture tree so
 * the source-failure branch is executed end to end, not simulated through the
 * merge helper.
 *
 * Guarantee under test: a source that fails to parse or fails top-level
 * validation must not clobber the last-known-good report for its month, and
 * must not drop that month from index.json — otherwise the UI loses the ability
 * to discover a report that is still sitting valid on disk.
 *
 * Run: node scripts/test-tournament-collector.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const COLLECTOR = path.join(__dirname, 'collect-tournament-reports.mjs');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const GOOD_SOURCE = {
  month: '2026-07',
  source: {
    name: 'Fixture column',
    url: 'https://example.test/col/vol-10',
    disclaimer: '測試用固定樣本。',
  },
  events: [
    {
      eventId: 'evt-a',
      name: 'Area Qualifier A',
      sourceUrl: 'https://example.test/col/vol-10',
      decks: [
        { decklogCode: '5USA7', rank: 8, rankLabel: '予選8位', archetypeId: 'a', archetypeLabel: 'A' },
        { decklogCode: '1XQQF', rank: 7, rankLabel: '予選7位', archetypeId: 'b', archetypeLabel: 'B' },
      ],
    },
  ],
};

const trees = [];
process.on('exit', () => {
  for (const dir of trees) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic979-collector-'));
  trees.push(dir);
  const sources = path.join(dir, 'sources');
  const out = path.join(dir, 'out');
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return { dir, sources, out };
}

function runCollector({ sources, out }, now) {
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      './scripts/register-ts.mjs',
      COLLECTOR,
      '--sources-dir',
      sources,
      '--out-dir',
      out,
      '--now',
      now,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const readOut = (out, file) => JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));

// Each failure mode gets its own fresh tree seeded with a good run, so the
// assertions are about the failure branch alone.
function seeded() {
  const tree = makeTree();
  fs.writeFileSync(
    path.join(tree.sources, 'jul.json'),
    JSON.stringify(GOOD_SOURCE, null, 2),
  );
  const run = runCollector(tree, '2026-08-01T05:00:00Z');
  assert.equal(run.code, 0, `baseline run should succeed:\n${run.stderr}`);
  return tree;
}

test('baseline: a valid source writes the month report and indexes it', () => {
  const { out } = seeded();
  const report = readOut(out, '2026-07.json');
  assert.equal(report.month, '2026-07');
  assert.equal(report.events.length, 1);
  assert.equal(report.observedSampleSize, 2);

  const index = readOut(out, 'index.json');
  assert.deepEqual(index.months, [{ month: '2026-07', events: 1, observedDecks: 2 }]);
});

test('unparseable source preserves last-known-good report AND its index entry', () => {
  const tree = seeded();
  const before = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');

  fs.writeFileSync(path.join(tree.sources, 'jul.json'), '{ this is not json ');
  const run = runCollector(tree, '2026-09-01T05:00:00Z');

  assert.equal(run.code, 1, 'a source failure must exit non-zero so a scheduler alerts');
  assert.match(run.stderr, /Failed to parse source jul\.json/);

  const after = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');
  assert.equal(after, before, 'the good report must be byte-identical (no clobber, no churn)');

  const index = readOut(tree.out, 'index.json');
  assert.deepEqual(
    index.months,
    [{ month: '2026-07', events: 1, observedDecks: 2 }],
    'the month must stay discoverable in index.json',
  );
  assert.match(run.stdout, /2026-07.*\[preserved\]/);

  const alerts = readOut(tree.out, 'collector-alerts.json');
  assert.ok(alerts.alerts.some((a) => a.level === 'error' && /Failed to parse/.test(a.message)));
  assert.ok(alerts.alerts.some((a) => a.level === 'warn' && a.month === '2026-07'));
});

test('top-level validation failure preserves the month the same way', () => {
  const tree = seeded();
  const before = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');

  // Well-formed JSON, but missing the required month/events[] contract.
  fs.writeFileSync(
    path.join(tree.sources, 'jul.json'),
    JSON.stringify({ source: GOOD_SOURCE.source }, null, 2),
  );
  const run = runCollector(tree, '2026-09-01T05:00:00Z');

  assert.equal(run.code, 1);
  assert.match(run.stderr, /missing "month" or "events\[\]"/);
  assert.equal(fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'), before);
  assert.deepEqual(readOut(tree.out, 'index.json').months, [
    { month: '2026-07', events: 1, observedDecks: 2 },
  ]);
});

test('a failing month does not drop a sibling month that collected fine', () => {
  const tree = seeded();
  fs.writeFileSync(
    path.join(tree.sources, 'aug.json'),
    JSON.stringify({ ...GOOD_SOURCE, month: '2026-08' }, null, 2),
  );
  assert.equal(runCollector(tree, '2026-09-01T05:00:00Z').code, 0);

  fs.writeFileSync(path.join(tree.sources, 'jul.json'), 'broken');
  const run = runCollector(tree, '2026-10-01T05:00:00Z');
  assert.equal(run.code, 1);

  assert.deepEqual(readOut(tree.out, 'index.json').months, [
    { month: '2026-08', events: 1, observedDecks: 2 },
    { month: '2026-07', events: 1, observedDecks: 2 },
  ]);
});

test('re-running an unchanged source rewrites nothing (idempotent, no churn)', () => {
  const tree = seeded();
  const before = {
    report: fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'),
    index: fs.readFileSync(path.join(tree.out, 'index.json'), 'utf8'),
  };
  const run = runCollector(tree, '2027-01-01T00:00:00Z');
  assert.equal(run.code, 0);
  assert.equal(fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'), before.report);
  assert.equal(fs.readFileSync(path.join(tree.out, 'index.json'), 'utf8'), before.index);
});

test('--live collects opt-in sources with committed cards without network', () => {
  const tree = seeded();
  // Opt the fixture source into live Deck Log mode, but every deck already has
  // committed cards (or no decklog code), so --live must NOT hit the network:
  // it skips the already-committed decks and the offline collection still runs.
  const src = JSON.parse(fs.readFileSync(path.join(tree.sources, 'jul.json'), 'utf8'));
  src.liveDecklog = true;
  src.events[0].decks[0].cards = [{ zone: 'oshi', cardNumber: 'hBP07-006', version: 'OSR', count: 1 }];
  src.events[0].decks[0].cardsVerified = true;
  fs.writeFileSync(path.join(tree.sources, 'jul.json'), JSON.stringify(src, null, 2));
  const before = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');

  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      './scripts/register-ts.mjs',
      COLLECTOR,
      '--sources-dir',
      tree.sources,
      '--out-dir',
      tree.out,
      '--now',
      '2026-09-01T05:00:00Z',
      '--live',
      '--skip-discovery',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `live run should succeed:\n${res.stderr}`);
  assert.match(res.stdout, /mode: LIVE/);

  // Committed cards were preserved verbatim (already-committed decks are not
  // re-fetched), and the report reflects them.
  const report = readOut(tree.out, '2026-07.json');
  const deck = report.events[0].decks.find((d) => d.decklogCode === '5USA7');
  assert.deepEqual(deck.cards, [{ zone: 'oshi', cardNumber: 'hBP07-006', version: 'OSR', count: 1 }]);
  assert.equal(deck.cardsVerified, true);

  // No live fetch happened → nothing re-fetched, no network in this run.
  assert.doesNotMatch(res.stderr, /Deck Log fetch failed|Deck Log .*: verified/);
});

// Offline (default) mode stays fully hermetic and is unchanged by the live path.
test('offline mode never performs live network work', () => {
  const tree = seeded();
  const res = runCollector(tree, '2026-09-01T05:00:00Z');
  assert.equal(res.code, 0);
  assert.match(res.stdout, /mode: offline/);
  assert.doesNotMatch(res.stdout, /Deck Log/);
});

console.log(`\nDIC-979 tournament-collector: ${passed} tests passed`);
