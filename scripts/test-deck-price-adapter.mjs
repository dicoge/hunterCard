#!/usr/bin/env node
/**
 * DIC-1013 price-provenance regression: the deck estimate is built from the
 * player-facing SELL price of a SOURCE-PROVEN printing.
 *
 * Two invariants are guarded at the raw-database → PriceRecord boundary
 * (src/utils/deckCardData.ts):
 *
 *  1. A printing exists only when the source listing's own label names it —
 *     plain, (パラレル), (パラレル/サイン) … — never the dataset's row-level
 *     rarity, which describes the card number as a whole (hBP04-005 is SEC on
 *     both of its rows while the source plainly lists a ¥980 printing).
 *  2. Only the sell price becomes a PriceRecord. A store's buy price is what a
 *     shop PAYS the player; it can never stand in for what a missing card costs
 *     to acquire, so it must not appear anywhere in the deck pipeline.
 *
 * Ambiguity fails closed: two listings that reach the same printing at different
 * prices leave that printing unpriced rather than picking one.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs scripts/test-deck-price-adapter.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adaptCardNumber, adaptDatabase, dropConflictingPrices, pickRepresentative,
  PRICE_CURRENCY, PRICE_SOURCE,
} from '../src/utils/deckCardData.ts';
import { computeGap, resolveExactPrice } from '../src/utils/deckRules.ts';
import { buildSourcePrintings, printingFromLabel, isPlainPrinting } from '../src/utils/printingIdentity.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SRC_TS = '2026-08-14T12:15:00.000Z';

// Production shape of hBP04-005 (the screenshot case). Both rows carry rarity
// SEC and the SAME listing set; the printings live in the listing labels.
const HBP04_005_ROWS = ['ent07', 'hBP04'].map((series) => ({
  id: `hBP04-005_${series}`,
  cardNumber: 'hBP04-005',
  name: 'ラプラス・ダークネス',
  rarity: 'SEC',
  series,
  sellPrice: 980,
  timestamp: SRC_TS,
  skillsJp: { cardType: '推しホロメン' },
  prices: [
    { name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800, rarity: '', buyPrice: 38000, buyPriceVersion: 'SEC', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
    { name: 'ラプラス・ダークネス(パラレル)', sellPrice: 9980, rarity: '', buyPrice: 5000, buyPriceVersion: 'SR', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
    { name: 'ラプラス・ダークネス', sellPrice: 980, rarity: '', buyPrice: 150, buyPriceVersion: 'BASE', buyPriceSource: 'fullahead', buyPriceTimestamp: SRC_TS },
  ],
}));

// ── Printing identity: nested sell variants stay isolated ────────────────────

test('nested plain / parallel / signed listings become three isolated printings', () => {
  const printings = buildSourcePrintings(HBP04_005_ROWS[0].prices);
  const byToken = Object.fromEntries(printings.map((p) => [p.printing, p]));
  assert.deepEqual(Object.keys(byToken).sort(), ['BASE', 'PARALLEL', 'PARALLEL/SIGN']);
  assert.equal(byToken.BASE.sellPrice, 980);
  assert.equal(byToken.PARALLEL.sellPrice, 9980);
  assert.equal(byToken['PARALLEL/SIGN'].sellPrice, 69800);
  // The raw label is preserved for display / provenance, never fabricated.
  assert.equal(byToken.BASE.label, 'ラプラス・ダークネス');
  assert.equal(byToken['PARALLEL/SIGN'].label, 'ラプラス・ダークネス(パラレル/サイン)');
});

test('every source descriptor is identity-bearing, not just premium markers', () => {
  // A listing with no parenthetical is the plain printing.
  assert.equal(printingFromLabel('ときのそら'), 'BASE');
  // Known treatments get a stable ASCII token …
  assert.equal(printingFromLabel('白銀ノエル(パラレル)'), 'PARALLEL');
  assert.equal(printingFromLabel('AZKi(パラレル/HR)'), 'PARALLEL/HR');
  assert.equal(printingFromLabel('白エール(S仕様)'), 'S-SPEC');
  assert.equal(printingFromLabel('AZKi(パラレル/hBP07)'), 'PARALLEL/HBP07');
  // … and an explicit base REPRINT is its own printing, not the plain one.
  // Collapsing it onto BASE made two unambiguous listings look ambiguous and
  // dropped both of their prices (DIC-1013 CR).
  assert.equal(printingFromLabel('AZKi(hBP07)'), 'HBP07');
  assert.equal(printingFromLabel('みっころね24(hBP04)'), 'HBP04');
  // Both are plain: a reprint is playable and budget-eligible like the original.
  assert.equal(isPlainPrinting(printingFromLabel('みっころね24(hBP04)')), true);
});

test('plain printings are distinguished from premium ones', () => {
  assert.equal(isPlainPrinting('BASE'), true);
  assert.equal(isPlainPrinting('PARALLEL'), false);
  assert.equal(isPlainPrinting('PARALLEL/SIGN'), false);
  assert.equal(isPlainPrinting('PARALLEL/HR'), false);
  assert.equal(isPlainPrinting('S-SPEC'), false);
  assert.equal(isPlainPrinting('S仕様'), false);
  assert.equal(isPlainPrinting('FOIL'), false);
});

// ── Buy price never enters the deck pipeline ────────────────────────────────

test('buy prices never become PriceRecords', () => {
  const { priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  const prices = priceRecords.map((r) => r.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [980, 9980, 69800]);
  for (const buy of [150, 5000, 38000]) {
    assert.equal(priceRecords.some((r) => r.price === buy), false,
      `store buy price ${buy} must never reach the deck price pipeline`);
  }
});

test('every emitted record carries currency, source and the row timestamp', () => {
  const { priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  for (const r of priceRecords) {
    assert.equal(r.currency, PRICE_CURRENCY);
    assert.equal(r.source, PRICE_SOURCE);
    assert.equal(r.timestamp, SRC_TS, 'timestamp comes from the source row, never fabricated');
    assert.notEqual(r.version, '');
  }
});

// ── Low-cost / exact-version resolution ─────────────────────────────────────

test('the plain printing resolves to its own ¥980 sell price', () => {
  const { priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  assert.equal(resolveExactPrice('hBP04-005', 'BASE', priceRecords).price, 980);
  assert.equal(resolveExactPrice('hBP04-005', 'PARALLEL', priceRecords).price, 9980);
  assert.equal(resolveExactPrice('hBP04-005', 'PARALLEL/SIGN', priceRecords).price, 69800);
});

test('the row-level rarity is never a price key', () => {
  const { priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  // 'SEC' is what both rows declare; no listing proves it, so it stays unpriced.
  assert.equal(resolveExactPrice('hBP04-005', 'SEC', priceRecords).status, 'NO_EXACT_PRICE');
});

test('reprint rows of one card number collapse to one printing set', () => {
  // ent07 + hBP04 rows share the listing set → three cards, three prices, not six.
  const { cards, priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  assert.equal(cards.length, 3);
  assert.equal(priceRecords.length, 3);
  assert.deepEqual(cards.map((c) => c.id).sort(),
    ['hBP04-005#BASE', 'hBP04-005#PARALLEL', 'hBP04-005#PARALLEL/SIGN']);
  // The representative supplies display fields; the card number's own set wins.
  assert.equal(pickRepresentative(HBP04_005_ROWS).series, 'hBP04');
});

// ── Fail closed on ambiguity ────────────────────────────────────────────────

test('two identical labels at different sell prices leave the printing unpriced', () => {
  // Real shape (hBP02-017): the source lists 白銀ノエル(パラレル) twice, ¥3,480 and
  // ¥500. Nothing distinguishes them, so PARALLEL must not be priced at either.
  const rows = [{
    id: 'hBP02-017_hBP02', cardNumber: 'hBP02-017', name: '白銀ノエル',
    rarity: 'UR', series: 'hBP02', timestamp: SRC_TS,
    skillsJp: { cardType: 'Buzzホロメン' },
    prices: [
      { name: '白銀ノエル(パラレル)', sellPrice: 3480, rarity: '' },
      { name: '白銀ノエル(パラレル)', sellPrice: 500, rarity: '' },
      { name: '白銀ノエル', sellPrice: 120, rarity: '', buyPrice: 1 },
    ],
  }];
  const { priceRecords } = adaptCardNumber(rows);
  assert.equal(resolveExactPrice('hBP02-017', 'PARALLEL', priceRecords).status, 'NO_EXACT_PRICE');
  // The unambiguous plain printing is unaffected — ambiguity is per printing.
  assert.equal(resolveExactPrice('hBP02-017', 'BASE', priceRecords).price, 120);
});

test('an explicit base reprint keeps its own price instead of colliding with BASE', () => {
  // Real shape (hBP02-084): the source lists the original みっころね24 at ¥120 and
  // its hBP04 reprint at ¥180. These are NOT ambiguous — the labels say which is
  // which — so reading only パラレル/サイン markers collapsed them onto one key
  // and dropped both prices (DIC-1013 CR blocker).
  const rows = [{
    id: 'hBP02-084_hBP04', cardNumber: 'hBP02-084', name: 'みっころね24',
    rarity: 'SR', series: 'hBP04', timestamp: SRC_TS,
    skillsJp: { cardType: 'サポート・イベント・LIMITED' },
    prices: [
      { name: 'みっころね24(パラレル/箔押し)', sellPrice: 99800, rarity: '' },
      { name: 'みっころね24(パラレル)', sellPrice: 1780, rarity: '', buyPrice: 2000 },
      { name: 'みっころね24', sellPrice: 120, rarity: '' },
      { name: 'みっころね24(パラレル/hBP04)', sellPrice: 5980, rarity: '', buyPrice: 1 },
      { name: 'みっころね24(hBP04)', sellPrice: 180, rarity: '' },
    ],
  }];
  const { cards, priceRecords } = adaptCardNumber(rows);
  assert.equal(resolveExactPrice('hBP02-084', 'BASE', priceRecords).price, 120);
  assert.equal(resolveExactPrice('hBP02-084', 'HBP04', priceRecords).price, 180);
  assert.equal(resolveExactPrice('hBP02-084', 'PARALLEL', priceRecords).price, 1780);
  assert.equal(resolveExactPrice('hBP02-084', 'PARALLEL/HBP04', priceRecords).price, 5980);
  assert.equal(resolveExactPrice('hBP02-084', 'PARALLEL/FOIL', priceRecords).price, 99800);
  // Each printing is separately ownable, and each keeps its raw source label.
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.equal(byId['hBP02-084#BASE'].printingLabel, 'みっころね24');
  assert.equal(byId['hBP02-084#HBP04'].printingLabel, 'みっころね24(hBP04)');
  // Owning the reprint never satisfies a deck slot asking for the original.
  const deck = {
    id: 'd', name: 'reprint', updatedAt: '',
    oshi: [], main: [{ card: byId['hBP02-084#BASE'], qty: 2 }], yell: [],
  };
  const gap = computeGap(deck, { 'hBP02-084|HBP04': 2 }, priceRecords);
  assert.equal(gap.rows[0].owned, 0);
  assert.equal(gap.total, 240);
});

test('a listing with no sell price stays unpriced rather than borrowing one', () => {
  const rows = [{
    id: 'hXX-001', cardNumber: 'hXX-001', name: 'X', rarity: 'R', series: 'hXX',
    timestamp: SRC_TS, skillsJp: { cardType: 'ホロメン' },
    prices: [
      { name: 'X', sellPrice: 500, rarity: '' },
      { name: 'X(パラレル)', sellPrice: null, rarity: '', buyPrice: 4000 },
    ],
  }];
  const { cards, priceRecords } = adaptCardNumber(rows);
  assert.equal(cards.length, 2, 'the parallel printing still exists as a choice');
  assert.equal(resolveExactPrice('hXX-001', 'PARALLEL', priceRecords).status, 'NO_EXACT_PRICE');
  assert.equal(resolveExactPrice('hXX-001', 'BASE', priceRecords).price, 500);
});

test('conflicting records for the same (cardNumber, printing) are all dropped', () => {
  const records = [
    { cardNumber: 'hXX-004', version: 'BASE', price: 100, currency: 'JPY', source: 's', timestamp: SRC_TS },
    { cardNumber: 'hXX-004', version: 'BASE', price: 250, currency: 'JPY', source: 's', timestamp: SRC_TS },
    { cardNumber: 'hXX-004', version: 'PARALLEL', price: 900, currency: 'JPY', source: 's', timestamp: SRC_TS },
  ];
  const kept = dropConflictingPrices(records);
  assert.deepEqual(kept.map((r) => r.version), ['PARALLEL']);
  assert.equal(resolveExactPrice('hXX-004', 'BASE', kept).status, 'NO_EXACT_PRICE');
});

test('a card number with no listings at all yields one unpriced BASE printing', () => {
  const rows = [{
    id: 'hXX-006', cardNumber: 'hXX-006', name: 'Y', rarity: 'C', series: 'hXX',
    timestamp: SRC_TS, skillsJp: { cardType: 'ホロメン' }, prices: [],
  }];
  const { cards, priceRecords } = adaptCardNumber(rows);
  assert.deepEqual(cards.map((c) => c.printing), ['BASE']);
  assert.deepEqual(priceRecords, []);
});

test('unpriced ordinary rows keep BASE default when only S仕様 is listed', () => {
  const rows = [
    {
      id: 'hY01-001_hBP01', cardNumber: 'hY01-001', name: '白エール', series: 'hBP01',
      timestamp: SRC_TS, skillsJp: { cardType: 'エール' }, prices: [],
    },
    {
      id: 'hY01-001', cardNumber: 'hY01-001', name: '白エール(S仕様)', series: '',
      timestamp: SRC_TS, skillsJp: { cardType: 'エール' },
      prices: [{ name: '白エール(S仕様)', sellPrice: 120, rarity: '' }],
    },
  ];
  const { cards, priceRecords } = adaptCardNumber(rows);
  assert.deepEqual(cards.map((c) => c.id), ['hY01-001#BASE', 'hY01-001#S-SPEC']);
  assert.equal(resolveExactPrice('hY01-001', 'BASE', priceRecords).status, 'NO_EXACT_PRICE');
  assert.equal(resolveExactPrice('hY01-001', 'S-SPEC', priceRecords).price, 120);
});

// ── Gap estimate: the screenshot case ───────────────────────────────────────

const deckCard = (cards, id) => {
  const card = cards.find((c) => c.id === id);
  assert.ok(card, `fixture is missing ${id}`);
  return card;
};

test('missing-card subtotal uses the exact plain sell price, never the buy price', () => {
  const { cards, priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  const deck = {
    id: 'd', name: 'screenshot', updatedAt: '',
    oshi: [{ card: deckCard(cards, 'hBP04-005#BASE'), qty: 1 }], main: [], yell: [],
  };
  const gap = computeGap(deck, {}, priceRecords); // own nothing → 1 missing
  assert.equal(gap.total, 980, 'the ¥980 plain sell price, not ¥69,800 and not the ¥150 buy price');
  assert.equal(gap.currency, 'JPY');
  assert.equal(gap.rows[0].versionLabel, 'ラプラス・ダークネス');
  assert.equal(gap.unpriced.length, 0);
});

test('a deliberately picked signed printing is priced at ITS listing, not the base one', () => {
  const { cards, priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  const deck = {
    id: 'd', name: 'premium', updatedAt: '',
    oshi: [{ card: deckCard(cards, 'hBP04-005#PARALLEL/SIGN'), qty: 1 }], main: [], yell: [],
  };
  assert.equal(computeGap(deck, {}, priceRecords).total, 69800);
});

test('owning the plain printing does not satisfy a signed requirement', () => {
  const { cards, priceRecords } = adaptCardNumber(HBP04_005_ROWS);
  const deck = {
    id: 'd', name: 'mixed', updatedAt: '',
    oshi: [{ card: deckCard(cards, 'hBP04-005#PARALLEL/SIGN'), qty: 1 }], main: [], yell: [],
  };
  const gap = computeGap(deck, { 'hBP04-005|BASE': 4 }, priceRecords);
  assert.equal(gap.rows[0].owned, 0);
  assert.equal(gap.total, 69800);
});

// ── Whole-dataset invariants against the committed database ─────────────────

const DB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'database.json'), 'utf8'));
const RAW_CARDS = Object.values(DB.cards || {});
const REAL = adaptDatabase(RAW_CARDS);

// Real cards spanning plain-only, plain+parallel, plain+parallel+signed,
// duplicated-label (fail closed) and explicit base-reprint cases.
const REAL_EXPECTATIONS = [
  { cardNumber: 'hBP04-005', printings: { BASE: 980, PARALLEL: 9980, 'PARALLEL/SIGN': 69800 } },
  { cardNumber: 'hBP04-057', printings: { BASE: 120, PARALLEL: 980 } },
  { cardNumber: 'hBP04-041', printings: { BASE: 50, PARALLEL: 180 } },
  { cardNumber: 'hSD01-001', printings: { BASE: 180 } },
  // Base tracked ¥220 for weeks; 2026-08-23 scrape settled at ¥180 (still the
  // exact source-listed price, no cross-tier collapse). Update the expectation
  // rather than pin to a stale snapshot — the invariant here is exact per-tier
  // pricing, not any particular yen value.
  { cardNumber: 'hBP01-044', printings: { BASE: 180, 'PARALLEL/HR': 9980, 'PARALLEL/HBP07': 80 } },
  { cardNumber: 'hBP02-017', printings: { BASE: 120 }, unpriced: ['PARALLEL'] },
  // Base reprints: original and hBP04 reprint must BOTH keep their exact price.
  {
    cardNumber: 'hBP02-084',
    printings: { BASE: 120, HBP04: 180, PARALLEL: 1780, 'PARALLEL/HBP04': 5980, 'PARALLEL/FOIL': 99800 },
  },
  {
    cardNumber: 'hSD01-017',
    printings: { BASE: 80, HBP04: 120, 'PARALLEL/HBP04': 1980, 'PARALLEL/ベーシックPRパック VOL.3': 980 },
  },
];

test('five+ real cards resolve each printing to its own listed sell price', () => {
  for (const { cardNumber, printings, unpriced = [] } of REAL_EXPECTATIONS) {
    for (const [printing, price] of Object.entries(printings)) {
      const res = resolveExactPrice(cardNumber, printing, REAL.priceRecords);
      assert.equal(res.status, 'ok', `${cardNumber} ${printing} should be priced`);
      assert.equal(res.price, price, `${cardNumber} ${printing}`);
    }
    for (const printing of unpriced) {
      assert.equal(resolveExactPrice(cardNumber, printing, REAL.priceRecords).status,
        'NO_EXACT_PRICE', `${cardNumber} ${printing} is ambiguous and must fail closed`);
    }
  }
});

test('no buy price from the real dataset appears as a deck price', () => {
  // Build the set of (cardNumber, buyPrice) pairs the source states, then assert
  // no emitted record for that card number carries a buy-only amount.
  const sellByNumber = new Map();
  const buyByNumber = new Map();
  const bucket = (map, key) => {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    return set;
  };
  for (const card of RAW_CARDS) {
    for (const p of card.prices || []) {
      if (typeof p.sellPrice === 'number' && p.sellPrice > 0) bucket(sellByNumber, card.cardNumber).add(p.sellPrice);
      if (typeof p.buyPrice === 'number' && p.buyPrice > 0) bucket(buyByNumber, card.cardNumber).add(p.buyPrice);
    }
  }
  const leaked = [];
  for (const r of REAL.priceRecords) {
    if (sellByNumber.get(r.cardNumber)?.has(r.price)) continue; // a real sell price
    if (buyByNumber.get(r.cardNumber)?.has(r.price)) leaked.push(`${r.cardNumber} ${r.version}=${r.price}`);
  }
  assert.deepEqual(leaked, [], 'buy prices leaked into the deck price pipeline: ' + leaked.slice(0, 5).join(', '));
});

test('every real record is an exact, source-labelled printing with provenance', () => {
  assert.ok(REAL.priceRecords.length > 1000, 'the dataset must actually be priced now');
  const seen = new Map();
  for (const r of REAL.priceRecords) {
    assert.notEqual(r.version, '', `${r.cardNumber} emitted an empty printing`);
    assert.equal(r.currency, PRICE_CURRENCY);
    assert.equal(r.source, PRICE_SOURCE);
    assert.ok(r.price > 0);
    const key = `${r.cardNumber}|${r.version}`;
    assert.equal(seen.has(key), false, `duplicate record for ${key} survived the conflict filter`);
    seen.set(key, r.price);
  }
});

test('every real card id is unique and re-derivable from its printing', () => {
  const ids = new Set();
  for (const c of REAL.cards) {
    assert.equal(ids.has(c.id), false, `duplicate card id ${c.id}`);
    ids.add(c.id);
    assert.equal(c.id, `${c.cardNumber}#${c.printing}`);
    assert.equal(printingFromLabel(c.printingLabel), c.printing,
      `${c.id}: printing must be derivable from its own source label`);
  }
});

console.log(`\nDIC-1013 deck price adapter: ${passed} tests passed`);
