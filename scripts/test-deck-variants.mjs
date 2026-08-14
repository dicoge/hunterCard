#!/usr/bin/env node
/**
 * DIC-1004 §A regression — low-cost default printing resolver.
 *
 * Covers: base beats premium, cheapest exact-version price wins inside the base
 * tier, a missing price never borrows another version's price, search groups
 * duplicate printings by card number, and the 套用低配版本 normalization
 * preserves zone + quantity.
 *
 * Run: npm run test:deck-variants
 */
import assert from 'node:assert/strict';
import {
  resolveLowCostVariant, groupVariantsByCardNumber, searchVariantGroups,
  buildLowCostIndex, normalizeSlotsToLowCost, countLowCostDrift,
  isPremiumPrinting, normalizeRarityCode,
} from '../src/utils/deckVariants.ts';
import { computeGap, resolveExactPrice } from '../src/utils/deckRules.ts';
import { useDeckStore } from '../src/store/deckStore.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const holomen = (cardNumber, rarity, series) => ({
  id: `${cardNumber}_${series}`,
  cardNumber,
  name: `card ${cardNumber}`,
  rarity,
  series,
  cardTypeJp: 'ホロメン',
});
const oshi = (cardNumber, rarity, series) => ({
  ...holomen(cardNumber, rarity, series), cardTypeJp: '推しホロメン',
});
const yell = (cardNumber, rarity, series) => ({
  ...holomen(cardNumber, rarity, series), cardTypeJp: 'エール',
});
const price = (cardNumber, version, p, currency = 'JPY') => ({
  cardNumber, version, price: p, currency, source: 'yuyu-tei.jp', timestamp: '2026-08-01',
});

console.log('DIC-1004 low-cost variant resolver');

// ── Rarity classification ──────────────────────────────────────────────────
test('scraper disambiguation affixes normalize to the real rarity code', () => {
  assert.equal(normalizeRarityCode('P_02'), 'P');
  assert.equal(normalizeRarityCode('02_HR'), 'HR');
  assert.equal(normalizeRarityCode('C_2'), 'C');
  assert.equal(normalizeRarityCode('C_re'), 'C');
  assert.equal(normalizeRarityCode(' sr '), 'SR');
  // premium codes that merely look suffixed must survive intact
  assert.equal(normalizeRarityCode('OSR'), 'OSR');
  assert.equal(normalizeRarityCode('OUR'), 'OUR');
});

test('SEC / S / OUR / OSR / P / UR are premium; base set rarities are not', () => {
  for (const r of ['SEC', 'S', 'OUR', 'OSR', 'P', 'PR', 'UR', 'HR', 'S_02']) {
    assert.equal(isPremiumPrinting(r), true, `${r} should be premium`);
  }
  for (const r of ['C', 'U', 'R', 'RR', 'SR', 'OC', 'C_2', 'U_02']) {
    assert.equal(isPremiumPrinting(r), false, `${r} should be base`);
  }
});

// ── Default selection ──────────────────────────────────────────────────────
test('base printing is chosen over a SEC/signature variant of the same card number', () => {
  const variants = [
    holomen('hBP04-057', 'SEC', 'ent07'),
    holomen('hBP04-057', 'S', 'hPR'),
    holomen('hBP04-057', 'C', 'hBP04'),
  ];
  assert.equal(resolveLowCostVariant(variants, []).rarity, 'C');
});

test('premium is never the default while ANY base printing exists, even if cheaper', () => {
  const variants = [
    holomen('hBP01-024', 'SEC', 'ent07'),
    holomen('hBP01-024', 'C', 'hBP01'),
  ];
  // The SEC printing carries the (absurdly) cheaper exact price — the base
  // printing must still win, because premium defaults are the reported bug.
  const records = [price('hBP01-024', 'SEC', 10), price('hBP01-024', 'C', 500)];
  assert.equal(resolveLowCostVariant(variants, records).rarity, 'C');
});

test('inside the base tier the lowest exact-version price wins', () => {
  const variants = [
    holomen('hBP01-050', 'SR', 'hBP05'),
    holomen('hBP01-050', 'U', 'hSD06'),
    holomen('hBP01-050', 'C', 'hBP01'),
  ];
  const records = [
    price('hBP01-050', 'SR', 40),
    price('hBP01-050', 'U', 900),
    price('hBP01-050', 'C', 800),
  ];
  assert.equal(resolveLowCostVariant(variants, records).rarity, 'SR');
});

test('prices in a different currency are never compared against the primary one', () => {
  const variants = [
    holomen('hBP01-052', 'C', 'hBP01'),
    holomen('hBP01-052', 'U', 'hSD06'),
  ];
  // The USD 1 record must not undercut the JPY context set by the C printing.
  const records = [price('hBP01-052', 'C', 300), price('hBP01-052', 'U', 1, 'USD')];
  assert.equal(resolveLowCostVariant(variants, records).rarity, 'C');
});

test('unpriced base printings fall back to the deterministic lowest rarity, never a borrowed price', () => {
  const variants = [
    holomen('hBP01-044', 'R', 'hBP07'),
    holomen('hBP01-044', 'C', 'hBP01'),
    holomen('hBP01-044', 'C', 'hSD06'),
  ];
  const chosen = resolveLowCostVariant(variants, []);
  assert.equal(chosen.rarity, 'C');
  // Ties break to the original set printing (series === the card number's set).
  assert.equal(chosen.series, 'hBP01');
  // …and the estimate stays unpriced rather than borrowing the R price.
  assert.deepEqual(
    resolveExactPrice(chosen.cardNumber, chosen.rarity, [price('hBP01-044', 'R', 50)]),
    { status: 'NO_EXACT_PRICE' },
  );
});

test('resolution is stable regardless of variant input order', () => {
  const variants = [
    holomen('hBP01-048', 'HR', 'ent07'),
    holomen('hBP01-048', 'C_2', 'hSD06'),
    holomen('hBP01-048', 'C', 'hBP01'),
    holomen('hBP01-048', 'P', 'hPR'),
  ];
  const first = resolveLowCostVariant(variants, []).id;
  assert.equal(resolveLowCostVariant(variants.slice().reverse(), []).id, first);
  assert.equal(first, 'hBP01-048_hBP01');
});

test('an all-premium card number still resolves deterministically', () => {
  const variants = [oshi('hBP04-005', 'SEC', 'ent07'), oshi('hBP04-005', 'SEC', 'hBP04')];
  assert.equal(resolveLowCostVariant(variants, []).series, 'hBP04');
});

test('unplayable entries are never the default', () => {
  const broken = { id: 'x_ent07', cardNumber: 'hBP04-057', name: 'x', rarity: 'C', series: 'ent07' };
  const variants = [broken, holomen('hBP04-057', 'SEC', 'hBP04')];
  assert.equal(resolveLowCostVariant(variants, []).id, 'hBP04-057_hBP04');
});

// ── Search grouping ────────────────────────────────────────────────────────
test('search returns one row per card number, carrying the low-cost default', () => {
  const cards = [
    holomen('hBP04-057', 'SEC', 'ent07'),
    holomen('hBP04-057', 'C', 'hBP04'),
    holomen('hBP01-024', 'P', 'hPR'),
  ];
  const groups = groupVariantsByCardNumber(cards, []);
  assert.equal(groups.length, 2);
  const hit = searchVariantGroups(groups, 'hBP04-057');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].card.rarity, 'C');
  assert.equal(hit[0].variants.length, 2);
});

test('a promo-series query still finds the card and yields the base default', () => {
  const cards = [holomen('hBP01-026', 'P', 'hPR'), holomen('hBP01-026', 'U', 'hBP01')];
  const groups = groupVariantsByCardNumber(cards, []);
  const hit = searchVariantGroups(groups, 'hPR');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].card.rarity, 'U');
});

// ── Existing-draft normalization ───────────────────────────────────────────
test('套用低配版本 preserves zone and quantity while swapping the printing', () => {
  const secOshi = oshi('hBP04-005', 'SEC', 'ent07');
  const baseOshi = oshi('hBP04-005', 'C', 'hBP04');
  const secMain = holomen('hBP04-057', 'S', 'hPR');
  const baseMain = holomen('hBP04-057', 'C', 'hBP04');
  const index = buildLowCostIndex(groupVariantsByCardNumber(
    [secOshi, baseOshi, secMain, baseMain], [],
  ));

  const normalizedOshi = normalizeSlotsToLowCost([{ card: secOshi, qty: 1 }], 'oshi', index);
  assert.deepEqual(normalizedOshi, [{ card: baseOshi, qty: 1 }]);

  const normalizedMain = normalizeSlotsToLowCost([{ card: secMain, qty: 4 }], 'main', index);
  assert.equal(normalizedMain[0].card.id, baseMain.id);
  assert.equal(normalizedMain[0].qty, 4);
});

test('slots collapsing onto the same printing merge their quantities', () => {
  const a = holomen('hBP01-070', 'P_02', 'hPR');
  const b = holomen('hBP01-070', 'HR', 'ent07');
  const base = holomen('hBP01-070', 'U', 'hBP01');
  const index = buildLowCostIndex(groupVariantsByCardNumber([a, b, base], []));
  const out = normalizeSlotsToLowCost([{ card: a, qty: 2 }, { card: b, qty: 1 }], 'main', index);
  assert.equal(out.length, 1);
  assert.equal(out[0].card.id, base.id);
  assert.equal(out[0].qty, 3);
});

test('a replacement that would change the slot zone is skipped', () => {
  const yellSlotCard = yell('hY01-001', 'SEC', 'ent07');
  // The "cheaper" printing of the same number is a main-deck card — swapping it
  // into the yell zone would silently corrupt the deck, so it must be left alone.
  const index = new Map([['hY01-001', holomen('hY01-001', 'C', 'hBP01')]]);
  const out = normalizeSlotsToLowCost([{ card: yellSlotCard, qty: 20 }], 'yell', index);
  assert.deepEqual(out, [{ card: yellSlotCard, qty: 20 }]);
});

test('drift count reports only slots the action would actually rewrite', () => {
  const secMain = holomen('hBP04-057', 'S', 'hPR');
  const baseMain = holomen('hBP04-057', 'C', 'hBP04');
  const index = buildLowCostIndex(groupVariantsByCardNumber([secMain, baseMain], []));
  const deck = { id: 'd', name: 'd', oshi: [], main: [{ card: secMain, qty: 3 }], yell: [], updatedAt: '' };
  assert.equal(countLowCostDrift(deck, index), 1);

  const normalized = { ...deck, main: normalizeSlotsToLowCost(deck.main, 'main', index) };
  assert.equal(countLowCostDrift(normalized, index), 0);
});

test('normalization does not rewrite collection ownership, so the gap re-targets the new version', () => {
  const secMain = holomen('hBP04-057', 'S', 'hPR');
  const baseMain = holomen('hBP04-057', 'C', 'hBP04');
  const index = buildLowCostIndex(groupVariantsByCardNumber([secMain, baseMain], []));
  const collection = { 'hBP04-057|S': 2 };
  const deck = { id: 'd', name: 'd', oshi: [], main: [{ card: secMain, qty: 3 }], yell: [], updatedAt: '' };

  const before = computeGap(deck, collection, []);
  assert.equal(before.rows[0].owned, 2);
  assert.equal(before.rows[0].missing, 1);

  const after = computeGap(
    { ...deck, main: normalizeSlotsToLowCost(deck.main, 'main', index) },
    collection,
    [],
  );
  // Ownership of the S printing is untouched and does NOT transfer to C.
  assert.deepEqual(collection, { 'hBP04-057|S': 2 });
  assert.equal(after.rows[0].version, 'C');
  assert.equal(after.rows[0].owned, 0);
  assert.equal(after.rows[0].missing, 3);
});

test('a priced low-cost default still produces an exact-version estimate', () => {
  const variants = [holomen('hBP01-052', 'SEC', 'ent07'), holomen('hBP01-052', 'C', 'hBP01')];
  const records = [price('hBP01-052', 'C', 80), price('hBP01-052', 'SEC', 9800)];
  const card = resolveLowCostVariant(variants, records);
  const gap = computeGap(
    { id: 'd', name: 'd', oshi: [], main: [{ card, qty: 4 }], yell: [], updatedAt: '' },
    {},
    records,
  );
  assert.equal(gap.total, 320);
  assert.equal(gap.currency, 'JPY');
  assert.equal(gap.unpriced.length, 0);
});

test('the store action normalizes an existing draft across all three zones', () => {
  const secOshi = oshi('hBP04-005', 'SEC', 'ent07');
  const baseOshi = oshi('hBP04-005', 'C', 'hBP04');
  const secMain = holomen('hBP04-057', 'S', 'hPR');
  const baseMain = holomen('hBP04-057', 'C', 'hBP04');
  const yellCard = yell('hY01-001', 'C', 'hBP01');
  const index = buildLowCostIndex(groupVariantsByCardNumber(
    [secOshi, baseOshi, secMain, baseMain, yellCard], [],
  ));

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: { 'hBP04-057|S': 2 } });
  const deckId = useDeckStore.getState().createDeck('螢幕截圖牌組');
  useDeckStore.getState().changeCard(deckId, 'oshi', secOshi, 1);
  useDeckStore.getState().changeCard(deckId, 'main', secMain, 4);
  useDeckStore.getState().changeCard(deckId, 'yell', yellCard, 20);

  useDeckStore.getState().applyLowCostVariants(deckId, index);

  const deck = useDeckStore.getState().decks.find((d) => d.id === deckId);
  assert.deepEqual(deck.oshi, [{ card: baseOshi, qty: 1 }]);
  assert.deepEqual(deck.main, [{ card: baseMain, qty: 4 }]);
  assert.deepEqual(deck.yell, [{ card: yellCard, qty: 20 }]);
  // The global collection is never rewritten into another version.
  assert.deepEqual(useDeckStore.getState().collection, { 'hBP04-057|S': 2 });
});

console.log(`\n${passed} checks passed`);
