#!/usr/bin/env node
/**
 * DIC-1004 §A low-cost default resolver, corrected by DIC-1013 to key on the
 * SOURCE-PROVEN printing instead of the dataset's row-level rarity.
 *
 * Covers: plain beats premium, cheapest exact sell price inside the plain tier,
 * a missing price never borrows a sibling's, search groups printings by card
 * number, 套用低配版本 preserves zone + quantity, pre-DIC-1013 drafts migrate
 * onto real printings without rewriting ownership, and every entry point
 * (search/add, normalization, migration) shares ONE resolver.
 *
 * Run: npm run test:deck-variants
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveLowCostVariant, groupVariantsByCardNumber, searchVariantGroups,
  buildLowCostIndex, normalizeSlotsToLowCost, countLowCostDrift,
  isLegacySlotCard, migrateSlotsToPrintings,
} from '../src/utils/deckVariants.ts';
import { computeGap, resolveExactPrice, ownershipKey } from '../src/utils/deckRules.ts';
import { isPlainPrinting, BASE_PRINTING } from '../src/utils/printingIdentity.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { useDeckStore } from '../src/store/deckStore.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const make = (cardNumber, printing, label, cardTypeJp, series = 'hBP04') => ({
  id: `${cardNumber}#${printing}`,
  cardNumber,
  name: `card ${cardNumber}`,
  printing,
  printingLabel: label,
  series,
  cardTypeJp,
});
const holomen = (cardNumber, printing, label = '') => make(cardNumber, printing, label, 'ホロメン');
const oshi = (cardNumber, printing, label = '') => make(cardNumber, printing, label, '推しホロメン');
const yell = (cardNumber, printing, label = '') => make(cardNumber, printing, label, 'エール');
const price = (cardNumber, version, p, currency = 'JPY') => ({
  cardNumber, version, price: p, currency, source: 'yuyu-tei.jp', timestamp: '2026-08-01',
});

console.log('DIC-1013 low-cost printing resolver');

// ── Default selection ──────────────────────────────────────────────────────
test('the plain printing beats the signed parallel of the same card number', () => {
  const variants = [
    oshi('hBP04-005', 'PARALLEL/SIGN', 'ラプラス・ダークネス(パラレル/サイン)'),
    oshi('hBP04-005', 'PARALLEL', 'ラプラス・ダークネス(パラレル)'),
    oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス'),
  ];
  const records = [
    price('hBP04-005', 'PARALLEL/SIGN', 69800),
    price('hBP04-005', 'PARALLEL', 9980),
    price('hBP04-005', 'BASE', 980),
  ];
  const chosen = resolveLowCostVariant(variants, records);
  assert.equal(chosen.printing, 'BASE');
  assert.equal(resolveExactPrice('hBP04-005', chosen.printing, records).price, 980);
});

test('premium is never the default while ANY plain printing exists, even if cheaper', () => {
  const variants = [
    holomen('hBP01-024', 'PARALLEL', 'x(パラレル)'),
    holomen('hBP01-024', 'BASE', 'x'),
  ];
  // The parallel printing carries the (absurdly) cheaper price — the plain one
  // must still win, because premium defaults are the reported bug.
  const records = [price('hBP01-024', 'PARALLEL', 10), price('hBP01-024', 'BASE', 500)];
  assert.equal(resolveLowCostVariant(variants, records).printing, 'BASE');
});

test('inside the plain tier the lowest exact sell price wins', () => {
  // Real shape (hBP03-027 / hSD07-003): a card number can have no bare listing
  // at all, only errata-marked plain printings.
  const variants = [
    holomen('hBP03-027', 'ERRATA-PRE', 'さくらみこ(エラッタ前)'),
    holomen('hBP03-027', 'ERRATA-POST', 'さくらみこ(エラッタ後)'),
    holomen('hBP03-027', 'PARALLEL/ERRATA-PRE', 'さくらみこ(パラレル)(エラッタ前)'),
  ];
  const records = [
    price('hBP03-027', 'ERRATA-PRE', 30),
    price('hBP03-027', 'ERRATA-POST', 25),
    price('hBP03-027', 'PARALLEL/ERRATA-PRE', 5),
  ];
  const chosen = resolveLowCostVariant(variants, records);
  assert.equal(chosen.printing, 'ERRATA-POST');
  assert.equal(isPlainPrinting(chosen.printing), true);
});

test('prices in a different currency are never compared against the primary one', () => {
  const variants = [
    holomen('hBP01-052', 'BASE', 'x'),
    holomen('hBP01-052', 'ERRATA-POST', 'x(エラッタ後)'),
  ];
  // The USD 1 record must not undercut the JPY context set by the BASE printing.
  const records = [price('hBP01-052', 'BASE', 300), price('hBP01-052', 'ERRATA-POST', 1, 'USD')];
  assert.equal(resolveLowCostVariant(variants, records).printing, 'BASE');
});

test('an unpriced plain printing still wins and stays unpriced, never borrowing', () => {
  const variants = [
    holomen('hBP01-044', 'PARALLEL/HR', 'AZKi(パラレル/HR)'),
    holomen('hBP01-044', 'BASE', 'AZKi'),
  ];
  const records = [price('hBP01-044', 'PARALLEL/HR', 50)];
  const chosen = resolveLowCostVariant(variants, records);
  assert.equal(chosen.printing, 'BASE');
  assert.deepEqual(
    resolveExactPrice(chosen.cardNumber, chosen.printing, records),
    { status: 'NO_EXACT_PRICE' },
  );
});

test('resolution is stable regardless of variant input order', () => {
  const variants = [
    holomen('hBP01-048', 'PARALLEL/SIGN', 'x(パラレル/サイン)'),
    holomen('hBP01-048', 'ERRATA-PRE', 'x(エラッタ前)'),
    holomen('hBP01-048', 'BASE', 'x'),
    holomen('hBP01-048', 'PARALLEL', 'x(パラレル)'),
  ];
  const first = resolveLowCostVariant(variants, []).id;
  assert.equal(resolveLowCostVariant(variants.slice().reverse(), []).id, first);
  assert.equal(first, 'hBP01-048#BASE');
});

test('an all-premium card number still resolves deterministically', () => {
  const variants = [
    oshi('hBP04-090', 'PARALLEL/SIGN', 'x(パラレル/サイン)'),
    oshi('hBP04-090', 'PARALLEL', 'x(パラレル)'),
  ];
  assert.equal(resolveLowCostVariant(variants, []).printing, 'PARALLEL');
  assert.equal(resolveLowCostVariant(variants.slice().reverse(), []).printing, 'PARALLEL');
});

test('unplayable entries are never the default', () => {
  const broken = { id: 'hBP04-057#BASE', cardNumber: 'hBP04-057', name: 'x', printing: 'BASE', printingLabel: '', series: 'ent07' };
  const variants = [broken, holomen('hBP04-057', 'PARALLEL', 'x(パラレル)')];
  assert.equal(resolveLowCostVariant(variants, []).id, 'hBP04-057#PARALLEL');
});

// The committed database really does ship untyped promo rows: `202_hPR`
// ("ReGLOSS") has empty type AND no classifiable card type, so the rules engine
// can place it in no zone. Such a card number must disappear, not fall back.
const regloss202 = {
  id: '202#BASE', cardNumber: '202', name: 'ReGLOSS', type: '',
  printing: 'BASE', printingLabel: '', series: 'hPR',
};

test('a card number whose every printing is unplayable resolves to null', () => {
  assert.equal(resolveLowCostVariant([regloss202], []), null);
  assert.equal(resolveLowCostVariant([regloss202], [price('202', 'BASE', 10)]), null);
});

test('an all-unplayable card number is omitted from grouping and search', () => {
  const cards = [regloss202, holomen('hBP01-024', 'BASE', 'x')];
  const groups = groupVariantsByCardNumber(cards, []);
  assert.deepEqual(groups.map((g) => g.cardNumber), ['hBP01-024']);
  assert.equal(searchVariantGroups(groups, '202').length, 0);
  assert.equal(searchVariantGroups(groups, 'ReGLOSS').length, 0);
  assert.equal(buildLowCostIndex(groups).has('202'), false);
});

// ── Search grouping ────────────────────────────────────────────────────────
test('search returns one row per card number, carrying the low-cost default', () => {
  const cards = [
    holomen('hBP04-057', 'PARALLEL', 'ラプラス・ダークネス(パラレル)'),
    holomen('hBP04-057', 'BASE', 'ラプラス・ダークネス'),
    holomen('hBP01-024', 'PARALLEL', 'x(パラレル)'),
  ];
  const groups = groupVariantsByCardNumber(cards, []);
  assert.equal(groups.length, 2);
  const hit = searchVariantGroups(groups, 'hBP04-057');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].card.printing, 'BASE');
  assert.equal(hit[0].variants.length, 2, 'the premium printing stays selectable in the group');
});

test('two card numbers sharing a listing label never collide', () => {
  // hBP04-005 and hBP04-057 are both ラプラス・ダークネス: identical labels, hence
  // identical printing tokens. Identity is (cardNumber, printing), so the two
  // must stay separate groups with separate prices.
  const cards = [
    oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス'),
    holomen('hBP04-057', 'BASE', 'ラプラス・ダークネス'),
  ];
  const records = [price('hBP04-005', 'BASE', 980), price('hBP04-057', 'BASE', 120)];
  const groups = groupVariantsByCardNumber(cards, records);
  assert.equal(groups.length, 2);
  assert.equal(resolveExactPrice('hBP04-005', 'BASE', records).price, 980);
  assert.equal(resolveExactPrice('hBP04-057', 'BASE', records).price, 120);
  assert.notEqual(ownershipKey('hBP04-005', 'BASE'), ownershipKey('hBP04-057', 'BASE'));
});

// ── Existing-draft normalization ───────────────────────────────────────────
test('套用低配版本 preserves zone and quantity while swapping the printing', () => {
  const signedOshi = oshi('hBP04-005', 'PARALLEL/SIGN', 'ラプラス・ダークネス(パラレル/サイン)');
  const plainOshi = oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス');
  const parMain = holomen('hBP04-057', 'PARALLEL', 'ラプラス・ダークネス(パラレル)');
  const plainMain = holomen('hBP04-057', 'BASE', 'ラプラス・ダークネス');
  const index = buildLowCostIndex(groupVariantsByCardNumber(
    [signedOshi, plainOshi, parMain, plainMain], [],
  ));

  assert.deepEqual(
    normalizeSlotsToLowCost([{ card: signedOshi, qty: 1 }], 'oshi', index),
    [{ card: plainOshi, qty: 1 }],
  );
  const normalizedMain = normalizeSlotsToLowCost([{ card: parMain, qty: 4 }], 'main', index);
  assert.equal(normalizedMain[0].card.id, plainMain.id);
  assert.equal(normalizedMain[0].qty, 4);
});

test('slots collapsing onto the same printing merge their quantities', () => {
  const a = holomen('hBP01-070', 'PARALLEL', 'x(パラレル)');
  const b = holomen('hBP01-070', 'PARALLEL/SIGN', 'x(パラレル/サイン)');
  const plain = holomen('hBP01-070', 'BASE', 'x');
  const index = buildLowCostIndex(groupVariantsByCardNumber([a, b, plain], []));
  const out = normalizeSlotsToLowCost([{ card: a, qty: 2 }, { card: b, qty: 1 }], 'main', index);
  assert.equal(out.length, 1);
  assert.equal(out[0].card.id, plain.id);
  assert.equal(out[0].qty, 3);
});

test('a replacement that would change the slot zone is skipped', () => {
  const yellSlotCard = yell('hY01-001', 'PARALLEL', 'x(パラレル)');
  const index = new Map([['hY01-001', holomen('hY01-001', 'BASE', 'x')]]);
  const out = normalizeSlotsToLowCost([{ card: yellSlotCard, qty: 20 }], 'yell', index);
  assert.deepEqual(out, [{ card: yellSlotCard, qty: 20 }]);
});

test('drift count reports only slots the action would actually rewrite', () => {
  const parMain = holomen('hBP04-057', 'PARALLEL', 'x(パラレル)');
  const plainMain = holomen('hBP04-057', 'BASE', 'x');
  const index = buildLowCostIndex(groupVariantsByCardNumber([parMain, plainMain], []));
  const deck = { id: 'd', name: 'd', oshi: [], main: [{ card: parMain, qty: 3 }], yell: [], updatedAt: '' };
  assert.equal(countLowCostDrift(deck, index), 1);

  const normalized = { ...deck, main: normalizeSlotsToLowCost(deck.main, 'main', index) };
  assert.equal(countLowCostDrift(normalized, index), 0);
});

test('normalization does not rewrite collection ownership, so the gap re-targets the new printing', () => {
  const parMain = holomen('hBP04-057', 'PARALLEL', 'x(パラレル)');
  const plainMain = holomen('hBP04-057', 'BASE', 'x');
  const index = buildLowCostIndex(groupVariantsByCardNumber([parMain, plainMain], []));
  const collection = { 'hBP04-057|PARALLEL': 2 };
  const deck = { id: 'd', name: 'd', oshi: [], main: [{ card: parMain, qty: 3 }], yell: [], updatedAt: '' };

  const before = computeGap(deck, collection, []);
  assert.equal(before.rows[0].owned, 2);
  assert.equal(before.rows[0].missing, 1);

  const after = computeGap(
    { ...deck, main: normalizeSlotsToLowCost(deck.main, 'main', index) },
    collection,
    [],
  );
  // Ownership of the parallel printing is untouched and does NOT transfer.
  assert.deepEqual(collection, { 'hBP04-057|PARALLEL': 2 });
  assert.equal(after.rows[0].version, 'BASE');
  assert.equal(after.rows[0].owned, 0);
  assert.equal(after.rows[0].missing, 3);
});

test('a priced low-cost default produces an exact-version sell estimate', () => {
  const variants = [
    holomen('hBP01-052', 'PARALLEL', 'x(パラレル)'),
    holomen('hBP01-052', 'BASE', 'x'),
  ];
  const records = [price('hBP01-052', 'BASE', 80), price('hBP01-052', 'PARALLEL', 9800)];
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

// ── Pre-DIC-1013 draft migration ───────────────────────────────────────────
// A slot persisted under the old model keys its version off the row-level rarity
// and carries no `printing` field at all.
const legacySlotCard = (cardNumber, rarity, series, cardTypeJp) => ({
  id: `${cardNumber}_${series}`, cardNumber, name: `card ${cardNumber}`,
  rarity, series, cardTypeJp,
});

test('a legacy slot is recognised, a migrated one is not', () => {
  assert.equal(isLegacySlotCard(legacySlotCard('hBP04-005', 'SEC', 'ent07', '推しホロメン')), true);
  assert.equal(isLegacySlotCard(oshi('hBP04-005', 'BASE', 'x')), false);
  assert.equal(isLegacySlotCard({ ...oshi('hBP04-005', 'BASE', 'x'), printing: '' }), true);
});

test('migration moves the screenshot draft onto the plain ¥980 printing', () => {
  const legacy = legacySlotCard('hBP04-005', 'SEC', 'ent07', '推しホロメン');
  const plain = oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス');
  const records = [price('hBP04-005', 'BASE', 980), price('hBP04-005', 'PARALLEL/SIGN', 69800)];
  const index = buildLowCostIndex(groupVariantsByCardNumber(
    [oshi('hBP04-005', 'PARALLEL/SIGN', 'ラプラス・ダークネス(パラレル/サイン)'), plain], records,
  ));
  const out = migrateSlotsToPrintings([{ card: legacy, qty: 1 }], 'oshi', index);
  assert.equal(out[0].card.id, 'hBP04-005#BASE');
  assert.equal(out[0].qty, 1, 'quantity is the player’s data and is preserved');
  const gap = computeGap(
    { id: 'd', name: 'd', oshi: out, main: [], yell: [], updatedAt: '' }, {}, records,
  );
  assert.equal(gap.total, 980);
});

test('migration never downgrades an already-migrated premium pick', () => {
  const signed = oshi('hBP04-005', 'PARALLEL/SIGN', 'ラプラス・ダークネス(パラレル/サイン)');
  const plain = oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス');
  const index = new Map([['hBP04-005', plain]]);
  assert.deepEqual(
    migrateSlotsToPrintings([{ card: signed, qty: 1 }], 'oshi', index),
    [{ card: signed, qty: 1 }],
  );
});

test('a legacy slot whose card number left the dataset survives as an unpriced BASE slot', () => {
  const legacy = legacySlotCard('hZZ-999', 'C', 'hZZ', 'ホロメン');
  const out = migrateSlotsToPrintings([{ card: legacy, qty: 4 }], 'main', new Map());
  assert.equal(out[0].card.printing, BASE_PRINTING);
  assert.equal(out[0].card.printingLabel, '');
  assert.equal(out[0].qty, 4);
  assert.equal(resolveExactPrice('hZZ-999', BASE_PRINTING, []).status, 'NO_EXACT_PRICE');
});

test('a legacy slot is not migrated into a different zone', () => {
  const legacy = legacySlotCard('hY01-001', 'SEC', 'ent07', 'エール');
  const index = new Map([['hY01-001', holomen('hY01-001', 'BASE', 'x')]]);
  const out = migrateSlotsToPrintings([{ card: legacy, qty: 20 }], 'yell', index);
  assert.equal(out[0].card.printing, BASE_PRINTING, 'stays a yell card on the unmarked printing');
  assert.equal(out[0].card.cardTypeJp, 'エール');
  assert.equal(out[0].qty, 20);
});

test('the store migrates every zone once and never rewrites the collection', () => {
  const legacyOshi = legacySlotCard('hBP04-005', 'SEC', 'ent07', '推しホロメン');
  const legacyMain = legacySlotCard('hBP04-057', 'S', 'hPR', 'ホロメン');
  const legacyYell = legacySlotCard('hY01-001', 'C', 'hBP01', 'エール');
  const index = new Map([
    ['hBP04-005', oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス')],
    ['hBP04-057', holomen('hBP04-057', 'BASE', 'ラプラス・ダークネス')],
    ['hY01-001', yell('hY01-001', 'BASE', 'x')],
  ]);

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: { 'hBP04-005|SEC': 1 } });
  const deckId = useDeckStore.getState().createDeck('螢幕截圖牌組');
  useDeckStore.getState().changeCard(deckId, 'oshi', legacyOshi, 1);
  useDeckStore.getState().changeCard(deckId, 'main', legacyMain, 4);
  useDeckStore.getState().changeCard(deckId, 'yell', legacyYell, 20);

  useDeckStore.getState().migrateLegacyPrintings(index);
  const deck = () => useDeckStore.getState().decks.find((d) => d.id === deckId);
  assert.equal(deck().oshi[0].card.id, 'hBP04-005#BASE');
  assert.equal(deck().main[0].card.id, 'hBP04-057#BASE');
  assert.equal(deck().yell[0].card.id, 'hY01-001#BASE');
  assert.deepEqual([deck().oshi[0].qty, deck().main[0].qty, deck().yell[0].qty], [1, 4, 20]);

  // Owning an SEC copy does not prove ownership of the plain printing.
  assert.deepEqual(useDeckStore.getState().collection, { 'hBP04-005|SEC': 1 });

  // Idempotent: a second pass is a no-op and does not touch the deck object.
  const before = deck();
  useDeckStore.getState().migrateLegacyPrintings(index);
  assert.equal(deck(), before, 'a settled deck must not be re-created');
});

test('the store action normalizes an existing draft across all three zones', () => {
  const signedOshi = oshi('hBP04-005', 'PARALLEL/SIGN', 'ラプラス・ダークネス(パラレル/サイン)');
  const plainOshi = oshi('hBP04-005', 'BASE', 'ラプラス・ダークネス');
  const parMain = holomen('hBP04-057', 'PARALLEL', 'ラプラス・ダークネス(パラレル)');
  const plainMain = holomen('hBP04-057', 'BASE', 'ラプラス・ダークネス');
  const yellCard = yell('hY01-001', 'BASE', 'x');
  const index = buildLowCostIndex(groupVariantsByCardNumber(
    [signedOshi, plainOshi, parMain, plainMain, yellCard], [],
  ));

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: { 'hBP04-057|PARALLEL': 2 } });
  const deckId = useDeckStore.getState().createDeck('螢幕截圖牌組');
  useDeckStore.getState().changeCard(deckId, 'oshi', signedOshi, 1);
  useDeckStore.getState().changeCard(deckId, 'main', parMain, 4);
  useDeckStore.getState().changeCard(deckId, 'yell', yellCard, 20);

  useDeckStore.getState().applyLowCostVariants(deckId, index);

  const deck = useDeckStore.getState().decks.find((d) => d.id === deckId);
  assert.deepEqual(deck.oshi, [{ card: plainOshi, qty: 1 }]);
  assert.deepEqual(deck.main, [{ card: plainMain, qty: 4 }]);
  assert.deepEqual(deck.yell, [{ card: yellCard, qty: 20 }]);
  assert.deepEqual(useDeckStore.getState().collection, { 'hBP04-057|PARALLEL': 2 });
});

// ── One shared resolver over the real database ─────────────────────────────
// Every deck entry point (search/add, 套用低配版本, legacy-draft migration and
// any future import such as DIC-1000's tournament decklists) must land on the
// SAME DeckCard for a card number. They all read buildLowCostIndex, so pin the
// three observable paths together over the real dataset.
const REAL = adaptDatabase(Object.values(
  JSON.parse(fs.readFileSync('data/database.json', 'utf-8')).cards,
));
const REAL_GROUPS = groupVariantsByCardNumber(REAL.cards, REAL.priceRecords);
const REAL_INDEX = buildLowCostIndex(REAL_GROUPS);

test('search/add, normalization and migration agree on the default printing', () => {
  const sample = [
    'hBP04-005', 'hBP04-057', 'hBP04-041', 'hSD01-001', 'hBP01-044', 'hBP03-027',
    'hBP02-084', 'hSD01-017',
  ];
  for (const cardNumber of sample) {
    const group = REAL_GROUPS.find((g) => g.cardNumber === cardNumber);
    assert.ok(group, `${cardNumber} must be offered by search`);
    const expected = group.card;
    const zone = expected.cardTypeJp.includes('推し') ? 'oshi'
      : expected.cardTypeJp.includes('エール') ? 'yell' : 'main';

    // search/add path
    const hit = searchVariantGroups(REAL_GROUPS, cardNumber);
    assert.equal(hit[0].card.id, expected.id, `${cardNumber}: search default`);
    // 套用低配版本 path — a premium slot normalizes onto the same card
    const premium = group.variants.find((v) => !isPlainPrinting(v.printing)) ?? expected;
    const normalized = normalizeSlotsToLowCost([{ card: premium, qty: 2 }], zone, REAL_INDEX);
    assert.equal(normalized[0].card.id, expected.id, `${cardNumber}: normalization default`);
    // migration path — a pre-DIC-1013 slot lands on the same card
    const legacy = { ...expected, id: `${cardNumber}_legacy`, printing: undefined };
    const migrated = migrateSlotsToPrintings([{ card: legacy, qty: 2 }], zone, REAL_INDEX);
    assert.equal(migrated[0].card.id, expected.id, `${cardNumber}: migration default`);
  }
});

test('every real default is playable, and plain whenever the source lists one', () => {
  let plainDefaults = 0;
  for (const group of REAL_GROUPS) {
    const hasPlain = group.variants.some((v) => isPlainPrinting(v.printing));
    if (hasPlain) {
      assert.equal(isPlainPrinting(group.card.printing), true,
        `${group.cardNumber} defaulted to ${group.card.printing} despite a plain listing`);
      plainDefaults += 1;
    }
    assert.equal(group.card.cardNumber, group.cardNumber);
  }
  assert.ok(plainDefaults > 500, `too few plain defaults to be meaningful (${plainDefaults})`);
});

test('hBP04-005 really defaults to the ¥980 plain printing in the shipped data', () => {
  const chosen = REAL_INDEX.get('hBP04-005');
  assert.equal(chosen.id, 'hBP04-005#BASE');
  assert.equal(chosen.printingLabel, 'ラプラス・ダークネス');
  const gap = computeGap(
    { id: 'd', name: 'd', oshi: [{ card: chosen, qty: 1 }], main: [], yell: [], updatedAt: '' },
    {},
    REAL.priceRecords,
  );
  assert.equal(gap.total, 980, 'not ¥69,800 (signed) and not ¥150 (store buy price)');
  assert.equal(REAL_INDEX.get('hBP04-057').id, 'hBP04-057#BASE');
});

test('an explicit base reprint is a separate, separately priced deck choice', () => {
  // hBP02-084 ships both みっころね24 ¥120 and みっころね24(hBP04) ¥180; hSD01-017
  // ships マネちゃん ¥80 and マネちゃん(hBP04) ¥120. Both printings must be
  // offered, both must be priced, and the cheaper original must win the default.
  for (const [cardNumber, base, reprint] of [['hBP02-084', 120, 180], ['hSD01-017', 80, 120]]) {
    const group = REAL_GROUPS.find((g) => g.cardNumber === cardNumber);
    const ids = group.variants.map((v) => v.id);
    assert.ok(ids.includes(`${cardNumber}#BASE`), `${cardNumber} must offer the original printing`);
    assert.ok(ids.includes(`${cardNumber}#HBP04`), `${cardNumber} must offer the hBP04 reprint`);
    assert.equal(group.card.id, `${cardNumber}#BASE`, `${cardNumber} defaults to the cheaper original`);

    const estimate = (card) => computeGap(
      { id: 'd', name: 'd', oshi: [], main: [{ card, qty: 1 }], yell: [], updatedAt: '' },
      {},
      REAL.priceRecords,
    );
    assert.equal(estimate(group.card).total, base, `${cardNumber} original price`);
    const reprintCard = group.variants.find((v) => v.id === `${cardNumber}#HBP04`);
    assert.equal(estimate(reprintCard).total, reprint, `${cardNumber} reprint price`);
  }
});

console.log(`\n${passed} checks passed`);
