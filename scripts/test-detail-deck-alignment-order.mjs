#!/usr/bin/env node
/**
 * test-detail-deck-alignment-order.mjs — mutation-sensitive coverage for the
 * per-cardNumber row ordering that keeps CardDetail resolving the same default
 * printing as deck aggregation (DIC-1167).
 *
 * `verify-version-alignment.js` is the shipped contract: for every cardNumber
 * the first-seen row must resolve (via buildPriceVersions +
 * resolveVersionForCard) to the same printing that groupVariantsByCardNumber
 * exposes to the deck builder. That contract is data-level; this test is code-
 * level. It exercises `orderCardsForDetailAlignment` directly on the exact row
 * shape the shipped verify script consumes, so a mutation that flattens the
 * ranker or drops the origin-product priority is caught here before it can
 * ship a broken data/database.json.
 *
 * Mutation sensitivity: the fixture places the origin-product row SECOND in
 * insertion order, mirroring the daily-scrape regression (hBP08 HR reprint
 * lands first). The passing assertion requires the reorder to promote the
 * hBP01 base row to first. Any mutation that removes the origin-prefix rule
 * (e.g. always returning rank 0) leaves the reprint first and this test fails.
 */
import assert from 'node:assert/strict';
import {
  cardNumberOriginPrefix,
  detailAlignmentRowRank,
  orderCardsForDetailAlignment,
} from './lib/order-cards-for-detail-alignment.js';
import { buildPriceVersions, resolveVersionForCard } from '../src/utils/versionAlignment.ts';

// ---- unit: prefix extraction -----------------------------------------------
assert.equal(cardNumberOriginPrefix('hBP01-028'), 'hBP01');
assert.equal(cardNumberOriginPrefix('hEB01-001'), 'hEB01');
assert.equal(cardNumberOriginPrefix('hSD2025summer-001'), 'hSD2025summer');
assert.equal(cardNumberOriginPrefix('hPR-014'), 'hPR');
assert.equal(cardNumberOriginPrefix(''), '');
assert.equal(cardNumberOriginPrefix(null), '');

// ---- unit: rank ordering ---------------------------------------------------
// Origin-product row with prices beats reprint row with prices.
const originPriced = {
  cardNumber: 'hBP01-028',
  sourceProduct: 'hBP01',
  rarity: 'C',
  prices: [{ name: 'IRyS', sellPrice: 180 }],
};
const reprintPriced = {
  cardNumber: 'hBP01-028',
  sourceProduct: 'hBP08',
  rarity: 'HR',
  prices: [{ name: 'IRyS(パラレル/HR)', sellPrice: 4980 }],
};
const reprintEmpty = {
  cardNumber: 'hBP01-028',
  sourceProduct: 'hBP08',
  rarity: 'C',
  prices: [],
};
assert.ok(
  detailAlignmentRowRank(originPriced) < detailAlignmentRowRank(reprintPriced),
  'origin-product row must outrank reprint row when both are priced',
);
assert.ok(
  detailAlignmentRowRank(reprintPriced) < detailAlignmentRowRank(reprintEmpty),
  'priced reprint outranks empty reprint',
);
assert.ok(
  detailAlignmentRowRank(originPriced) < detailAlignmentRowRank(reprintEmpty),
  'origin-product row outranks empty reprint',
);

// ---- integration: reorder promotes origin row to first ---------------------
// The insertion order mirrors the shipped regression: reprint HR row first,
// origin base row second. Without the reorder the CardDetail pipeline would
// pick PARALLEL from the reprint. After the reorder the origin base row is
// first and CardDetail resolves to BASE — matching deck aggregation.
const shippedShapedRepro = {
  cards: {
    'hBP01-028_hBP08_HR_hBP01-028_HR': {
      id: 'hBP01-028_hBP08_HR_hBP01-028_HR',
      cardNumber: 'hBP01-028',
      sourceProduct: 'hBP08',
      rarity: 'HR',
      prices: [
        { name: 'IRyS(パラレル/HR)', sellPrice: 4980 },
        { name: 'IRyS(パラレル/hBP08)', sellPrice: 50 },
      ],
    },
    'hBP01-028_hBP01_C_hBP01-028_C': {
      id: 'hBP01-028_hBP01_C_hBP01-028_C',
      cardNumber: 'hBP01-028',
      sourceProduct: 'hBP01',
      rarity: 'C',
      prices: [
        { name: 'IRyS', sellPrice: 180 },
        { name: 'IRyS(パラレル/HR)', sellPrice: 4980 },
        { name: 'IRyS(パラレル/hBP08)', sellPrice: 50 },
      ],
    },
    'hBP01-028_hBP08_C_hBP01-028_C_02': {
      id: 'hBP01-028_hBP08_C_hBP01-028_C_02',
      cardNumber: 'hBP01-028',
      sourceProduct: 'hBP08',
      rarity: 'C',
      prices: [],
    },
  },
};

const { cards: ordered, reorderedCardNumbers } = orderCardsForDetailAlignment(shippedShapedRepro.cards);
assert.equal(reorderedCardNumbers, 1, 'expected exactly the hBP01-028 group to reorder');

const orderedIds = Object.keys(ordered);
assert.equal(
  orderedIds[0],
  'hBP01-028_hBP01_C_hBP01-028_C',
  'origin-product base row must land first after reorder',
);
assert.equal(
  orderedIds[orderedIds.length - 1],
  'hBP01-028_hBP08_C_hBP01-028_C_02',
  'empty-prices row must sink to last',
);

// The end-to-end proof: the first row's buildPriceVersions must now produce a
// BASE printing. This is exactly what verify-version-alignment.js checks in
// production and is the assertion that a mutation which weakens the ranker
// will trip.
const firstRow = ordered[orderedIds[0]];
const versions = buildPriceVersions(firstRow);
const resolved = resolveVersionForCard(versions);
assert.equal(
  versions[resolved.index].printing,
  'BASE',
  `first-row detail pick must be BASE; got ${versions[resolved.index].printing}`,
);

// ---- cross-cardNumber order is preserved -----------------------------------
const multi = {
  cards: {
    // hBP02 group first
    'hBP02-018_hBP08_HR': { id: 'hBP02-018_hBP08_HR', cardNumber: 'hBP02-018', sourceProduct: 'hBP08', rarity: 'HR', prices: [{ name: 'X(パラレル/HR)', sellPrice: 4980 }] },
    'hBP02-018_hBP02_C': { id: 'hBP02-018_hBP02_C', cardNumber: 'hBP02-018', sourceProduct: 'hBP02', rarity: 'C', prices: [{ name: 'X', sellPrice: 100 }] },
    // hBP03 group second
    'hBP03-001_hBP03_C': { id: 'hBP03-001_hBP03_C', cardNumber: 'hBP03-001', sourceProduct: 'hBP03', rarity: 'C', prices: [{ name: 'Y', sellPrice: 100 }] },
  },
};
const { cards: multiOrdered } = orderCardsForDetailAlignment(multi.cards);
const multiIds = Object.keys(multiOrdered);
assert.equal(multiIds[0], 'hBP02-018_hBP02_C', 'hBP02 origin row must come first within its group');
assert.equal(multiIds[1], 'hBP02-018_hBP08_HR', 'hBP02 reprint follows origin');
assert.equal(multiIds[2], 'hBP03-001_hBP03_C', 'hBP03 group preserves its cross-group position');

// ---- same-rank ties keep the previous committed order (DIC-1430 / PR #215) --
// The 2026-09-23 daily rebuild re-read hBP07 in official-site listing order,
// which put the `02_C` reprint row before the `HR` reprint row. Both rows rank
// identically (non-base prices, same richness, non-origin source), so the old
// input-order tie-break inverted 724 sibling pairs and flipped the DIC-1430
// exact-print search election for hBP01-024 from HR to 02_C. With
// `previousCards` the previous relative order must win the tie; a row absent
// from the previous database still falls back to input order.
const tieRepro = {
  cards: {
    'hBP01-024_hBP01_C_hBP01-024_C': {
      id: 'hBP01-024_hBP01_C_hBP01-024_C',
      cardNumber: 'hBP01-024',
      sourceProduct: 'hBP01',
      rarity: 'C',
      prices: [{ name: 'ベスティア・ゼータ', sellPrice: 30 }],
    },
    // rebuild input order: 02_C listed before HR (official-site order)
    'hBP01-024_hBP07_C_hBP01-024_02_C': {
      id: 'hBP01-024_hBP07_C_hBP01-024_02_C',
      cardNumber: 'hBP01-024',
      sourceProduct: 'hBP07',
      rarity: 'C',
      prices: [{ name: 'ベスティア・ゼータ(パラレル/hBP07)', sellPrice: 50 }],
    },
    'hBP01-024_hBP07_HR_hBP01-024_HR': {
      id: 'hBP01-024_hBP07_HR_hBP01-024_HR',
      cardNumber: 'hBP01-024',
      sourceProduct: 'hBP07',
      rarity: 'HR',
      prices: [{ name: 'ベスティア・ゼータ(パラレル/HR)', sellPrice: 3480 }],
    },
  },
};
const previousCommitted = {
  'hBP01-024_hBP01_C_hBP01-024_C': {},
  'hBP01-024_hBP07_HR_hBP01-024_HR': {},
  'hBP01-024_hBP07_C_hBP01-024_02_C': {},
};
const { cards: tieOrdered } = orderCardsForDetailAlignment(tieRepro.cards, previousCommitted);
const tieIds = Object.keys(tieOrdered);
assert.deepEqual(
  tieIds,
  [
    'hBP01-024_hBP01_C_hBP01-024_C',
    'hBP01-024_hBP07_HR_hBP01-024_HR',
    'hBP01-024_hBP07_C_hBP01-024_02_C',
  ],
  'same-rank reprint siblings must keep the previous committed order (HR before 02_C)',
);

// Without previousCards the tie must still fall back to input order — the
// tie-break is additive, never a behavior change for callers that omit it.
const { cards: tieNoPrev } = orderCardsForDetailAlignment(tieRepro.cards);
assert.deepEqual(
  Object.keys(tieNoPrev),
  [
    'hBP01-024_hBP01_C_hBP01-024_C',
    'hBP01-024_hBP07_C_hBP01-024_02_C',
    'hBP01-024_hBP07_HR_hBP01-024_HR',
  ],
  'omitting previousCards must preserve the input-order tie-break',
);

// A brand-new row (absent from previousCards) keeps the input-order fallback
// and stays behind the previously-known same-rank sibling it followed.
const freshRepro = {
  cards: {
    ...tieRepro.cards,
    'hBP01-024_hBP09_C_hBP01-024_03_C': {
      id: 'hBP01-024_hBP09_C_hBP01-024_03_C',
      cardNumber: 'hBP01-024',
      sourceProduct: 'hBP09',
      rarity: 'C',
      prices: [{ name: 'ベスティア・ゼータ(パラレル/hBP09)', sellPrice: 50 }],
    },
  },
};
const { cards: freshOrdered } = orderCardsForDetailAlignment(freshRepro.cards, previousCommitted);
assert.equal(
  Object.keys(freshOrdered)[1],
  'hBP01-024_hBP07_HR_hBP01-024_HR',
  'previous-order tie-break must still elect HR first among known siblings when a fresh row joins the group',
);
assert.equal(
  Object.keys(freshOrdered)[3],
  'hBP01-024_hBP09_C_hBP01-024_03_C',
  'a row absent from previousCards must keep its input-order (appended) position',
);

// ---- interleaved new row must not mask the previous-order restoration ------
// Regression for the non-transitive comparator (DIC-1167 remediation): with a
// NEW row sitting BETWEEN two known same-rank siblings whose previous order is
// inverted relative to the rebuild input — current [A, new, B], previous
// [B, A] — the old comparator compared A/new and new/B by input position and
// never got to apply the B-before-A previous order, shipping [A, new, B].
// The known-row subsequence must be restored to previous order (B before A)
// while the new row keeps its input-order slot (the middle).
const interleaveRepro = {
  cards: {
    'hBP01-024_hBP07_C_hBP01-024_02_C': tieRepro.cards['hBP01-024_hBP07_C_hBP01-024_02_C'],
    'hBP01-024_hBP09_C_hBP01-024_03_C': {
      id: 'hBP01-024_hBP09_C_hBP01-024_03_C',
      cardNumber: 'hBP01-024',
      sourceProduct: 'hBP09',
      rarity: 'C',
      prices: [{ name: 'ベスティア・ゼータ(パラレル/hBP09)', sellPrice: 50 }],
    },
    'hBP01-024_hBP07_HR_hBP01-024_HR': tieRepro.cards['hBP01-024_hBP07_HR_hBP01-024_HR'],
  },
};
const interleavePrevious = {
  'hBP01-024_hBP07_HR_hBP01-024_HR': {},
  'hBP01-024_hBP07_C_hBP01-024_02_C': {},
};
const { cards: interleaveOrdered } = orderCardsForDetailAlignment(
  interleaveRepro.cards,
  interleavePrevious,
);
assert.deepEqual(
  Object.keys(interleaveOrdered),
  [
    'hBP01-024_hBP07_HR_hBP01-024_HR',
    'hBP01-024_hBP09_C_hBP01-024_03_C',
    'hBP01-024_hBP07_C_hBP01-024_02_C',
  ],
  'known siblings must restore previous order (HR before 02_C) across an interleaved new row, which keeps its middle slot',
);

console.log('DIC-1167 detail↔deck row alignment ordering checks passed');
