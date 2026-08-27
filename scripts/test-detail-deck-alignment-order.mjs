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

console.log('DIC-1167 detail↔deck row alignment ordering checks passed');
