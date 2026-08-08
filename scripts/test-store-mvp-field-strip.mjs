#!/usr/bin/env node
/**
 * QA DIC-915 regression: Store MVP must fail-close the disabled advanced fields
 * (buyPrice, priceHistory, ytStats, prices[].buyPrice) at the card mapping
 * boundary, while full / non-MVP mode preserves every field. Verifies the pure
 * choke point (src/utils/cardReleaseFilter.ts) both profiles route through.
 *
 * Run: node --experimental-strip-types scripts/test-store-mvp-field-strip.mjs
 */
import assert from 'node:assert/strict';
import { stripDisabledCardFields } from '../src/utils/cardReleaseFilter.ts';

const sampleCard = () => ({
  id: 'hBP04-005',
  cardNumber: 'hBP04-005',
  name: 'Test Card',
  sellPrice: 1200,
  buyPrice: 800,
  prices: [
    { name: 'ノーマル', sellPrice: 1200, rarity: 'R', buyPrice: 800 },
    { name: 'サイン', sellPrice: 5000, rarity: 'SR', buyPrice: 3600 },
  ],
  priceHistory: { '2026-07-01': 1100, '2026-07-08': 1200 },
  ytStats: { subscribers: 1000000, views: 5000000 },
});

const FULL_FLAGS = { buyPrice: true, trendPrediction: true, ytStats: true };
const MVP_FLAGS = { buyPrice: false, trendPrediction: false, ytStats: false };

// ── Full / non-MVP mode: every field preserved, input not mutated ──
const original = sampleCard();
const full = stripDisabledCardFields(sampleCard(), FULL_FLAGS);
assert.equal(full.buyPrice, 800, 'full mode keeps buyPrice');
assert.deepEqual(full.priceHistory, original.priceHistory, 'full mode keeps priceHistory');
assert.deepEqual(full.ytStats, original.ytStats, 'full mode keeps ytStats');
assert.equal(full.prices[0].buyPrice, 800, 'full mode keeps prices[].buyPrice');
assert.equal(full.prices[1].buyPrice, 3600, 'full mode keeps every version buyPrice');

// ── Store MVP mode: disabled fields removed, sale price preserved ──
const input = sampleCard();
const mvp = stripDisabledCardFields(input, MVP_FLAGS);
assert.ok(!('buyPrice' in mvp), 'Store MVP strips card buyPrice');
assert.ok(!('priceHistory' in mvp), 'Store MVP strips priceHistory');
assert.ok(!('ytStats' in mvp), 'Store MVP strips ytStats');
for (const p of mvp.prices) {
  assert.ok(!('buyPrice' in p), 'Store MVP strips prices[].buyPrice');
  assert.ok('sellPrice' in p, 'Store MVP keeps prices[].sellPrice (sale reference)');
}
// Sale reference price is a must-show field — never stripped.
assert.equal(mvp.sellPrice, 1200, 'Store MVP keeps sellPrice');
assert.equal(mvp.name, 'Test Card', 'Store MVP keeps non-market fields');
// Input object must not be mutated (shallow clone contract).
assert.equal(input.buyPrice, 800, 'strip does not mutate the input card');
assert.equal(input.prices[0].buyPrice, 800, 'strip does not mutate input prices');

// ── Per-flag independence ──
const onlyYt = stripDisabledCardFields(sampleCard(), { buyPrice: true, trendPrediction: true, ytStats: false });
assert.ok(!('ytStats' in onlyYt), 'ytStats-off strips ytStats only');
assert.equal(onlyYt.buyPrice, 800, 'ytStats-off keeps buyPrice');
assert.ok('priceHistory' in onlyYt, 'ytStats-off keeps priceHistory');

console.log('Store MVP field-strip regression checks passed');
