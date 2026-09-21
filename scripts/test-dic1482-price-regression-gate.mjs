#!/usr/bin/env node
/**
 * test-dic1482-price-regression-gate.mjs — regression suite for the DIC-1482
 * exact-print price-regression contract.
 *
 * Fixtures are REAL production-sequence rows (scripts/fixtures/
 * dic1482-production-sequence.json) extracted from main baseline
 * cfcb081059b5 and scrape candidate bot/scrape/2026-09-19 @ 1a35e14b8b28:
 * the 29 source-proven hBD24 printings the candidate silently nulled, six
 * candidate-proven hBP09 recoveries, and the three strict-gate rejection
 * exemplars (ent07 aggregation row, hCS01 row with an /heb01/ image, and an
 * hBP09 row whose only listing image is the noimage placeholder).
 *
 * Covered contracts:
 *   1. classifyExactPrintPayload — strict per-printing provenance verdicts.
 *   2. evaluatePriceRegressionGate — every decrease in priced rows / priced
 *      unique cardNumbers / price entries must be covered by an
 *      independently re-verifiable per-print rejection; blanket or bogus
 *      rejections are themselves violations (mutation-sensitivity).
 *   3. Last-known-good preservation — replaying the exact production
 *      sequence (healthy scrape that lost the hBD24 listings) through the
 *      same applyPreservedMarketFields wiring build-database.js uses now
 *      preserves all 29 payloads, and the pass is idempotent (fixed point —
 *      no 0↔N oscillation).
 *   4. recoverExactPrintPrices — fill-only exact-id recovery adopts every
 *      proven hBP09 payload, refuses the three exemplars with exact
 *      machine-readable reasons, never touches the preserved hBD24 rows,
 *      and is idempotent.
 *   5. Canonical/public/native fixed-point parity — sanitizeDatabase (the
 *      exact transform generate-native-database.mjs ships through) keeps
 *      priced metrics bit-identical, is itself a fixed point, and the
 *      committed public artifact equals the sanitized canonical byte-for-byte.
 *
 * Run: node scripts/test-dic1482-price-regression-gate.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyExactPrintPayload,
  evaluatePriceRegressionGate,
  buildPriceRejectionManifest,
  priceMetrics,
  isPricedRow,
  makeRejection,
  PRICE_REJECTION_MANIFEST_SCHEMA,
  PROVENANCE_REJECTION_REASONS,
  CONTEXT_REJECTION_REASONS,
} from './lib/price-regression-gate.mjs';
import { applyPreservedMarketFields } from './lib/preserve-market-fields.js';
import { sanitizeDatabase } from './lib/store-mvp-sanitize.mjs';
import { recoverExactPrintPrices } from './recover-dic1482-exact-print-prices.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dic1482-production-sequence.json'), 'utf8',
));

const clone = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ─── 1. classifier verdicts on the real rows ─────────────────────────────
check('all 29 hBD24 baseline payloads are exact-print proven', () => {
  assert.equal(fixture.lostHBD24Ids.length, 29, 'fixture must carry the 29 lost printings');
  for (const id of fixture.lostHBD24Ids) {
    const verdict = classifyExactPrintPayload(fixture.baselineCards[id]);
    assert.equal(verdict.proven, true, `${id} must be proven`);
  }
});

check('candidate hBP09 sample payloads are exact-print proven', () => {
  for (const id of fixture.hbp09SampleIds) {
    assert.equal(classifyExactPrintPayload(fixture.candidateCards[id]).proven, true, id);
  }
});

check('rejection exemplars classify with exact machine-readable reasons', () => {
  assert.equal(classifyExactPrintPayload(fixture.candidateCards['hBD24-064_ent07']).reason,
    'cross-product-image', 'ent07 aggregation row with /promo-hbd20/ image');
  assert.equal(classifyExactPrintPayload(fixture.candidateCards['hBP01-081_hCS01_SR_hBP01-081_02_SR']).reason,
    'cross-product-image', 'hCS01 row with /heb01/ image');
  assert.equal(classifyExactPrintPayload(fixture.candidateCards['hBP09-004_hBP09_SEC_hBP09-004_SEC']).reason,
    'no-yuyu-image-provenance', 'hBP09 row whose only listing image is the noimage placeholder');
});

// DIC-1482 CR (PR #214): the classifier must NEVER infer printing identity from
// the row-level rarity. It briefly rejected every SEC row outright, which did
// two wrong things at once — nulled 12 live PLAIN ent07 prices under a "signed"
// reason, and refused signed rows carrying an exact product-path image, which
// collapsed hBP04-005's パラレル/サイン variant out of the picker (DIC-1067).
// Evidence decides; rarity never does (src/utils/printingIdentity.ts, DIC-1013).
check('a SEC row with exact product-path evidence is proven, not rarity-rejected', () => {
  const listing = 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10013.jpg';
  const signedWithEvidence = {
    id: 'hBP04-005_hBP04_SEC', cardNumber: 'hBP04-005', rarity: 'SEC', sourceProduct: 'hBP04',
    sellPrice: 69800, yuyuName: 'ラプラス・ダークネス(パラレル/サイン)', yuyuImage: listing,
    prices: [{ name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800, rarity: '', imageUrl: listing }],
  };
  assert.equal(classifyExactPrintPayload(signedWithEvidence).proven, true,
    'a signed printing that proves its own exact product path must not be refused for being SEC');
  // …and a SEC row WITHOUT that evidence still fails closed — on its own
  // evidence, under the reason that evidence derives.
  const placeholder = 'https://card.yuyu-tei.jp/noimage_100_140.jpg';
  assert.equal(classifyExactPrintPayload({
    ...signedWithEvidence,
    yuyuImage: placeholder,
    prices: [{ name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800, rarity: '', imageUrl: placeholder }],
  }).reason, 'no-yuyu-image-provenance', 'no provenance still fails closed');
  // A plain printing on a SEC-rarity row is likewise judged on its own image.
  assert.equal(classifyExactPrintPayload({
    ...signedWithEvidence, yuyuName: 'ラプラス・ダークネス', sellPrice: 980,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/9.jpg',
    prices: [{ name: 'ラプラス・ダークネス', sellPrice: 980, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/9.jpg' }],
  }).reason, 'cross-product-image', 'a foreign image is cross-product, not "signed"');
});

check('synthetic edge reasons: noimage placeholder and missing sourceProduct', () => {
  assert.equal(classifyExactPrintPayload({
    id: 'x', cardNumber: 'hBP09-099', rarity: 'RR', sourceProduct: 'hBP09',
    sellPrice: 100, yuyuImage: 'https://card.yuyu-tei.jp/noimage_100_140.jpg', prices: [],
  }).reason, 'no-yuyu-image-provenance');
  assert.equal(classifyExactPrintPayload({
    id: 'x', cardNumber: 'hBP09-099', rarity: 'RR', sourceProduct: '',
    sellPrice: 100, yuyuImage: '', prices: [],
  }).reason, 'missing-source-product');
  assert.equal(classifyExactPrintPayload({ sellPrice: null }).reason, 'unpriced');
});

// ─── 2. the hard gate over the REAL production sequence ──────────────────
check('production sequence: the candidate artifact is refused (29 uncovered losses)', () => {
  const gate = evaluatePriceRegressionGate({
    previousCards: fixture.baselineCards,
    nextCards: fixture.candidateCards,
    rejections: [],
    // The candidate WAS a fresh scrape of every printing it kept — but the
    // lost hBD24 printings still count as silent priced-row losses.
    freshlyScrapedPrintingIds: new Set(
      Object.entries(fixture.candidateCards).filter(([, c]) => isPricedRow(c)).map(([id]) => id),
    ),
  });
  assert.equal(gate.ok, false);
  const lost = gate.violations.filter((v) => v.kind === 'priced-row-lost');
  assert.equal(lost.length, 29, `expected 29 uncovered losses, got ${lost.length}`);
});

check('blanket rejections cannot rubber-stamp a collapse (mutation sensitivity)', () => {
  const blanket = fixture.lostHBD24Ids.map((id) => ({ id, reason: 'cross-product-image' }));
  const gate = evaluatePriceRegressionGate({
    previousCards: fixture.baselineCards,
    nextCards: fixture.candidateCards,
    rejections: blanket,
  });
  assert.equal(gate.ok, false, 'proven payloads must not be rejectable');
  assert.ok(gate.violations.every((v) => v.kind === 'rejection-not-verifiable'));
});

check('unknown rejection reasons are violations', () => {
  const previousCards = { a: { id: 'a', cardNumber: 'hBP01-001', rarity: 'C', sourceProduct: 'hBP01', sellPrice: 100, yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/1.jpg', prices: [] } };
  const nextCards = { a: { ...previousCards.a, sellPrice: null } };
  const gate = evaluatePriceRegressionGate({
    previousCards, nextCards, rejections: [{ id: 'a', reason: 'because-i-said-so' }],
  });
  assert.equal(gate.ok, false);
});

check('a verifiable rejection covers the decrease', () => {
  const prev = {
    id: 'bad', cardNumber: 'hBP04-028', rarity: 'C', sourceProduct: 'hBP08',
    sellPrice: 30, yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10058.jpg', prices: [],
  };
  const previousCards = { bad: prev };
  const nextCards = { bad: { ...prev, sellPrice: null, yuyuImage: '', prices: [] } };
  const uncovered = evaluatePriceRegressionGate({ previousCards, nextCards, rejections: [] });
  assert.equal(uncovered.ok, false);
  const covered = evaluatePriceRegressionGate({
    previousCards, nextCards, rejections: [makeRejection('bad', prev, 'cross-product-image')],
  });
  assert.equal(covered.ok, true);
});

check('ambiguity and removal reasons verify against context, not claims', () => {
  const prev = {
    id: 'p', cardNumber: 'hSD03-002', rarity: 'P', sourceProduct: 'hPR',
    sellPrice: 500, yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10020.jpg', prices: [],
  };
  const previousCards = { p: prev };
  const nulled = { p: { ...prev, sellPrice: null, yuyuImage: '', prices: [] } };
  const claimedOnly = evaluatePriceRegressionGate({
    previousCards, nextCards: nulled, rejections: [{ id: 'p', reason: 'ambiguous-promo-identity' }],
  });
  assert.equal(claimedOnly.ok, false, 'ambiguity claim without the ambiguous set must fail');
  const verified = evaluatePriceRegressionGate({
    previousCards, nextCards: nulled,
    rejections: [{ id: 'p', reason: 'ambiguous-promo-identity' }],
    ambiguousIds: new Set(['p']),
  });
  assert.equal(verified.ok, true);
  const removedUncovered = evaluatePriceRegressionGate({ previousCards, nextCards: {}, rejections: [] });
  assert.equal(removedUncovered.ok, false);
  const removedWithoutEvidence = evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections: [{ id: 'p', reason: 'printing-removed-from-catalog' }],
  });
  assert.equal(removedWithoutEvidence.ok, false,
    'a removal label with no independently derived removal set must not verify');
  const removedCovered = evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections: [{ id: 'p', reason: 'printing-removed-from-catalog' }],
    removedIds: new Set(['p']),
  });
  assert.equal(removedCovered.ok, true);
  const prunedWithoutSet = evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections: [{ id: 'p', reason: 'pruned-not-in-official-catalog' }],
  });
  assert.equal(prunedWithoutSet.ok, false, 'a prune label with no pruned set must not verify');
  const prunedCovered = evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections: [{ id: 'p', reason: 'pruned-not-in-official-catalog' }],
    prunedIds: new Set(['p']),
  });
  assert.equal(prunedCovered.ok, true);
  const fakeRemoval = evaluatePriceRegressionGate({
    previousCards, nextCards: nulled, rejections: [{ id: 'p', reason: 'printing-removed-from-catalog' }],
  });
  assert.equal(fakeRemoval.ok, false, 'removal claim while the row still exists must fail');
});

check('entry decreases: fresh scrape or per-entry cross-product proof, never silent', () => {
  const goodEntry = { name: 'a', sellPrice: 100, rarity: 'RR', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp09/1.jpg' };
  const foreignEntry = { name: 'b', sellPrice: 50, rarity: 'C', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/2.jpg' };
  const prev = { id: 'e', cardNumber: 'hBP09-010', rarity: 'RR', sourceProduct: 'hBP09', sellPrice: 100, yuyuImage: goodEntry.imageUrl, prices: [goodEntry, foreignEntry] };
  const previousCards = { e: prev };
  // (a) foreign entry filtered out — auto-allowed per-entry proof.
  const filtered = { e: { ...prev, prices: [goodEntry] } };
  assert.equal(evaluatePriceRegressionGate({ previousCards, nextCards: filtered, rejections: [] }).ok, true);
  // (b) the PROVEN entry dropped — no proof, no fresh scrape → violation.
  const silent = { e: { ...prev, prices: [foreignEntry] } };
  assert.equal(evaluatePriceRegressionGate({ previousCards, nextCards: silent, rejections: [] }).ok, false);
  // (c) same drop under a fresh scrape of that exact printing → the source's claim.
  assert.equal(evaluatePriceRegressionGate({
    previousCards, nextCards: silent, rejections: [],
    freshlyScrapedPrintingIds: new Set(['e']),
  }).ok, true);
  // (d) freshness is keyed by printing id, so the row's cardNumber is not a key.
  assert.equal(evaluatePriceRegressionGate({
    previousCards, nextCards: silent, rejections: [],
    freshlyScrapedPrintingIds: new Set(['hBP09-010']),
  }).ok, false, 'a cardNumber must never act as a freshness key');
});

// ─── 2b. DIC-1484 CR blockers: the two gate bypasses ─────────────────────
// Both were reproduced directly against the shipped gate on PR #214 head
// 842c4167a. They are regression-pinned here per the CR's request.
check('CR blocker 1: a removal label cannot self-authorize deleting a proven priced row', () => {
  const listing = 'https://card.yuyu-tei.jp/hocg/100_140/hbp09/10001.jpg';
  const proven = {
    id: 'hBP09-001_hBP09_OSR', cardNumber: 'hBP09-001', rarity: 'OSR', sourceProduct: 'hBP09',
    sellPrice: 480, yuyuName: 'x', yuyuImage: listing,
    prices: [{ name: 'x', sellPrice: 480, rarity: '', imageUrl: listing }],
  };
  assert.equal(classifyExactPrintPayload(proven).proven, true, 'precondition: the row is exact-print proven');
  const previousCards = { [proven.id]: proven };
  const rejections = [makeRejection(proven.id, proven, 'printing-removed-from-catalog')];
  // The exact CR reproduction: a rebuild drops the proven row, then labels its
  // own casualty "removed". Absence from the rebuilt map is the same fact the
  // label asserts, so it must not verify it.
  const selfAuthorized = evaluatePriceRegressionGate({ previousCards, nextCards: {}, rejections });
  assert.equal(selfAuthorized.ok, false,
    'a caller-generated removal label must not authorize deleting a proven priced row');
  assert.ok(selfAuthorized.violations.every((v) => v.kind === 'rejection-not-verifiable'));
  assert.equal(selfAuthorized.before.pricedRows, 1);
  assert.equal(selfAuthorized.after.pricedRows, 0);
  // Evidence derived for a DIFFERENT printing does not cover this one.
  assert.equal(evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections, removedIds: new Set(['hBP09-002_hBP09_OSR']),
  }).ok, false, 'removal evidence for another printing must not cover this one');
  // Independently derived evidence for THIS printing does.
  assert.equal(evaluatePriceRegressionGate({
    previousCards, nextCards: {}, rejections, removedIds: new Set([proven.id]),
  }).ok, true);
});

check('CR blocker 2: cardNumber-wide freshness cannot hide a sibling printing\'s entry loss', () => {
  // One cardNumber, two printings from different products — the shape the
  // cardNumber-wide waiver could not tell apart.
  const plainListing = 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/1.jpg';
  const reprintA = { name: 'b', sellPrice: 200, rarity: 'C', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp08/2.jpg' };
  const reprintB = { name: 'c', sellPrice: 300, rarity: 'C', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp08/3.jpg' };
  const plain = {
    id: 'hBP01-001_hBP01_C', cardNumber: 'hBP01-001', rarity: 'C', sourceProduct: 'hBP01',
    sellPrice: 100, yuyuImage: plainListing,
    prices: [{ name: 'a', sellPrice: 100, rarity: 'C', imageUrl: plainListing }],
  };
  const reprint = {
    id: 'hBP01-001_hBP08_C', cardNumber: 'hBP01-001', rarity: 'C', sourceProduct: 'hBP08',
    sellPrice: 200, yuyuImage: reprintA.imageUrl, prices: [reprintA, reprintB],
  };
  const previousCards = { [plain.id]: plain, [reprint.id]: reprint };
  // The hBP08 printing silently loses a source-proven entry; only the hBP01
  // printing was freshly scraped.
  const nextCards = { [plain.id]: { ...plain }, [reprint.id]: { ...reprint, prices: [reprintA] } };
  const hidden = evaluatePriceRegressionGate({
    previousCards, nextCards, rejections: [], freshlyScrapedPrintingIds: new Set([plain.id]),
  });
  assert.equal(hidden.ok, false,
    'a fresh scrape of the hBP01 printing must not waive entry loss on the hBP08 printing');
  assert.equal(hidden.violations[0].kind, 'price-entries-decreased');
  assert.equal(hidden.before.priceEntries, 3);
  assert.equal(hidden.after.priceEntries, 2);
  // The waiver applies only to the printing the source actually re-listed.
  assert.equal(evaluatePriceRegressionGate({
    previousCards, nextCards, rejections: [], freshlyScrapedPrintingIds: new Set([reprint.id]),
  }).ok, true, 'freshness on the losing printing itself is the source\'s own claim');
});

check('CR blocker 3: the price recovery rewrites price fields only — no localImage drift', () => {
  const listing = 'https://card.yuyu-tei.jp/hocg/100_140/hbp09/10050.jpg';
  const current = {
    x: {
      id: 'x', cardNumber: 'hBP09-050', rarity: 'OSR', sourceProduct: 'hBP09',
      sellPrice: null, yuyuName: '', yuyuImage: '', timestamp: '', prices: [], localImage: '',
    },
  };
  const candidate = {
    x: {
      id: 'x', cardNumber: 'hBP09-050', rarity: 'OSR', sourceProduct: 'hBP09',
      sellPrice: 620, yuyuName: 'y', yuyuImage: listing, timestamp: '2026-09-19T00:00:00.000Z',
      prices: [{ name: 'y', sellPrice: 620, rarity: '', imageUrl: listing }],
      localImage: '/images/hBP09-050.jpg',
    },
  };
  const result = recoverExactPrintPrices(current, clone(candidate));
  assert.equal(result.accepted.length, 1, 'the proven price must still be recovered');
  assert.ok(isPricedRow(current.x), 'the row must be priced after recovery');
  assert.equal(current.x.localImage, '',
    'localImage is build-database Step 2 territory; the price recovery must not backfill it');
  // …and the same invariant over the real production-sequence fixture.
  const real = clone(fixture.baselineCards);
  const before = Object.fromEntries(Object.entries(real).map(([id, c]) => [id, c.localImage ?? null]));
  recoverExactPrintPrices(real, clone(fixture.candidateCards));
  for (const [id, card] of Object.entries(real)) {
    assert.equal(card.localImage ?? null, before[id], `${id} localImage must be untouched by the recovery`);
  }
});

// ─── 3. last-known-good preservation over the real sequence ──────────────
function freshRebuildRow(card) {
  return {
    ...clone(card),
    sellPrice: null, yuyuName: '', yuyuImage: '', timestamp: '', prices: [], _rawPricesArchive: [],
    priceHistory: undefined,
  };
}
function replayHealthyScrapePreservation(prevCards) {
  // Exactly the build-database.js wiring: a healthy scrape rebuilt every row
  // with no yuyu payload (the listing rotated out), and preservation runs
  // per-row with the DIC-1482 strict extension.
  const next = {};
  for (const [id, prev] of Object.entries(prevCards)) {
    const fresh = freshRebuildRow(prev);
    const hasCurrentYuyuPayload = false; // healthy scrape found nothing for these rows
    applyPreservedMarketFields(fresh, prev, {
      matchKind: 'exact-id',
      preserveYuyuPayload: hasCurrentYuyuPayload || classifyExactPrintPayload(prev).proven,
    });
    next[id] = fresh;
  }
  return next;
}

check('healthy-scrape replay preserves all 29 hBD24 last-known-good payloads', () => {
  const baseline = Object.fromEntries(fixture.lostHBD24Ids.map((id) => [id, clone(fixture.baselineCards[id])]));
  const preserved = replayHealthyScrapePreservation(baseline);
  for (const id of fixture.lostHBD24Ids) {
    assert.equal(preserved[id].sellPrice, baseline[id].sellPrice, `${id} sellPrice`);
    assert.equal(preserved[id].yuyuImage, baseline[id].yuyuImage, `${id} yuyuImage`);
  }
  const gate = evaluatePriceRegressionGate({ previousCards: baseline, nextCards: preserved, rejections: [] });
  assert.equal(gate.ok, true, 'preservation must leave no uncovered decrease');
  assert.equal(gate.after.pricedRows, gate.before.pricedRows);
});

check('preservation is a fixed point — no 0↔N snapshot oscillation', () => {
  const baseline = Object.fromEntries(fixture.lostHBD24Ids.map((id) => [id, clone(fixture.baselineCards[id])]));
  const once = replayHealthyScrapePreservation(baseline);
  const twice = replayHealthyScrapePreservation(once);
  for (const id of fixture.lostHBD24Ids) {
    assert.equal(twice[id].sellPrice, once[id].sellPrice, `${id} oscillated`);
    assert.deepEqual(twice[id].prices, once[id].prices, `${id} prices oscillated`);
  }
});

check('unproven payloads are NOT preserved and land as verifiable rejections', () => {
  const prev = {
    id: 'bad', cardNumber: 'hBP04-028', rarity: 'C', sourceProduct: 'hBP08',
    sellPrice: 30, yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10058.jpg',
    prices: [{ name: 'x', sellPrice: 30, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10058.jpg' }],
  };
  const fresh = freshRebuildRow(prev);
  const verdict = classifyExactPrintPayload(prev);
  assert.equal(verdict.proven, false);
  applyPreservedMarketFields(fresh, prev, { matchKind: 'exact-id', preserveYuyuPayload: verdict.proven });
  assert.equal(fresh.sellPrice, null, 'DIC-1167 stays in force for unproven payloads');
  const gate = evaluatePriceRegressionGate({
    previousCards: { bad: prev }, nextCards: { bad: fresh },
    rejections: [makeRejection('bad', prev, verdict.reason)],
  });
  assert.equal(gate.ok, true);
});

// ─── 4. recovery over the real sequence ──────────────────────────────────
check('recovery adopts proven hBP09 payloads, refuses the three exemplars, keeps hBD24 intact', () => {
  const current = clone(fixture.baselineCards);
  const result = recoverExactPrintPrices(current, clone(fixture.candidateCards));
  const acceptedIds = new Set(result.accepted.map((a) => a.id));
  for (const id of fixture.hbp09SampleIds) {
    assert.ok(acceptedIds.has(id), `${id} must be recovered`);
    assert.ok(isPricedRow(current[id]), `${id} must be priced after recovery`);
    assert.ok((current[id].prices || []).every((e) => e.buyPrice === undefined), `${id} buy fields must be stripped`);
  }
  const rejectedById = new Map(result.rejected.map((r) => [r.id, r.reason]));
  assert.equal(rejectedById.get('hBD24-064_ent07'), 'cross-product-image');
  assert.equal(rejectedById.get('hBP01-081_hCS01_SR_hBP01-081_02_SR'), 'cross-product-image');
  assert.equal(rejectedById.get('hBP09-004_hBP09_SEC_hBP09-004_SEC'), 'no-yuyu-image-provenance');
  for (const id of fixture.lostHBD24Ids) {
    assert.deepEqual(current[id], fixture.baselineCards[id], `${id} must be untouched by recovery`);
  }
  const preserved = result.regressions.filter((r) => r.decision === 'preserved-last-known-good');
  assert.equal(preserved.length, 29, 'all 29 hBD24 regressions classify as preserved-last-known-good');
  const gate = evaluatePriceRegressionGate({
    previousCards: fixture.baselineCards, nextCards: current, rejections: result.rejected,
  });
  assert.equal(gate.ok, true);
  assert.ok(gate.after.pricedRows > gate.before.pricedRows, 'recovery must be a strict increase here');
});

check('recovery is idempotent (fixed point)', () => {
  const current = clone(fixture.baselineCards);
  recoverExactPrintPrices(current, clone(fixture.candidateCards));
  const snapshot = clone(current);
  const second = recoverExactPrintPrices(current, clone(fixture.candidateCards));
  assert.deepEqual(current, snapshot, 'second run must not change any card');
  assert.equal(second.accepted.length, 0, 'nothing left to adopt on the second run');
});

// ─── 5. canonical/public/native fixed-point parity ───────────────────────
check('sanitizeDatabase keeps priced metrics identical and is a fixed point', () => {
  const current = clone(fixture.baselineCards);
  recoverExactPrintPrices(current, clone(fixture.candidateCards));
  const canonical = { lastUpdated: 'x', totalCards: Object.keys(current).length, cards: current };
  const publicDb = sanitizeDatabase(canonical);
  assert.deepEqual(priceMetrics(publicDb.cards), priceMetrics(canonical.cards),
    'sanitize must not change pricedRows / pricedUniqueCardNumbers / priceEntries');
  const once = JSON.stringify(publicDb);
  const twice = JSON.stringify(sanitizeDatabase(JSON.parse(once)));
  assert.equal(twice, once, 'sanitize∘sanitize must equal sanitize (fixed point)');
});

check('committed public/native artifact equals sanitized canonical byte-for-byte', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'database.json'), 'utf8'));
  const expected = JSON.stringify(sanitizeDatabase(canonical));
  const actual = fs.readFileSync(path.join(repoRoot, 'public', 'data', 'database.json'), 'utf8');
  assert.equal(actual, expected, 'public/data/database.json must be sanitizeDatabase(data/database.json)');
  assert.deepEqual(priceMetrics(JSON.parse(actual).cards), priceMetrics(canonical.cards),
    'canonical and shipped public/native priced metrics must be identical');
});

check('committed rejection manifest is schema-valid with recognised reasons only', () => {
  const manifestPath = path.join(repoRoot, 'data', 'price-rejections.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schema, PRICE_REJECTION_MANIFEST_SCHEMA);
  const known = new Set([...PROVENANCE_REJECTION_REASONS, ...CONTEXT_REJECTION_REASONS]);
  for (const rejection of manifest.rejections) {
    assert.ok(known.has(rejection.reason), `unknown manifest reason ${rejection.reason}`);
    assert.ok(rejection.id && typeof rejection.evidence === 'object', 'rejection must carry id + evidence');
  }
});

check('manifest builder reports before/after metrics and deltas', () => {
  const manifest = buildPriceRejectionManifest({
    label: 'test', previousCards: fixture.baselineCards, nextCards: fixture.candidateCards, rejections: [],
  });
  assert.equal(manifest.schema, PRICE_REJECTION_MANIFEST_SCHEMA);
  assert.deepEqual(manifest.before, priceMetrics(fixture.baselineCards));
  assert.deepEqual(manifest.after, priceMetrics(fixture.candidateCards));
  assert.equal(manifest.deltas.pricedRows, manifest.after.pricedRows - manifest.before.pricedRows);
  assert.equal(manifest.deltas.priceEntries, manifest.after.priceEntries - manifest.before.priceEntries);
});

console.log(`\n✅ dic1482 price-regression gate: ${passed} checks passed`);
