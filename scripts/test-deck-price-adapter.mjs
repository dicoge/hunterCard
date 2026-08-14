#!/usr/bin/env node
/**
 * DIC-952 fail-closed price-provenance regression + buy-price provenance channel
 * (merge-buy-prices.js buyPriceVersion stamps). Guards the raw-database →
 * PriceRecord boundary in src/utils/deckCardData.ts, which previously turned a
 * single marketplace listing into an "exact" price for every rarity variant of
 * a cardNumber — and, before that, never surfaced version-precise buy prices at
 * all (every slot showed the collapsed card-level max).
 *
 * The adapter may only emit a (cardNumber, version) price when the SOURCE
 * explicitly declares that version:
 *  - a prices[] entry with its own non-empty `rarity` (yuyu-tei), or
 *  - merge-buy-prices.js provenance (buyPrice + buyPriceVersion + buyPriceSource
 *    + buyPriceTimestamp). 'BASE' = the bare original-printing listing, claimable
 *    ONLY by the card number's own-set non-premium row — never by SEC/signed/
 *    parallel rows (no cross-version fallback).
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/test-deck-price-adapter.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptPrices, adaptDatabase, dropConflictingPrices } from '../src/utils/deckCardData.ts';
import { computeGap, resolveExactPrice, normalizeVersion } from '../src/utils/deckRules.ts';
import { isPremiumPrinting } from '../src/utils/deckVariants.ts';

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
// the 80円 listing belongs to. No buy provenance either → must stay unpriced.
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

// ── Buy-price provenance channel (DIC-856 follow-up) ─────────────────────────
// The database now stores version-precise buy prices per variant, each stamped
// with its source (merge-buy-prices.js buyPriceVersion / buyPriceSource /
// buyPriceTimestamp). The adapter must turn those into exact PriceRecords so a
// low-cost deck slot resolves ITS version's price — and must never let a premium
// row absorb the bare BASE price.
const SRC_TS = '2026-08-14T12:15:00.000Z';
const HBP04_005_ROW = {
  id: 'hBP04-005_hBP04', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス',
  rarity: 'SEC', series: 'hBP04', sellPrice: 980, timestamp: SRC_TS,
  prices: [
    { name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800, rarity: '', buyPrice: 38000, buyPriceVersion: 'SEC', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
    { name: 'ラプラス・ダークネス(パラレル)', sellPrice: 9980, rarity: '', buyPrice: 5000, buyPriceVersion: 'SR', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
    { name: 'ラプラス・ダークネス', sellPrice: 980, rarity: '', buyPrice: 150, buyPriceVersion: 'BASE', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
  ],
};
const BASE_CARD_ROW = {
  id: 'hXX-002_hXX', cardNumber: 'hXX-002', name: 'Base Card',
  rarity: 'U', series: 'hXX', sellPrice: 120, timestamp: SRC_TS,
  prices: [
    { name: 'Base Card', sellPrice: 120, rarity: '', buyPrice: 300, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: SRC_TS },
  ],
};

test('explicit SEC/parallel buy-price provenance yields exact records on any row', () => {
  // The premium SEC row of hBP04-005 shares the listing set; SEC and SR tokens
  // are proven by the source and apply to every row of the card number alike.
  const recs = adaptPrices(HBP04_005_ROW);
  const byVersion = Object.fromEntries(recs.map((r) => [r.version, r]));
  assert.deepEqual(Object.keys(byVersion).sort(), ['SEC', 'SR']);
  assert.equal(byVersion.SEC.price, 38000);
  assert.equal(byVersion.SEC.source, 'fullahead');
  assert.equal(byVersion.SR.price, 5000);
  // resolves each version to ITS OWN price
  assert.equal(resolveExactPrice('hBP04-005', 'SEC', recs).price, 38000);
  assert.equal(resolveExactPrice('hBP04-005', 'SR', recs).price, 5000);
});

test('BASE buy price is NOT leaked onto a premium row', () => {
  const recs = adaptPrices(HBP04_005_ROW);
  // The 150円 bare listing must never become a version-keyed record via this
  // SEC row (a hypothetical 'C'/'SEC' slot may NOT inherit the base price).
  assert.equal(recs.filter((r) => r.price === 150).length, 0);
  assert.equal(resolveExactPrice('hBP04-005', 'C', recs).status, 'NO_EXACT_PRICE');
  assert.equal(resolveExactPrice('hBP04-005', 'BASE', recs).status, 'NO_EXACT_PRICE');
});

test('BASE buy price IS claimed by the own-set base row (exact base-version price)', () => {
  const recs = adaptPrices(BASE_CARD_ROW);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].version, 'U');
  assert.equal(recs[0].price, 300);
  assert.equal(recs[0].source, 'torecolo');
  assert.equal(resolveExactPrice('hXX-002', 'U', recs).price, 300);
});

test('buy price without a version token stays unpriced (fail closed)', () => {
  const raw = {
    ...BASE_CARD_ROW, id: 'hXX-003', cardNumber: 'hXX-003',
    prices: [{ name: 'X', rarity: '', buyPrice: 999, buyPriceSource: 'fullahead' }],
  };
  assert.deepEqual(adaptPrices(raw), [], 'no buyPriceVersion → cannot prove a version');
});

test('conflicting prices for the same (cardNumber, version) are all dropped', () => {
  // Two rows of the same card number claim the same version at DIFFERENT prices
  // (simulating two stores disagreeing) → ambiguous → fail closed.
  const rows = [
    { ...BASE_CARD_ROW, id: 'hXX-004_a', cardNumber: 'hXX-004', rarity: 'R', prices: [{ name: 'X', rarity: '', buyPrice: 100, buyPriceVersion: 'R', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS }] },
    { ...BASE_CARD_ROW, id: 'hXX-004_b', cardNumber: 'hXX-004', rarity: 'R', prices: [{ name: 'X', rarity: '', buyPrice: 250, buyPriceVersion: 'R', buyPriceSource: 'torecolo', buyPriceTimestamp: SRC_TS }] },
  ];
  const { priceRecords } = adaptDatabase(rows);
  assert.equal(priceRecords.length, 0, 'conflict must be dropped, not arbitrarily picked');
  assert.equal(resolveExactPrice('hXX-004', 'R', priceRecords).status, 'NO_EXACT_PRICE');
});

test('version tokens are normalized (case/width/spacing)', () => {
  const raw = {
    ...BASE_CARD_ROW, id: 'hXX-005', cardNumber: 'hXX-005', rarity: 'SR',
    prices: [{ name: 'X', rarity: '', buyPrice: 700, buyPriceVersion: ' sr ', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS }],
  };
  const recs = adaptPrices(raw);
  assert.equal(recs[0].version, 'SR');
  assert.equal(resolveExactPrice('hXX-005', 'SR', recs).price, 700);
});

test('e2e: low-cost deck slot totals exactly its base-version price (no max)', () => {
  // Rebuild the pre-merge database.json shape: every printing is its own card,
  // and every row of a card number shares the same prices[] (with provenance).
  const rawCards = [
    HBP04_005_ROW,
    { ...HBP04_005_ROW, id: 'hBP04-005_ent07', series: 'ent07' }, // reprint SEC row
    BASE_CARD_ROW,
  ];
  const { priceRecords } = adaptDatabase(rawCards);
  // The deck wants ONE base printing of hXX-002 and one SEC printing of hBP04-005.
  const card = (cn, rarity, series) => ({
    id: `${cn}_${series}`, cardNumber: cn, name: cn, rarity, series, cardTypeJp: 'ホロメン',
  });
  const deck = {
    id: 'd', name: 'low-cost', updatedAt: '',
    oshi: [], yell: [],
    main: [
      { card: card('hXX-002', 'U', 'hXX'), qty: 1 },
      { card: card('hBP04-005', 'SEC', 'hBP04'), qty: 1 },
    ],
  };
  const gap = computeGap(deck, {}, priceRecords); // own nothing → all missing
  const byNumber = Object.fromEntries(gap.rows.map((r) => [r.cardNumber, r]));
  // Base slot gets the BASE (bare) price, NOT the card's highest listing.
  assert.equal(byNumber['hXX-002'].price.status, 'ok');
  assert.equal(byNumber['hXX-002'].price.price, 300);
  // SEC slot gets the exact SEC price.
  assert.equal(byNumber['hBP04-005'].price.price, 38000);
  // Both slots were priced → total = 300 + 38000, no unpriced leakage.
  assert.equal(gap.total, 38300);
  assert.equal(gap.unpriced.length, 0);
});

// ── Whole-dataset invariant: no fabricated cross-version exact prices ────────
test('real database.json emits only source-proven exact-version records', () => {
  const dbPath = path.join(__dirname, '..', 'data', 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const rawCards = Object.values(db.cards || {});
  const { priceRecords } = adaptDatabase(rawCards);
  // With buy-price provenance stamped by the merge, the production dataset now
  // carries version-precise prices (the pre-DIC-856 collapse emitted none).
  assert.ok(priceRecords.length > 0, 'production dataset now carries buy-price provenance');
  const byNumber = new Map();
  for (const r of priceRecords) {
    assert.ok(r.version !== '', `emitted record for ${r.cardNumber} has empty version`);
    assert.ok(r.source, `emitted record for ${r.cardNumber} ${r.version} has no source`);
    if (!byNumber.has(r.cardNumber)) byNumber.set(r.cardNumber, new Map());
    const versions = byNumber.get(r.cardNumber);
    if (versions.has(r.version)) {
      assert.equal(versions.get(r.version), r.price,
        `conflicting price for ${r.cardNumber} ${r.version}`);
    }
    versions.set(r.version, r.price);
  }
  // BASE price may never leak onto a premium printing: for each card number, a
  // premium row's OWN rarity may only carry a price when an explicit non-BASE
  // token backs it. Without such a token, the only path that could produce a
  // (cardNumber, premiumVersion) record is the BASE claim on that premium row —
  // which is exactly the cross-version fallback the adapter must never do.
  const legitTokens = new Map();   // cardNumber -> Set<explicit non-BASE version tokens>
  const premiumOwn = new Map();    // cardNumber -> Set<premium row own-versions>
  for (const card of rawCards) {
    for (const p of card.prices || []) {
      if (typeof p.buyPrice === 'number' && p.buyPriceVersion && p.buyPriceVersion !== 'BASE') {
        const v = normalizeVersion(p.buyPriceVersion);
        if (v) {
          if (!legitTokens.has(card.cardNumber)) legitTokens.set(card.cardNumber, new Set());
          legitTokens.get(card.cardNumber).add(v);
        }
      }
    }
    if (isPremiumPrinting(card.rarity || '')) {
      const v = normalizeVersion(card.rarity || '');
      if (v) {
        if (!premiumOwn.has(card.cardNumber)) premiumOwn.set(card.cardNumber, new Set());
        premiumOwn.get(card.cardNumber).add(v);
      }
    }
  }
  const leaked = [];
  for (const r of priceRecords) {
    if (legitTokens.get(r.cardNumber)?.has(r.version)) continue; // explicit token claim
    if (premiumOwn.get(r.cardNumber)?.has(r.version)) leaked.push(`${r.cardNumber} ${r.version}`);
  }
  assert.deepEqual(leaked, [],
    'BASE buy price leaked onto premium versions (no explicit token backs them): ' + leaked.slice(0, 5).join(', '));
});

console.log(`\nDIC-952 price adapter: ${passed} tests passed`);
