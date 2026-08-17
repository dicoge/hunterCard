#!/usr/bin/env node
/**
 * DIC-1066 observed-share donut regression. Deterministic, fixture-based, no
 * network and no hardcoded production counts — every expected number is derived
 * from the fixture it is asserted against.
 *
 * Covers: the verified-only denominator (all=5 / 2026-07=3 / 2026-08=2 built
 * from fixtures), an unknown-archetype slice, an empty and an unknown month,
 * integer percentages that sum to 100, wedge geometry that closes the circle,
 * slice click filtering, and the multi-month screen state machine.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *   scripts/test-tournament-donut.mjs
 */
import assert from 'node:assert/strict';
import {
  ALL_SCOPE,
  UNKNOWN_SLICE_KEY,
  SMALL_SAMPLE_MIN,
  MAX_ARC_SWEEP,
  buildDonutModel,
  computeShareRows,
  donutArcs,
  filterEventsBySlice,
  integerPercents,
  verifiedDecks,
} from '../src/utils/tournamentDonut.ts';
import { computeArchetypeShare } from '../src/utils/tournamentReport.ts';
import {
  tournamentReportReducer,
  initialTournamentReportState,
  reportsInScope,
  scopeLoading,
  scopeError,
} from '../src/utils/tournamentReportState.ts';

const NOW = '2026-08-17T00:00:00Z';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Shaped like a real month file. `cardsVerified` is what decides whether a deck
// is part of the published sample, so the fixtures carry both kinds.
function deck(id, { archetypeId = null, label = null, oshi = null, verified = true } = {}) {
  return {
    deckId: `decklog:${id}`,
    decklogCode: id,
    sourceUrl: `https://decklog.bushiroad.com/view/${id}`,
    playerName: null,
    rank: 1,
    rankLabel: 'champion',
    archetypeId,
    archetypeLabel: label,
    oshi,
    colors: [],
    cards: [],
    cardsVerified: verified,
    coverage: verified ? 'ranked' : 'partial',
    fetchedAt: NOW,
  };
}

function event(eventId, decks) {
  return {
    eventId,
    name: eventId,
    nameZh: null,
    date: null,
    region: null,
    format: null,
    entrants: null,
    sourceUrl: 'https://example.test/col',
    sourceType: 'official-column',
    coverageNote: 'note',
    decks,
    fetchedAt: NOW,
  };
}

function report(month, events) {
  const observed = events.reduce((n, e) => n + e.decks.length, 0);
  return {
    schemaVersion: 1,
    month,
    generatedAt: NOW,
    source: { name: 'src', url: 'https://example.test', disclaimer: 'd' },
    coverage: {
      knownEvents: events.length,
      totalEvents: null,
      observedDecks: observed,
      rankedDecks: observed,
      note: 'coverage',
    },
    events,
    archetypeShare: computeArchetypeShare(events),
    observedSampleSize: observed,
  };
}

// July: three verified decks, three distinct archetypes (post-backfill shape).
const july = report('2026-07', [
  event('tohoku', [deck('5USA7', { archetypeId: 'takane-lui', label: '鷹嶺ルイ', oshi: '鷹嶺ルイ' })]),
  event('kyushu', [
    deck('1XQQF', { archetypeId: 'wando-chihaya', label: '輪堂千速', oshi: '輪堂千速' }),
  ]),
  event('hokkaido', [
    deck('4PQXH', { archetypeId: 'jiji-murin', label: 'ジジ・ムリン', oshi: 'ジジ・ムリン' }),
  ]),
]);

// August: two verified decks in one event.
const august = report('2026-08', [
  event('tokai', [
    deck('DUKHN', { archetypeId: 'azki', label: 'AZKi', oshi: 'AZKi' }),
    deck('2H33J8', { archetypeId: 'auro-chrony', label: 'オーロ・クロニー', oshi: 'オーロ・クロニー' }),
  ]),
]);

const ALL = [august, july];

// ── Verified-only denominator ───────────────────────────────────────────────
test('all-months scope counts every verified deck exactly once', () => {
  const m = buildDonutModel(ALL, ALL_SCOPE, 'archetype');
  const expected = ALL.reduce((n, r) => n + verifiedDecks(r.events).length, 0);
  assert.equal(m.sampleSize, expected);
  assert.equal(m.sampleSize, 5);
  assert.equal(m.slices.length, 5, 'five distinct archetypes → five slices');
  assert.equal(
    m.slices.reduce((n, s) => n + s.count, 0),
    m.sampleSize,
    'slice counts must add back up to the sample',
  );
  assert.equal(m.smallSample, false);
});

test('a single-month scope uses only that month', () => {
  assert.equal(buildDonutModel(ALL, '2026-07', 'archetype').sampleSize, 3);
  assert.equal(buildDonutModel(ALL, '2026-08', 'archetype').sampleSize, 2);
});

test('a sample below the minimum is flagged as small, a sufficient one is not', () => {
  assert.equal(SMALL_SAMPLE_MIN, 3);
  assert.equal(buildDonutModel(ALL, '2026-08', 'archetype').smallSample, true);
  assert.equal(buildDonutModel(ALL, '2026-07', 'archetype').smallSample, false);
});

test('unverified decks are observed but never counted in the sample', () => {
  const pending = report('2026-07', [
    event('tohoku', [deck('5USA7', { archetypeId: 'takane-lui', label: '鷹嶺ルイ', verified: false })]),
    event('kyushu', [deck('1XQQF', { archetypeId: 'wando-chihaya', label: '輪堂千速', verified: false })]),
  ]);
  const m = buildDonutModel([pending], '2026-07', 'archetype');
  assert.equal(m.sampleSize, 0, 'no verified card list → no sample');
  assert.equal(m.observedSize, 2, 'the decks are still reported as observed');
  assert.deepEqual(m.slices, [], 'an empty sample draws no slices at all');
  assert.equal(m.smallSample, false, 'empty is not "small", it is empty');
  assert.deepEqual(donutArcs(m.slices), []);
});

test('a deck present in two month files is counted once', () => {
  const dupe = report('2026-09', [
    event('tokai', [deck('DUKHN', { archetypeId: 'azki', label: 'AZKi', oshi: 'AZKi' })]),
  ]);
  assert.equal(buildDonutModel([august, dupe], ALL_SCOPE, 'archetype').sampleSize, 2);
});

test('a month with no data at all yields an empty model, never NaN', () => {
  const empty = report('2026-06', []);
  const m = buildDonutModel([empty], '2026-06', 'archetype');
  assert.equal(m.sampleSize, 0);
  assert.equal(m.observedSize, 0);
  assert.deepEqual(m.slices, []);
  assert.ok(!Number.isNaN(m.sampleSize));
});

test('an unknown month scope resolves to nothing rather than falling back', () => {
  const m = buildDonutModel(ALL, '2027-01', 'archetype');
  assert.equal(m.sampleSize, 0);
  assert.deepEqual(m.slices, []);
});

// ── Unknown slice ───────────────────────────────────────────────────────────
test('a deck with no archetype becomes its own explicit unknown slice, sorted last', () => {
  const mixed = report('2026-08', [
    event('tokai', [
      deck('DUKHN', { archetypeId: 'azki', label: 'AZKi', oshi: 'AZKi' }),
      deck('ZZZ01', { oshi: null }),
    ]),
  ]);
  const m = buildDonutModel([mixed], '2026-08', 'archetype');
  assert.equal(m.sampleSize, 2);
  assert.equal(m.slices.at(-1).key, UNKNOWN_SLICE_KEY);
  assert.equal(m.slices.at(-1).id, null);
  assert.equal(m.slices.at(-1).count, 1);
  assert.equal(
    m.slices.filter((s) => s.id === 'azki').length,
    1,
    'the unknown deck is never folded into a named archetype',
  );
});

// ── Dimension parity with the shipped analytics ─────────────────────────────
test('the archetype dimension agrees with computeArchetypeShare on the same decks', () => {
  const decks = verifiedDecks(ALL.flatMap((r) => r.events));
  const viaDonut = computeShareRows(decks, 'archetype');
  const viaReport = computeArchetypeShare([event('all', decks)]);
  assert.deepEqual(viaDonut, viaReport, 'the donut must not re-implement share math differently');
});

test('the oshi dimension groups by the published oshi, with no inference', () => {
  const m = buildDonutModel(ALL, ALL_SCOPE, 'oshi');
  assert.equal(m.sampleSize, 5);
  assert.deepEqual(
    m.slices.map((s) => s.id).sort(),
    ['AZKi', 'オーロ・クロニー', 'ジジ・ムリン', '輪堂千速', '鷹嶺ルイ'].sort(),
  );
});

// ── Percentages ─────────────────────────────────────────────────────────────
test('integer percentages always sum to exactly 100', () => {
  for (const counts of [[1, 1, 1], [2, 1], [1, 1, 1, 1, 1], [5], [7, 2, 1], [1, 1, 1, 1, 1, 1, 1]]) {
    const p = integerPercents(counts);
    assert.equal(
      p.reduce((a, b) => a + b, 0),
      100,
      `percentages for ${JSON.stringify(counts)} must sum to 100, got ${JSON.stringify(p)}`,
    );
    assert.ok(p.every((v) => Number.isInteger(v) && v >= 0));
  }
  assert.deepEqual(integerPercents([]), []);
  assert.deepEqual(integerPercents([0, 0]), [0, 0], 'an empty sample never divides by zero');
});

test('the rendered legend percentages sum to 100 for every scope', () => {
  for (const scope of [ALL_SCOPE, '2026-07', '2026-08']) {
    const m = buildDonutModel(ALL, scope, 'archetype');
    assert.equal(m.slices.reduce((n, s) => n + s.percent, 0), 100, scope);
  }
});

test('a larger count never renders a smaller percentage', () => {
  const skewed = report('2026-08', [
    event('e', [
      deck('A1', { archetypeId: 'azki', label: 'AZKi' }),
      deck('A2', { archetypeId: 'azki', label: 'AZKi' }),
      deck('B1', { archetypeId: 'auro', label: 'Auro' }),
    ]),
  ]);
  const [big, small] = buildDonutModel([skewed], '2026-08', 'archetype').slices;
  assert.equal(big.count, 2);
  assert.equal(small.count, 1);
  assert.ok(big.percent > small.percent);
});

// ── Geometry ────────────────────────────────────────────────────────────────
test('wedges tile the full circle with no gap and no overlap', () => {
  const m = buildDonutModel(ALL, ALL_SCOPE, 'archetype');
  const arcs = donutArcs(m.slices);
  let cursor = 0;
  for (const a of arcs) {
    assert.ok(Math.abs(a.startAngle - cursor) < 1e-9, 'each wedge starts where the previous ended');
    assert.ok(a.sweep > 0 && a.sweep <= MAX_ARC_SWEEP, 'a wedge is never empty or wider than half');
    cursor += a.sweep;
  }
  assert.ok(Math.abs(cursor - 360) < 1e-9, 'the wedges must close the circle exactly');
});

test('a slice wider than half the circle is split into drawable wedges', () => {
  const single = report('2026-08', [
    event('e', [
      deck('A1', { archetypeId: 'azki', label: 'AZKi' }),
      deck('A2', { archetypeId: 'azki', label: 'AZKi' }),
    ]),
  ]);
  const m = buildDonutModel([single], '2026-08', 'archetype');
  assert.equal(m.slices.length, 1);
  assert.equal(m.slices[0].percent, 100);
  const arcs = donutArcs(m.slices);
  assert.equal(arcs.length, 2, 'a 360° slice cannot be drawn as one wedge');
  assert.ok(arcs.every((a) => a.sliceKey === 'azki' && a.sweep === 180));
  assert.notEqual(arcs[0].key, arcs[1].key, 'split wedges keep distinct render keys');
});

// ── Click filtering ─────────────────────────────────────────────────────────
test('selecting a slice narrows the deck list to that slice only', () => {
  const events = ALL.flatMap((r) => r.events);
  const filtered = filterEventsBySlice(events, 'azki', 'archetype');
  const decks = filtered.flatMap((e) => e.decks);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].deckId, 'decklog:DUKHN');
  assert.equal(filtered.length, 1, 'events with no matching deck are dropped, not left empty');
});

test('clearing the selection restores every event', () => {
  const events = ALL.flatMap((r) => r.events);
  assert.deepEqual(filterEventsBySlice(events, null, 'archetype'), events);
});

test('filtering by the unknown slice returns only unclassified decks', () => {
  const events = [event('e', [
    deck('A1', { archetypeId: 'azki', label: 'AZKi' }),
    deck('ZZ1'),
  ])];
  const decks = filterEventsBySlice(events, UNKNOWN_SLICE_KEY, 'archetype').flatMap((e) => e.decks);
  assert.equal(decks.length, 1);
  assert.equal(decks[0].deckId, 'decklog:ZZ1');
});

test('filtering follows the selected dimension', () => {
  const events = ALL.flatMap((r) => r.events);
  const byOshi = filterEventsBySlice(events, 'AZKi', 'oshi').flatMap((e) => e.decks);
  assert.equal(byOshi.length, 1);
  assert.equal(byOshi[0].deckId, 'decklog:DUKHN');
  assert.deepEqual(filterEventsBySlice(events, 'AZKi', 'archetype'), [], 'no archetype is named AZKi');
});

test('filtering never mutates the source events', () => {
  const events = ALL.flatMap((r) => r.events);
  const before = events.map((e) => e.decks.length);
  filterEventsBySlice(events, 'azki', 'archetype');
  assert.deepEqual(events.map((e) => e.decks.length), before);
});

// ── Screen state machine (multi-month scope) ────────────────────────────────
const idx = {
  schemaVersion: 1,
  generatedAt: NOW,
  months: [
    { month: '2026-08', events: 1, observedDecks: 2 },
    { month: '2026-07', events: 3, observedDecks: 3 },
  ],
};

function reduceAll(actions, from = initialTournamentReportState) {
  return actions.reduce(tournamentReportReducer, from);
}

test('the index defaults to the all-months scope and requests every month', () => {
  const s = reduceAll([{ type: 'index-loaded', index: idx }]);
  assert.equal(s.scope, ALL_SCOPE);
  assert.deepEqual(s.pending, ['2026-08', '2026-07']);
  assert.equal(scopeLoading(s), true);
  assert.deepEqual(reportsInScope(s), []);
});

test('an all-months scope renders once every month has resolved', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-08', report: august },
    { type: 'report-loaded', month: '2026-07', report: july },
  ]);
  assert.equal(scopeLoading(s), false);
  assert.equal(scopeError(s), null);
  assert.equal(buildDonutModel(reportsInScope(s), s.scope, 'archetype').sampleSize, 5);
});

test('switching scope shows only that month, with no refetch', () => {
  const loaded = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-08', report: august },
    { type: 'report-loaded', month: '2026-07', report: july },
  ]);
  const s = tournamentReportReducer(loaded, { type: 'select-scope', scope: '2026-07' });
  assert.deepEqual(reportsInScope(s).map((r) => r.month), ['2026-07']);
  assert.equal(scopeLoading(s), false, 'an already-loaded month never re-enters loading');
  assert.equal(buildDonutModel(reportsInScope(s), s.scope, 'archetype').sampleSize, 3);
});

test('a failed month never renders another month in its place', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-08', report: august },
    { type: 'report-failed', month: '2026-07', message: 'boom' },
    { type: 'select-scope', scope: '2026-07' },
  ]);
  assert.deepEqual(reportsInScope(s), [], 'must not fall back to the 2026-08 report');
  assert.equal(scopeLoading(s), false);
  assert.equal(scopeError(s), 'boom');
});

test('a partially failed all-scope still renders the months that loaded', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-08', report: august },
    { type: 'report-failed', month: '2026-07', message: 'boom' },
  ]);
  assert.equal(scopeError(s), null, 'one bad month must not blank the whole chart');
  assert.equal(buildDonutModel(reportsInScope(s), s.scope, 'archetype').sampleSize, 2);
});

test('an every-month failure surfaces one honest error instead of an empty chart', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-failed', month: '2026-08', message: 'a' },
    { type: 'report-failed', month: '2026-07', message: 'b' },
  ]);
  assert.equal(scopeError(s), '無法載入賽事月報資料。');
});

test('a response for a month the index never listed is ignored', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-05', report: july },
  ]);
  assert.deepEqual(Object.keys(s.reports), []);
});

test('an empty index reports no data rather than an endless spinner', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: { ...idx, months: [] } },
  ]);
  assert.equal(scopeLoading(s), false);
  assert.equal(scopeError(s), '目前沒有可用的賽事月報資料。');
});

console.log(`test-tournament-donut: PASS (${passed} checks)`);
