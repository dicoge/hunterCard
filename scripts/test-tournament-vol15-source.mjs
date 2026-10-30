#!/usr/bin/env node
/**
 * PR228 — acceptance check for the curated 「イチ推し！デッキ紹介！」vol.15 source
 * (エクストリーマーカップ25-26 Final, 2026-10-12) and the October report built from it.
 *
 * The generic collector/analytics suites prove the pipeline; this file pins what this
 * particular source may and may not claim, against the committed data:
 *   • it is a curated source, not the discovery stub, so a live discovery run sees the
 *     2026-10-23 column as already known ('same'), never 'newer' again;
 *   • exactly the four 敢闘賞 decks the column links, with no fabricated rank, entrants or
 *     record (rank/entrants null; rankLabel is the published non-numeric award);
 *   • a deck is only cardsVerified when its committed list re-passes the strict gate
 *     against the local catalog; X9552 is verified ONLY through the proven art-slot
 *     consolidation of its public list (hSD14-010 as two artworks ×1, fixture-backed),
 *     and without that proof its list is still refused;
 *   • no Deck Log owner/title/comment/image field is stored;
 *   • the generated October report (data + public mirror) reflects exactly that, and the
 *     July/August reports keep their known-good deck sets.
 *
 * Run: npm run test:tournament-vol15-source
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDeckCards, classifyFreshness, cardsFromDecklog } from '../src/utils/tournamentReport.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const SOURCE = 'data/tournaments/sources/discovered-2026-10-23.json';
const src = read(SOURCE);
const catalog = new Set(Object.values(read('data/database.json').cards).map((c) => String(c.cardNumber ?? '').trim()));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const FEATURED = ['SDC2Y', '1A64C0', '1ZDYLG', 'X9552'];

check('source is curated (no stub marker, events present) and the column date is known, not newer', () => {
  assert.equal(src._stub, undefined);
  assert.equal(src.month, '2026-10');
  assert.equal(src.publishedDate, '2026-10-23T17:49:27');
  assert.ok(Array.isArray(src.events) && src.events.length === 1);
  // Same predicate the collector's discovery leg uses for "known" sources.
  const known = fs
    .readdirSync(path.join(ROOT, 'data/tournaments/sources'))
    .map((f) => read(`data/tournaments/sources/${f}`))
    .filter((d) => d.publishedDate && !d._stub && Array.isArray(d.events) && d.events.length > 0)
    .map((d) => String(d.publishedDate).trim())
    .sort();
  assert.equal(classifyFreshness('2026-10-23T17:49:27', known.at(-1)), 'same');
});

const event = src.events[0];

check('event facts are the published ones; unknowns stay null', () => {
  assert.equal(event.eventId, 'extreamer-cup-25-26-final');
  assert.equal(event.date, '2026-10-12');
  assert.equal(event.entrants, null);
  assert.equal(event.format, null);
  assert.equal(event.sourceType, 'official-column');
  assert.match(event.sourceUrl, /^https:\/\/hololive-official-cardgame\.com\/news_detail\/deck-showcase_vol-15\/$/);
});

check('exactly the four linked 敢闘賞 decks, none ranked', () => {
  assert.deepEqual(event.decks.map((d) => d.decklogCode), FEATURED);
  for (const d of event.decks) {
    assert.equal(d.rank, null, `${d.decklogCode} rank must stay unknown`);
    assert.equal(d.rankLabel, '敢闘賞');
    assert.ok(!/champion|優勝|1位|top|TOP/.test(d.rankLabel));
  }
});

check('cardsVerified only when the committed list re-passes the strict gate', () => {
  for (const d of event.decks) {
    if (d.cardsVerified) {
      const v = verifyDeckCards(d.cards, catalog);
      assert.equal(v.cardsVerified, true, `${d.decklogCode}: ${v.failure}`);
      assert.deepEqual(v.totals, { oshi: 1, main: 50, yell: 20 });
      // The PR228 capture time; X9552 was re-fetched later for the art-slot proof.
      if (d.decklogCode === 'X9552') assert.equal(d.fetchedAt, '2026-10-29T17:06:42.625986+00:00');
      else assert.match(d.fetchedAt, /^2026-10-29T07:13:4\d\.\d+\+00:00$/);
    } else {
      assert.deepEqual(d.cards, [], `${d.decklogCode}: an unverified deck must not ship a card list`);
    }
  }
  assert.equal(event.decks.filter((d) => d.cardsVerified).length, 4);
});

check('X9552 is verified only through the proven art-slot consolidation of its public list', () => {
  const x = event.decks.find((d) => d.decklogCode === 'X9552');
  assert.equal(x.cardsVerified, true);
  assert.equal(x.cardsUnverifiedReason, undefined);
  const fixture = read('scripts/fixtures/decklog-x9552-art-slots.json');
  // The committed list is exactly what the adapter makes of the sanitized public response.
  assert.deepEqual(x.cards, cardsFromDecklog(fixture.deck));
  assert.deepEqual(x.cards.filter((c) => c.cardNumber === 'hSD14-010'), [{ zone: 'main', cardNumber: 'hSD14-010', version: 'P', count: 2 }]);
  assert.equal(x.cards.find((c) => c.cardNumber === 'hBP01-068').count, 5, 'source-published ×5 is kept');
  assert.deepEqual(x.artSlotProof, [{
    zone: 'main', cardNumber: 'hSD14-010', version: 'P', decklogIds: [2727, 2995], counts: [1, 1],
    fixture: 'scripts/fixtures/decklog-x9552-art-slots.json',
  }]);
  assert.equal(fixture.provenance.decklog.fetchedAt, x.fetchedAt);
  // Negative control: the same published rows WITHOUT the art proof (as in the PR228
  // capture) stay two slots and the strict gate still refuses them.
  const unproven = structuredClone(fixture.deck);
  for (const r of unproven.list) { delete r.id; delete r.img; }
  const v = verifyDeckCards(cardsFromDecklog(unproven), catalog);
  assert.equal(v.cardsVerified, false);
  assert.match(v.failure, /duplicate card slot within zone: main:hSD14-010/);
});

check('no Deck Log owner / title / comment / image field is stored', () => {
  const allowed = new Set([
    'decklogCode', 'playerName', 'rank', 'rankLabel', 'archetypeId', 'archetypeLabel', 'oshi',
    'colors', 'cards', 'cardsVerified', 'fetchedAt', 'cardsUnverifiedReason', 'artSlotProof',
  ]);
  for (const d of event.decks) {
    for (const k of Object.keys(d)) assert.ok(allowed.has(k), `unexpected deck field ${k}`);
    for (const c of d.cards) assert.deepEqual(Object.keys(c).sort(), ['cardNumber', 'count', 'version', 'zone']);
  }
});

// R1: the evidence is the TEXT of two captured pages, so the copy may only say what was
// not obtained from that captured text — never that the official did not publish it
// (images/charts, the stream and other channels were not checked).
const GLOBAL_ABSENCE = /官方未公開|均未公開|未公開完整|官方不公開|is (?:not )?published|never published|not published|unpublished/;
function assertCapturedScope(label, text) {
  assert.equal(typeof text, 'string', `${label} missing`);
  assert.ok(!GLOBAL_ABSENCE.test(text), `${label} claims a global absence: ${text.match(GLOBAL_ABSENCE)?.[0]}`);
}

check('copy states only what the captured text lacks, never that the official did not publish it', () => {
  assertCapturedScope('source.disclaimer', src.source.disclaimer);
  assertCapturedScope('coverageNote', event.coverageNote);
  assertCapturedScope('provenance', src.provenance);
  for (const [label, text] of [['source.disclaimer', src.source.disclaimer], ['coverageNote', event.coverageNote]]) {
    assert.match(text, /擷取/, `${label} must scope the claim to the captured text`);
    assert.match(text, /未核對/, `${label} must say images/stream/other channels were not checked`);
  }
  assert.match(src.provenance, /captured column and event-page text/);
  assert.match(src.provenance, /not checked/);
  // The official X9552 column image WAS viewed (card-list proof only), so "not
  // checked" must be scoped to the other images, never stated without exception,
  // and the image must not be presented as evidence of rank/record/entrants.
  for (const [label, text] of [['source.disclaimer', src.source.disclaimer], ['coverageNote', event.coverageNote]]) {
    assert.match(text, /除 X9552 牌組圖片外之圖片[^）]*未核對/, `${label} must exempt only the X9552 image from 未核對`);
    assert.match(text, /佐證(?:其)?卡表/, `${label} must say the X9552 image corroborates the card list only`);
    assert.match(text, /維持未知/, `${label} must keep the unknown fields unknown`);
    assert.ok(!/（圖片(?:／圖表)?[、，]/.test(text), `${label} still says images were not checked without exception`);
  }
  assert.match(src.provenance, /images\/charts other than the X9552 deck image[^)]*not checked/);
  assert.match(src.provenance, /X9552 deck image was viewed only to corroborate its card list and states no rank, record or entrant count/);
  assert.ok(!src.provenance.includes('(images/charts, the live stream'), 'provenance still says images were not checked without exception');
  const report = read('data/tournaments/2026-10.json');
  assert.equal(report.source.disclaimer, src.source.disclaimer);
  assert.equal(report.events[0].coverageNote, event.coverageNote);
  // the oracle rejects the R0 wording it replaced
  assert.throws(() => assertCapturedScope('r0', '冠軍、8 強、名次、個人戰績與參賽數均未公開。'));
  assert.throws(() => assertCapturedScope('r0', 'No rank, placement, win/loss record or entrant count is published'));
});

check('October report (data + public mirror) matches the source; July/August deck sets unchanged', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'data/tournaments/2026-10.json'), 'utf8');
  assert.equal(raw, fs.readFileSync(path.join(ROOT, 'public/data/tournaments/2026-10.json'), 'utf8'));
  const report = JSON.parse(raw);
  assert.equal(report.events.length, 1);
  assert.equal(report.coverage.rankedDecks, 0);
  assert.equal(report.coverage.totalEvents, null);
  assert.equal(report.observedSampleSize, 4);
  assert.deepEqual(
    report.events[0].decks.map((d) => [d.deckId, d.cardsVerified, d.coverage]),
    [
      ['decklog:SDC2Y', true, 'featured'],
      ['decklog:1A64C0', true, 'featured'],
      ['decklog:1ZDYLG', true, 'featured'],
      ['decklog:X9552', true, 'featured'],
    ],
  );
  const ids = (m) => read(`data/tournaments/${m}.json`).events.flatMap((e) => e.decks.map((d) => d.deckId)).sort();
  assert.deepEqual(ids('2026-07'), ['decklog:1XQQF', 'decklog:4PQXH', 'decklog:5USA7']);
  assert.deepEqual(ids('2026-08'), ['decklog:2H33J8', 'decklog:DUKHN']);
});

console.log(`\nPR228 vol.15 source acceptance: ${passed} checks passed`);
