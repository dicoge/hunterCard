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
  buildImportedDeck(augustEvent, deck, catalog, existingNames, IMPORTED_AT);

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
// A grade therefore proves the card number, not a collectible printing.
await test('a source grade that is not a local printing never selects a printing', () => {
  const draft = importOf(DUKHN);
  const oshi = draft.oshi[0];
  const sourceRef = DUKHN.cards.find((c) => c.zone === 'oshi');
  const localPrintings = catalog.get(sourceRef.cardNumber).map((c) => c.printing);

  assert.equal(sourceRef.version, 'OSR');
  assert.ok(!localPrintings.includes('OSR'), 'precondition: OSR is not a local printing');
  assert.equal(oshi.card.cardNumber, sourceRef.cardNumber, 'card number is preserved exactly');
  assert.equal(oshi.card.unresolvedPrinting, true, 'the printing must be flagged unresolved');
  assert.equal(oshi.card.printing, UNRESOLVED_PRINTING);
  assert.equal(oshi.card.sourceVersion, 'OSR', 'the source grade is kept verbatim as provenance');
  // The decisive assertion: it did not silently become any real printing —
  // not the ¥1,280 plain one, not the ¥29,800 parallel, not the ¥148,000 signed.
  for (const printing of localPrintings) {
    assert.notEqual(oshi.card.printing, printing, `must not adopt local printing ${printing}`);
  }
});

await test('an unresolved printing prices NO_EXACT_PRICE, never a sibling version price', () => {
  const draft = importOf(DUKHN);
  const imported = draftToDeck(draft);
  assert.ok(draft.unresolvedPrintings > 0, 'precondition: this deck has unresolved printings');

  const gap = computeGap(imported, {}, db.priceRecords);
  for (const row of gap.rows) {
    const slot = [...imported.oshi, ...imported.main, ...imported.yell]
      .find((s) => s.card.cardNumber === row.cardNumber && s.card.printing === row.version);
    if (slot?.card.unresolvedPrinting) {
      assert.equal(row.price.status, 'NO_EXACT_PRICE', `${row.cardNumber} must not be priced`);
      assert.equal(row.subtotal, undefined, 'an unpriced row contributes no subtotal');
    }
  }
  // Directly: the sentinel printing resolves to no price at all.
  assert.deepEqual(
    resolveExactPrice(DUKHN.cards[0].cardNumber, UNRESOLVED_PRINTING, db.priceRecords),
    { status: 'NO_EXACT_PRICE' },
  );
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

await test('a source-proven printing is preserved exactly', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL', count: 1 }, decoyCatalog,
  );
  assert.equal(card.printing, 'PARALLEL', 'the proven printing must be kept');
  assert.ok(!card.unresolvedPrinting, 'a proven printing is not flagged unresolved');
});

await test('a proven printing matches case / width-insensitively but never approximately', () => {
  const exact = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: ' parallel ', count: 1 }, decoyCatalog,
  );
  assert.equal(exact.printing, 'PARALLEL', 'normalization folds case and padding only');

  // "PARALLEL/SIGN" is a DIFFERENT printing from "PARALLEL" — a prefix or
  // substring relationship must never be treated as a match.
  const sign = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'PARALLEL/SIGN', count: 1 }, decoyCatalog,
  );
  assert.equal(sign.printing, 'PARALLEL/SIGN');
});

await test('an unknown version picks NEITHER the cheapest nor the dearest decoy', () => {
  for (const version of ['SEC', 'OSR', 'RR', 'C', '']) {
    const card = resolveSlotCard(
      { zone: 'main', cardNumber: 'hDX-001', version: version || null, count: 1 }, decoyCatalog,
    );
    assert.equal(card.unresolvedPrinting, true, `version ${version || '(none)'} must stay unresolved`);
    assert.equal(card.printing, UNRESOLVED_PRINTING);
    assert.equal(card.cardNumber, 'hDX-001', 'the card number is still exact');
  }
});

await test('same-name cards with a different number are never substituted', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-999', version: 'BASE', count: 1 }, decoyCatalog,
  );
  assert.equal(card, null, 'an unknown card number resolves to nothing, not to a same-name card');
});

await test('an unresolved slot keeps a real card type so rule validation stays honest', () => {
  const card = resolveSlotCard(
    { zone: 'main', cardNumber: 'hDX-001', version: 'SEC', count: 1 }, decoyCatalog,
  );
  assert.equal(card.cardTypeJp, 'ホロメン', 'the local card identity supplies the type');
  assert.equal(card.printingLabel, '', 'no other printing label is borrowed');
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
      buildImportedDeck(augustEvent, deck, fullIndex, [], IMPORTED_AT), null,
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
  assert.equal(buildImportedDeck(augustEvent, deck, fullIndex, [], IMPORTED_AT), null);
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
      buildImportedDeck(july.events[0], deck, catalog, [], IMPORTED_AT), null,
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

await test('a reloaded unresolved printing is NOT silently rewritten to another version', async () => {
  resetStore();
  const store = () => useDeckStore.getState();
  const id = store().importDeck(importOf(DUKHN));
  const raw = platformStorage.getItem(STORE_KEY);
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  // migrateLegacyPrintings runs on every DB load and rewrites slots that carry
  // NO printing. The unresolved sentinel is deliberately non-empty so it is not
  // mistaken for a pre-DIC-1013 draft and downgraded onto a real printing.
  const lowCostIndex = new Map();
  for (const card of db.cards) if (!lowCostIndex.has(card.cardNumber)) lowCostIndex.set(card.cardNumber, card);
  store().migrateLegacyPrintings(lowCostIndex);

  const restored = store().decks.find((d) => d.id === id);
  const oshi = restored.oshi[0];
  assert.equal(oshi.card.printing, UNRESOLVED_PRINTING, 'the unresolved printing is preserved');
  assert.equal(oshi.card.unresolvedPrinting, true);
  assert.equal(deckStats(restored).total, 71);
});

console.log(`\nDIC-1033 tournament deck import: ${passed} tests passed`);
