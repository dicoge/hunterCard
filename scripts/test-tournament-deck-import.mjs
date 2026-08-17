#!/usr/bin/env node
/**
 * DIC-1033 — one-tap import of a VERIFIED tournament deck into the deck planner.
 *
 * Every assertion runs against the real shipped artefacts, not hand-written
 * stand-ins: the August report (both DUKHN and 2H33J8), the July report (the
 * older unverified records that must stay browse-only) and the real card
 * database adapted through the production adapter. Synthetic fixtures appear
 * only where a case cannot exist in the shipped data — malformed slots and the
 * exact-version decoys.
 *
 * Covers the issue's §9 matrix:
 *   1.  exact 1 / 50 / 20 mapping and per-slot quantities
 *   2.  both real fixture decks import
 *   3.  repeat import produces independent copies with (2)/(3) naming
 *   4.  no overwrite / no merge into an existing deck
 *   5.  reload persistence (serialize + rehydrate)
 *   6.  every fail-closed case
 *   7.  exact-version decoys — no cross-version / cheapest / dearest fallback
 *   8.  old unverified July entries stay disabled with the exact reason
 *   9.  the imported deck becomes the active deck the editor opens
 *   10. provenance is preserved and existing local decks keep working
 *
 * Run: npm run test:tournament-deck-import
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  UNRESOLVED_PRINTING,
  buildCatalogIndex,
  buildImportedDeck,
  evaluateImport,
  importedDeckName,
  resolveSlotCard,
  uniqueDeckName,
} from '../src/utils/tournamentDeckImport.ts';
import {
  computeGap, isDeckLegal, resolveExactPrice, validateDeck, deckStats, ownershipKey,
} from '../src/utils/deckRules.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
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
const july = JSON.parse(fs.readFileSync('data/tournaments/2026-07.json', 'utf8'));
const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const db = adaptDatabase(Object.values(rawDb.cards || {}));
const catalog = buildCatalogIndex(db.cards);

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

// ── 1 + 2. Both real decks map to exactly 1 / 50 / 20 with exact quantities ──
for (const deck of [DUKHN, H2]) {
  await test(`${deck.decklogCode}: imports exactly 1 oshi / 50 main / 20 yell`, () => {
    const draft = importOf(deck);
    assert.ok(draft, 'a verified real deck must be importable');
    const stats = deckStats(draftToDeck(draft));
    assert.equal(stats.oshi, 1);
    assert.equal(stats.main, 50);
    assert.equal(stats.yell, 20);
    assert.equal(stats.total, 71, 'the imported deck must hold 71 cards');
  });

  await test(`${deck.decklogCode}: every source slot keeps its exact cardNumber, zone and count`, () => {
    const draft = importOf(deck);
    // Expected per (zone, cardNumber): the summed source count. Two source rows
    // for one card number in one zone are the same requirement, so they are
    // compared as a sum — no copy may be dropped or invented.
    const expected = new Map();
    for (const ref of deck.cards) {
      const key = `${ref.zone}|${ref.cardNumber}`;
      expected.set(key, (expected.get(key) ?? 0) + ref.count);
    }
    const actual = new Map();
    for (const zone of ['oshi', 'main', 'yell']) {
      for (const slot of draft[zone]) {
        const key = `${zone}|${slot.card.cardNumber}`;
        actual.set(key, (actual.get(key) ?? 0) + slot.qty);
      }
    }
    assert.deepEqual(
      [...actual.entries()].sort(),
      [...expected.entries()].sort(),
      'zone + cardNumber + quantity must match the source exactly',
    );
  });

  await test(`${deck.decklogCode}: the imported deck passes the existing rule engine unchanged`, () => {
    const imported = draftToDeck(importOf(deck));
    assert.deepEqual(
      validateDeck(imported).filter((i) => i.level === 'error'),
      [],
      'a real champion deck must import with no rule errors',
    );
    assert.equal(isDeckLegal(imported), true);
  });

  await test(`${deck.decklogCode}: no slot has a zero / negative / fractional quantity`, () => {
    const draft = importOf(deck);
    for (const zone of ['oshi', 'main', 'yell']) {
      for (const slot of draft[zone]) {
        assert.ok(Number.isInteger(slot.qty) && slot.qty > 0, `${slot.card.cardNumber} qty`);
      }
    }
  });
}

// ── 7. Exact-version handling on the REAL data ───────────────────────────────
// Deck Log publishes a RARITY GRADE (OSR/RR/C/…); the local catalog's printing
// identity comes from the yuyu-tei listing label (BASE/PARALLEL/PARALLEL/SIGN).
// A grade therefore proves the card number, not a collectible printing — so it
// may not SELECT a printing, and the slot takes the card number's lowest
// ordinary printing as a declared planning default instead (DIC-1060). The
// exhaustive default-selection matrix lives in test-tournament-printing-default.
await test('a source grade never selects a printing; the slot is defaulted instead', () => {
  const draft = importOf(DUKHN);
  const oshi = draft.oshi[0];
  const sourceRef = DUKHN.cards.find((c) => c.zone === 'oshi');
  const localPrintings = catalog.get(sourceRef.cardNumber).map((c) => c.printing);

  assert.equal(sourceRef.version, 'OSR');
  assert.ok(!localPrintings.includes('OSR'), 'precondition: OSR is not a local printing');
  assert.equal(oshi.card.cardNumber, sourceRef.cardNumber, 'card number is preserved exactly');
  assert.equal(oshi.card.sourceVersion, 'OSR', 'the source grade is kept verbatim as provenance');
  assert.equal(
    oshi.card.defaultedPrinting, true,
    'the printing is the planner’s declared default, not something the source stated',
  );
  assert.notEqual(oshi.card.unresolvedPrinting, true);
  // The decisive assertion: the default is the ¥1,280 ordinary printing — never
  // the ¥29,800 parallel and never the ¥148,000 signed parallel.
  assert.equal(oshi.card.printing, 'BASE');
  assert.equal(
    resolveExactPrice(oshi.card.cardNumber, oshi.card.printing, db.priceRecords).price, 1280,
  );
});

await test('the unresolved sentinel itself can never carry a price', () => {
  // The sentinel is still the fail-closed state for a card number with no
  // ordinary printing, and no price record may ever key it.
  assert.deepEqual(
    resolveExactPrice(DUKHN.cards[0].cardNumber, UNRESOLVED_PRINTING, db.priceRecords),
    { status: 'NO_EXACT_PRICE' },
  );
  const imported = draftToDeck(importOf(DUKHN));
  const gap = computeGap(imported, {}, db.priceRecords);
  for (const row of gap.rows) {
    const slot = [...imported.oshi, ...imported.main, ...imported.yell]
      .find((s) => s.card.cardNumber === row.cardNumber && s.card.printing === row.version);
    if (slot?.card.unresolvedPrinting) {
      assert.equal(row.price.status, 'NO_EXACT_PRICE', `${row.cardNumber} must not be priced`);
      assert.equal(row.subtotal, undefined, 'an unpriced row contributes no subtotal');
    }
  }
});

// ── 7b. Decoys: a proven printing IS used; a grade next to decoys is not ─────
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

const decoyPrices = [];

await test('a source-proven printing is preserved exactly', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL', count: 1, printingProven: true },
    decoyCatalog,
    decoyPrices,
  );
  assert.equal(card.printing, 'PARALLEL', 'the proven printing must be kept');
  assert.ok(!card.unresolvedPrinting, 'a proven printing is not flagged unresolved');
  assert.ok(!card.defaultedPrinting, 'nor relabelled as the planner’s default');
});

await test('a proven printing matches case / width-insensitively but never approximately', () => {
  const exact = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: ' parallel ', count: 1, printingProven: true },
    decoyCatalog,
    decoyPrices,
  );
  assert.equal(exact.printing, 'PARALLEL', 'normalization folds case and padding only');

  // "PARALLEL/SIGN" is a DIFFERENT printing from "PARALLEL" — a prefix or
  // substring relationship must never be treated as a match.
  const sign = resolveSlotCard(
    {
      zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL/SIGN', count: 1, printingProven: true,
    },
    decoyCatalog,
    decoyPrices,
  );
  assert.equal(sign.printing, 'PARALLEL/SIGN');
});

// The DIC-1036 promotion hole: matching a local printing token is a COLLISION,
// not proof. Deck Log grades the card number (OSR/RR/SR/…) and never states a
// physical printing, so without an explicit claim the token may not select one
// — otherwise a grade would silently acquire a premium printing's price. The
// slot takes the ordinary default instead, which is the planner's own choice.
await test('a token that matches a local printing is NOT promoted without an explicit claim', () => {
  for (const version of ['PARALLEL', ' parallel ', 'PARALLEL/SIGN', 'BASE']) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version, count: 1 }, decoyCatalog, decoyPrices,
    );
    assert.equal(
      card.printing, 'BASE',
      `an unclaimed token (${version}) must never select a premium printing`,
    );
    assert.equal(card.defaultedPrinting, true);
    assert.equal(card.sourceVersion, version.trim(), 'the token survives as provenance only');
  }
});

await test('only a strictly-true proof claim unlocks the printing', () => {
  // Anything merely truthy — a stringified flag, a 1 — is data of the wrong
  // shape, not a claim, and must fail closed onto the ordinary default exactly
  // like an absent key.
  for (const printingProven of [false, 'true', 1, 'yes', null, undefined, {}]) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL', count: 1, printingProven },
      decoyCatalog,
      decoyPrices,
    );
    assert.equal(
      card.printing, 'BASE',
      `printingProven=${JSON.stringify(printingProven)} must not count as proof`,
    );
  }
});

// A grade and a printing token can collide outright: printing identity keeps any
// parenthetical the yuyu-tei label prints verbatim, so a listing named
// `カード名(SR)` yields the token "SR" — the same string Deck Log uses as a grade.
await test('a rarity grade equal to a local printing token stays unresolved', () => {
  const collidingCatalog = buildCatalogIndex([
    {
      id: 'hDX-002#BASE', cardNumber: 'hDX-002', name: 'collide', printing: 'BASE',
      printingLabel: 'collide', series: 'hDX', cardTypeJp: 'ホロメン',
    },
    {
      id: 'hDX-002#SR', cardNumber: 'hDX-002', name: 'collide', printing: 'SR',
      printingLabel: 'collide(SR)', series: 'hDX', cardTypeJp: 'ホロメン',
    },
  ]);
  const graded = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-002', version: 'SR', count: 1 }, collidingCatalog, decoyPrices,
  );
  assert.equal(
    graded.printing, 'BASE',
    'the grade "SR" must not be promoted onto the printing that spells "SR"',
  );
  assert.equal(graded.defaultedPrinting, true, 'it is the ordinary default, not a source claim');
  assert.equal(graded.id, 'hDX-002#BASE', 'and it may not borrow the "SR" printing’s identity');

  // The same token, explicitly claimed as a printing, is honoured — the rule
  // discriminates on the claim, not on the string.
  const claimed = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-002', version: 'SR', count: 1, printingProven: true },
    collidingCatalog,
    decoyPrices,
  );
  assert.equal(claimed.printing, 'SR');
  assert.equal(claimed.id, 'hDX-002#SR');
});

await test('the shipped reports claim no printing, so every real slot is defaulted', () => {
  for (const deck of [DUKHN, H2]) {
    for (const ref of deck.cards) {
      assert.equal(
        ref.printingProven, undefined,
        `${deck.decklogCode} ${ref.cardNumber}: a shipped Deck Log row may not claim a printing`,
      );
    }
    const draft = importOf(deck);
    const slots = [...draft.oshi, ...draft.main, ...draft.yell];
    assert.equal(
      draft.defaultedPrintings, slots.length,
      `${deck.decklogCode}: every slot of a Deck Log deck takes the ordinary default`,
    );
    assert.equal(draft.unresolvedPrintings, 0);
    for (const s of slots) {
      assert.notEqual(s.card.printing, UNRESOLVED_PRINTING);
      assert.equal(s.card.defaultedPrinting, true);
    }
  }
});

await test('an unknown version picks the ordinary decoy, NEITHER the cheapest nor the dearest', () => {
  for (const version of ['SEC', 'OSR', 'RR', 'C', '']) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version: version || null, count: 1 },
      decoyCatalog,
      // The parallel is deliberately the CHEAPEST listing here: ordinary-version
      // priority has to beat market price, not follow it.
      [
        { cardNumber: 'hDX-001', version: 'BASE', price: 500, currency: 'JPY', source: 't', timestamp: 'T' },
        { cardNumber: 'hDX-001', version: 'PARALLEL', price: 60, currency: 'JPY', source: 't', timestamp: 'T' },
        { cardNumber: 'hDX-001', version: 'PARALLEL/SIGN', price: 90000, currency: 'JPY', source: 't', timestamp: 'T' },
      ],
    );
    assert.equal(card.printing, 'BASE', `version ${version || '(none)'} takes the ordinary printing`);
    assert.equal(card.defaultedPrinting, true);
    assert.equal(card.cardNumber, 'hDX-001', 'the card number is still exact');
  }
});

await test('same-name cards with a different number are never substituted', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-999', version: 'BASE', count: 1 }, decoyCatalog, decoyPrices,
  );
  assert.equal(card, null, 'an unknown card number resolves to nothing, not to a same-name card');
});

await test('a defaulted slot keeps a real card type so rule validation stays honest', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'SEC', count: 1 }, decoyCatalog, decoyPrices,
  );
  assert.equal(card.cardTypeJp, 'ホロメン', 'the local card identity supplies the type');
  // The label is the ORDINARY printing's own listing label — the printing the
  // slot actually adopted. A premium sibling's label is never borrowed.
  assert.equal(card.printingLabel, 'decoy');
  assert.notEqual(card.printingLabel, 'decoy(パラレル)');
  assert.notEqual(card.printingLabel, 'decoy(パラレル/サイン)');
});

// ── 6. Fail-closed matrix ────────────────────────────────────────────────────
const validRef = (zone, cardNumber, count) => ({ zone, cardNumber, version: null, count });
function syntheticDeck(overrides = {}) {
  const cards = [validRef('oshi', 'hDX-001', 1)];
  for (let i = 0; i < 50; i += 1) cards.push(validRef('main', `hMAIN-${i}`, 1));
  for (let i = 0; i < 20; i += 1) cards.push(validRef('yell', `hYELL-${i}`, 1));
  return { deckId: 'synthetic', cardsVerified: true, cards, ...overrides };
}
const fullIndex = buildCatalogIndex(
  syntheticDeck().cards.map((c) => ({
    id: `${c.cardNumber}#BASE`, cardNumber: c.cardNumber, name: c.cardNumber,
    printing: 'BASE', printingLabel: '', series: 's', cardTypeJp: 'ホロメン',
  })),
);

await test('the synthetic baseline itself is importable (guards the negative cases)', () => {
  assert.equal(evaluateImport(syntheticDeck(), fullIndex).importable, true);
});

const failCases = [
  ['cardsVerified:false', syntheticDeck({ cardsVerified: false }), 'NOT_VERIFIED', '卡表尚未取得，無法匯入'],
  ['missing card list', syntheticDeck({ cards: [] }), 'NO_CARDS', '卡表尚未取得，無法匯入'],
  ['absent card list', syntheticDeck({ cards: undefined }), 'NO_CARDS', '卡表尚未取得，無法匯入'],
  [
    'invalid zone',
    syntheticDeck({ cards: [{ zone: 'bench', cardNumber: 'hDX-001', version: null, count: 1 }] }),
    'BAD_ZONE', '卡表區域資料異常，無法匯入',
  ],
  [
    'blank card number',
    syntheticDeck({ cards: [validRef('oshi', '   ', 1)] }),
    'BAD_CARD_NUMBER', '卡表卡號資料異常，無法匯入',
  ],
];

for (const [label, deck, code, reason] of failCases) {
  await test(`fail-closed: ${label} disables the button with its exact reason`, () => {
    const gate = evaluateImport(deck, fullIndex);
    assert.equal(gate.importable, false);
    assert.equal(gate.code, code);
    assert.equal(gate.reason, reason);
    assert.equal(
      buildImportedDeck(augustEvent, deck, fullIndex, db.priceRecords, [], IMPORTED_AT), null,
      'a blocked deck must never build a draft, even if a caller skips the gate',
    );
  });
}

for (const truthy of ['true', 'false', 1, {}, 'yes']) {
  await test(`fail-closed: a non-boolean cardsVerified (${JSON.stringify(truthy)}) is not permission`, () => {
    const gate = evaluateImport(syntheticDeck({ cardsVerified: truthy }), fullIndex);
    assert.equal(gate.importable, false, 'only a real boolean true may unlock the import');
    assert.equal(gate.code, 'NOT_VERIFIED');
    assert.equal(gate.reason, '卡表尚未取得，無法匯入');
  });
}

for (const badCount of [0, -1, 2.5, NaN, null, '3']) {
  await test(`fail-closed: quantity ${String(badCount)} is rejected`, () => {
    const deck = syntheticDeck();
    deck.cards = deck.cards.map((c, i) => (i === 0 ? { ...c, count: badCount } : c));
    const gate = evaluateImport(deck, fullIndex);
    assert.equal(gate.importable, false);
    assert.equal(gate.code, 'BAD_COUNT');
    assert.equal(gate.reason, '卡表張數資料異常，無法匯入');
  });
}

await test('fail-closed: a duplicate slot is rejected rather than merged', () => {
  const deck = syntheticDeck();
  deck.cards = [...deck.cards, validRef('main', 'hMAIN-0', 1)];
  const gate = evaluateImport(deck, fullIndex);
  assert.equal(gate.importable, false);
  assert.equal(gate.code, 'DUPLICATE_SLOT');
  assert.equal(gate.reason, '卡表有重複項目，無法匯入');
});

// ── 6b. DIC-1036: a slot's identity is (zone, cardNumber) and NOTHING else ───
// The rarity grade used to be part of the duplicate key, so one card number
// could occupy two rows of one zone as long as the grades read differently.
// Totals still summed to 1/50/20, the gate opened, and the two rows collapsed
// into a single silently doubled slot. Each case below splits a REAL slot of a
// REAL shipped deck, leaving 1/50/20 exactly intact, so nothing but the
// duplicate rule itself can be what rejects it.
const splitRealSlot = (deck, zone, versions) => {
  const cards = deck.cards.map((c) => ({ ...c }));
  const i = cards.findIndex((c) => c.zone === zone && c.count > 1);
  assert.notEqual(i, -1, `precondition: ${deck.decklogCode} has a splittable ${zone} slot`);
  const base = cards[i];
  cards.splice(
    i, 1,
    { ...base, count: 1, version: versions[0] },
    { ...base, count: base.count - 1, version: versions[1] },
  );
  return { ...deck, cards, cardNumber: base.cardNumber };
};

for (const deck of [DUKHN, H2]) {
  for (const zone of ['main', 'yell']) {
    for (const versions of [['C', 'SR'], ['SR', 'SR'], [null, 'OSR'], ['sr', 'SR']]) {
      const label = versions.map((v) => JSON.stringify(v)).join(' vs ');
      await test(
        `fail-closed: ${deck.decklogCode} ${zone} duplicate cardNumber (${label}) is rejected`,
        () => {
          const mutated = splitRealSlot(deck, zone, versions);

          // The mutation must be invisible to every OTHER gate, or this test
          // would pass for the wrong reason.
          const totals = { oshi: 0, main: 0, yell: 0 };
          for (const c of mutated.cards) totals[c.zone] += c.count;
          assert.deepEqual(totals, { oshi: 1, main: 50, yell: 20 }, 'totals stay exactly 1/50/20');
          assert.equal(mutated.cardsVerified, true, 'the deck is still flagged verified');

          const gate = evaluateImport(mutated, catalog);
          assert.equal(gate.importable, false, 'differing grades may not unlock a duplicate');
          assert.equal(gate.code, 'DUPLICATE_SLOT');
          assert.equal(gate.reason, '卡表有重複項目，無法匯入');

          assert.equal(
            buildImportedDeck(augustEvent, mutated, catalog, db.priceRecords, [], IMPORTED_AT), null,
            'and no draft is built — the two rows are never merged into one slot',
          );
        },
      );
    }
  }

  await test(`fail-closed: ${deck.decklogCode} repeating the oshi is rejected`, () => {
    const oshi = deck.cards.find((c) => c.zone === 'oshi');
    const mutated = {
      ...deck,
      cards: [...deck.cards, { ...oshi, count: 1, version: 'OSR-ALT' }],
    };
    const gate = evaluateImport(mutated, catalog);
    assert.equal(gate.importable, false);
    assert.equal(gate.code, 'DUPLICATE_SLOT');
    assert.equal(
      buildImportedDeck(augustEvent, mutated, catalog, db.priceRecords, [], IMPORTED_AT), null,
      'a second oshi row can never reach the planner',
    );
  });
}

// The rule is scoped to a zone, so the fix must not start rejecting a card
// number that legitimately appears in two different zones.
await test('one card number in two different zones is still importable', () => {
  const deck = syntheticDeck();
  deck.cards = deck.cards.map((c) => (
    c.zone === 'yell' && c.cardNumber === 'hYELL-0' ? { ...c, cardNumber: 'hMAIN-0' } : c
  ));
  const gate = evaluateImport(deck, fullIndex);
  assert.equal(gate.importable, true, 'main and yell are independent slot namespaces');
  const draft = buildImportedDeck(augustEvent, deck, fullIndex, db.priceRecords, [], IMPORTED_AT);
  assert.ok(draft, 'the deck still builds');
  assert.equal(draft.main.filter((s) => s.card.cardNumber === 'hMAIN-0').length, 1);
  assert.equal(draft.yell.filter((s) => s.card.cardNumber === 'hMAIN-0').length, 1);
});

// Last line of defence: even if two rows the gate accepted as distinct card
// numbers resolved onto ONE local card, their quantities may not be summed into
// a slot whose count still looks legal.
await test('two rows resolving to one local card refuse to merge', () => {
  const shared = {
    id: 'hMAIN-0#BASE', cardNumber: 'hMAIN-0', name: 'shared', printing: 'BASE',
    printingLabel: '', series: 's', cardTypeJp: 'ホロメン',
  };
  const collidingIndex = new Map(fullIndex);
  collidingIndex.set('hMAIN-1', [shared]); // hMAIN-1 now resolves to hMAIN-0's card

  const deck = syntheticDeck();
  assert.equal(evaluateImport(deck, collidingIndex).importable, true, 'the gate sees 71 numbers');
  assert.equal(
    buildImportedDeck(augustEvent, deck, collidingIndex, db.priceRecords, [], IMPORTED_AT), null,
    'the collision fails closed instead of producing a doubled slot',
  );
});

await test('fail-closed: totals that are not 1 / 50 / 20 are rejected with the counts', () => {
  const deck = syntheticDeck();
  deck.cards = deck.cards.filter((c) => c.cardNumber !== 'hMAIN-49'); // 49 main
  const gate = evaluateImport(deck, fullIndex);
  assert.equal(gate.importable, false);
  assert.equal(gate.code, 'ZONE_TOTAL');
  assert.match(gate.reason, /主牌組 49\/50/);
  assert.match(gate.reason, /無法匯入$/);
});

await test('fail-closed: a partial deck can never be imported', () => {
  const deck = syntheticDeck();
  deck.cards = deck.cards.slice(0, 10);
  assert.equal(evaluateImport(deck, fullIndex).importable, false);
  assert.equal(buildImportedDeck(augustEvent, deck, fullIndex, db.priceRecords, [], IMPORTED_AT), null);
});

await test('fail-closed: an empty oshi / yell zone is rejected', () => {
  for (const zone of ['oshi', 'yell']) {
    const deck = syntheticDeck();
    deck.cards = deck.cards.filter((c) => c.zone !== zone);
    const gate = evaluateImport(deck, fullIndex);
    assert.equal(gate.importable, false, `${zone} empty must block`);
    assert.equal(gate.code, 'ZONE_TOTAL');
  }
});

await test('fail-closed: an unidentifiable card number blocks the whole import', () => {
  const deck = syntheticDeck();
  deck.cards = deck.cards.map((c, i) => (i === 0 ? { ...c, cardNumber: 'hGHOST-001' } : c));
  const gate = evaluateImport(deck, fullIndex);
  assert.equal(gate.importable, false);
  assert.equal(gate.code, 'UNKNOWN_CARD');
  assert.match(gate.reason, /hGHOST-001/);
  assert.match(gate.reason, /無法匯入$/);
});

await test('fail-closed: the button stays disabled while the catalog is still loading', () => {
  const gate = evaluateImport(DUKHN, null);
  assert.equal(gate.importable, false);
  assert.equal(gate.code, 'CATALOG_LOADING');
  assert.equal(gate.reason, '卡片資料庫載入中，請稍候');
});

// ── 8. Older unverified July records stay browse-only ────────────────────────
await test('every unverified July deck is disabled with 卡表尚未取得，無法匯入', () => {
  const julyDecks = july.events.flatMap((e) => e.decks);
  assert.ok(julyDecks.length >= 3, 'precondition: July ships the older featured records');
  for (const deck of julyDecks) {
    assert.equal(deck.cardsVerified, false, `${deck.deckId} precondition: unverified`);
    const gate = evaluateImport(deck, catalog);
    assert.equal(gate.importable, false, `${deck.deckId} must not offer an import`);
    assert.equal(gate.reason, '卡表尚未取得，無法匯入');
    assert.equal(
      buildImportedDeck(july.events[0], deck, catalog, db.priceRecords, [], IMPORTED_AT), null,
      'no July record may produce a deck',
    );
  }
});

// ── Naming ───────────────────────────────────────────────────────────────────
await test('the deck name is built from event + block + rank + player/oshi', () => {
  const name = importedDeckName(augustEvent, DUKHN);
  assert.ok(name.includes(augustEvent.nameZh), 'event name is present');
  assert.ok(name.includes('A 組'), 'block is present');
  assert.ok(name.includes(DUKHN.rankLabel), 'rank label is present');
  assert.ok(name.includes(DUKHN.playerName), 'player is present');
  assert.ok(name.includes(DUKHN.oshi), 'oshi is present');
});

await test('the two real decks get distinguishable names', () => {
  assert.notEqual(importedDeckName(augustEvent, DUKHN), importedDeckName(augustEvent, H2));
});

await test('naming is deterministic and omits unknown parts instead of inventing them', () => {
  const bare = { deckId: 'x', decklogCode: 'ABC', playerName: null, oshi: null, rankLabel: null };
  assert.equal(importedDeckName({ name: 'E', nameZh: null }, bare), 'E');
  assert.equal(importedDeckName({ name: '', nameZh: null }, bare), '賽事牌組 ABC');
  assert.equal(
    importedDeckName({ name: '', nameZh: null }, { ...bare, decklogCode: null }), '賽事牌組',
  );
  assert.equal(importedDeckName(augustEvent, DUKHN), importedDeckName(augustEvent, DUKHN));
});

await test('repeat names get ascending (2) / (3) suffixes', () => {
  assert.equal(uniqueDeckName('牌組', []), '牌組');
  assert.equal(uniqueDeckName('牌組', ['牌組']), '牌組 (2)');
  assert.equal(uniqueDeckName('牌組', ['牌組', '牌組 (2)']), '牌組 (3)');
  assert.equal(uniqueDeckName('牌組', ['其他']), '牌組');
});

// ── 3 + 4 + 9 + 10. Store behaviour ──────────────────────────────────────────
await test('importing creates a NEW deck, makes it active, and preserves provenance', () => {
  resetStore();
  const draft = importOf(DUKHN);
  const id = useDeckStore.getState().importDeck(draft);

  const state = useDeckStore.getState();
  assert.equal(state.decks.length, 1);
  assert.equal(state.activeDeckId, id, 'the imported deck must be the active deck');

  const deck = state.getActiveDeck();
  assert.equal(deck.id, id);
  assert.equal(deck.origin.kind, 'tournament');
  assert.equal(deck.origin.decklogCode, 'DUKHN');
  assert.equal(deck.origin.eventId, augustEvent.eventId);
  assert.equal(deck.origin.sourceUrl, DUKHN.sourceUrl);
  assert.equal(deck.origin.importedAt, IMPORTED_AT);
  assert.equal(deckStats(deck).total, 71);
});

await test('a repeat import creates an independent copy and never overwrites the first', () => {
  resetStore();
  const store = () => useDeckStore.getState();
  const names = () => store().decks.map((d) => d.name);

  const firstId = store().importDeck(importOf(DUKHN, names()));
  const secondId = store().importDeck(importOf(DUKHN, names()));
  const thirdId = store().importDeck(importOf(DUKHN, names()));

  assert.equal(store().decks.length, 3, 'three independent decks');
  assert.equal(new Set([firstId, secondId, thirdId]).size, 3, 'three distinct ids');

  const [d1, d2, d3] = store().decks;
  assert.equal(d2.name, `${d1.name} (2)`);
  assert.equal(d3.name, `${d1.name} (3)`);
  for (const d of [d1, d2, d3]) assert.equal(deckStats(d).total, 71);

  // Editing the copy must not touch the original — they are separate decks.
  store().changeCard(thirdId, 'main', store().decks[2].main[0].card, -1);
  assert.equal(deckStats(store().decks[0]).total, 71, 'the original is untouched');
  assert.equal(deckStats(store().decks[2]).total, 70, 'only the edited copy changed');
});

await test('importing never overwrites or merges into an existing hand-built deck', () => {
  resetStore();
  const store = () => useDeckStore.getState();
  const handBuiltId = store().createDeck('我的手工牌組');
  const handCard = {
    id: 'hMN-777#BASE', cardNumber: 'hMN-777', name: 'mine', printing: 'BASE',
    printingLabel: '', series: 's', cardTypeJp: 'ホロメン',
  };
  store().changeCard(handBuiltId, 'main', handCard, 3);
  const before = JSON.parse(JSON.stringify(
    store().decks.find((d) => d.id === handBuiltId),
  ));

  const importedId = store().importDeck(importOf(DUKHN, store().decks.map((d) => d.name)));

  assert.notEqual(importedId, handBuiltId);
  assert.equal(store().decks.length, 2, 'the hand-built deck still exists alongside the import');
  const after = store().decks.find((d) => d.id === handBuiltId);
  assert.deepEqual(after.main, before.main, 'the hand-built deck contents are untouched');
  assert.equal(after.name, '我的手工牌組');
  assert.equal(after.origin, undefined, 'a hand-built deck gains no fake provenance');
});

await test('the global collection is never mutated by an import', () => {
  resetStore();
  useDeckStore.getState().setOwned('hMN-777', 'BASE', 4);
  const before = { ...useDeckStore.getState().collection };
  useDeckStore.getState().importDeck(importOf(DUKHN));
  assert.deepEqual(useDeckStore.getState().collection, before, 'ownership is untouched');
  assert.equal(useDeckStore.getState().getOwned('hMN-777', 'BASE'), 4);
});

await test('collection / shortage maths still work on an imported deck', () => {
  resetStore();
  const id = useDeckStore.getState().importDeck(importOf(H2));
  const deck = useDeckStore.getState().decks.find((d) => d.id === id);
  const slot = deck.main[0];

  // Record ownership under the imported slot's own key, as the editor would.
  useDeckStore.getState().setOwned(slot.card.cardNumber, slot.card.printing, 1);
  const owned = useDeckStore.getState().collection;
  assert.equal(owned[ownershipKey(slot.card.cardNumber, slot.card.printing)], 1);

  const gap = computeGap(deck, owned, db.priceRecords);
  const row = gap.rows.find((r) => r.cardNumber === slot.card.cardNumber);
  assert.equal(row.owned, 1, 'owned copies are counted');
  assert.equal(row.missing, Math.max(0, row.required - 1));
  assert.ok(gap.rows.length > 0);
  // Unresolved printings are excluded from the total rather than mispriced.
  for (const r of gap.unpriced) assert.equal(r.price.status, 'NO_EXACT_PRICE');
});

// ── 5. Reload persistence ────────────────────────────────────────────────────
await test('an imported deck survives reload and reopens from 我的牌組', async () => {
  resetStore();
  const store = () => useDeckStore.getState();
  const id = store().importDeck(importOf(DUKHN));
  const expectedName = store().decks.find((d) => d.id === id).name;

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'the import must be written to persistent storage');
  assert.ok(raw.includes('DUKHN'), 'provenance is persisted');

  // Simulate an app reload.
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  assert.equal(store().decks.length, 0);
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  const restored = store().decks.find((d) => d.id === id);
  assert.ok(restored, 'the imported deck must reopen from 我的牌組 after reload');
  assert.equal(restored.name, expectedName);
  assert.equal(deckStats(restored).total, 71, 'all 71 cards survive reload');
  assert.equal(restored.origin.decklogCode, 'DUKHN', 'provenance survives reload');
  assert.equal(store().activeDeckId, id, 'it is still the active deck the editor opens');
  assert.deepEqual(validateDeck(restored).filter((i) => i.level === 'error'), []);
});

await test('a reloaded printing is NOT silently rewritten by the legacy migration', async () => {
  resetStore();
  const store = () => useDeckStore.getState();
  const id = store().importDeck(importOf(DUKHN));
  const before = JSON.stringify(store().decks.find((d) => d.id === id));
  const raw = platformStorage.getItem(STORE_KEY);
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  // migrateLegacyPrintings runs on every DB load and rewrites slots that carry
  // NO printing at all. An imported slot always names one — its declared
  // ordinary default, or the non-empty UNRESOLVED sentinel — so this pass must
  // leave every one of them exactly as reloaded. The index below is deliberately
  // FIRST-SEEN rather than lowest-cost, so a slot it did touch would move onto a
  // different printing and show up here.
  const firstSeenIndex = new Map();
  for (const card of db.cards) if (!firstSeenIndex.has(card.cardNumber)) firstSeenIndex.set(card.cardNumber, card);
  store().migrateLegacyPrintings(firstSeenIndex);

  const restored = store().decks.find((d) => d.id === id);
  assert.equal(JSON.stringify(restored), before, 'the reloaded deck is byte-identical');
  assert.equal(restored.oshi[0].card.defaultedPrinting, true);
  assert.equal(deckStats(restored).total, 71);
});

console.log(`\nDIC-1033 tournament deck import: ${passed} tests passed`);
