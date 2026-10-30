#!/usr/bin/env node
/**
 * X9552 follow-up — the REAL import of the verified X9552 deck must be legal in
 * the deck editor, not merely `cardsVerified` in the report.
 *
 * X9552 publishes hBP01-068 (尾丸ポルカ Debut) ×5. The official card carries the
 * エクストラ 「このホロメンはデッキに何枚でも入れられる」 (official image
 * hBP01/hBP01-068_C.png, sha256 43baddd1…, and the official card list text), so
 * ×5 is legal. Before this change data/deck-rules.json listed no unlimited card,
 * so the imported deck opened in the editor with ERR_CARD_LIMIT on hBP01-068 and
 * isDeckLegal === false.
 *
 * The fix is ONLY the data-driven registry entry for hBP01-068, with its source
 * attribution. This suite runs the real chain — shipped October report →
 * production catalog adapter (adaptDatabase) → buildImportedDeck → deckStore
 * importDeck → persist/rehydrate → the editor's load migrations →
 * validateDeck / isDeckLegal — and keeps the other limits honest:
 *   • an ordinary card ×5 is still ERR_CARD_LIMIT (default 4 unchanged);
 *   • a card whose catalog text has the same エクストラ but is NOT in the
 *     attributed registry is still limited (no automatic exemption from text);
 *   • the restricted card hBP07-101 ×2 is still ERR_RESTRICTED;
 *   • without the registry entry the same real deck is refused again.
 *
 * Run: npm run test:tournament-x9552-import
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildCatalogIndex, buildImportedDeck, evaluateImport, resolveSlotCard,
} from '../src/utils/tournamentDeckImport.ts';
import { RULES, validateDeck, isDeckLegal, deckStats } from '../src/utils/deckRules.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { groupVariantsByCardNumber, buildLowCostIndex } from '../src/utils/deckVariants.ts';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const STORE_KEY = 'hunterCard-decks';
const IMPORTED_AT = '2026-10-30T00:00:00.000Z';
const POLKA = 'hBP01-068';
const HOLOAN = 'hSD14-010';
const RESTRICTED = 'hBP07-101';
const EXTRA_TEXT = 'このホロメンはデッキに何枚でも入れられる';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const reportRaw = fs.readFileSync('data/tournaments/2026-10.json', 'utf8');
const report = JSON.parse(reportRaw);
const event = report.events[0];
const X9552 = event.decks.find((d) => d.decklogCode === 'X9552');
assert.ok(X9552, 'X9552 must be present in the shipped October report');
const sourceSnapshot = JSON.stringify(X9552);

const liveRows = Object.values(read('public/data/database.json').cards || {});
const db = adaptDatabase(liveRows);
const catalog = buildCatalogIndex(db.cards);

const sumOf = (deck, zone, n) => deck[zone].filter((s) => s.card.cardNumber === n).reduce((a, s) => a + s.qty, 0);
const codes = (deck) => validateDeck(deck).filter((i) => i.level === 'error').map((i) => `${i.code}:${i.cardNumber ?? ''}`);
const reportSums = () => {
  const m = new Map();
  for (const r of X9552.cards) m.set(`${r.zone}|${r.cardNumber}`, (m.get(`${r.zone}|${r.cardNumber}`) ?? 0) + r.count);
  return [...m.entries()].sort();
};
const deckSums = (deck) => {
  const m = new Map();
  for (const z of ['oshi', 'main', 'yell']) {
    for (const s of deck[z]) m.set(`${z}|${s.card.cardNumber}`, (m.get(`${z}|${s.card.cardNumber}`) ?? 0) + s.qty);
  }
  return [...m.entries()].sort();
};
const keywordEffects = (rows, n) => rows.filter((r) => r.cardNumber === n)
  .flatMap((r) => (r.skillsJp?.keywords ?? []).filter((k) => k.label === 'エクストラ').map((k) => k.effect));

function importIntoStore() {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.removeItem(STORE_KEY);
  const draft = buildImportedDeck(event, X9552, catalog, db.priceRecords, [], IMPORTED_AT);
  assert.ok(draft, 'the verified X9552 deck must build an import draft');
  const id = useDeckStore.getState().importDeck(draft);
  return useDeckStore.getState().decks.find((d) => d.id === id);
}

/** Move `qty` copies from one main slot to another (keeps main at exactly 50). */
function shift(deck, fromNumber, toCard, qty) {
  const d = structuredClone(deck);
  const from = d.main.find((s) => s.card.cardNumber === fromNumber);
  assert.ok(from && from.qty >= qty, `${fromNumber} must hold ${qty} copies to move`);
  from.qty -= qty;
  if (from.qty === 0) d.main = d.main.filter((s) => s !== from);
  const to = d.main.find((s) => s.card.cardNumber === toCard.cardNumber);
  if (to) to.qty += qty;
  else d.main.push({ card: toCard, qty });
  assert.equal(deckStats(d).main, 50);
  return d;
}

const ordinaryCard = (cardNumber) => {
  const card = resolveSlotCard({ zone: 'main', cardNumber, count: 1, version: null }, catalog, db.priceRecords);
  assert.ok(card, `${cardNumber} must exist in the local catalog`);
  return card;
};

// ── Registry: exactly one attributed entry, matching the official text ───────
await test('registry lists ONLY hBP01-068 as unlimited, with official source attribution', () => {
  assert.deepEqual(RULES.unlimitedCopyCards.cardNumbers, [POLKA]);
  const sources = RULES.unlimitedCopyCards.sources ?? {};
  assert.deepEqual(Object.keys(sources), RULES.unlimitedCopyCards.cardNumbers, 'every unlimited card needs its source, and only those');
  const s = sources[POLKA];
  assert.equal(s.label, 'エクストラ');
  assert.equal(s.text, EXTRA_TEXT);
  assert.equal(s.officialImage, 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP01/hBP01-068_C.png');
  assert.equal(s.officialImageSha256, '43baddd1d8dbc81580ede54a949bb7f34cf6d79c13f30337205366faad09a0a9');
  assert.match(s.officialCardList, /^https:\/\/hololive-official-cardgame\.com\/cardlist\/cardsearch\//);
  // The attributed text is the one the canonical catalog carries for every
  // printing of that number, and the image is one of the catalog's own.
  for (const p of ['data/database.json', 'public/data/database.json']) {
    const rows = Object.values(read(p).cards);
    const effects = keywordEffects(rows, POLKA);
    assert.ok(effects.length > 0 && effects.every((e) => e === s.text), `${p}: ${POLKA} エクストラ text`);
    assert.ok(rows.some((r) => r.cardNumber === POLKA && r.officialImage === s.officialImage), `${p}: official image`);
  }
  // Every other limit is untouched.
  assert.equal(RULES.copyLimits.mainDefault, 4);
  assert.deepEqual(RULES.restrictedCards, { [RESTRICTED]: 1 });
});

// ── The real import chain ────────────────────────────────────────────────────
await test('real X9552 report → catalog adapter → buildImportedDeck → store: legal 1/50/20, holoAN ×2, Polka ×5', () => {
  assert.equal(X9552.cardsVerified, true);
  assert.deepEqual(evaluateImport(X9552, catalog), { importable: true });
  const deck = importIntoStore();
  const st = deckStats(deck);
  assert.deepEqual([st.oshi, st.main, st.yell, st.total], [1, 50, 20, 71]);
  assert.equal(sumOf(deck, 'main', HOLOAN), 2);
  assert.equal(deck.main.filter((s) => s.card.cardNumber === HOLOAN).length, 1, 'holoAN is one slot');
  assert.equal(sumOf(deck, 'main', POLKA), 5, 'source-published ×5 is kept, never trimmed to 4');
  assert.deepEqual(deckSums(deck), reportSums(), 'every source slot keeps its zone, number and count');
  assert.deepEqual(codes(deck), []);
  assert.equal(isDeckLegal(deck), true);
  assert.equal(deck.origin?.decklogCode, 'X9552');
});

await test('it stays legal and complete after reload and the editor load migrations', async () => {
  const imported = importIntoStore();
  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw && raw.includes('X9552'), 'the import is persisted');
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();
  // What DeckEditorScreen runs on every database load.
  const lowCostIndex = buildLowCostIndex(groupVariantsByCardNumber(db.cards, db.priceRecords));
  assert.ok(lowCostIndex.size > 0);
  useDeckStore.getState().migrateLegacyPrintings(lowCostIndex);
  useDeckStore.getState().migrateTournamentDefaults(lowCostIndex);
  const deck = useDeckStore.getState().decks.find((d) => d.id === imported.id);
  assert.ok(deck, 'the imported deck reopens');
  assert.deepEqual(deckSums(deck), reportSums());
  assert.equal(sumOf(deck, 'main', POLKA), 5);
  assert.equal(sumOf(deck, 'main', HOLOAN), 2);
  assert.deepEqual(codes(deck), []);
  assert.equal(isDeckLegal(deck), true);
});

await test('import and validation never alter the source report', () => {
  importIntoStore();
  assert.equal(JSON.stringify(X9552), sourceSnapshot);
  assert.equal(fs.readFileSync('data/tournaments/2026-10.json', 'utf8'), reportRaw);
});

// ── Negative controls on the same real deck ──────────────────────────────────
await test('negative: without the registry entry the same real deck is ERR_CARD_LIMIT again', () => {
  const deck = importIntoStore();
  const saved = RULES.unlimitedCopyCards.cardNumbers;
  try {
    RULES.unlimitedCopyCards.cardNumbers = [];
    assert.deepEqual(codes(deck), [`ERR_CARD_LIMIT:${POLKA}`]);
    assert.equal(isDeckLegal(deck), false);
  } finally {
    RULES.unlimitedCopyCards.cardNumbers = saved;
  }
  assert.equal(isDeckLegal(deck), true);
});

await test('negative: an unrelated ordinary card ×5 is still ERR_CARD_LIMIT (default 4 unchanged)', () => {
  const deck = importIntoStore();
  assert.deepEqual(keywordEffects(liveRows, HOLOAN), [], 'holoAN carries no unlimited text');
  const holoAN = deck.main.find((s) => s.card.cardNumber === HOLOAN).card;
  const bad = shift(deck, POLKA, holoAN, 3); // holoAN 2→5, Polka 5→2
  assert.equal(sumOf(bad, 'main', HOLOAN), 5);
  assert.deepEqual(codes(bad), [`ERR_CARD_LIMIT:${HOLOAN}`]);
  assert.equal(isDeckLegal(bad), false);
  // exactly 4 is still fine
  assert.equal(isDeckLegal(shift(deck, POLKA, holoAN, 2)), true);
});

await test('negative: catalog text alone exempts nothing — an unlisted card with the same エクストラ ×5 is refused', () => {
  const deck = importIntoStore();
  const unlisted = [...new Set(liveRows
    .filter((r) => !RULES.unlimitedCopyCards.cardNumbers.includes(r.cardNumber))
    .filter((r) => keywordEffects([r], r.cardNumber).includes(EXTRA_TEXT))
    .map((r) => r.cardNumber))]
    .sort()
    .find((n) => !deck.main.some((s) => s.card.cardNumber === n) && ordinaryCard(n).defaultedPrinting === true);
  assert.ok(unlisted, 'the catalog has an unlisted card with the same text');
  const bad = shift(deck, POLKA, ordinaryCard(unlisted), 5); // Polka 5→0, unlisted ×5
  assert.deepEqual(codes(bad), [`ERR_CARD_LIMIT:${unlisted}`]);
  assert.equal(isDeckLegal(bad), false);
});

await test('negative: the restricted card ×2 is still ERR_RESTRICTED; ×1 is legal', () => {
  const deck = importIntoStore();
  const restricted = ordinaryCard(RESTRICTED);
  const bad = shift(deck, POLKA, restricted, 2);
  assert.deepEqual(codes(bad), [`ERR_RESTRICTED:${RESTRICTED}`]);
  assert.equal(isDeckLegal(bad), false);
  assert.equal(isDeckLegal(shift(deck, POLKA, restricted, 1)), true);
});

console.log(`\nX9552 real import + deck rules: ${passed} checks passed`);
