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
 * to discover a report that is still sitting valid on disk. Since DIC-1029 the
 * same guarantee covers a source whose committed card array fails strict
 * revalidation (totals, duplicate zone slots, catalog membership, unreadable
 * counts and card numbers), plus Deck Log request safety in --live mode
 * (401/403/429 handling and the ≥500ms floor) driven through a mocked fetch.
 *
 * Run: node scripts/test-tournament-collector.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ── DIC-1029: committed card arrays are revalidated on every run ─────────────
// A committed (last-known-good) array is an input, not a certificate. These
// tests drive the REAL collector over a genuinely valid 1/50/20 deck and over
// each way it can be corrupted.

// The real shipped DUKHN list: 1 oshi / 50 main / 20 yell, every number in the
// local official catalog. Using the real data keeps the fixture honest — a
// future edit that breaks the shipped deck breaks these tests too.
function committedValidCards() {
  const src = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'data', 'tournaments', 'sources', '2026-08-extreamer-cup-tokai-2.json'),
      'utf8',
    ),
  );
  const deck = src.events[0].decks.find((d) => d.decklogCode === 'DUKHN');
  assert.ok(deck?.cards?.length > 0, 'committed 2026-08 source must carry DUKHN cards');
  return deck.cards.map((c) => ({ ...c }));
}

function writeSource(tree, mutate) {
  const src = JSON.parse(JSON.stringify(GOOD_SOURCE));
  src.events[0].decks[0].cards = committedValidCards();
  src.events[0].decks[0].cardsVerified = true;
  mutate?.(src);
  fs.writeFileSync(path.join(tree.sources, 'jul.json'), JSON.stringify(src, null, 2));
}

// A tree whose last-known-good report holds a genuinely verified deck — the
// valid output the corruption cases below must not be allowed to overwrite.
function seededWithVerifiedDeck() {
  const tree = makeTree();
  writeSource(tree);
  const run = runCollector(tree, '2026-08-01T05:00:00Z');
  assert.equal(run.code, 0, `baseline run should succeed:\n${run.stderr}`);
  const deck = readOut(tree.out, '2026-07.json').events[0].decks.find(
    (d) => d.decklogCode === '5USA7',
  );
  assert.equal(deck.cardsVerified, true, 'baseline deck must be verified');
  return tree;
}

// Each corruption must: exit non-zero, name the exact failing slot, and leave
// the previously valid report byte-identical.
for (const [label, mutate, failurePattern] of [
  [
    'truncated totals',
    (src) => {
      src.events[0].decks[0].cards = src.events[0].decks[0].cards.filter((c) => c.zone !== 'yell');
    },
    /failed revalidation: deck totals must be 1 oshi \/ 50 main \/ 20 yell, got 1\/50\/0/,
  ],
  [
    'a duplicate slot within a zone',
    (src) => {
      const cards = src.events[0].decks[0].cards;
      const i = cards.findIndex((c) => c.zone === 'main' && c.count > 1);
      const base = cards[i];
      cards.splice(i, 1, { ...base, count: 1 }, { ...base, count: base.count - 1 });
    },
    /failed revalidation: duplicate card slot within zone: main:/,
  ],
  [
    'a card missing from the catalog',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'main').cardNumber = 'hBP99-999';
    },
    /failed revalidation: card not found in local official catalog: hBP99-999/,
  ],
  // The counts and card numbers below were previously sanitized away — a zero
  // count became 1 and an unreadable number was dropped — so a broken list
  // could still add up to a legal deck or empty out into "no card data".
  [
    'a zero copy count',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'oshi').count = 0;
    },
    /has no readable copy count \(count=0\)/,
  ],
  [
    'a negative copy count',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'yell').count = -3;
    },
    /has no readable copy count \(count=-3\)/,
  ],
  [
    'a fractional copy count',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'main').count = 1.5;
    },
    /has no readable copy count \(count=1\.5\)/,
  ],
  [
    'a non-numeric copy count',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'main').count = '4';
    },
    /has no readable copy count \(count="4"\)/,
  ],
  [
    'an empty card number',
    (src) => {
      src.events[0].decks[0].cards.find((c) => c.zone === 'main').cardNumber = '';
    },
    /has no readable card number \(cardNumber=""\)/,
  ],
  [
    'a missing card number',
    (src) => {
      delete src.events[0].decks[0].cards.find((c) => c.zone === 'yell').cardNumber;
    },
    /has no readable card number \(cardNumber=undefined\)/,
  ],
]) {
  test(`committed cards with ${label} never overwrite the valid report`, () => {
    const tree = seededWithVerifiedDeck();
    const before = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');

    writeSource(tree, mutate);
    const run = runCollector(tree, '2026-09-01T05:00:00Z');

    assert.equal(run.code, 1, 'invalid committed data must exit non-zero');
    assert.match(run.stderr, failurePattern);
    assert.equal(
      fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'),
      before,
      'the last valid report must stay byte-identical',
    );
    assert.match(run.stdout, /2026-07.*\[preserved\]/);
    assert.deepEqual(readOut(tree.out, 'index.json').months, [
      { month: '2026-07', events: 1, observedDecks: 2 },
    ]);
  });
}

test('a wholly unreadable committed list never empties the valid report', () => {
  // The exact regression: every slot was dropped as unreadable, the list
  // sanitized down to "no card data", the run exited 0 and replaced a verified
  // 1/50/20 deck with zero cards.
  const tree = seededWithVerifiedDeck();
  const before = fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8');

  writeSource(tree, (src) => {
    src.events[0].decks[0].cards = src.events[0].decks[0].cards.map((c) => ({ ...c, cardNumber: '' }));
  });
  const run = runCollector(tree, '2026-09-01T05:00:00Z');

  assert.equal(run.code, 1);
  assert.match(run.stderr, /has no readable card number/);
  assert.equal(fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'), before);
  const deck = readOut(tree.out, '2026-07.json').events[0].decks.find(
    (d) => d.decklogCode === '5USA7',
  );
  assert.deepEqual(deck.cards, committedValidCards(), 'the verified deck must still be there in full');
  assert.equal(deck.cardsVerified, true);
});

test('invalid committed cards are emitted unverified when no valid report exists', () => {
  const tree = makeTree();
  writeSource(tree, (src) => {
    src.events[0].decks[0].cards = src.events[0].decks[0].cards.slice(0, 1);
  });
  const run = runCollector(tree, '2026-08-01T05:00:00Z');

  assert.equal(run.code, 1);
  assert.match(run.stderr, /failed revalidation/);
  // Nothing to preserve, so the data is written — but never as verified.
  const deck = readOut(tree.out, '2026-07.json').events[0].decks.find(
    (d) => d.decklogCode === '5USA7',
  );
  assert.ok(deck.cards.length > 0);
  assert.equal(deck.cardsVerified, false);
  assert.equal(deck.coverage, 'partial');
});

test('--live skips a valid committed deck without touching the network', () => {
  const tree = seededWithVerifiedDeck();
  // Opt into live Deck Log mode. Every deck either has a valid committed list or
  // no decklog code, so --live must NOT hit the network.
  writeSource(tree, (src) => {
    src.liveDecklog = true;
  });
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

  // Revalidated, still verified, byte-identical output → no fetch, no churn.
  assert.equal(fs.readFileSync(path.join(tree.out, '2026-07.json'), 'utf8'), before);
  const deck = readOut(tree.out, '2026-07.json').events[0].decks.find(
    (d) => d.decklogCode === '5USA7',
  );
  assert.deepEqual(deck.cards, committedValidCards());
  assert.equal(deck.cardsVerified, true);
  assert.doesNotMatch(res.stderr, /Deck Log fetch failed|Deck Log .*: verified/);
});

// ── DIC-1029: Deck Log request safety ───────────────────────────────────────
// A deterministic network double installed with --import, so it is in place
// before the collector issues its first request. Every attempt is appended to a
// log file with a timestamp — that log is what the pacing assertions read, so
// they measure the real collector's real gaps rather than a simulation.
const FETCH_STUB = `
import fs from 'node:fs';
const plan = JSON.parse(process.env.DECKLOG_STUB_PLAN);
const logFile = process.env.DECKLOG_STUB_LOG;
const calls = [];
globalThis.fetch = async (url) => {
  const code = String(url).split('/').pop();
  calls.push({ code, at: Date.now() });
  fs.writeFileSync(logFile, JSON.stringify(calls));
  const queue = plan[code];
  if (!Array.isArray(queue) || queue.length === 0) {
    throw new Error('unstubbed Deck Log request: ' + url);
  }
  const step = queue.length > 1 ? queue.shift() : queue[0];
  const headers = new Map(
    Object.entries(step.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  return {
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    json: async () => step.body ?? {},
    text: async () => JSON.stringify(step.body ?? {}),
  };
};
`;

function runLiveCollector(tree, now, plan) {
  const stubFile = path.join(tree.dir, 'fetch-stub.mjs');
  const logFile = path.join(tree.dir, 'fetch-log.json');
  fs.writeFileSync(stubFile, FETCH_STUB);
  fs.rmSync(logFile, { force: true });
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      './scripts/register-ts.mjs',
      '--import',
      pathToFileURL(stubFile).href,
      COLLECTOR,
      '--sources-dir',
      tree.sources,
      '--out-dir',
      tree.out,
      '--now',
      now,
      '--live',
      '--skip-discovery',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DECKLOG_STUB_PLAN: JSON.stringify(plan),
        DECKLOG_STUB_LOG: logFile,
      },
    },
  );
  const calls = fs.existsSync(logFile)
    ? JSON.parse(fs.readFileSync(logFile, 'utf8'))
    : [];
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls };
}

// Live source whose decks all still need fetching (empty committed lists), so
// every deck below is one real request through the stub.
function liveTree(codes) {
  const tree = makeTree();
  const src = JSON.parse(JSON.stringify(GOOD_SOURCE));
  src.liveDecklog = true;
  src.events[0].decks = codes.map((code, i) => ({
    decklogCode: code,
    rank: i + 1,
    rankLabel: `予選${i + 1}位`,
    archetypeId: 'a',
    archetypeLabel: 'A',
    cards: [],
  }));
  fs.writeFileSync(path.join(tree.sources, 'jul.json'), JSON.stringify(src, null, 2));
  return tree;
}

// The shipped DUKHN list re-expressed in Deck Log's own response shape, so a
// stubbed success drives the real parse + strict validation path.
function decklogPayload() {
  const cards = committedValidCards();
  const listFor = (zone, type) =>
    cards
      .filter((c) => c.zone === zone)
      .map((c) => ({ card_number: c.cardNumber, num: c.count, type, rare: c.version ?? '' }));
  return {
    game_title_id: 9,
    p_list: listFor('oshi', 3),
    list: listFor('main', 1),
    sub_list: listFor('yell', 2),
  };
}

// An auth/permission answer is settled: re-sending the identical anonymous
// request cannot change it, so a retry is pure extra load on a public endpoint.
for (const status of [401, 403]) {
  test(`--live treats HTTP ${status} as terminal and still paces the next deck`, () => {
    const tree = liveTree(['5USA7', '1XQQF']);
    const run = runLiveCollector(tree, '2026-09-01T05:00:00Z', {
      '5USA7': [{ status }],
      '1XQQF': [{ status }],
    });

    assert.equal(run.code, 1, 'a failed live fetch must surface as an incident');
    assert.equal(
      run.calls.length,
      2,
      `HTTP ${status} must not be retried — expected one attempt per deck`,
    );
    assert.match(run.stderr, new RegExp(`HTTP ${status}: terminal, not retried`));
    const gap = run.calls[1].at - run.calls[0].at;
    assert.ok(gap >= 500, `pacing must survive a failed request, waited only ${gap}ms`);
  });
}

test('--live gives up on a 429 that specifies no Retry-After', () => {
  const tree = liveTree(['5USA7']);
  const run = runLiveCollector(tree, '2026-09-01T05:00:00Z', {
    '5USA7': [{ status: 429 }],
  });

  assert.equal(run.code, 1);
  assert.equal(run.calls.length, 1, 'an unqualified 429 must not be retried');
  assert.match(run.stderr, /HTTP 429: rate limited, not retried/);
});

test('--live honors Retry-After for exactly one more 429 attempt', () => {
  const tree = liveTree(['5USA7']);
  const run = runLiveCollector(tree, '2026-09-01T05:00:00Z', {
    '5USA7': [
      { status: 429, headers: { 'Retry-After': '1' } },
      { status: 200, body: decklogPayload() },
    ],
  });

  assert.equal(run.code, 0, `the run should recover after the wait:\n${run.stderr}`);
  assert.equal(run.calls.length, 2, 'the rate-limit retry is bounded to one extra attempt');
  const gap = run.calls[1].at - run.calls[0].at;
  assert.ok(gap >= 1000, `the server's Retry-After must be honored, waited only ${gap}ms`);

  const deck = readOut(tree.out, '2026-07.json').events[0].decks[0];
  assert.equal(deck.cardsVerified, true);
  assert.deepEqual(deck.cards, committedValidCards());
});

test('--live paces after early exits, not just after a successful request', () => {
  const truncated = decklogPayload();
  truncated.sub_list = []; // parses fine, then fails the strict 1/50/20 gate
  const tree = liveTree(['5USA7', '1XQQF', 'ABCDE']);
  const run = runLiveCollector(tree, '2026-09-01T05:00:00Z', {
    '5USA7': [{ status: 200, body: { game_title_id: 1 } }],
    '1XQQF': [{ status: 200, body: truncated }],
    'ABCDE': [{ status: 200, body: decklogPayload() }],
  });

  assert.equal(run.code, 1);
  assert.match(run.stderr, /is not an hOCG deck \(game_title_id=1\)/);
  assert.match(
    run.stderr,
    /failed validation: deck totals must be 1 oshi \/ 50 main \/ 20 yell, got 1\/50\/0/,
  );
  assert.equal(run.calls.length, 3);
  assert.ok(
    run.calls[1].at - run.calls[0].at >= 500,
    'a wrong game_title_id must not let the next request jump the queue',
  );
  assert.ok(
    run.calls[2].at - run.calls[1].at >= 500,
    'a validation failure must not let the next request jump the queue',
  );
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
