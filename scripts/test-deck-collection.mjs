#!/usr/bin/env node
/**
 * DIC-978 global collection + missing-card estimate regression.
 *
 * Covers the acceptance matrix (issue item 8):
 *   - inventory persistence + v0→v1 migration (normalized re-keying, collision sum)
 *   - exact-version ownership (normalized variant/version key)
 *   - missing math per exact card version
 *   - multiple decks do NOT mutate the shared inventory (no double-counting)
 *   - ambiguous / cross-version prices excluded from the priced subtotal
 *   - currency separation (different currencies never summed together)
 *   - zero / negative / fractional input protection on the owned setters
 *
 * Pure engine lives in src/utils/deckRules.ts; the store path exercises the real
 * persistent zustand store against the in-memory fallback storage.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-deck-collection.mjs
 */
import assert from 'node:assert/strict';
import {
  computeGap, ownershipKey, normalizeVersion, resolveExactPrice,
} from '../src/utils/deckRules.ts';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const STORE_KEY = 'hunterCard-decks';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// Identity is (cardNumber, printing) — the source-proven printing token (DIC-1013).
const holomen = (n, printing = 'BASE') => ({
  id: `${n}#${printing}`, cardNumber: n, name: `holomen ${n}`,
  printing, printingLabel: '', series: 's', cardTypeJp: 'ホロメン',
});
const slot = (card, qty) => ({ card, qty });
const deck = (id, main) => ({ id, name: id, updatedAt: '', oshi: [], main, yell: [] });

function resetStore() {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.removeItem(STORE_KEY);
}

// ── Normalized variant/version key ───────────────────────────────────────────
await test('normalizeVersion folds case / width / whitespace to one bucket', () => {
  assert.equal(normalizeVersion(' sr '), 'SR');
  assert.equal(normalizeVersion('Sr'), 'SR');
  assert.equal(normalizeVersion('ＳＲ'), 'SR'); // full-width → half-width via NFKC
  assert.equal(normalizeVersion('P_02'), 'P_02');
  // Two spellings of the same printing collapse to one ownershipKey.
  assert.equal(ownershipKey('hMN-001', ' sr '), ownershipKey('hMN-001', 'SR'));
  // A genuinely different rarity keeps its own key.
  assert.notEqual(ownershipKey('hMN-001', 'SR'), ownershipKey('hMN-001', 'SEC'));
});

// ── Exact-version ownership via the store ────────────────────────────────────
await test('setOwned stores under the normalized key; getOwned reads it back', () => {
  resetStore();
  const s = useDeckStore.getState();
  s.setOwned('hMN-001', ' sr ', 3);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'SR'), 3);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'Sr'), 3);
  // Different version is a separate, independent bucket.
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'SEC'), 0);
});

// ── Zero / negative / fractional input protection ────────────────────────────
await test('setOwned rejects zero / negative / NaN and floors fractional', () => {
  resetStore();
  const s = useDeckStore.getState();
  s.setOwned('hMN-001', 'R', -5);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 0);
  s.setOwned('hMN-001', 'R', 0);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 0);
  s.setOwned('hMN-001', 'R', 2.9);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 2);
  s.setOwned('hMN-001', 'R', Number.NaN);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 0);
  // A removed entry must not linger in the persisted map.
  assert.equal(ownershipKey('hMN-001', 'R') in useDeckStore.getState().collection, false);
});

await test('adjustOwned clamps at 0 and never goes negative', () => {
  resetStore();
  const s = useDeckStore.getState();
  s.adjustOwned('hMN-001', 'R', 3);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 3);
  s.adjustOwned('hMN-001', 'R', -10); // over-decrement
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'R'), 0);
  assert.equal(ownershipKey('hMN-001', 'R') in useDeckStore.getState().collection, false);
});

// ── Missing math per exact version ───────────────────────────────────────────
await test('computeGap missing = required − globally owned, per exact version', () => {
  const d = deck('d', [slot(holomen('hMN-001'), 4)]);
  const owned = { [ownershipKey('hMN-001', 'BASE')]: 1 };
  const gap = computeGap(d, owned, []);
  const row = gap.rows.find((r) => r.cardNumber === 'hMN-001');
  assert.equal(row.required, 4);
  assert.equal(row.owned, 1);
  assert.equal(row.missing, 3);
  // Over-owning never yields a negative missing.
  const over = computeGap(d, { [ownershipKey('hMN-001', 'BASE')]: 9 }, []);
  assert.equal(over.rows[0].missing, 0);
});

// ── Multiple decks share ONE inventory; neither mutates it ───────────────────
await test('two decks read the same inventory without double-counting or mutation', () => {
  resetStore();
  const s = useDeckStore.getState();
  s.setOwned('hMN-001', 'BASE', 2);
  const snapshot = JSON.stringify(useDeckStore.getState().collection);

  const owned = useDeckStore.getState().collection;
  const deckA = deck('A', [slot(holomen('hMN-001'), 4)]);
  const deckB = deck('B', [slot(holomen('hMN-001'), 3)]);

  // Each deck sees the FULL global owned (2), not a per-deck split.
  const gapA = computeGap(deckA, owned, []);
  const gapB = computeGap(deckB, owned, []);
  assert.equal(gapA.rows[0].owned, 2);
  assert.equal(gapA.rows[0].missing, 2); // 4 − 2
  assert.equal(gapB.rows[0].owned, 2);
  assert.equal(gapB.rows[0].missing, 1); // 3 − 2

  // Editing a deck's slots must not touch the global inventory.
  const bId = useDeckStore.getState().createDeck('B');
  useDeckStore.getState().changeCard(bId, 'main', holomen('hMN-001'), 3);
  assert.equal(
    JSON.stringify(useDeckStore.getState().collection), snapshot,
    'deck edits must leave the shared inventory unchanged',
  );
});

// ── Ambiguous / cross-version price excluded ─────────────────────────────────
await test('cross-version price never used; row lands in unpriced, not the total', () => {
  const d = deck('p', [slot(holomen('hMN-001'), 2), slot(holomen('hMN-002', 'PARALLEL'), 2)]);
  const records = [
    { cardNumber: 'hMN-001', version: 'BASE', price: 300, currency: 'JPY', source: 'yuyu', timestamp: '2026-07-15' },
    // hMN-002 only has a DIFFERENT-printing (BASE) price → must not price the
    // PARALLEL copy the deck actually requires.
    { cardNumber: 'hMN-002', version: 'BASE', price: 9999, currency: 'JPY', source: 'yuyu', timestamp: '2026-07-01' },
  ];
  const gap = computeGap(d, {}, records);
  assert.equal(gap.total, 600); // only hMN-001 (300×2)
  assert.equal(gap.unpriced.length, 1);
  assert.equal(gap.unpriced[0].cardNumber, 'hMN-002');
  // Empty version can never match, even for the same number.
  assert.equal(
    resolveExactPrice('hMN-002', '', [{ cardNumber: 'hMN-002', version: '', price: 1, currency: 'JPY', source: 's', timestamp: 't' }]).status,
    'NO_EXACT_PRICE',
  );
});

// ── Currency separation ──────────────────────────────────────────────────────
await test('different currencies are kept in separate subtotals, never summed', () => {
  const d = deck('c', [slot(holomen('hMN-001'), 2), slot(holomen('hMN-002', 'PARALLEL'), 2)]);
  const records = [
    { cardNumber: 'hMN-001', version: 'BASE', price: 300, currency: 'JPY', source: 'yuyu', timestamp: '2026-07-15' },
    { cardNumber: 'hMN-002', version: 'PARALLEL', price: 5, currency: 'USD', source: 'other', timestamp: '2026-06-01' },
  ];
  const gap = computeGap(d, {}, records);
  // Primary total is the first-seen currency ONLY (JPY 300×2), not 600+10.
  assert.equal(gap.currency, 'JPY');
  assert.equal(gap.total, 600);
  assert.equal(gap.dataAsOf, '2026-07-15');
  // Both currencies appear as isolated subtotals.
  assert.equal(gap.subtotals.length, 2);
  const jpy = gap.subtotals.find((x) => x.currency === 'JPY');
  const usd = gap.subtotals.find((x) => x.currency === 'USD');
  assert.equal(jpy.total, 600);
  assert.equal(usd.total, 10); // 5×2, kept apart from JPY
  assert.equal(usd.dataAsOf, '2026-06-01');
  // Guard against any accidental cross-currency addition.
  assert.notEqual(gap.total, 610);
});

// ── Persistence + v0 → v1 migration ──────────────────────────────────────────
await test('v0 payload migrates: keys normalized, collisions summed, junk dropped', async () => {
  resetStore();
  // Simulate a pre-DIC-978 (version 0) on-device payload with raw, un-normalized
  // keys — including a case/space collision and an invalid negative count.
  const legacy = JSON.stringify({
    state: {
      decks: [],
      activeDeckId: null,
      collection: {
        'hMN-001|sr': 2,     // collides with 'hMN-001|SR' after normalization
        'hMN-001|SR': 3,
        'hMN-003| r ': 1,    // whitespace + case → 'hMN-003|R'
        'hMN-002|C': -4,     // invalid → dropped
      },
    },
    version: 0,
  });

  // Wipe live state, plant the legacy payload, then rehydrate through migrate().
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, legacy);
  await useDeckStore.persist.rehydrate();

  const col = useDeckStore.getState().collection;
  assert.equal(col[ownershipKey('hMN-001', 'SR')], 5, 'collided buckets must sum (2+3)');
  assert.equal(col[ownershipKey('hMN-003', 'R')], 1, 'whitespace/case key must normalize');
  assert.equal(ownershipKey('hMN-002', 'C') in col, false, 'negative count must be dropped');
  assert.equal(useDeckStore.getState().getOwned('hMN-001', ' sr '), 5);
});

await test('current-version inventory persists and survives reload', async () => {
  resetStore();
  useDeckStore.getState().setOwned('hMN-009', 'OSR', 4);

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'store must write a persisted payload');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2, 'persisted payload must be at current schema version (v2 after DIC-1139)');

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();
  assert.equal(useDeckStore.getState().getOwned('hMN-009', 'OSR'), 4, 'owned count survives reload');
});

// ── DIC-1013: deck slots migrate, inventory does not ─────────────────────────
await test('a pre-DIC-1013 inventory entry survives rehydration untouched', async () => {
  resetStore();
  // Owning an SEC copy of hBP04-005 does NOT prove ownership of the plain ¥980
  // printing, so the persist migration must leave the entry exactly where it is
  // rather than re-keying it onto BASE and fabricating ownership.
  const payload = JSON.stringify({
    state: { decks: [], activeDeckId: null, collection: { 'hBP04-005|SEC': 2 } },
    version: 1,
  });
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, payload);
  await useDeckStore.persist.rehydrate();

  assert.deepEqual(useDeckStore.getState().collection, { 'hBP04-005|SEC': 2 },
    'legacy inventory entries stay visible and editable, and stay put');
  assert.equal(useDeckStore.getState().getOwned('hBP04-005', 'BASE'), 0);
  // A deck requiring the plain printing therefore reports all copies missing,
  // priced at the exact ¥980 sell listing.
  const gap = computeGap(
    deck('m', [slot(holomen('hBP04-005'), 1)]),
    useDeckStore.getState().collection,
    [{ cardNumber: 'hBP04-005', version: 'BASE', price: 980, currency: 'JPY', source: 'yuyu-tei.jp', timestamp: '2026-08-14' }],
  );
  assert.equal(gap.rows[0].owned, 0);
  assert.equal(gap.total, 980);
});

console.log(`\nDIC-978 deck-collection: ${passed} tests passed`);
