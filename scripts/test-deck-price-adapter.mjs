#!/usr/bin/env node
/**
 * DIC-952 fail-closed price-provenance regression. Guards the raw-database →
 * PriceRecord boundary in src/utils/deckCardData.ts, which previously turned a
 * single marketplace listing into an "exact" price for every rarity variant of
 * a cardNumber. Uses real ambiguous data shapes (the hBP01-044 C/HR/P_02 case)
 * to prove prices are NOT spread across versions and excluded items never enter
 * the gap total.
 *
 * Run: node --experimental-strip-types scripts/test-deck-price-adapter.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptPrices, adaptDatabase } from '../src/utils/deckCardData.ts';
import { computeGap, resolveExactPrice } from '../src/utils/deckRules.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Real database shape: the same scraped listing ("AZKi(パラレル/hBP07)", 80) is
// copied onto three different rarity variants of hBP01-044. The `prices[]`
// breakdown carries no per-listing rarity, so nothing here proves which variant
// the 80円 listing belongs to.
const AMBIGUOUS_HBP01_044 = ['HR', 'C', 'P_02'].map((rarity, i) => ({
  id: `hBP01-044_${i}`,
  cardNumber: 'hBP01-044',
  name: 'AZKi',
  rarity,
  sellPrice: 80,
  yuyuName: 'AZKi(パラレル/hBP07)',
  timestamp: '2026-08-09T12:12:09.518Z',
  prices: [
    { name: 'AZKi', sellPrice: 220, rarity: '' },
    { name: 'AZKi(パラレル/HR)', sellPrice: 9980, rarity: '' },
    { name: 'AZKi(パラレル/hBP07)', sellPrice: 80, rarity: '' },
  ],
}));

// ── Adapter boundary: ambiguous provenance yields NO version-keyed price ─────
test('ambiguous top-level sellPrice is NOT assigned to rarity', () => {
  for (const raw of AMBIGUOUS_HBP01_044) {
    assert.deepEqual(
      adaptPrices(raw), [],
      `expected no price record for hBP01-044 ${raw.rarity}, provenance is ambiguous`,
    );
  }
});

test('one listing is never spread across the C/HR/P_02 versions', () => {
  const { priceRecords } = adaptDatabase(AMBIGUOUS_HBP01_044);
  assert.equal(priceRecords.length, 0);
  // Even the resolver, asked for each specific version, must fail closed.
  for (const v of ['C', 'HR', 'P_02']) {
    assert.equal(resolveExactPrice('hBP01-044', v, priceRecords).status, 'NO_EXACT_PRICE');
  }
});

// ── Gap total: ambiguous items are excluded, never summed ────────────────────
test('gap excludes the ambiguous card from the total', () => {
  const { priceRecords } = adaptDatabase(AMBIGUOUS_HBP01_044);
  const card = (rarity) => ({
    id: `hBP01-044_${rarity}`, cardNumber: 'hBP01-044', name: 'AZKi',
    rarity, series: '', cardTypeJp: 'ホロメン',
  });
  const deck = {
    id: 'd', name: 'ambiguous', updatedAt: '',
    oshi: [], yell: [],
    main: [
      { card: card('C'), qty: 2 },
      { card: card('HR'), qty: 1 },
    ],
  };
  const gap = computeGap(deck, {}, priceRecords); // own nothing → all missing
  assert.equal(gap.total, 0, 'no fabricated price may enter the total');
  assert.equal(gap.currency, null);
  assert.equal(gap.unpriced.length, 2, 'both versions land in unpriced');
  for (const row of gap.rows) assert.equal(row.price.status, 'NO_EXACT_PRICE');
});

// ── Positive: an EXPLICIT per-listing rarity is a verified mapping ───────────
test('a prices[] entry with explicit rarity yields a version-keyed price', () => {
  const raw = {
    id: 'hXX-001_HR', cardNumber: 'hXX-001', name: 'X', rarity: 'HR',
    sellPrice: 80, yuyuName: 'X(パラレル)', timestamp: '2026-08-09T00:00:00Z',
    // This listing explicitly declares its own version → verified mapping.
    prices: [{ name: 'X(SR)', sellPrice: 1200, rarity: 'SR' }],
  };
  const recs = adaptPrices(raw);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].version, 'SR');
  assert.equal(recs[0].price, 1200);
  // Resolves only for the explicitly-declared version, never for the card's own
  // top-level rarity (HR), which had no verified price.
  assert.equal(resolveExactPrice('hXX-001', 'SR', recs).status, 'ok');
  assert.equal(resolveExactPrice('hXX-001', 'HR', recs).status, 'NO_EXACT_PRICE');
});

// ── Whole-dataset invariant: no fabricated cross-version exact prices ────────
test('real database.json produces no version-spread exact prices', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const rawCards = Object.values(db.cards || {});
  const { priceRecords } = adaptDatabase(rawCards);
  // For every cardNumber, no two DIFFERENT versions may carry the same price
  // sourced from a single listing (the exact failure mode of the old adapter).
  const byNumber = new Map();
  for (const r of priceRecords) {
    if (!byNumber.has(r.cardNumber)) byNumber.set(r.cardNumber, new Map());
    const versions = byNumber.get(r.cardNumber);
    assert.ok(r.version !== '', `emitted record for ${r.cardNumber} has empty version`);
    if (versions.has(r.version)) {
      assert.equal(versions.get(r.version), r.price,
        `conflicting price for ${r.cardNumber} ${r.version}`);
    }
    versions.set(r.version, r.price);
  }
  // The current dataset carries no explicit per-listing rarity, so it must fail
  // closed to zero exact prices rather than fabricate any.
  assert.equal(priceRecords.length, 0,
    'current dataset has no verified version prices → must emit none');
});

console.log(`\nDIC-952 price adapter: ${passed} tests passed`);
