#!/usr/bin/env node
/**
 * test-dic1167-price-coverage-reconciliation.mjs — DIC-1167 (2026-09-28).
 *
 * The 2026-09-28 scrape freshly listed 1,331 cardNumbers; the build exited 0
 * printing "1260 freshly-proven (1289 incl. preservation); 45 not priced"
 * while it actually shipped 1259 / 1288, and 71 yuyu-only fallback refusals
 * existed only as console lines. This regression pins, red-before-green:
 *
 *   1. Every refused listing set is recorded per cardNumber in
 *      data/price-rejections.json `listingRefusals`, with its candidate
 *      official printings (the hY01-001 nine-printing shape and the hBD24
 *      promo shape), and refused prices stay null.
 *   2. A refused cardNumber that keeps its own last source-proven payload
 *      (hBD24-001 hPR/P) is reported as preserved — never as a loss.
 *   3. The DIC-1334 audit reports the SHIPPED coverage: hBD24-064's only
 *      priced row (hBD24-064_ent07, cross-product promo-hbd20 image) is
 *      stripped before the audit, so "total incl. preservation" equals the
 *      manifest's `after.pricedUniqueCardNumbers` (was off by one).
 *   4. The scraped-vs-shipped reconciliation accounts for every scraped
 *      cardNumber, and a scraped positive-price cardNumber that ships
 *      unpriced with no recorded reason fails closed.
 *   5. CR 1924ef80: accounting is per exact printing (compound-key row id).
 *      A priced sibling — fresh or preserved — never masks a printing this
 *      scrape priced and then lost, nor a positive listing that was neither
 *      matched to a printing nor refused.
 *   6. CR 81802b00: a printing a POSITIVE listing matched that received no
 *      fresh price is ledgered too — behind a fresh or preserved sibling it
 *      fails closed unless a per-printing disposition is recorded
 *      (`printingListingRefusals`, e.g. a retired pre-errata price the
 *      canonical rows drop). A non-positive match never stands in for a
 *      positive listing, and never false-positives on its own.
 *   7. CR e0a089af: every positive LISTING is accounted for individually. A
 *      proven positive listing that priced one printing (U ¥100) never masks a
 *      sibling positive listing that proved to no printing (SR ¥2,480): it
 *      must be named (`refusedListingIds`) by a durable `listingRefusals`
 *      record, or the cardNumber is unaccounted and the build fails.
 *   8. CR 4132f98e: raw alias keys of one yuyu-only cardNumber (hZZ01-14 /
 *      hZZ01-014) are one listing set. Both positive listings land on the one
 *      canonical row — the later alias never overwrites the earlier price
 *      while both are counted as matched.
 *
 * Fixture listings for hY01-001 / hBD24-001 / hBD24-018 / hBD24-064 are the
 * real yuyu-tei rows captured by the 2026-09-26 scrape.
 *
 * Run: node scripts/test-dic1167-price-coverage-reconciliation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  reconcileScrapedCoverage,
  reconciliationManifestBlock,
  formatReconciliationFailure,
  scrapedListingId,
} from './lib/price-coverage-reconciliation.mjs';
import { canonicalizeCardNumber } from './lib/card-number.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

// ── Unit: pure reconciliation ─────────────────────────────────────────────
{
  const listing = (sellPrice) => [{ sellPrice, rarity: 'C', yuyuImage: '' }];
  const prices = {
    'hA01-001': listing(100), // fresh
    'hA01-002': listing(100), // preserved (not fresh)
    'hA01-003': listing(100), // refused by fallback, unpriced
    'hA01-004': listing(100), // refused increase
    'hA01-005': listing(100), // ambiguity nulled
    'hA01-006': listing(0), //   no positive sell listing
    'hA01-007': listing(100), // silent loss
    'hA01-08': listing(0), //    short suffix — merges with hA01-008 below
    'hA01-008': listing(100), // refused by fallback but preserved
  };
  const cards = {
    a1: { cardNumber: 'hA01-001', sellPrice: 100 },
    a2: { cardNumber: 'hA01-002', sellPrice: 90 },
    a3: { cardNumber: 'hA01-003', sellPrice: null },
    a4: { cardNumber: 'hA01-004', sellPrice: null },
    a5: { cardNumber: 'hA01-005', sellPrice: null },
    a6: { cardNumber: 'hA01-006', sellPrice: null },
    a7: { cardNumber: 'hA01-007', sellPrice: null },
    a8: { cardNumber: 'hA01-008', sellPrice: 70 },
  };
  const base = {
    prices,
    canonicalizeCardNumber,
    cards,
    freshlyPricedRowIds: new Set(['a1', 'a4']),
    // a2's positive listing matched its exact printing but produced no
    // positive canonical price; the per-printing record explains it, so its
    // preserved price is not standing in for an unhandled listing.
    positiveListingRowIds: new Set(['a1', 'a2', 'a4']),
    printingListingRefusals: new Map([['a2', { reason: 'no-positive-canonical-price' }]]),
    // Every positive listing that reached an exact printing (hA01-005's was
    // matched, then ambiguity-nulled); hA01-007's reached nothing.
    matchedListingIds: new Set(['hA01-001#0', 'hA01-002#0', 'hA01-004#0', 'hA01-005#0']),
    listingRefusals: new Map([
      ['hA01-003', { refusedListingIds: ['hA01-003#0'] }],
      ['hA01-008', { refusedListingIds: ['hA01-008#0'] }],
    ]),
    increaseRejections: [{ id: 'a4', cardNumber: 'hA01-004' }],
    ambiguityNulledIds: new Set(['a5']),
  };
  const r = reconcileScrapedCoverage(base);
  assert.equal(r.scrapedCardNumbers, 8, 'raw keys canonicalizing to one cardNumber count once');
  assert.deepEqual(r.categories.fresh, ['hA01-001']);
  assert.deepEqual(r.categories.preserved, ['hA01-002', 'hA01-008']);
  assert.deepEqual(r.preservedAfterFallbackRefusal, ['hA01-008']);
  assert.deepEqual(r.categories.refusedFallback, ['hA01-003']);
  assert.deepEqual(r.categories.refusedIncrease, ['hA01-004'], 'a fresh row stripped by the increase gate is not fresh');
  assert.deepEqual(r.categories.ambiguityNulled, ['hA01-005']);
  assert.deepEqual(r.categories.noSellListing, ['hA01-006']);
  assert.deepEqual(r.categories.unaccounted, ['hA01-007']);
  assert.equal(r.ok, false, 'a scraped positive-price cardNumber lost without a reason must fail closed');
  assert.match(formatReconciliationFailure(r), /1 scraped cardNumber\(s\).*hA01-007/);
  assert.equal(r.pricedCardNumbers + r.unpricedCardNumbers, r.scrapedCardNumbers, 'categories partition the scraped set');

  // Removing the refusal record turns a lawful refusal into a silent loss.
  const withoutRefusal = reconcileScrapedCoverage({ ...base, listingRefusals: new Map([['hA01-008', { refusedListingIds: ['hA01-008#0'] }]]) });
  assert.ok(withoutRefusal.categories.unaccounted.includes('hA01-003'));

  // Once the loss is accounted for, the reconciliation passes.
  const clean = reconcileScrapedCoverage({
    ...base,
    prices: Object.fromEntries(Object.entries(prices).filter(([k]) => k !== 'hA01-007')),
  });
  assert.equal(clean.ok, true);
  const block = reconciliationManifestBlock(clean);
  assert.equal(block.counts.unaccounted, 0);
  assert.equal(block.fresh, undefined, 'the manifest block does not enumerate fresh cardNumbers');
  assert.equal(reconciliationManifestBlock(null), null);
  assert.deepEqual(clean.printingLedger, {
    freshlyPriced: 2,
    positiveListingUnpriced: 1, // a2
    shippedPriced: 1,
    refusedIncrease: 1,
    ambiguityNulled: 0,
    refusedListing: 1, // a2
    unaccounted: 0,
  });
  // Without a2's per-printing record its matched positive listing is a loss,
  // even though a preserved price still ships on that very row.
  const noPrintingRecord = reconcileScrapedCoverage({
    ...base,
    prices: Object.fromEntries(Object.entries(prices).filter(([k]) => k !== 'hA01-007')),
    printingListingRefusals: new Map(),
  });
  assert.deepEqual(noPrintingRecord.unaccountedPrintings, ['a2']);
  assert.equal(noPrintingRecord.ok, false);
  assert.deepEqual(block.unaccountedPrintings, []);
  console.log('  ✓ unit: reconciliation partitions the scraped set and fails closed on a silent loss');
}

// ── Unit: exact-printing accounting (CR 1924ef80) ─────────────────────────
// A priced sibling must never mask a lost exact printing. The accounting key is
// the compound-key row id (the official printing identity), not cardNumber.
{
  const listing = (sellPrice) => [{ sellPrice, rarity: 'P', yuyuImage: '' }];
  const P = 'hA01-009_hPR_P_hA01-009_P';
  const P02 = 'hA01-009_hPR_P_hA01-009_P_02';
  const refused = { refusedListingIds: ['hA01-009#0'] };
  const scenario = ({
    siblingFresh, lostFresh = true, positive, printingRefusals = new Map(),
    refusals = new Map(), increase = [], ambiguity = new Set(), sellPrice = 100, matched,
  }) => {
    const fresh = new Set();
    if (siblingFresh) fresh.add(P);
    if (lostFresh) fresh.add(P02);
    // The single listing reached an exact printing iff some printing was
    // freshly priced by, or positively matched to, it.
    const listingMatched = matched ?? (positive ?? fresh).size > 0;
    return reconcileScrapedCoverage({
      prices: { 'hA01-009': listing(sellPrice) },
      canonicalizeCardNumber,
      cards: {
        [P]: { cardNumber: 'hA01-009', sellPrice: 90 },
        [P02]: { cardNumber: 'hA01-009', sellPrice: null },
      },
      freshlyPricedRowIds: fresh,
      positiveListingRowIds: positive ?? fresh,
      matchedListingIds: new Set(listingMatched ? ['hA01-009#0'] : []),
      printingListingRefusals: printingRefusals,
      listingRefusals: refusals,
      increaseRejections: increase,
      ambiguityNulledIds: ambiguity,
    });
  };

  // 1. Freshly-priced sibling: P02 was priced by this scrape, then lost.
  const freshMask = scenario({ siblingFresh: true });
  assert.deepEqual(freshMask.categories.fresh, ['hA01-009'], 'the cardNumber bucket alone looks healthy');
  assert.deepEqual(freshMask.unaccountedPrintings, [P02], 'the lost exact printing is named by its row id');
  assert.equal(freshMask.ok, false, 'a fresh sibling must not mask a lost exact printing');
  assert.match(formatReconciliationFailure(freshMask), /1 exact printing\(s\) priced by, or matched to a positive listing of, this scrape shipped without a fresh price.*hA01-009_hPR_P_hA01-009_P_02/);
  assert.equal(freshMask.pricedCardNumbers + freshMask.unpricedCardNumbers, freshMask.scrapedCardNumbers);
  const pl = freshMask.printingLedger;
  assert.equal(pl.freshlyPriced, pl.shippedPriced + pl.refusedIncrease + pl.ambiguityNulled + pl.unaccounted,
    'the exact-printing ledger partitions every freshly-priced printing');

  // 2. Preserved sibling: same loss, the sibling priced only via preservation.
  const preservedMask = scenario({ siblingFresh: false });
  assert.deepEqual(preservedMask.categories.preserved, ['hA01-009']);
  assert.deepEqual(preservedMask.unaccountedPrintings, [P02]);
  assert.equal(preservedMask.ok, false, 'a preserved sibling must not mask a lost exact printing');

  // 3. Preserved sibling, positive listing that neither matched a printing nor
  //    was refused: the preserved price is not evidence the listing was handled.
  //    (A non-positive match of P02 is the same shape: positive = none.)
  const unhandled = scenario({ siblingFresh: false, lostFresh: false, positive: new Set() });
  assert.deepEqual(unhandled.categories.unaccounted, ['hA01-009']);
  assert.deepEqual(unhandled.categories.preserved, []);
  assert.equal(unhandled.ok, false);
  assert.match(formatReconciliationFailure(unhandled), /1 scraped cardNumber\(s\).*hA01-009/);
  // …but once the fallback refusal is recorded it is the lawful hBD24-001 shape.
  const refusedPreserved = scenario({ siblingFresh: false, lostFresh: false, positive: new Set(), refusals: new Map([['hA01-009', refused]]) });
  assert.equal(refusedPreserved.ok, true);
  assert.deepEqual(refusedPreserved.preservedAfterFallbackRefusal, ['hA01-009']);

  // 4. The same exact-printing drop is lawful only under a per-printing record.
  const stripped = scenario({ siblingFresh: true, increase: [{ id: P02, cardNumber: 'hA01-009' }] });
  assert.equal(stripped.ok, true);
  assert.equal(stripped.printingLedger.refusedIncrease, 1);
  const nulled = scenario({ siblingFresh: true, ambiguity: new Set([P02]) });
  assert.equal(nulled.ok, true);
  assert.equal(nulled.printingLedger.ambiguityNulled, 1);
  // A record for a DIFFERENT printing of the same cardNumber does not cover it.
  const wrongId = scenario({ siblingFresh: true, increase: [{ id: P, cardNumber: 'hA01-009' }] });
  assert.deepEqual(wrongId.unaccountedPrintings, [P02], 'rejection records are matched per printing, not per cardNumber');

  // 5. No false positive on unlisted siblings: a printing no listing proved to
  //    had no scraped price to lose (binding a sibling's listing is forbidden).
  const unlisted = scenario({ siblingFresh: true, lostFresh: false });
  assert.equal(unlisted.ok, true);
  assert.deepEqual(unlisted.unaccountedPrintings, []);
  console.log('  ✓ unit: exact-printing ledger — a priced sibling (fresh or preserved) never masks a lost printing');

  // 6. CR 81802b00: P02 matched a POSITIVE listing but was never freshly
  //    priced (so it is outside freshlyPricedRowIds) and ships null.
  //    a. behind a freshly-priced sibling
  const matchedFresh = scenario({ siblingFresh: true, lostFresh: false, positive: new Set([P, P02]) });
  assert.deepEqual(matchedFresh.categories.fresh, ['hA01-009'], 'the cardNumber bucket alone looks healthy');
  assert.deepEqual(matchedFresh.unaccountedPrintings, [P02], 'the matched-but-unpriced printing is named by its row id');
  assert.equal(matchedFresh.ok, false, 'a fresh sibling must not mask a matched-but-unpriced printing');
  assert.match(formatReconciliationFailure(matchedFresh), /1 exact printing\(s\) priced by, or matched to a positive listing of, this scrape.*hA01-009_hPR_P_hA01-009_P_02/);
  assert.equal(matchedFresh.printingLedger.positiveListingUnpriced, 1);
  //    b. behind a preserved sibling
  const matchedPreserved = scenario({ siblingFresh: false, lostFresh: false, positive: new Set([P02]) });
  assert.deepEqual(matchedPreserved.categories.preserved, ['hA01-009']);
  assert.deepEqual(matchedPreserved.unaccountedPrintings, [P02]);
  assert.equal(matchedPreserved.ok, false, 'a preserved sibling must not mask a matched-but-unpriced printing');
  //    c. lawful only under a per-printing disposition for THAT printing
  const disposed = scenario({
    siblingFresh: false, lostFresh: false, positive: new Set([P02]),
    printingRefusals: new Map([[P02, { reason: 'no-positive-canonical-price' }]]),
  });
  assert.equal(disposed.ok, true);
  assert.equal(disposed.printingLedger.refusedListing, 1);
  const siblingRecord = scenario({
    siblingFresh: false, lostFresh: false, positive: new Set([P02]),
    printingRefusals: new Map([[P, { reason: 'no-positive-canonical-price' }]]),
  });
  assert.deepEqual(siblingRecord.unaccountedPrintings, [P02], 'a sibling printing record never covers another printing');
  const cardNumberRecord = scenario({
    siblingFresh: false, lostFresh: false, positive: new Set([P02]), refusals: new Map([['hA01-009', refused]]),
  });
  assert.deepEqual(cardNumberRecord.unaccountedPrintings, [P02], 'a cardNumber refusal never covers a matched printing');
  const nulledMatch = scenario({ siblingFresh: true, lostFresh: false, positive: new Set([P, P02]), ambiguity: new Set([P02]) });
  assert.equal(nulledMatch.ok, true);
  assert.equal(nulledMatch.printingLedger.ambiguityNulled, 1);
  const lp = matchedFresh.printingLedger;
  assert.equal(lp.freshlyPriced + lp.positiveListingUnpriced,
    lp.shippedPriced + lp.refusedIncrease + lp.ambiguityNulled + lp.refusedListing + lp.unaccounted,
    'the ledger partitions every freshly-priced and positive-listing-matched printing');

  // 7. No false positive: a printing matched only by non-positive listings had
  //    no price to lose, behind either sibling shape.
  const zeroFresh = scenario({ siblingFresh: true, lostFresh: false, positive: new Set([P]) });
  assert.equal(zeroFresh.ok, true);
  assert.deepEqual(zeroFresh.unaccountedPrintings, []);
  const zeroPreserved = scenario({ siblingFresh: false, lostFresh: false, positive: new Set(), sellPrice: 0 });
  assert.equal(zeroPreserved.ok, true);
  assert.deepEqual(zeroPreserved.categories.preserved, ['hA01-009']);
  console.log('  ✓ unit: CR 81802b00 — a matched positive listing that yields no fresh price needs a per-printing disposition');
}

// ── Unit: per-listing accounting (CR e0a089af) ────────────────────────────
// The CR reproduction: the U listing (¥100) priced its exact printing; the SR
// listing (¥2,480) proved to no printing. Printing-level accounting sees only
// the U printing, so without a listing ledger this reconciled `ok: true`.
{
  const U = 'hBP01-045_hBP01_U_hBP01-045_U';
  const mixed = (extra = {}) => reconcileScrapedCoverage({
    prices: { 'hBP01-045': [{ sellPrice: 100, rarity: 'U' }, { sellPrice: 2480, rarity: 'SR' }] },
    canonicalizeCardNumber,
    cards: { [U]: { cardNumber: 'hBP01-045', sellPrice: 100 } },
    freshlyPricedRowIds: new Set([U]),
    positiveListingRowIds: new Set([U]),
    matchedListingIds: new Set(['hBP01-045#0']),
    ...extra,
  });
  assert.equal(scrapedListingId('hBP01-045', 1), 'hBP01-045#1');

  // 1. Unproven sibling positive listing with no refusal: fails closed, and the
  //    cardNumber is NOT a clean `fresh` despite its freshly-priced U printing.
  const silent = mixed();
  assert.equal(silent.ok, false, 'a proven positive sibling must not mask an unproven positive listing');
  assert.deepEqual(silent.unaccountedListings, ['hBP01-045#1']);
  assert.deepEqual(silent.categories.fresh, []);
  assert.deepEqual(silent.categories.unaccounted, ['hBP01-045']);
  assert.deepEqual(silent.unaccountedPrintings, [], 'the printing ledger alone cannot see it');
  assert.deepEqual(silent.listingLedger, { positiveListings: 2, matched: 1, refused: 0, unaccounted: 1 });
  assert.match(formatReconciliationFailure(silent), /1 scraped positive listing\(s\) neither matched an exact printing nor were named by a recorded refusal: hBP01-045#1/);
  assert.deepEqual(reconciliationManifestBlock(silent).unaccountedListings, ['hBP01-045#1']);

  // 2. A cardNumber refusal that does not NAME the listing does not cover it.
  const unnamed = mixed({ listingRefusals: new Map([['hBP01-045', { reason: 'positive-listings-unbound-priced-sibling' }]]) });
  assert.equal(unnamed.ok, false);
  assert.deepEqual(unnamed.unaccountedListings, ['hBP01-045#1']);
  const wrongListing = mixed({
    matchedListingIds: new Set(),
    listingRefusals: new Map([['hBP01-045', { refusedListingIds: ['hBP01-045#1'] }]]),
  });
  assert.deepEqual(wrongListing.unaccountedListings, ['hBP01-045#0'], 'a refusal names listings, never the whole cardNumber');

  // 3. Named by a durable refusal: lawful, and the U price stays fresh.
  const disposed = mixed({ listingRefusals: new Map([['hBP01-045', { refusedListingIds: ['hBP01-045#1'] }]]) });
  assert.equal(disposed.ok, true);
  assert.deepEqual(disposed.categories.fresh, ['hBP01-045']);
  assert.deepEqual(disposed.listingLedger, { positiveListings: 2, matched: 1, refused: 1, unaccounted: 0 });

  // 4. Fail-closed default: a caller that reports no matched listings gets
  //    every positive listing flagged, never a silent pass.
  const noLedger = mixed({ matchedListingIds: undefined });
  assert.deepEqual(noLedger.unaccountedListings, ['hBP01-045#0', 'hBP01-045#1']);
  assert.equal(noLedger.ok, false);
  // Non-positive listings are never ledgered.
  const zeroSibling = mixed({ prices: { 'hBP01-045': [{ sellPrice: 100, rarity: 'U' }, { sellPrice: 0, rarity: 'SR' }] } });
  assert.equal(zeroSibling.ok, true);
  assert.equal(zeroSibling.listingLedger.positiveListings, 1);
  console.log('  ✓ unit: CR e0a089af — every positive listing is matched or named by a refusal; a priced sibling never masks it');
}

// ── Integration: real build-database.js run on real-shape listings ────────
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const historyDir = path.join(repo, 'data/price-history');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const manifestPath = path.join(repo, 'data/price-rejections.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}
for (const p of [scrapeLogPath, manifestPath]) {
  if (fs.existsSync(p)) preRunBytes.set(p, fs.readFileSync(p));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1167-reconcile-'));
let passed = false;
try {
  const prevCards = JSON.parse(originalDb).cards;
  const row = (id) => prevCards[id];
  // Preconditions on the committed baseline the scenario relies on.
  assert.equal(row('hBD24-064_ent07')?.sellPrice ?? null, null, 'baseline: hBD24-064_ent07 unpriced');
  assert.ok(row('hBD24-001_hPR_P_hBD24-001_P')?.sellPrice > 0, 'baseline: hBD24-001 hPR/P priced (last-known-good)');
  assert.equal(row('hBD24-018_hPR_P_hBD24-018_P_02')?.sellPrice ?? null, null, 'baseline: hBD24-018 unpriced');
  const hy01Printings = Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === 'hY01-001');
  assert.ok(hy01Printings.length >= 6, `baseline: hY01-001 has many official printings (${hy01Printings.length})`);
  assert.ok(hy01Printings.every((id) => prevCards[id].sellPrice == null), 'baseline: hY01-001 unpriced');
  // hY01-014 has exactly one official printing; yuyu lists it as `hY01-14`.
  const noSellNum = 'hY01-014';
  const noSellRows = Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === noSellNum);
  assert.deepEqual(noSellRows, ['hY01-014_hEB01_SY_hY01-014_SY'], 'baseline: hY01-014 has one official printing');
  assert.equal(prevCards[noSellRows[0]].sellPrice ?? null, null, 'baseline: hY01-014 unpriced');
  // CR 81802b00 sibling pairs: the hBP01 printing priced (last-known-good), the
  // ent07 reprint unpriced.
  const retiredNum = 'hBP01-025';
  const retiredLost = 'hBP01-025_ent07';
  const retiredSibling = 'hBP01-025_hBP01_C_hBP01-025_C';
  const unprovenNum = 'hBP01-045';
  const unprovenZero = 'hBP01-045_ent07';
  const unprovenSibling = 'hBP01-045_hBP01_U_hBP01-045_U';
  for (const [num, lost, sib] of [[retiredNum, retiredLost, retiredSibling], [unprovenNum, unprovenZero, unprovenSibling]]) {
    assert.deepEqual(Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === num).sort(), [lost, sib].sort(),
      `baseline: ${num} has exactly the two sibling printings`);
    assert.ok(row(sib)?.sellPrice > 0, `baseline: ${sib} priced`);
    assert.equal(row(lost)?.sellPrice ?? null, null, `baseline: ${lost} unpriced`);
  }

  // CR e0a089af mixed proven/unproven sibling listings.
  const mixedNum = 'hBP03-025';
  const mixedPriced = 'hBP03-025_hBP03_C_hBP03-025_C';
  const mixedRows = Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === mixedNum);
  assert.ok(mixedRows.includes(mixedPriced), `baseline: ${mixedPriced} exists`);
  assert.ok(mixedRows.every((id) => prevCards[id].rarity !== 'SR'), `baseline: ${mixedNum} has no SR printing`);

  // CR 4132f98e alias pair: a cardNumber with no official printing at all.
  const aliasShort = 'hZZ01-14';
  const aliasNum = 'hZZ01-014';
  assert.equal(canonicalizeCardNumber(aliasShort), aliasNum);
  assert.ok(!Object.values(prevCards).some((c) => c.cardNumber === aliasNum) && !prevCards[aliasNum],
    `baseline: ${aliasNum} has no official or previous row`);

  const promo = (cid, sellPrice, name) => ({
    sellPrice, rarity: 'P', name,
    yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/promo-hbd20/${cid}.jpg`,
    imageVersion: 'promo-hbd20', imageCid: cid, sourceSeries: 'ent07', timestamp: '2026-09-26T12:26:08.033Z',
  });
  const fixture = {
    prices: {
      'hBD24-064': [promo('10064', 8980, '大神ミオ')],
      'hBD24-001': [promo('10001', 39800, 'パヴォリア・レイネ')],
      'hBD24-018': [promo('10018', 9980, 'アユンダ・リス')],
      'hY01-001': [{
        sellPrice: 120, rarity: 'S', name: '白エール(S仕様)',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/yell01/10065.jpg',
        imageVersion: 'yell01', imageCid: '10065', sourceSeries: 'hPC01', timestamp: '2026-09-26T12:26:33.037Z',
      }],
      // CR e0a089af: the C listing prices its exact hBP03 printing; the SR
      // listing (no official SR printing exists) proves to none. The priced
      // sibling skips the fallback, which must still refuse the SR listing.
      [mixedNum]: [
        {
          sellPrice: 500, rarity: 'C', name: 'hBP03-025',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp03/dic1167.jpg',
          imageVersion: 'hbp03', imageCid: 'dic1167', sourceSeries: 'hbp03', timestamp: '2026-09-28T00:00:00.000Z',
        },
        {
          sellPrice: 2480, rarity: 'SR', name: 'hBP03-025',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp03/dic1167sr.jpg',
          imageVersion: 'hbp03', imageCid: 'dic1167sr', sourceSeries: 'hbp03', timestamp: '2026-09-28T00:00:00.000Z',
        },
      ],
      // CR 81802b00 (a): a positive listing matches the ent07 printing, but
      // its only positive price sits on the retired pre-errata row; the
      // corrected row is unpriced, so the printing lawfully ships null — and
      // must say so per printing, behind its preserved hBP01 sibling.
      [retiredNum]: [
        {
          sellPrice: 300, rarity: 'C', name: 'ベスティア・ゼータ(エラッタ前)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/ent07/dic1167a.jpg',
          imageVersion: 'ent07', imageCid: 'dic1167a', sourceSeries: 'ent07', timestamp: '2026-09-28T00:00:00.000Z',
        },
        {
          sellPrice: 0, rarity: 'C', name: 'ベスティア・ゼータ(エラッタ後)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/ent07/dic1167b.jpg',
          imageVersion: 'ent07', imageCid: 'dic1167b', sourceSeries: 'ent07', timestamp: '2026-09-28T00:00:00.000Z',
        },
      ],
      // CR 81802b00 (b): only a zero-price listing proves to the ent07
      // printing; the positive listing (an SR no official printing carries)
      // proves to none. The zero-price match must not dispose of it.
      [unprovenNum]: [
        {
          sellPrice: 0, rarity: 'U', name: 'hBP01-045',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/ent07/dic1167c.jpg',
          imageVersion: 'ent07', imageCid: 'dic1167c', sourceSeries: 'ent07', timestamp: '2026-09-28T00:00:00.000Z',
        },
        {
          sellPrice: 2480, rarity: 'SR', name: 'hBP01-045',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/dic1167d.jpg',
          imageVersion: 'hbp01', imageCid: 'dic1167d', sourceSeries: 'hbp01', timestamp: '2026-09-28T00:00:00.000Z',
        },
      ],
      // CR 4132f98e: two raw alias keys of one truly yuyu-only cardNumber
      // (no official row), both positive. Per-raw-key processing let the
      // later alias (¥200) overwrite the earlier one (¥100) on the same row
      // while both listings stayed `matched`.
      [aliasShort]: [{
        sellPrice: 100, rarity: 'SR', name: 'AZKi',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hzz01/dic1167e.jpg',
        imageVersion: 'hzz01', imageCid: 'dic1167e', sourceSeries: 'hzz01', timestamp: '2026-09-28T00:00:00.000Z',
      }],
      [aliasNum]: [{
        sellPrice: 200, rarity: 'SR', name: 'AZKi',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hzz01/dic1167f.jpg',
        imageVersion: 'hzz01', imageCid: 'dic1167f', sourceSeries: 'hzz01', timestamp: '2026-09-28T00:00:00.000Z',
      }],
      // Short-suffix key, a listing with no positive sell price.
      'hY01-14': [{
        sellPrice: 0, rarity: 'SY', name: '白エール',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1167.jpg',
        imageVersion: 'heb01', imageCid: 'dic1167', sourceSeries: 'heb01', timestamp: '2026-09-28T00:00:00.000Z',
      }],
    },
    totalCards: 100,
    seriesWithPrices: 1,
  };
  const fixturePath = path.join(tmp, 'yuyu-dic1167-reconcile.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
    encoding: 'utf8',
  });
  const out = `${build.stdout}\n${build.stderr}`;
  assert.equal(build.status, 0, `fixture build must succeed\n${out}`);

  const cards = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const refusals = new Map((manifest.listingRefusals || []).map((r) => [r.cardNumber, r]));

  // 1. Refusals are durable, per cardNumber, with candidate printings; prices stay null.
  const hy = refusals.get('hY01-001');
  assert.ok(hy, 'hY01-001 listing refusal must be in the manifest');
  assert.equal(hy.reason, 'no-exact-printing-proven');
  assert.deepEqual([...hy.candidatePrintings].sort(), [...hy01Printings].sort(), 'refusal names every official candidate printing');
  assert.deepEqual(hy.listingImageProducts, ['yell01']);
  assert.deepEqual(hy.listingSellPrices, [120]);
  assert.ok(hy01Printings.every((id) => cards[id].sellPrice == null), 'hY01-001 printings stay null (no sibling fallback)');
  assert.equal(refusals.get('hBD24-018')?.reason, 'no-exact-printing-proven');
  assert.deepEqual(refusals.get('hBD24-018')?.candidatePrintings, ['hBD24-018_hPR_P_hBD24-018_P_02']);
  assert.equal(cards['hBD24-018_hPR_P_hBD24-018_P_02'].sellPrice, null);
  assert.ok(!(manifest.rejections || []).some((r) => r.id === 'hY01-001' || r.id === 'hBD24-018'),
    'listing refusals stay out of the per-printing rejections[] the DIC-1482 gate verifies');
  console.log('  ✓ fallback refusals recorded per cardNumber with candidate printings; refused prices stay null');

  // 2. Refused-but-preserved is preserved, not a loss.
  assert.ok(refusals.has('hBD24-001'), 'hBD24-001 refusal is recorded');
  assert.equal(cards['hBD24-001_hPR_P_hBD24-001_P'].sellPrice, row('hBD24-001_hPR_P_hBD24-001_P').sellPrice,
    'hBD24-001 keeps its own last source-proven price');
  assert.ok(manifest.coverage.preservedAfterFallbackRefusal.includes('hBD24-001'));
  assert.ok(!manifest.coverage.refusedFallback.includes('hBD24-001'));
  console.log('  ✓ refused-but-preserved cardNumber reported as preserved, not lost');

  // 3. The DIC-1334 audit reports what ships (post increase-strip).
  assert.ok((manifest.rejections || []).some((r) => r.id === 'hBD24-064_ent07' && r.reason === 'cross-product-image'),
    'hBD24-064_ent07 refused as cross-product-image');
  assert.equal(cards['hBD24-064_ent07'].sellPrice, null);
  assert.deepEqual(manifest.coverage.refusedIncrease, ['hBD24-064']);
  const audit = out.match(/\[DIC-1334\] final artifact keeps (\d+)\/(\d+) freshly-proven priced cardNumbers \((\d+) total incl\. preservation\)/);
  assert.ok(audit, `DIC-1334 audit line missing\n${out}`);
  assert.equal(Number(audit[3]), manifest.after.pricedUniqueCardNumbers,
    'DIC-1334 "total incl. preservation" must equal the shipped priced cardNumbers (post-strip)');
  assert.equal(Number(audit[1]), manifest.coverage.counts.fresh,
    'DIC-1334 freshly-proven coverage must exclude the stripped hBD24-064 row');
  const stripAt = out.indexOf('[DIC-1167] fail-closed 1 newly-priced row(s)');
  assert.ok(stripAt >= 0 && stripAt < out.indexOf('[DIC-1334] final artifact keeps'),
    'the increase strip must run before the DIC-1334 audit');
  console.log(`  ✓ DIC-1334 audit reports shipped coverage (${audit[1]} fresh / ${audit[3]} total = manifest)`);

  // 4. Full reconciliation of the scraped set.
  assert.deepEqual(manifest.coverage.counts, {
    fresh: 2, // hBP03-025, hZZ01-014 (scraped as hZZ01-14 + hZZ01-014)
    preserved: 3, // hBD24-001, hBP01-025, hBP01-045
    refusedFallback: 2, // hBD24-018, hY01-001
    refusedIncrease: 1, // hBD24-064
    ambiguityNulled: 0,
    noSellListing: 1, // hY01-014 (scraped as hY01-14)
    unaccounted: 0,
    preservedAfterFallbackRefusal: 2, // hBD24-001, hBP01-045
  });
  assert.equal(manifest.coverage.scrapedCardNumbers, 9, 'the hZZ01 alias pair counts once');
  assert.deepEqual(manifest.coverage.noSellListing, [noSellNum], 'short-suffix key reconciles under its canonical cardNumber');
  assert.equal(cards[noSellRows[0]].sellPrice ?? null, null, 'a zero-price listing publishes no price');
  assert.match(out, /\[DIC-1167\] price coverage reconciled: 9 scraped cardNumbers = 2 fresh \+ 3 preserved \(2 after fallback refusal\) \+ 2 refused-fallback \+ 1 refused-increase \+ 0 ambiguity-nulled \+ 1 no-sell-listing \+ 0 unaccounted; 5 listing refusal\(s\) recorded/);
  const builderSrc = fs.readFileSync(path.join(repo, 'scripts/build-database.js'), 'utf8');
  assert.match(builderSrc, /throw new Error\(formatReconciliationFailure\(coverageReconciliation\)\)/,
    'build-database.js must fail closed on an unreconciled scraped cardNumber');
  console.log('  ✓ scraped-vs-shipped reconciliation: 9 = 2 fresh + 3 preserved + 2 refused-fallback + 1 refused-increase + 1 no-sell-listing');

  // 5. Exact-printing ledger on the real build: hBP03-025 ships its fresh
  //    price, hBD24-064_ent07 is stripped by the increase gate — by row id.
  const pl = manifest.coverage.printingLedger;
  assert.equal(pl.unaccounted, 0);
  assert.deepEqual(manifest.coverage.unaccountedPrintings, []);
  assert.deepEqual(pl, {
    freshlyPriced: 3, // hBP03-025 + hZZ01-014 + hBD24-064_ent07
    positiveListingUnpriced: 1, // hBP01-025_ent07
    shippedPriced: 2, // hBP03-025 + hZZ01-014
    refusedIncrease: 1, // hBD24-064_ent07
    ambiguityNulled: 0,
    refusedListing: 1, // hBP01-025_ent07
    unaccounted: 0,
  });
  assert.match(out, new RegExp(`\\[DIC-1167\\] exact-printing ledger: ${pl.freshlyPriced} freshly-priced \\+ 1 positive-listing-unpriced printings = ${pl.shippedPriced} shipped priced \\+ 1 refused-increase \\+ 0 ambiguity-nulled \\+ 1 refused-listing \\+ 0 unaccounted`));
  console.log(`  ✓ exact-printing ledger: ${pl.freshlyPriced} freshly-priced + 1 positive-listing-unpriced = ${pl.shippedPriced} shipped + 1 refused-increase + 1 refused-listing + 0 unaccounted`);

  // 6. CR 81802b00 on the real build. (a) The matched positive listing whose
  //    only positive price was retired ships null with a durable per-printing
  //    disposition; its preserved sibling keeps its own price.
  assert.equal(cards[retiredLost].sellPrice, null, 'a retired pre-errata price never ships');
  assert.equal(cards[retiredSibling].sellPrice, row(retiredSibling).sellPrice, 'the hBP01 sibling keeps its own last source-proven price');
  assert.deepEqual(manifest.printingListingRefusals, [{
    id: retiredLost,
    cardNumber: retiredNum,
    reason: 'no-positive-canonical-price',
    listingSellPrices: [300, 0],
    canonicalSellPrices: [null],
  }], 'the matched-but-unpriced printing is recorded per printing, and nothing else is');
  assert.ok(manifest.coverage.preserved.includes(retiredNum));
  assert.ok(!(manifest.rejections || []).some((r) => r.id === retiredLost),
    'the per-printing disposition stays out of the DIC-1482 rejections[]');
  // (b) A zero-price match does not dispose of the positive listing: the
  //     fallback records the refusal, and the preserved sibling is lawful.
  const unproven = refusals.get(unprovenNum);
  assert.equal(unproven?.reason, 'positive-listings-unproven');
  assert.deepEqual(unproven.provenPrintings, [unprovenZero]);
  assert.deepEqual(unproven.listingSellPrices, [0, 2480]);
  assert.deepEqual(unproven.refusedListingIds, [`${unprovenNum}#1`], 'the refusal names the positive listing, not the bound zero-price one');
  assert.equal(cards[unprovenZero].sellPrice, null);
  assert.equal(cards[unprovenSibling].sellPrice, row(unprovenSibling).sellPrice);
  assert.ok(manifest.coverage.preservedAfterFallbackRefusal.includes(unprovenNum));
  console.log('  ✓ CR 81802b00: matched-but-unpriced printing carries a per-printing disposition; a zero-price match never disposes of a positive listing');

  // 7. CR e0a089af on the real build: the C listing ships its fresh price on
  //    its exact printing; the unproven SR listing is refused by listing id —
  //    no SR price is published anywhere.
  assert.equal(cards[mixedPriced].sellPrice, 500, 'the proven C listing prices its exact printing');
  assert.ok(Object.values(cards).filter((c) => c.cardNumber === mixedNum).every((c) => c.sellPrice !== 2480),
    'the unproven SR price is bound to no printing');
  const mixed = refusals.get(mixedNum);
  assert.equal(mixed?.reason, 'positive-listings-unbound-priced-sibling');
  assert.deepEqual(mixed.refusedListingIds, [`${mixedNum}#1`]);
  assert.deepEqual(mixed.provenPrintings, [mixedPriced]);
  assert.deepEqual(mixed.listingSellPrices, [500, 2480]);
  assert.ok(!manifest.coverage.preservedAfterFallbackRefusal.includes(mixedNum));
  assert.deepEqual(manifest.coverage.listingLedger, {
    // hBD24-064 + hBP03-025 C + hBP01-025 + both hZZ01 aliases matched;
    // hBD24-001, hBD24-018, hY01-001, hBP03-025 SR, hBP01-045 SR refused.
    positiveListings: 10, matched: 5, refused: 5, unaccounted: 0,
  });
  assert.deepEqual(manifest.coverage.unaccountedListings, []);
  assert.match(out, /\[DIC-1167\] listing ledger: 10 positive listings = 5 matched to an exact printing \+ 5 refused by listing id \+ 0 unaccounted/);
  for (const r of manifest.listingRefusals) {
    assert.ok(Array.isArray(r.refusedListingIds) && r.refusedListingIds.length > 0, `${r.cardNumber} refusal names its listings`);
  }
  console.log('  ✓ CR e0a089af: a priced sibling listing never masks an unproven positive listing — refused by listing id');

  // 8. CR 4132f98e on the real build: both positive alias listings survive on
  //    the one canonical yuyu-only row — the later alias never overwrites the
  //    earlier one — and the row ships the lowest of them.
  const aliasRows = Object.entries(cards).filter(([, c]) => c.cardNumber === aliasNum);
  assert.deepEqual(aliasRows.map(([id]) => id), [aliasNum], 'the alias pair publishes exactly one canonical row');
  const aliasRow = cards[aliasNum];
  assert.equal(aliasRow.sellPrice, 100, 'the earlier alias ¥100 listing is not overwritten by the later ¥200 one');
  assert.deepEqual(aliasRow.prices.map((p) => p.sellPrice).sort((a, b) => a - b), [100, 200],
    'every matched positive alias listing is on the shipped row');
  assert.ok(!refusals.has(aliasNum), 'a published alias pair needs no refusal');
  const builderSrcAlias = fs.readFileSync(path.join(repo, 'scripts/build-database.js'), 'utf8');
  assert.match(builderSrcAlias, /yuyu-only fallback would overwrite row/,
    'the fallback must refuse to write any row twice in one run');
  console.log('  ✓ CR 4132f98e: positive alias listings (hZZ01-14 / hZZ01-014) merge onto one row — none overwritten');

  console.log('✓ DIC-1167 price coverage reconciliation regression passed');
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  for (const f of fs.readdirSync(historyDir)) {
    const p = path.join(historyDir, f);
    if (!preRunBytes.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (passed) {
    const dirty = [];
    if (fs.readFileSync(dbPath, 'utf8') !== originalDb) dirty.push(dbPath);
    if (fs.readFileSync(publicDbPath, 'utf8') !== originalPublicDb) dirty.push(publicDbPath);
    for (const f of fs.readdirSync(historyDir)) {
      const p = path.join(historyDir, f);
      if (!preRunBytes.has(p)) dirty.push(`${p} (new)`);
    }
    for (const [p, bytes] of preRunBytes) {
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) dirty.push(p);
    }
    assert.deepEqual(dirty, [], `regression must be worktree-hermetic; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched tracked file restored byte-for-byte');
  }
}
