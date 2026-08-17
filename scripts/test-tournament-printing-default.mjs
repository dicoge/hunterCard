#!/usr/bin/env node
/**
 * DIC-1060 — a tournament slot whose printing the source did not prove must
 * default to the SAME CARD NUMBER's lowest ORDINARY (non-parallel) printing, and
 * be priced at that printing's player-facing yuyu-tei sell price.
 *
 * DIC-1033 shipped the opposite rule: every slot of a Deck Log deck landed on
 * the UNRESOLVED sentinel, so an imported deck priced entirely NO_EXACT_PRICE
 * and could not estimate its completion cost. The product rule this file
 * encodes supersedes it:
 *
 *   • a printing the source EXPLICITLY proves is preserved exactly — never
 *     downgraded onto the default;
 *   • otherwise the slot intentionally adopts the lowest ordinary/base printing
 *     of the EXACT same card number, marked `defaultedPrinting` (a deliberate
 *     planning default) rather than `sourceProven`;
 *   • version priority precedes market price: an ordinary ¥220 printing wins
 *     over a ¥80 parallel of the same number;
 *   • when a card number has no ordinary printing at all, the slot still fails
 *     closed on UNRESOLVED rather than crossing onto a premium version.
 *
 * Every price assertion is checked against an oracle built straight off the raw
 * shipped listings in `public/data/database.json` rather than off the resolver
 * under test, so a resolver that silently changes its mind cannot make this file
 * agree with it. The oracle shares the printing-IDENTITY primitives
 * (`buildSourcePrintings` / `isPlainPrinting`) — identity is the one thing both
 * sides must agree on for a comparison to mean anything — but it does the tier
 * filtering and the lowest-price SELECTION itself, which is the behaviour under
 * test. The five reported prices are additionally pinned as literals below.
 *
 * Run: npm run test:tournament-printing-default
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  UNRESOLVED_PRINTING,
  buildCatalogIndex,
  buildImportedDeck,
  resolveSlotCard,
} from '../src/utils/tournamentDeckImport.ts';
import { computeGap, deckStats, isDeckLegal, validateDeck } from '../src/utils/deckRules.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { buildLowCostIndex, groupVariantsByCardNumber } from '../src/utils/deckVariants.ts';
import { buildSourcePrintings, isPlainPrinting } from '../src/utils/printingIdentity.ts';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const STORE_KEY = 'hunterCard-decks';
const IMPORTED_AT = '2026-08-17T00:00:00.000Z';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function resetStore() {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.removeItem(STORE_KEY);
}

// ── Real shipped artefacts ───────────────────────────────────────────────────
const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));
const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const rawRows = Object.values(rawDb.cards || {});
const db = adaptDatabase(rawRows);
const catalog = buildCatalogIndex(db.cards);
const lowCostIndex = buildLowCostIndex(groupVariantsByCardNumber(db.cards, db.priceRecords));

const augustEvent = august.events[0];
const deckByCode = (code) => augustEvent.decks.find((d) => d.decklogCode === code);
const DUKHN = deckByCode('DUKHN');
const H2 = deckByCode('2H33J8');
assert.ok(DUKHN && H2, 'both real August decks must be present in the shipped report');

const importOf = (deck, existingNames = []) =>
  buildImportedDeck(augustEvent, deck, catalog, db.priceRecords, existingNames, IMPORTED_AT);

const draftToDeck = (draft) => ({
  id: 'test', name: draft.name, oshi: draft.oshi, main: draft.main, yell: draft.yell,
  updatedAt: IMPORTED_AT, origin: draft.origin,
});

const slotsOf = (deckLike) => [...deckLike.oshi, ...deckLike.main, ...deckLike.yell];
const slotFor = (deckLike, cardNumber) =>
  slotsOf(deckLike).find((s) => s.card.cardNumber === cardNumber);

/**
 * INDEPENDENT oracle: the lowest ordinary printing of a card number, read from
 * the raw shipped listings rather than from the module under test. Returns null
 * when the number has no priced ordinary listing at all.
 */
function expectedOrdinary(cardNumber) {
  const listings = rawRows
    .filter((r) => r.cardNumber === cardNumber)
    .flatMap((r) => r.prices ?? []);
  const ordinary = buildSourcePrintings(listings)
    .filter((p) => isPlainPrinting(p.printing) && typeof p.sellPrice === 'number');
  if (ordinary.length === 0) return null;
  return ordinary.slice().sort((a, b) => a.sellPrice - b.sellPrice)[0];
}

/** Every sell price the source lists for a card number, ordinary or premium. */
function allSellPrices(cardNumber) {
  return rawRows
    .filter((r) => r.cardNumber === cardNumber)
    .flatMap((r) => r.prices ?? [])
    .map((p) => p.sellPrice)
    .filter((p) => typeof p === 'number');
}

// The exact production regressions the user reported, with the price each slot
// must now carry. Kept as literals so a dataset change that moves them is a
// loud failure rather than a silently re-derived "expectation".
const EXAMPLES = [
  { cardNumber: 'hBP07-006', ordinary: 1280, mustNotUse: [29800, 148000] },
  { cardNumber: 'hBP01-044', ordinary: 220, mustNotUse: [80, 9980] },
  { cardNumber: 'hBP01-045', ordinary: 180, mustNotUse: [] },
  { cardNumber: 'hBP01-046', ordinary: 180, mustNotUse: [980] },
  { cardNumber: 'hSD01-009', ordinary: 320, mustNotUse: [7980] },
];

// ── 1. The five reported production regressions ──────────────────────────────
await test('the raw shipped listings really do carry the reported prices', () => {
  for (const ex of EXAMPLES) {
    const oracle = expectedOrdinary(ex.cardNumber);
    assert.ok(oracle, `${ex.cardNumber}: precondition — an ordinary listing exists`);
    assert.equal(
      oracle.sellPrice, ex.ordinary,
      `${ex.cardNumber}: the ordinary listing is ¥${ex.ordinary}`,
    );
    const prices = allSellPrices(ex.cardNumber);
    for (const wrong of ex.mustNotUse) {
      assert.ok(prices.includes(wrong), `${ex.cardNumber}: decoy ¥${wrong} is really listed`);
    }
  }
});

await test('every reported DUKHN slot now prices at its ordinary printing', () => {
  const imported = draftToDeck(importOf(DUKHN));
  const gap = computeGap(imported, {}, db.priceRecords);

  for (const ex of EXAMPLES) {
    const slot = slotFor(imported, ex.cardNumber);
    assert.ok(slot, `${ex.cardNumber} must be a slot of the imported deck`);

    const oracle = expectedOrdinary(ex.cardNumber);
    assert.equal(
      slot.card.printing, oracle.printing,
      `${ex.cardNumber}: the slot must adopt the ordinary printing`,
    );
    assert.equal(slot.card.defaultedPrinting, true, `${ex.cardNumber}: marked as a default`);
    assert.notEqual(
      slot.card.unresolvedPrinting, true,
      `${ex.cardNumber}: a defaulted slot is no longer unresolved`,
    );

    const row = gap.rows.find((r) => r.cardNumber === ex.cardNumber);
    assert.equal(row.price.status, 'ok', `${ex.cardNumber}: must have an exact version price`);
    assert.equal(
      row.price.price, ex.ordinary,
      `${ex.cardNumber}: unit price must be the ordinary ¥${ex.ordinary}`,
    );
    assert.equal(row.price.currency, 'JPY');
    assert.equal(
      row.subtotal, ex.ordinary * row.missing,
      `${ex.cardNumber}: subtotal is the ordinary price times the shortage`,
    );
    for (const wrong of ex.mustNotUse) {
      assert.notEqual(row.price.price, wrong, `${ex.cardNumber}: must not price at ¥${wrong}`);
    }
  }
});

// ── 2. Version priority precedes market price ────────────────────────────────
await test('an ordinary ¥220 printing beats a ¥80 parallel of the same number', () => {
  // hBP01-044 really ships BASE ¥220 alongside a CHEAPER パラレル/hBP07 at ¥80.
  // The cheapest listing is therefore the wrong answer on purpose.
  const prices = allSellPrices('hBP01-044');
  assert.equal(Math.min(...prices), 80, 'precondition: the parallel is the cheapest listing');

  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hBP01-044', version: 'P', count: 2 },
    catalog,
    db.priceRecords,
  );
  assert.equal(card.printing, 'BASE');
  assert.ok(isPlainPrinting(card.printing), 'the chosen printing must be ordinary');
  assert.equal(
    expectedOrdinary('hBP01-044').sellPrice, 220,
    'and it is priced at the ordinary ¥220, not the globally cheapest ¥80',
  );
});

await test('an ordinary ¥1,280 printing beats the parallel and the signed parallel', () => {
  const card = resolveSlotCard(
    { zone: 'oshi', cardNumber: 'hBP07-006', version: 'OSR', count: 1 },
    catalog,
    db.priceRecords,
  );
  assert.equal(card.printing, 'BASE');
  assert.equal(card.defaultedPrinting, true);
  assert.equal(card.sourceVersion, 'OSR', 'the source grade survives as provenance');
  assert.notEqual(card.printing, 'PARALLEL');
  assert.notEqual(card.printing, 'PARALLEL/SIGN');
});

// ── 3. Exact card number only ────────────────────────────────────────────────
await test('the default is drawn from the EXACT same card number, never a sibling', () => {
  const imported = draftToDeck(importOf(DUKHN));
  for (const ref of DUKHN.cards) {
    const slot = slotFor(imported, ref.cardNumber);
    assert.equal(slot.card.cardNumber, ref.cardNumber, 'card number is copied verbatim');
    assert.equal(slot.qty, ref.count, 'quantity is copied verbatim');
    const local = catalog.get(ref.cardNumber).map((c) => c.printing);
    assert.ok(
      local.includes(slot.card.printing) || slot.card.printing === UNRESOLVED_PRINTING,
      `${ref.cardNumber}: the printing must belong to this very card number`,
    );
  }
});

await test('an unknown card number still resolves to nothing at all', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hZZ-999', version: 'C', count: 1 },
    catalog,
    db.priceRecords,
  );
  assert.equal(card, null, 'a number the catalog does not know is never substituted');
});

// ── 4. A source-proven printing is preserved, never downgraded ───────────────
const decoyCatalog = buildCatalogIndex([
  {
    id: 'hDX-001#BASE', cardNumber: 'hDX-001', name: 'decoy', printing: 'BASE',
    printingLabel: 'decoy', series: 'hDX', cardTypeJp: 'ホロメン',
  },
  {
    id: 'hDX-001#PARALLEL', cardNumber: 'hDX-001', name: 'decoy', printing: 'PARALLEL',
    printingLabel: 'decoy(パラレル)', series: 'hDX', cardTypeJp: 'ホロメン',
  },
  {
    id: 'hDX-001#PARALLEL/SIGN', cardNumber: 'hDX-001', name: 'decoy', printing: 'PARALLEL/SIGN',
    printingLabel: 'decoy(パラレル/サイン)', series: 'hDX', cardTypeJp: 'ホロメン',
  },
]);
const decoyPrices = [
  { cardNumber: 'hDX-001', version: 'BASE', price: 500, currency: 'JPY', source: 't', timestamp: 'T' },
  { cardNumber: 'hDX-001', version: 'PARALLEL', price: 60, currency: 'JPY', source: 't', timestamp: 'T' },
  { cardNumber: 'hDX-001', version: 'PARALLEL/SIGN', price: 90000, currency: 'JPY', source: 't', timestamp: 'T' },
];

await test('a source-proven premium printing is preserved exactly, never defaulted down', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL/SIGN', count: 1, printingProven: true },
    decoyCatalog,
    decoyPrices,
  );
  assert.equal(card.printing, 'PARALLEL/SIGN', 'a proven printing is kept as published');
  assert.notEqual(card.defaultedPrinting, true, 'and is NOT labelled a default');
  assert.notEqual(card.unresolvedPrinting, true);
});

await test('an unproven token defaults to the ordinary printing, not to the token', () => {
  for (const version of ['PARALLEL', 'PARALLEL/SIGN', 'SEC', 'OSR', 'RR', null]) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version, count: 1 },
      decoyCatalog,
      decoyPrices,
    );
    assert.equal(
      card.printing, 'BASE',
      `version ${version ?? '(none)'}: an unproven token may not select its own printing`,
    );
    assert.equal(card.defaultedPrinting, true);
    if (version) assert.equal(card.sourceVersion, version, 'the token survives as provenance');
  }
});

await test('a merely truthy proof claim is still not proof', () => {
  for (const printingProven of [false, 'true', 1, 'yes', null, undefined, {}]) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL', count: 1, printingProven },
      decoyCatalog,
      decoyPrices,
    );
    assert.equal(
      card.printing, 'BASE',
      `printingProven=${JSON.stringify(printingProven)} must not unlock the parallel`,
    );
  }
});

// ── 5. No ordinary printing → fail closed, never a premium substitute ────────
const premiumOnlyCatalog = buildCatalogIndex([
  {
    id: 'hPX-001#PARALLEL', cardNumber: 'hPX-001', name: 'premium only', printing: 'PARALLEL',
    printingLabel: 'premium only(パラレル)', series: 'hPX', cardTypeJp: 'ホロメン',
  },
  {
    id: 'hPX-001#PARALLEL/SIGN', cardNumber: 'hPX-001', name: 'premium only',
    printing: 'PARALLEL/SIGN', printingLabel: 'premium only(パラレル/サイン)',
    series: 'hPX', cardTypeJp: 'ホロメン',
  },
]);

await test('a card number with no ordinary printing fails closed on UNRESOLVED', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hPX-001', version: 'SEC', count: 1 },
    premiumOnlyCatalog,
    [
      { cardNumber: 'hPX-001', version: 'PARALLEL', price: 30, currency: 'JPY', source: 't', timestamp: 'T' },
    ],
  );
  assert.equal(card.printing, UNRESOLVED_PRINTING, 'no ordinary printing → no default at all');
  assert.equal(card.unresolvedPrinting, true);
  assert.notEqual(card.defaultedPrinting, true);
  assert.equal(card.cardNumber, 'hPX-001', 'the card number is still exact');
  assert.equal(card.sourceVersion, 'SEC');
});

await test('an ordinary printing with no listed price is still an honest default', () => {
  // hY05-003 really ships with no listings at all, so its only printing is the
  // unlabelled base one. Defaulting there is correct; PRICING it is not.
  const card = resolveSlotCard(
    { zone: 'yell', cardNumber: 'hY05-003', version: 'SY', count: 20 },
    catalog,
    db.priceRecords,
  );
  assert.equal(expectedOrdinary('hY05-003'), null, 'precondition: no priced ordinary listing');
  assert.equal(card.printing, 'BASE');
  assert.equal(card.defaultedPrinting, true);
  const gap = computeGap(
    { id: 'x', name: 'x', oshi: [], main: [], yell: [{ card, qty: 20 }], updatedAt: IMPORTED_AT },
    {},
    db.priceRecords,
  );
  assert.equal(gap.rows[0].price.status, 'NO_EXACT_PRICE', 'an unpriced printing stays unpriced');
  assert.equal(gap.total, 0, 'and contributes nothing to the total');
});

// ── 6. The imported deck is still exactly the deck the source published ──────
for (const deck of [DUKHN, H2]) {
  await test(`${deck.decklogCode}: still imports as exactly 1 / 50 / 20`, () => {
    const imported = draftToDeck(importOf(deck));
    const stats = deckStats(imported);
    assert.equal(stats.oshi, 1);
    assert.equal(stats.main, 50);
    assert.equal(stats.yell, 20);
    assert.equal(stats.total, 71);
    assert.deepEqual(validateDeck(imported).filter((i) => i.level === 'error'), []);
    assert.equal(isDeckLegal(imported), true);
    for (const ref of deck.cards) {
      assert.equal(slotFor(imported, ref.cardNumber).qty, ref.count);
    }
  });

  await test(`${deck.decklogCode}: every slot is defaulted or honestly unresolved`, () => {
    const draft = importOf(deck);
    const slots = slotsOf(draft);
    assert.equal(
      draft.defaultedPrintings + draft.unresolvedPrintings, slots.length,
      'every slot is accounted for by exactly one of the two states',
    );
    for (const s of slots) {
      const defaulted = s.card.defaultedPrinting === true;
      const unresolved = s.card.unresolvedPrinting === true;
      assert.ok(defaulted !== unresolved, `${s.card.cardNumber}: exactly one state`);
      if (defaulted) {
        assert.ok(isPlainPrinting(s.card.printing), `${s.card.cardNumber}: ordinary printing only`);
      }
    }
  });
}

// ── 7. Exact shortage totals and price-alert eligibility ─────────────────────
await test('the shortage total uses only ordinary-printing SELL prices', () => {
  for (const [code, deck] of [['DUKHN', DUKHN], ['2H33J8', H2]]) {
    const imported = draftToDeck(importOf(deck));
    const gap = computeGap(imported, {}, db.priceRecords);

    // Independent oracle: sum the raw listings' lowest ordinary sell price.
    let expected = 0;
    for (const ref of deck.cards) {
      const oracle = expectedOrdinary(ref.cardNumber);
      if (oracle) expected += oracle.sellPrice * ref.count;
    }
    assert.equal(gap.total, expected, `${code}: total must equal the ordinary-price sum`);
    assert.equal(gap.currency, 'JPY');
    assert.deepEqual(
      gap.subtotals.map((s) => s.currency), ['JPY'],
      `${code}: a single-currency total`,
    );

    // No buy price may leak in: every store buy price of these numbers differs
    // from the sell price we charged, and none of them appears as a unit price.
    const buyPrices = new Set(
      deck.cards.flatMap((ref) => rawRows
        .filter((r) => r.cardNumber === ref.cardNumber)
        .flatMap((r) => r.prices ?? [])
        .map((p) => p.buyPrice)
        .filter((p) => typeof p === 'number')),
    );
    for (const row of gap.rows) {
      if (row.price.status !== 'ok') continue;
      const oracle = expectedOrdinary(row.cardNumber);
      assert.equal(row.price.price, oracle.sellPrice, `${row.cardNumber}: sell price only`);
      assert.ok(!buyPrices.has(row.price.price) || row.price.price === oracle.sellPrice);
    }
  }
});

await test('DUKHN now prices 13,220 JPY with only the genuinely unlisted card unpriced', () => {
  const imported = draftToDeck(importOf(DUKHN));
  const gap = computeGap(imported, {}, db.priceRecords);
  assert.equal(gap.total, 13220);
  assert.deepEqual(
    gap.unpriced.map((r) => r.cardNumber), ['hY05-003'],
    'the only unpriced row is the card the source lists no price for',
  );
});

await test('2H33J8 prices every slot, so nothing is excluded from its total', () => {
  const imported = draftToDeck(importOf(H2));
  const gap = computeGap(imported, {}, db.priceRecords);
  assert.equal(gap.total, 72740);
  assert.deepEqual(gap.unpriced, [], 'every slot of this deck has an ordinary price');
});

await test('price alerts become available for every defaulted, priced slot', () => {
  const imported = draftToDeck(importOf(DUKHN));
  const gap = computeGap(imported, {}, db.priceRecords);
  // The editor offers the alert row exactly when missing > 0 and the price
  // resolved; before this fix that was never true for an imported deck.
  const eligible = gap.rows.filter((r) => r.missing > 0 && r.price.status === 'ok');
  assert.equal(eligible.length, gap.rows.length - 1, 'all but the unlisted card are alertable');
  for (const ex of EXAMPLES) {
    const row = eligible.find((r) => r.cardNumber === ex.cardNumber);
    assert.ok(row, `${ex.cardNumber} must be alert-eligible`);
    assert.equal(row.version, expectedOrdinary(ex.cardNumber).printing);
    assert.equal(row.price.price, ex.ordinary, 'the alert range anchors on the ordinary price');
  }
});

// ── 8. Migration of decks already persisted with UNRESOLVED slots ────────────

/** A deck exactly as DIC-1033 persisted it: every slot on the sentinel. */
function legacyImportedDeck() {
  const draft = importOf(DUKHN);
  const rewrite = (slots) => slots.map((s) => ({
    qty: s.qty,
    card: {
      ...s.card,
      id: `${s.card.cardNumber}#${UNRESOLVED_PRINTING}`,
      printing: UNRESOLVED_PRINTING,
      printingLabel: '',
      unresolvedPrinting: true,
      defaultedPrinting: undefined,
    },
  }));
  return {
    id: 'legacy-deck',
    name: draft.name,
    oshi: rewrite(draft.oshi),
    main: rewrite(draft.main),
    yell: rewrite(draft.yell),
    origin: draft.origin,
    updatedAt: IMPORTED_AT,
  };
}

await test('an already-saved UNRESOLVED tournament deck is repaired in place', () => {
  resetStore();
  const legacy = legacyImportedDeck();
  useDeckStore.setState({ decks: [legacy], activeDeckId: legacy.id, collection: {} });

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);

  const fixed = useDeckStore.getState().decks[0];
  assert.equal(fixed.id, legacy.id, 'the same deck is repaired, not replaced');
  assert.equal(fixed.name, legacy.name, 'the name is untouched');
  assert.deepEqual(fixed.origin, legacy.origin, 'provenance is untouched');
  assert.equal(deckStats(fixed).total, 71, 'no card is lost or gained');

  for (const ex of EXAMPLES) {
    const slot = slotFor(fixed, ex.cardNumber);
    assert.equal(slot.card.printing, expectedOrdinary(ex.cardNumber).printing);
    assert.equal(slot.card.defaultedPrinting, true);
    assert.notEqual(slot.card.unresolvedPrinting, true);
  }
  const gap = computeGap(fixed, {}, db.priceRecords);
  assert.equal(gap.total, 13220, 'the repaired deck estimates the same as a fresh import');
});

await test('a printing the user picked themselves is never rewritten', () => {
  resetStore();
  const legacy = legacyImportedDeck();
  // The player deliberately upgraded their oshi to the ¥148,000 signed parallel.
  const chosen = catalog.get('hBP07-006').find((c) => c.printing === 'PARALLEL/SIGN');
  assert.ok(chosen, 'precondition: the signed parallel exists in the catalog');
  legacy.oshi = [{ card: chosen, qty: 1 }];
  useDeckStore.setState({ decks: [legacy], activeDeckId: legacy.id, collection: {} });

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);

  const fixed = useDeckStore.getState().decks[0];
  assert.deepEqual(fixed.oshi[0].card, chosen, 'the deliberate choice survives untouched');
  assert.equal(fixed.oshi[0].qty, 1);
  // …while the untouched UNRESOLVED slots around it were still repaired.
  assert.equal(slotFor(fixed, 'hBP01-044').card.printing, 'BASE');
});

await test('a hand-built deck with no tournament origin is never touched', () => {
  resetStore();
  // The card number MUST be one the index can actually default, or this test
  // would pass even with the tournament-origin guard deleted.
  assert.ok(lowCostIndex.has('hBP01-044'), 'precondition: this number IS defaultable');
  const handCard = {
    id: 'hBP01-044#UNRESOLVED', cardNumber: 'hBP01-044', name: 'mine', printing: UNRESOLVED_PRINTING,
    printingLabel: '', series: 's', cardTypeJp: 'ホロメン', unresolvedPrinting: true,
  };
  const hand = {
    id: 'hand', name: '我的手工牌組', oshi: [], main: [{ card: handCard, qty: 3 }], yell: [],
    updatedAt: IMPORTED_AT,
  };
  useDeckStore.setState({ decks: [hand], activeDeckId: 'hand', collection: {} });

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);

  assert.deepEqual(useDeckStore.getState().decks[0], hand, 'a non-tournament deck is untouched');
});

await test('migration is idempotent — a second and third pass change nothing', () => {
  resetStore();
  const legacy = legacyImportedDeck();
  useDeckStore.setState({ decks: [legacy], activeDeckId: legacy.id, collection: {} });

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);
  const first = JSON.stringify(useDeckStore.getState().decks);
  const firstRef = useDeckStore.getState().decks;

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);
  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);

  assert.equal(JSON.stringify(useDeckStore.getState().decks), first, 'byte-stable');
  assert.equal(
    useDeckStore.getState().decks, firstRef,
    'and referentially stable, so a re-render loop cannot start',
  );
});

await test('a freshly imported deck needs no migration at all', () => {
  resetStore();
  const store = () => useDeckStore.getState();
  store().importDeck(importOf(DUKHN));
  const before = store().decks;
  store().migrateTournamentDefaults(lowCostIndex);
  assert.equal(store().decks, before, 'a current import is already on its defaults');
});

await test('the repair survives a reload without the user re-importing', async () => {
  resetStore();
  const legacy = legacyImportedDeck();
  // Let the store's own persist middleware write the BROKEN state, so what this
  // test reloads is byte-identical to what an existing installation has on disk.
  useDeckStore.setState({ decks: [legacy], activeDeckId: legacy.id, collection: {} });
  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'the broken deck must reach persistent storage');

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();
  assert.equal(
    useDeckStore.getState().decks[0].oshi[0].card.printing, UNRESOLVED_PRINTING,
    'precondition: the persisted deck really is the broken one',
  );

  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);
  const fixed = useDeckStore.getState().decks[0];
  assert.equal(slotFor(fixed, 'hBP07-006').card.printing, 'BASE');
  assert.equal(computeGap(fixed, {}, db.priceRecords).total, 13220);
});

// The defaulted state is deliberately SILENT in the UI (DIC-1064, and DIC-1067
// retired the same copy from the picker rewrite): the printing it selected is
// shown, the reason it was selected is not. The constant is gone rather than
// merely unrendered, so nothing is pinned here — the absence is asserted against
// the real component tree by scripts/test-deck-editor-copy.mjs.

console.log(`\nDIC-1060 tournament ordinary-printing default: ${passed} tests passed`);
