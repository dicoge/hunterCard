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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  cardsFromDecklog,
  verifyDeckCards,
  normalizeCards,
  classifyFreshness,
  HOCG_DECKLOG_GAME_TITLE_ID,
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
    { rank: 1, cards: [{ zone: 'main', cardNumber: 'hBP08-067', count: 4 }] },
    'evt',
    'https://src',
    0,
    NOW,
  );
  assert.equal(d.cardsVerified, true);
  assert.equal(d.coverage, 'ranked'); // rank + verified cards
  assert.equal(d.cards[0].cardNumber, 'hBP08-067');
  assert.equal(d.cards[0].version, null); // not fabricated
  assert.equal(d.cards[0].count, 4);
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

// ── DIC-1024: Deck Log live import core (pure, no network) ──────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadCatalogCardNumbers() {
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'database.json'), 'utf8'));
  return new Set(Object.values(db.cards).map((c) => String(c.cardNumber ?? '').trim()));
}

// Rebuild a Deck Log view-API-shaped body from the committed last-known-good
// cards of the DIC-1024 verified sample, so the happy path is tested against the
// REAL shipped data and the real local catalog — and a future edit to the source
// file that breaks 1/50/20 or drifts from the catalog fails this test.
function decklogFromCommittedDeck(decklogCode) {
  const src = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'data', 'tournaments', 'sources', '2026-08-extreamer-cup-tokai-2.json'),
      'utf8',
    ),
  );
  const deck = src.events[0].decks.find((d) => d.decklogCode === decklogCode);
  assert.ok(deck && deck.cardsVerified && deck.cards.length > 0,
    `committed 2026-08 source must carry verified cards for ${decklogCode}`);
  const LIST_BY_ZONE = { oshi: 'p_list', main: 'list', yell: 'sub_list' };
  const body = { title: deck.deckName, game_title_id: HOCG_DECKLOG_GAME_TITLE_ID, p_list: [], list: [], sub_list: [] };
  for (const c of deck.cards) {
    body[LIST_BY_ZONE[c.zone]].push({ card_number: c.cardNumber, num: c.count, rare: c.version ?? '' });
  }
  return body;
}

test('cardsFromDecklog maps Deck Log lists to zones and normalizes versions', () => {
  const cards = cardsFromDecklog({
    game_title_id: HOCG_DECKLOG_GAME_TITLE_ID,
    p_list: [{ card_number: 'hBP07-006', num: 1, rare: 'OSR', type: 3 }],
    list: [{ card_number: 'hBP07-063', num: 4, rare: 'C', type: 1 }],
    sub_list: [{ card_number: 'hY05-003', num: 20, rare: 'SY', type: 2 }],
  });
  assert.deepEqual(cards, [
    { zone: 'oshi', cardNumber: 'hBP07-006', version: 'OSR', count: 1 },
    { zone: 'main', cardNumber: 'hBP07-063', version: 'C', count: 4 },
    { zone: 'yell', cardNumber: 'hY05-003', version: 'SY', count: 20 },
  ]);
});

test('cardsFromDecklog throws on unreadable slots instead of guessing', () => {
  assert.throws(() => cardsFromDecklog(null), /empty Deck Log response/);
  assert.throws(
    () => cardsFromDecklog({ p_list: [{ num: 1 }] }),
    /has no card number/,
  );
  // numeric `type` is a cross-signal: yell card in the main list must fail
  assert.throws(
    () => cardsFromDecklog({ list: [{ card_number: 'hY05-003', type: 2 }] }),
    /type 2, expected 1/,
  );
});

test('verifyDeckCards passes the real committed DUKHN and 2H33J8 lists', () => {
  const catalog = loadCatalogCardNumbers();
  for (const code of ['DUKHN', '2H33J8']) {
    const { cardsVerified, totals, failure } = verifyDeckCards(
      cardsFromDecklog(decklogFromCommittedDeck(code)),
      catalog,
    );
    assert.equal(cardsVerified, true, `${code}: ${failure}`);
    assert.deepEqual(totals, { oshi: 1, main: 50, yell: 20 });
  }
});

test('verifyDeckCards fails closed on a duplicate slot inside a zone', () => {
  const cards = cardsFromDecklog(decklogFromCommittedDeck('DUKHN'));
  // Split one main slot into two entries of the same number (totals still 1/50/20).
  const i = cards.findIndex((c) => c.zone === 'main' && c.count > 1);
  const base = cards[i];
  cards.splice(i, 1, { ...base, count: 2 }, { ...base, count: base.count - 2 });
  const { cardsVerified, failure } = verifyDeckCards(cards, loadCatalogCardNumbers());
  assert.equal(cardsVerified, false);
  assert.match(failure, new RegExp(`duplicate card slot within zone: main:${base.cardNumber}`));
});

test('verifyDeckCards reports the exact slot of a card missing from the catalog', () => {
  const cards = cardsFromDecklog(decklogFromCommittedDeck('2H33J8'));
  const target = cards.find((c) => c.zone === 'main');
  target.cardNumber = 'hBP99-999'; // totals unchanged, but not in the local catalog
  const { cardsVerified, failure } = verifyDeckCards(cards, loadCatalogCardNumbers());
  assert.equal(cardsVerified, false);
  assert.match(failure, /card not found in local official catalog: hBP99-999/);
});

test('verifyDeckCards fails when totals deviate from 1/50/20', () => {
  const cards = cardsFromDecklog(decklogFromCommittedDeck('DUKHN'));
  cards[0].count += 1; // oshi 1 → 2
  const { cardsVerified, failure } = verifyDeckCards(cards, loadCatalogCardNumbers());
  assert.equal(cardsVerified, false);
  assert.match(failure, /2\/50\/20/);
});

test('normalizeCards requires a readable zone (never infers one)', () => {
  assert.throws(
    () => normalizeCards([{ cardNumber: 'hBP08-067', count: 4 }]),
    /has no readable zone/,
  );
});

test('classifyFreshness flags only a strictly newer official publication', () => {
  assert.equal(classifyFreshness(null, '2026-08-09'), 'unknown');
  assert.equal(classifyFreshness('2026-08-09T12:00:00Z', '2026-08-09'), 'same');
  assert.equal(classifyFreshness('2026-08-10T12:00:00Z', '2026-08-09'), 'newer');
  assert.equal(classifyFreshness('2026-08-01T12:00:00Z', '2026-08-09'), 'older');
});

console.log(`\nDIC-979 tournament-report: ${passed} tests passed`);
