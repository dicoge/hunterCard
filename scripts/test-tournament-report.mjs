#!/usr/bin/env node
/**
 * DIC-979 tournament-report core regression. Deterministic, fixture-based, no
 * network. Exercises the honesty invariants of src/utils/tournamentReport.ts:
 * parser/normalizer, dedupe, partial/unknown preservation, source-failure
 * last-known-good preservation, monthly boundary bucketing, and the
 * observed-sample percentage denominator + coverage labeling. Also covers the
 * screen state machine in src/utils/tournamentReportState.ts, where a month
 * switch must clear the prior report so a failed fetch can never render it.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *   scripts/test-tournament-report.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizeEvent,
  normalizeDeck,
  dedupeDecks,
  dedupeEvents,
  monthOf,
  eventsForMonth,
  groupEventsByMonth,
  computeArchetypeShare,
  computeCoverage,
  buildMonthlyReport,
  mergeMonthlyReport,
  reportContentKey,
} from '../src/utils/tournamentReport.ts';
import {
  tournamentReportReducer,
  initialTournamentReportState,
} from '../src/utils/tournamentReportState.ts';

const NOW = '2026-08-01T05:00:00Z';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const rawFeatured = {
  eventId: 'evt-a',
  name: 'Area Qualifier A',
  date: '2026-07-15',
  region: '東北',
  sourceUrl: 'https://example.test/col/vol-10',
  decks: [
    {
      decklogCode: '5USA7',
      playerName: 'p1',
      rank: 8,
      rankLabel: '予選8位',
      archetypeId: 'takane-lui',
      archetypeLabel: '鷹嶺ルイ',
      oshi: '鷹嶺ルイ',
      colors: ['紫'],
    },
  ],
};

// A COMPLETE list (1 / 50 / 20). Only a complete list is treated as verified,
// so anything asserting the verified path has to start from one.
function completeList(mainOverrides = {}) {
  const main = Array.from({ length: 12 }, (_, i) => ({
    zone: 'main',
    cardNumber: `hBP08-1${String(i).padStart(2, '0')}`,
    count: i === 0 ? 6 : 4,
  }));
  return [
    { zone: 'oshi', cardNumber: 'hSD10-001', count: 1 },
    ...main.map((c, i) => (i === 0 ? { ...c, ...mainOverrides } : c)),
    { zone: 'yell', cardNumber: 'hY04-001', count: 20 },
  ];
}

// ── Parser / normalizer ─────────────────────────────────────────────────────
test('normalizeEvent builds stable ids and decklog-derived deck identity', () => {
  const e = normalizeEvent(rawFeatured, NOW);
  assert.equal(e.eventId, 'evt-a');
  assert.equal(e.decks.length, 1);
  const d = e.decks[0];
  assert.equal(d.deckId, 'decklog:5USA7');
  assert.equal(d.sourceUrl, 'https://decklog.bushiroad.com/view/5USA7');
  assert.equal(d.rank, 8);
  assert.equal(d.fetchedAt, NOW);
});

test('participant count is never fabricated — stays null', () => {
  const e = normalizeEvent(rawFeatured, NOW);
  assert.equal(e.entrants, null);
});

test('eventId falls back to slug+date when not supplied', () => {
  const e = normalizeEvent(
    { name: 'My Event!!', date: '2026-07-03', sourceUrl: 'u' },
    NOW,
  );
  assert.equal(e.eventId, 'my-event_2026-07-03');
});

// ── Partial / unknown preservation ──────────────────────────────────────────
test('missing rank/archetype/cards stay unknown, not back-filled', () => {
  const d = normalizeDeck(
    { playerName: 'x' },
    'evt',
    'https://src',
    0,
    NOW,
  );
  assert.equal(d.rank, null);
  assert.equal(d.archetypeId, null);
  assert.equal(d.archetypeLabel, null);
  assert.deepEqual(d.cards, []);
  assert.equal(d.cardsVerified, false);
  assert.equal(d.coverage, 'featured'); // no rank → featured
  // no decklog code → identity falls back to eventId + slot index
  assert.equal(d.deckId, 'evt#slot-0');
});

test('card version is preserved, never inferred; missing version → null', () => {
  const d = normalizeDeck(
    { rank: 1, cards: completeList({ cardNumber: 'hBP08-067' }) },
    'evt',
    'https://src',
    0,
    NOW,
  );
  assert.equal(d.cardsVerified, true);
  assert.equal(d.cardsIssue, null);
  assert.equal(d.coverage, 'ranked'); // rank + verified cards
  const card = d.cards.find((c) => c.cardNumber === 'hBP08-067');
  assert.equal(card.version, null); // not fabricated
  assert.equal(card.count, 6);
  assert.equal(card.zone, 'main');
});

// DIC-1001 #2: a list read only in part describes a deck nobody played. It is
// kept out of the importable set with a reason instead of being trimmed into a
// plausible-looking illegal deck.
test('an incomplete or malformed list is never marked verified', () => {
  const short = normalizeDeck(
    { rank: 1, cards: completeList().slice(0, -1) },
    'evt', 'https://src', 0, NOW,
  );
  assert.equal(short.cardsVerified, false);
  assert.equal(short.cardsIssue, 'incomplete');
  assert.equal(short.coverage, 'partial');

  const malformed = normalizeDeck(
    { rank: 1, cards: [...completeList(), { zone: 'main', cardNumber: '', count: 2 }] },
    'evt', 'https://src', 0, NOW,
  );
  assert.equal(malformed.cardsVerified, false);
  assert.equal(malformed.cardsIssue, 'incomplete');

  const none = normalizeDeck({ rank: 1 }, 'evt', 'https://src', 0, NOW);
  assert.equal(none.cardsIssue, 'missing');
});

// DIC-1000: a slot the source did not place in a zone cannot be imported into
// the editor, and guessing a zone would fabricate deck structure. DIC-1001: nor
// is the rest of the list kept — a trimmed list is a deck nobody played.
test('a card with no zone (or an unknown one) rejects the list, never guesses', () => {
  const d = normalizeDeck(
    {
      rank: 1,
      cards: [
        { cardNumber: 'hBP08-067', count: 4 },
        { zone: 'bench', cardNumber: 'hBP08-068', count: 2 },
        { zone: 'yell', cardNumber: 'hY04-001', count: 20 },
      ],
    },
    'evt',
    'https://src',
    0,
    NOW,
  );
  assert.deepEqual(d.cards, []);
  assert.equal(d.cardsIssue, 'incomplete');
});

// Runtime shapes the DeckCardRef type only claims to guarantee. Each mutation
// below keeps the totals at exactly 1/50/20, so coercion would let it through
// as a complete deck.
test('runtime field types are checked exactly, never coerced', () => {
  const mutations = [
    (c) => (c.zone === 'oshi' ? { ...c, count: '1' } : c),
    (c) => (c.zone === 'oshi' ? { ...c, cardNumber: '  ' } : c),
    (c) => (c.zone === 'oshi' ? { ...c, version: {} } : c),
    (c) => (c.zone === 'oshi' ? { ...c, name: 7 } : c),
    (c) => (c.zone === 'oshi' ? { ...c, imagePath: ['a/b.png'] } : c),
  ];
  for (const mutate of mutations) {
    const d = normalizeDeck(
      { rank: 1, cards: completeList().map(mutate) },
      'evt', 'https://src', 0, NOW,
    );
    assert.equal(d.cardsVerified, false);
    assert.equal(d.cardsIssue, 'incomplete');
    assert.deepEqual(d.cards, []);
  }
});

test('ranked deck with no card list is partial (placement known, list unknown)', () => {
  const e = normalizeEvent(rawFeatured, NOW);
  assert.equal(e.decks[0].coverage, 'partial');
  assert.equal(e.decks[0].cardsVerified, false);
});

// ── Dedupe ──────────────────────────────────────────────────────────────────
test('dedupeDecks drops repeats by deckId (idempotent re-runs)', () => {
  const e = normalizeEvent(rawFeatured, NOW);
  const dup = [...e.decks, ...e.decks];
  assert.equal(dedupeDecks(dup).length, 1);
});

test('dedupeEvents merges decks of the same eventId without duplicating', () => {
  const e1 = normalizeEvent(rawFeatured, NOW);
  const e2 = normalizeEvent(
    {
      ...rawFeatured,
      decks: [{ decklogCode: '1XQQF', rank: 7, archetypeId: 'a2', archetypeLabel: 'A2' }],
    },
    NOW,
  );
  const merged = dedupeEvents([e1, e2]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].decks.length, 2);
  // same-code deck across the two must not double up
  const again = dedupeEvents([e1, e1]);
  assert.equal(again[0].decks.length, 1);
});

// ── Monthly boundary ────────────────────────────────────────────────────────
test('monthOf buckets on UTC, no timezone drift at month edges', () => {
  assert.equal(monthOf('2026-07-31'), '2026-07');
  assert.equal(monthOf('2026-08-01'), '2026-08');
  assert.equal(monthOf(null), null);
  assert.equal(monthOf(''), null);
});

test('eventsForMonth / groupEventsByMonth split on the month boundary', () => {
  const jul = normalizeEvent({ name: 'jul', date: '2026-07-31', sourceUrl: 'u' }, NOW);
  const aug = normalizeEvent({ name: 'aug', date: '2026-08-01', sourceUrl: 'u' }, NOW);
  assert.deepEqual(
    eventsForMonth([jul, aug], '2026-07').map((e) => e.name),
    ['jul'],
  );
  const grouped = groupEventsByMonth([jul, aug]);
  assert.equal(grouped.get('2026-07').length, 1);
  assert.equal(grouped.get('2026-08').length, 1);
  // events with no verifiable date are not date-bucketed
  const undated = normalizeEvent({ name: 'x', date: null, sourceUrl: 'u' }, NOW);
  assert.equal(groupEventsByMonth([undated]).size, 0);
});

// ── Percentage denominator + coverage labeling ──────────────────────────────
test('archetype share denominator is the observed sample; shares sum to 1', () => {
  const events = [
    normalizeEvent({ name: 'e', sourceUrl: 'u', decks: [
      { decklogCode: 'c1', archetypeId: 'a', archetypeLabel: 'A' },
      { decklogCode: 'c2', archetypeId: 'a', archetypeLabel: 'A' },
      { decklogCode: 'c3', archetypeId: 'b', archetypeLabel: 'B' },
    ] }, NOW),
  ];
  const rows = computeArchetypeShare(events);
  const sum = rows.reduce((n, r) => n + r.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, 'shares must sum to 1');
  assert.equal(rows[0].archetypeId, 'a'); // count desc
  assert.equal(rows[0].count, 2);
  assert.ok(Math.abs(rows[0].share - 2 / 3) < 1e-9);
});

test('unknown archetype is a visible slice, always last, counted in denominator', () => {
  const events = [
    normalizeEvent({ name: 'e', sourceUrl: 'u', decks: [
      { decklogCode: 'c1', archetypeId: 'a', archetypeLabel: 'A' },
      { decklogCode: 'c2' }, // unknown archetype
      { decklogCode: 'c3' }, // unknown archetype
    ] }, NOW),
  ];
  const rows = computeArchetypeShare(events);
  const unknown = rows[rows.length - 1];
  assert.equal(unknown.archetypeId, null);
  assert.equal(unknown.count, 2);
  assert.ok(Math.abs(unknown.share - 2 / 3) < 1e-9);
  // denominator includes unknown → known 'a' is 1/3, not 1/1
  assert.ok(Math.abs(rows[0].share - 1 / 3) < 1e-9);
});

test('all-unknown month → single unknown slice at 100% (no fake classification)', () => {
  const events = [
    normalizeEvent({ name: 'e', sourceUrl: 'u', decks: [{ decklogCode: 'c1' }, { decklogCode: 'c2' }] }, NOW),
  ];
  const rows = computeArchetypeShare(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].archetypeId, null);
  assert.equal(rows[0].share, 1);
});

test('coverage never fabricates the event universe (totalEvents null)', () => {
  const events = [normalizeEvent(rawFeatured, NOW)];
  const cov = computeCoverage(events);
  assert.equal(cov.knownEvents, 1);
  assert.equal(cov.totalEvents, null); // unknown universe, never invented
  assert.equal(cov.observedDecks, 1);
  assert.equal(cov.rankedDecks, 1);
});

// ── Incremental merge + source-failure preservation ─────────────────────────
test('mergeMonthlyReport preserves prior events and lets incoming win on conflict', () => {
  const prev = buildMonthlyReport({
    month: '2026-07',
    events: [normalizeEvent(rawFeatured, NOW)],
    generatedAt: NOW,
  });
  // incoming: a NEW event + an update to the existing event's deck set
  const incoming = [
    normalizeEvent({ name: 'new evt', eventId: 'evt-b', sourceUrl: 'u', decks: [
      { decklogCode: '9ZZZZ', archetypeId: 'z', archetypeLabel: 'Z' },
    ] }, NOW),
  ];
  const merged = mergeMonthlyReport(prev, incoming, { month: '2026-07', generatedAt: NOW });
  const ids = merged.events.map((e) => e.eventId).sort();
  assert.deepEqual(ids, ['evt-a', 'evt-b']); // prior evt-a preserved
  assert.equal(merged.observedSampleSize, 2);
});

test('source failure preserves last-known-good (empty incoming → prev intact)', () => {
  const prev = buildMonthlyReport({
    month: '2026-07',
    events: [normalizeEvent(rawFeatured, NOW)],
    generatedAt: NOW,
  });
  // Simulate a collection where the source failed: no incoming events.
  const merged = mergeMonthlyReport(prev, [], { month: '2026-07', generatedAt: '2026-09-01T00:00:00Z' });
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].eventId, 'evt-a');
  // content identical to prev despite the newer generatedAt
  assert.equal(reportContentKey(merged), reportContentKey(prev));
});

// ── Change detection ────────────────────────────────────────────────────────
test('reportContentKey ignores timestamps but reacts to real data changes', () => {
  const a = buildMonthlyReport({ month: '2026-07', events: [normalizeEvent(rawFeatured, NOW)], generatedAt: NOW });
  const b = buildMonthlyReport({ month: '2026-07', events: [normalizeEvent(rawFeatured, '2027-01-01T00:00:00Z')], generatedAt: '2027-01-01T00:00:00Z' });
  assert.equal(reportContentKey(a), reportContentKey(b)); // only timestamps differ
  const c = buildMonthlyReport({ month: '2026-07', events: [
    normalizeEvent({ ...rawFeatured, decks: [...rawFeatured.decks, { decklogCode: 'NEW11', archetypeId: 'q', archetypeLabel: 'Q' }] }, NOW),
  ], generatedAt: NOW });
  assert.notEqual(reportContentKey(a), reportContentKey(c)); // data changed
});

// ── Screen state machine (month switch must never show a stale report) ──────
const idx = {
  schemaVersion: 1,
  generatedAt: NOW,
  months: [
    { month: '2026-07', events: 3, observedDecks: 3 },
    { month: '2026-06', events: 1, observedDecks: 1 },
  ],
};
const reportJuly = buildMonthlyReport({
  month: '2026-07',
  events: [normalizeEvent(rawFeatured, NOW)],
  generatedAt: NOW,
});

function reduceAll(actions, from = initialTournamentReportState) {
  return actions.reduce(tournamentReportReducer, from);
}

test('index load selects the newest month and starts loading its report', () => {
  const s = reduceAll([{ type: 'index-loaded', index: idx }]);
  assert.equal(s.month, '2026-07');
  assert.equal(s.report, null);
  assert.equal(s.loading, true);
  assert.equal(s.error, null);
});

test('switching month clears the previous report before the fetch resolves', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-07', report: reportJuly },
    { type: 'select-month', month: '2026-06' },
  ]);
  assert.equal(s.month, '2026-06');
  assert.equal(s.report, null, 'stale report must be cleared on month switch');
  assert.equal(s.loading, true);
});

test('failed fetch after month switch shows an error, never the previous month', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-07', report: reportJuly },
    { type: 'select-month', month: '2026-06' },
    { type: 'report-failed', month: '2026-06', message: 'boom' },
  ]);
  assert.equal(s.report, null, 'must not fall back to the 2026-07 report');
  assert.equal(s.loading, false);
  assert.equal(s.error, 'boom');
});

test('a late response for an abandoned month is ignored', () => {
  const base = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'select-month', month: '2026-06' },
  ]);
  const late = tournamentReportReducer(base, {
    type: 'report-loaded',
    month: '2026-07',
    report: reportJuly,
  });
  assert.equal(late.report, null);
  assert.equal(late.month, '2026-06');
  assert.equal(late.loading, true);

  const lateFail = tournamentReportReducer(base, {
    type: 'report-failed',
    month: '2026-07',
    message: 'stale failure',
  });
  assert.equal(lateFail.error, null, 'a stale failure must not surface as an error');
  assert.equal(lateFail.loading, true);
});

test('re-selecting the current month is a no-op (no refetch flicker)', () => {
  const base = reduceAll([
    { type: 'index-loaded', index: idx },
    { type: 'report-loaded', month: '2026-07', report: reportJuly },
  ]);
  const same = tournamentReportReducer(base, { type: 'select-month', month: '2026-07' });
  assert.equal(same, base);
});

test('an empty index reports "no data" instead of hanging on the spinner', () => {
  const s = reduceAll([
    { type: 'index-loaded', index: { schemaVersion: 1, generatedAt: NOW, months: [] } },
  ]);
  assert.equal(s.month, null);
  assert.equal(s.loading, false);
  assert.ok(s.error);
});

console.log(`\nDIC-979 tournament-report: ${passed} tests passed`);
