#!/usr/bin/env node
/**
 * DIC-1000 tournament-deck → my-deck import regression. Deterministic, no
 * network and no third-party card content: every deck list it exercises is a
 * hand-built fixture in this repo's own source schema.
 *
 * Covers the issue's item 9 acceptance list:
 *   1. source record → normalized schema mapping
 *   2. all three zones (oshi / main / yell)
 *   3. exact quantities
 *   4. repeated import creates independent copies
 *   5. deterministic human-readable naming, no fabricated values
 *   6. copies are independent (editing one never touches another or the source)
 *   7. persistence payload survives reload
 *   8. unresolved version is preserved, never silently resolved
 *   9. a deck with no card list — or an incomplete one — is not importable
 *  10. exact-version fail-closed: no same-name / same-number / cross-version
 *      substitution, and no price without an exact-version match
 *
 * Plus the two DIC-1001 review findings:
 *   • no Deck Log content is committed or published by this repo
 *   • a partial / malformed list is never presented as importable
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *   scripts/test-tournament-deck-import.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildImportZones,
  buildImportedDeck,
  buildPrintingIndex,
  importedDeckName,
  isImportable,
  resolvePrinting,
  uniqueDeckName,
  unresolvedDeckCard,
} from '../src/utils/tournamentDeckImport.ts';
import { normalizeDeck } from '../src/utils/tournamentReport.ts';
import { computeGap, validateDeck } from '../src/utils/deckRules.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STORE_KEY = 'hunterCard-decks';
const IMAGE_BASE =
  'https://hololive-official-cardgame.com/wp-content/images/cardlist';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), 'utf8'));
}

function resetStore() {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.removeItem(STORE_KEY);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Filler holomen so the fixture main deck reaches the real 50-card requirement
// without breaking the 4-copy limit. 11 numbers × 4 + 4 + 2 = 50.
const FILLER = Array.from({ length: 11 }, (_, i) => {
  const cardNumber = `hMAIN-1${String(i).padStart(2, '0')}`;
  return {
    cardNumber,
    version: 'C',
    imagePath: `hBP01/${cardNumber}_C.png`,
    name: `填充${i}`,
    cardKind: 'ホロメン',
  };
});

// A COMPLETE source list (1 / 50 / 20) in this repo's own schema. Completeness
// matters: the importer only offers decks the source published in full, so a
// fixture that is short of a zone would exercise the rejected path instead.
const sourceCards = [
  { zone: 'oshi', cardNumber: 'hOSHI-001', version: 'OSR', count: 1, name: '推し', cardKind: '推しホロメン', imagePath: 'hSD10/hOSHI-001_OSR.png' },
  { zone: 'main', cardNumber: 'hMAIN-001', version: 'C', count: 4, name: '主力', cardKind: 'ホロメン', imagePath: 'hBP01/hMAIN-001_C.png' },
  { zone: 'main', cardNumber: 'hMAIN-002', version: 'U', count: 2, name: '道具', cardKind: 'サポート・アイテム', imagePath: 'hBP01/hMAIN-002_U.png' },
  ...FILLER.map((f) => ({ zone: 'main', count: 4, ...f })),
  { zone: 'yell', cardNumber: 'hY01-001', version: 'C', count: 20, name: '青エール', cardKind: 'エール', imagePath: 'COMMON/hY01-001_C.png' },
];

// A catalog that deliberately contains DECOYS for every forbidden fallback:
// the same card name, the same cardNumber at a different printing, and a
// higher-priced printing. Only hMAIN-001_hBP01 is the exact printing the
// source named.
const rawCatalog = [
  {
    id: 'hMAIN-001_hBP01', cardNumber: 'hMAIN-001', name: '主力', rarity: 'C', series: 'hBP01',
    skillsJp: { cardType: 'ホロメン' },
    officialImage: `${IMAGE_BASE}/hBP01/hMAIN-001_C.png`,
    prices: [{ rarity: 'C', sellPrice: 30 }, { rarity: 'SR', sellPrice: 5000 }],
  },
  {
    id: 'hMAIN-001_hPR', cardNumber: 'hMAIN-001', name: '主力', rarity: 'SR', series: 'hPR',
    skillsJp: { cardType: 'ホロメン' },
    officialImage: `${IMAGE_BASE}/hPR/hMAIN-001_SR.png`,
    prices: [{ rarity: 'SR', sellPrice: 5000 }],
  },
  {
    id: 'hOSHI-001_hSD10', cardNumber: 'hOSHI-001', name: '推し', rarity: 'OSR', series: 'hSD10',
    skillsJp: { cardType: '推しホロメン' },
    officialImage: `${IMAGE_BASE}/hSD10/hOSHI-001_OSR.png`,
    prices: [],
  },
  // Same printing path listed once per product it was reprinted in — identical
  // art, identical rarity. These are one version, not two.
  {
    id: 'hY01-001_hSD01', cardNumber: 'hY01-001', name: '青エール', rarity: 'C', series: 'hSD01',
    skillsJp: { cardType: 'エール' },
    officialImage: `${IMAGE_BASE}/COMMON/hY01-001_C.png`,
    prices: [],
  },
  {
    id: 'hY01-001_hBP01', cardNumber: 'hY01-001', name: '青エール', rarity: 'C', series: 'hBP01',
    skillsJp: { cardType: 'エール' },
    officialImage: `${IMAGE_BASE}/COMMON/hY01-001_C.png`,
    prices: [],
  },
  // hMAIN-002 is present only at a DIFFERENT printing than the source named.
  {
    id: 'hMAIN-002_hPR', cardNumber: 'hMAIN-002', name: '道具', rarity: 'P', series: 'hPR',
    skillsJp: { cardType: 'サポート・アイテム' },
    officialImage: `${IMAGE_BASE}/hPR/hMAIN-002_P.png`,
    prices: [{ rarity: 'P', sellPrice: 900 }],
  },
  ...FILLER.map((f) => ({
    id: `${f.cardNumber}_hBP01`, cardNumber: f.cardNumber, name: f.name, rarity: 'C', series: 'hBP01',
    skillsJp: { cardType: 'ホロメン' },
    officialImage: `${IMAGE_BASE}/${f.imagePath}`,
    prices: [],
  })),
];

const catalog = adaptDatabase(rawCatalog);
const index = buildPrintingIndex(catalog.cards);

const event = {
  eventId: 'evt-1',
  name: 'Area Qualifier Tohoku A',
  nameZh: '東北 A 組預選',
  decks: [],
};

function entry(overrides = {}) {
  return normalizeDeck(
    {
      decklogCode: 'TEST1',
      playerName: 'まっさん3297',
      rank: 8,
      rankLabel: '予選8位',
      archetypeLabel: '鷹嶺ルイ（紫単）',
      oshi: '鷹嶺ルイ',
      cards: sourceCards,
      ...overrides,
    },
    'evt-1',
    'https://example.test/col',
    0,
    '2026-08-01T00:00:00Z',
  );
}

// ── 1. Schema mapping ───────────────────────────────────────────────────────
await test('a complete source list normalizes to zone-tagged slots', () => {
  const deck = entry();
  assert.equal(deck.cardsVerified, true);
  assert.equal(deck.cardsIssue, null);
  assert.deepEqual(deck.cards[0], {
    zone: 'oshi',
    cardNumber: 'hOSHI-001',
    version: 'OSR',
    count: 1,
    name: '推し',
    cardKind: '推しホロメン',
    imagePath: 'hSD10/hOSHI-001_OSR.png',
  });
});

await test('an entry the source gave no version for stays version:null', () => {
  const deck = entry({
    cards: sourceCards.map((c) =>
      c.cardNumber === 'hMAIN-001' ? { ...c, version: undefined, imagePath: undefined } : c,
    ),
  });
  const card = deck.cards.find((c) => c.cardNumber === 'hMAIN-001');
  assert.equal(card.version, null);
  assert.equal(card.imagePath, null);
});

// ── 2 + 3. All three zones, exact quantities ────────────────────────────────
await test('all three zones and their quantities map exactly', () => {
  const { zones } = buildImportZones(entry().cards, index);
  assert.equal(zones.oshi.length, 1);
  assert.equal(zones.oshi[0].qty, 1);
  assert.equal(zones.main.find((s) => s.card.cardNumber === 'hMAIN-001').qty, 4);
  assert.equal(zones.main.find((s) => s.card.cardNumber === 'hMAIN-002').qty, 2);
  assert.equal(zones.yell.length, 1);
  assert.equal(zones.yell[0].qty, 20);
  assert.deepEqual(
    [zones.oshi, zones.main, zones.yell].map((z) => z.reduce((n, s) => n + s.qty, 0)),
    [1, 50, 20],
  );
});

await test('a source slot is placed in the zone the source published', () => {
  // The source declares a yell card in the main zone. It is imported where the
  // source put it, and the rule checker reports the real error rather than the
  // importer silently "fixing" the deck.
  const { zones } = buildImportZones(
    [{ zone: 'main', cardNumber: 'hY01-001', version: 'C', count: 1, name: '青エール', cardKind: 'エール', imagePath: 'COMMON/hY01-001_C.png' }],
    index,
  );
  assert.equal(zones.main.length, 1);
  assert.equal(zones.yell.length, 0);
  const issues = validateDeck({ id: 'd', name: 'n', ...zones, updatedAt: '' });
  assert.ok(issues.some((i) => i.code === 'ERR_MAIN_TYPE'), 'misplaced card must raise a real error');
});

// ── DIC-1001 #2: partial / malformed lists stay non-importable ──────────────
await test('one malformed slot rejects the whole list, never trims it into a deck', () => {
  const deck = entry({
    cards: [
      ...sourceCards,
      { zone: 'main', cardNumber: '', count: 3, name: '無卡號', version: 'C', imagePath: 'x/y.png' },
    ],
  });
  assert.deepEqual(deck.cards, [], 'the surviving slots must not become a "read" card list');
  assert.equal(deck.cardsVerified, false, 'a dropped entry must not leave a "verified" deck');
  assert.equal(deck.cardsIssue, 'incomplete');
  assert.equal(isImportable(deck), false);
  assert.equal(deck.coverage, 'partial');
});

await test('a non-positive or non-numeric quantity is malformed, never coerced', () => {
  for (const count of [0, -1, 2.5, '4', 'four', null, true, [4]]) {
    const deck = entry({
      cards: sourceCards.map((c) => (c.cardNumber === 'hMAIN-001' ? { ...c, count } : c)),
    });
    assert.equal(deck.cardsVerified, false, `count=${JSON.stringify(count)} must not verify`);
    assert.equal(deck.cardsIssue, 'incomplete');
  }
});

await test('a slot with no zone (or an unknown one) blocks import', () => {
  const deck = entry({
    cards: sourceCards.map((c) =>
      c.cardNumber === 'hMAIN-002' ? { ...c, zone: 'bench' } : c,
    ),
  });
  assert.deepEqual(deck.cards, [], 'zone is never guessed');
  assert.equal(deck.cardsIssue, 'incomplete');
  assert.equal(isImportable(deck), false);
});

// Each of these keeps the zone totals at exactly 1 / 50 / 20 — under coercion
// they would all read as a complete, importable deck. The only thing standing
// between them and a fabricated card list is the runtime field check.
await test('a malformed runtime field is rejected even when the totals look complete', () => {
  const cases = {
    'whitespace-only cardNumber': (c) =>
      c.cardNumber === 'hMAIN-001' ? { ...c, cardNumber: '   ' } : c,
    'numeric-string count': (c) => (c.zone === 'oshi' ? { ...c, count: '1' } : c),
    'object version': (c) =>
      c.cardNumber === 'hMAIN-001' ? { ...c, version: { rare: 'C' } } : c,
    'empty-string version': (c) => (c.cardNumber === 'hMAIN-001' ? { ...c, version: '' } : c),
    'numeric name': (c) => (c.cardNumber === 'hMAIN-001' ? { ...c, name: 123 } : c),
    'array cardKind': (c) =>
      c.cardNumber === 'hMAIN-001' ? { ...c, cardKind: ['ホロメン'] } : c,
    'object imagePath': (c) => (c.cardNumber === 'hMAIN-001' ? { ...c, imagePath: {} } : c),
    'null slot': (c) => (c.cardNumber === 'hMAIN-001' ? null : c),
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const mutated = sourceCards.map(mutate);
    const deck = entry({ cards: mutated });
    assert.equal(deck.cardsVerified, false, `${label} must not verify`);
    assert.equal(deck.cardsIssue, 'incomplete', `${label} must report an incomplete list`);
    assert.deepEqual(deck.cards, [], `${label} must not leave a partial list behind`);
    assert.equal(isImportable(deck), false, `${label} must not be importable`);
  }
});

await test('a card list that is not an array at all is treated as absent', () => {
  for (const cards of [null, undefined, 'hMAIN-001', { 0: sourceCards[0] }]) {
    const deck = entry({ cards });
    assert.equal(deck.cardsIssue, 'missing');
    assert.equal(isImportable(deck), false);
  }
});

await test('a list short of 1/50/20 is incomplete even when every entry parsed', () => {
  for (const drop of ['hOSHI-001', 'hMAIN-001', 'hY01-001']) {
    const deck = entry({ cards: sourceCards.filter((c) => c.cardNumber !== drop) });
    assert.equal(deck.cardsVerified, false, `missing ${drop} must not verify`);
    assert.equal(deck.cardsIssue, 'incomplete');
    assert.equal(isImportable(deck), false);
  }
});

await test('a deck the source published no list for reports "missing", not "incomplete"', () => {
  const linkOnly = entry({ cards: [] });
  assert.equal(linkOnly.cardsVerified, false);
  assert.equal(linkOnly.cardsIssue, 'missing');
  assert.equal(isImportable(linkOnly), false);
  assert.equal(isImportable(entry()), true);
});

// ── DIC-1001 #1: no third-party deck content is carried or published ────────
await test('no Deck Log content or harvesting tool is committed', () => {
  for (const p of [
    ['data', 'tournaments', 'decklog'],
    ['public', 'data', 'tournaments', 'decklog'],
    ['src', 'utils', 'decklogDeck.ts'],
    ['scripts', 'fetch-decklog-decks.mjs'],
  ]) {
    assert.equal(
      fs.existsSync(path.join(ROOT, ...p)),
      false,
      `${p.join('/')} republishes Deck Log content and must not exist`,
    );
  }
});

await test('the published report republishes no card list', () => {
  const report = readJson('public', 'data', 'tournaments', '2026-07.json');
  const decks = report.events.flatMap((e) => e.decks);
  assert.ok(decks.length > 0, 'the report must still list the decks it observed');
  for (const deck of decks) {
    assert.deepEqual(deck.cards, [], `${deck.deckId} must carry no card content`);
    assert.equal(deck.cardsVerified, false);
    assert.equal(isImportable(deck), false, 'no deck is importable without a licensed list');
  }
});

// ── 10. Exact-version fail-closed ───────────────────────────────────────────
await test('resolution matches the exact printing only — decoys are never used', () => {
  const cards = entry().cards;
  const pick = (n) => cards.find((c) => c.cardNumber === n);
  assert.equal(resolvePrinting(pick('hOSHI-001'), index).id, 'hOSHI-001_hSD10');
  // Same name AND same cardNumber exist at a pricier SR printing; the C
  // printing the source named must win.
  assert.equal(resolvePrinting(pick('hMAIN-001'), index).id, 'hMAIN-001_hBP01');
  assert.equal(resolvePrinting(pick('hMAIN-001'), index).rarity, 'C');
  // hMAIN-002 exists in the catalog, but only at another printing → no match.
  assert.equal(resolvePrinting(pick('hMAIN-002'), index), null);
});

await test('one printing reprinted across products resolves without substitution', () => {
  const yell = entry().cards.find((c) => c.zone === 'yell');
  const resolved = resolvePrinting(yell, index);
  assert.ok(resolved, 'identical-version reprints must still resolve');
  assert.equal(resolved.rarity, 'C');
  assert.equal(resolved.id, 'hY01-001_hBP01', 'pick must be deterministic (lowest id)');
});

// A printing path is a string, not an identity. Two source slots below name a
// path the catalog serves, but disagree with the entry behind it — resolving
// either would hand the player a different card than the one that was played.
await test('a printing path match with a conflicting card number resolves to nothing', () => {
  const ref = {
    zone: 'main', cardNumber: 'hMAIN-999', version: 'C', count: 1,
    name: '主力', cardKind: 'ホロメン', imagePath: 'hBP01/hMAIN-001_C.png',
  };
  assert.equal(resolvePrinting(ref, index), null, 'hMAIN-999 must never become hMAIN-001');
  const { zones, unresolved } = buildImportZones([ref], index);
  assert.deepEqual(unresolved.map((c) => c.cardNumber), ['hMAIN-999']);
  assert.equal(zones.main[0].card.cardNumber, 'hMAIN-999', 'the source number is kept verbatim');
  assert.equal(zones.main[0].card.unresolvedPrinting, true);
});

await test('a printing path match with a conflicting version resolves to nothing', () => {
  const ref = {
    zone: 'main', cardNumber: 'hMAIN-001', version: 'SR', count: 1,
    name: '主力', cardKind: 'ホロメン', imagePath: 'hBP01/hMAIN-001_C.png',
  };
  // The catalog entry behind that path is the C printing, and an SR printing of
  // the same number exists at 5000 — neither may be borrowed.
  assert.equal(resolvePrinting(ref, index), null);
  const { zones } = buildImportZones([ref], index);
  assert.equal(zones.main[0].card.rarity, 'SR', 'the source version is kept verbatim');
  assert.equal(zones.main[0].card.unresolvedPrinting, true);
  const gap = computeGap(
    { id: 'd', name: 'n', oshi: [], main: zones.main, yell: [], updatedAt: '' },
    {},
    catalog.priceRecords,
  );
  // Pricing still keys off the SOURCE's version, so the 30-yen C printing that
  // shares the path is not what this slot costs.
  assert.equal(gap.rows[0].version, 'SR');
  assert.equal(gap.rows[0].price.price, 5000);
});

await test('a printing bucket that disagrees on card number resolves to nothing', () => {
  const ambiguous = buildPrintingIndex([
    { id: 'a', cardNumber: 'hZ-001', name: 'z', rarity: 'C', series: 's', printingPath: 'X/shared.png' },
    { id: 'b', cardNumber: 'hZ-002', name: 'z', rarity: 'C', series: 's', printingPath: 'X/shared.png' },
  ]);
  const ref = { zone: 'main', cardNumber: 'hZ-001', version: 'C', count: 1, name: 'z', cardKind: 'ホロメン', imagePath: 'X/shared.png' };
  assert.equal(resolvePrinting(ref, ambiguous), null);
});

await test('a printing bucket that disagrees on version resolves to nothing', () => {
  const ambiguous = buildPrintingIndex([
    { id: 'a', cardNumber: 'hZ-001', name: 'z', rarity: 'C', series: 's', printingPath: 'X/hZ-001.png' },
    { id: 'b', cardNumber: 'hZ-001', name: 'z', rarity: 'SR', series: 's', printingPath: 'X/hZ-001.png' },
  ]);
  const ref = { zone: 'main', cardNumber: 'hZ-001', version: 'C', count: 1, name: 'z', cardKind: 'ホロメン', imagePath: 'X/hZ-001.png' };
  assert.equal(resolvePrinting(ref, ambiguous), null);
});

await test('a source slot with no version never resolves to a printing', () => {
  const ref = { zone: 'main', cardNumber: 'hMAIN-001', version: null, count: 1, name: '主力', cardKind: 'ホロメン', imagePath: 'hBP01/hMAIN-001_C.png' };
  assert.equal(resolvePrinting(ref, index), null);
  const card = unresolvedDeckCard(ref);
  assert.equal(card.rarity, '', 'no version is invented for an unversioned source slot');
  assert.equal(card.unresolvedPrinting, true);
});

// ── 8. Unresolved version preserved ─────────────────────────────────────────
await test('an unresolvable printing is kept verbatim and flagged', () => {
  const { zones, unresolved } = buildImportZones(entry().cards, index);
  assert.deepEqual(unresolved.map((c) => c.cardNumber), ['hMAIN-002']);

  const slot = zones.main.find((s) => s.card.cardNumber === 'hMAIN-002');
  assert.equal(slot.card.rarity, 'U', 'the source version is preserved exactly');
  assert.equal(slot.card.unresolvedPrinting, true);
  assert.equal(slot.qty, 2, 'the deck is still complete — the slot is not dropped');
  assert.ok(!catalog.cards.some((c) => c.id === slot.card.id), 'no catalog entry was borrowed');
});

await test('an unresolved slot gets no price and is reported as unpriced', () => {
  const { zones } = buildImportZones(entry().cards, index);
  const gap = computeGap({ id: 'd', name: 'n', ...zones, updatedAt: '' }, {}, catalog.priceRecords);

  const unresolvedRow = gap.rows.find((r) => r.cardNumber === 'hMAIN-002');
  assert.equal(unresolvedRow.version, 'U');
  assert.equal(unresolvedRow.price.status, 'NO_EXACT_PRICE', 'the 900-yen P printing must not be borrowed');
  assert.ok(gap.unpriced.some((r) => r.cardNumber === 'hMAIN-002'));

  // The resolved slot prices at its OWN version, not the 5000 SR decoy.
  const resolvedRow = gap.rows.find((r) => r.cardNumber === 'hMAIN-001');
  assert.equal(resolvedRow.price.status, 'ok');
  assert.equal(resolvedRow.price.price, 30);
  assert.equal(resolvedRow.subtotal, 120, '4 missing × 30, never the SR price');
});

await test('imported slots feed the existing collection gap without a second model', () => {
  const { zones } = buildImportZones(entry().cards, index);
  const deck = { id: 'd', name: 'n', ...zones, updatedAt: '' };
  // Owned counts are keyed by the same cardNumber|version the import produced.
  const gap = computeGap(deck, { 'hMAIN-001|C': 1, 'hMAIN-002|U': 2 }, catalog.priceRecords);
  assert.equal(gap.rows.find((r) => r.cardNumber === 'hMAIN-001').missing, 3);
  assert.equal(gap.rows.find((r) => r.cardNumber === 'hMAIN-002').missing, 0);
});

await test('a complete source deck imports as a legal deck', () => {
  const { zones } = buildImportZones(entry().cards, index);
  assert.deepEqual(validateDeck({ id: 'd', name: 'n', ...zones, updatedAt: '' }), []);
});

// ── 5. Naming ───────────────────────────────────────────────────────────────
await test('deck name is built only from published values', () => {
  assert.equal(
    importedDeckName(event, entry()),
    '東北 A 組預選｜鷹嶺ルイ（紫単）·予選8位·まっさん3297',
  );
});

await test('unknown name parts are omitted, never filled with a placeholder', () => {
  const anonymous = entry({ playerName: null, rank: null, rankLabel: null, archetypeLabel: null, oshi: null });
  const name = importedDeckName(event, anonymous);
  assert.equal(name, '東北 A 組預選');
  for (const placeholder of ['未知', '未公開', 'null', 'undefined', 'NaN']) {
    assert.ok(!name.includes(placeholder), `name must not contain "${placeholder}"`);
  }
});

await test('a deck with nothing published falls back to its decklog code', () => {
  const bare = entry({ playerName: null, rank: null, rankLabel: null, archetypeLabel: null, oshi: null });
  assert.equal(importedDeckName({ eventId: 'e', name: '', nameZh: null, decks: [] }, bare), '賽事牌組 TEST1');
});

await test('repeated names get a deterministic ascending suffix', () => {
  assert.equal(uniqueDeckName('A', []), 'A');
  assert.equal(uniqueDeckName('A', ['A']), 'A (2)');
  assert.equal(uniqueDeckName('A', ['A', 'A (2)']), 'A (3)');
  assert.equal(uniqueDeckName('A', ['A', 'A (3)']), 'A (2)', 'the first free slot is reused');
});

// ── 4 + 6 + 7. Store: independent copies, persistence ───────────────────────
await test('one import creates a new active deck without touching existing decks', () => {
  resetStore();
  const existingId = useDeckStore.getState().createDeck('我原本的牌組');
  const draft = buildImportedDeck(event, entry(), catalog.cards, useDeckStore.getState().decks.map((d) => d.name));
  const importedId = useDeckStore.getState().importDeck(draft.name, draft.zones);

  const state = useDeckStore.getState();
  assert.equal(state.decks.length, 2);
  assert.equal(state.activeDeckId, importedId);
  assert.equal(state.decks.find((d) => d.id === existingId).name, '我原本的牌組');
  assert.equal(state.decks.find((d) => d.id === existingId).main.length, 0, 'existing deck untouched');

  const imported = state.decks.find((d) => d.id === importedId);
  assert.equal(imported.oshi[0].qty, 1);
  assert.equal(imported.main.reduce((n, s) => n + s.qty, 0), 50);
  assert.equal(imported.yell[0].qty, 20);
});

await test('repeated import creates independent copies with distinct names', () => {
  resetStore();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const names = useDeckStore.getState().decks.map((d) => d.name);
    const draft = buildImportedDeck(event, entry(), catalog.cards, names);
    ids.push(useDeckStore.getState().importDeck(draft.name, draft.zones));
  }
  const decks = useDeckStore.getState().decks;
  assert.equal(decks.length, 3);
  assert.equal(new Set(ids).size, 3, 'each import gets its own deck id');
  assert.deepEqual(decks.map((d) => d.name), [
    '東北 A 組預選｜鷹嶺ルイ（紫単）·予選8位·まっさん3297',
    '東北 A 組預選｜鷹嶺ルイ（紫単）·予選8位·まっさん3297 (2)',
    '東北 A 組預選｜鷹嶺ルイ（紫単）·予選8位·まっさん3297 (3)',
  ]);
});

await test('editing one copy never changes another copy or the source report', () => {
  resetStore();
  const sourceDeck = entry();
  const sourceCardsBefore = JSON.parse(JSON.stringify(sourceDeck.cards));

  const first = buildImportedDeck(event, sourceDeck, catalog.cards, []);
  const firstId = useDeckStore.getState().importDeck(first.name, first.zones);
  const second = buildImportedDeck(event, sourceDeck, catalog.cards, useDeckStore.getState().decks.map((d) => d.name));
  const secondId = useDeckStore.getState().importDeck(second.name, second.zones);

  const slot = useDeckStore.getState().decks.find((d) => d.id === firstId).main[0];
  useDeckStore.getState().changeCard(firstId, 'main', slot.card, 5);
  useDeckStore.getState().renameDeck(firstId, '我改過的版本');

  const edited = useDeckStore.getState().decks.find((d) => d.id === firstId);
  const untouched = useDeckStore.getState().decks.find((d) => d.id === secondId);
  assert.equal(edited.main.find((s) => s.card.id === slot.card.id).qty, 9);
  assert.equal(untouched.main.find((s) => s.card.id === slot.card.id).qty, 4, 'the other copy is unchanged');
  assert.equal(untouched.name, second.name);
  assert.deepEqual(sourceDeck.cards, sourceCardsBefore, 'the tournament source data is unchanged');
});

await test('an imported deck survives reload with zones, quantities and flags intact', async () => {
  resetStore();
  const draft = buildImportedDeck(event, entry(), catalog.cards, []);
  const id = useDeckStore.getState().importDeck(draft.name, draft.zones);

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'import must write a persisted payload');

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  const restored = useDeckStore.getState().decks.find((d) => d.id === id);
  assert.ok(restored, 'imported deck must be restored after reload');
  assert.equal(restored.name, draft.name);
  assert.equal(restored.oshi.reduce((n, s) => n + s.qty, 0), 1);
  assert.equal(restored.main.reduce((n, s) => n + s.qty, 0), 50);
  assert.equal(restored.yell.reduce((n, s) => n + s.qty, 0), 20);
  assert.equal(
    restored.main.find((s) => s.card.cardNumber === 'hMAIN-002').card.unresolvedPrinting,
    true,
    'the unresolved-printing flag must survive reload',
  );
  assert.equal(useDeckStore.getState().activeDeckId, id, 'the imported deck stays active');
});

console.log(`\nDIC-1000 tournament deck import: ${passed} tests passed`);
