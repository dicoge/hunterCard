#!/usr/bin/env node
/**
 * DIC-957 deck-rename regression (P0 QA blocker on PR #98).
 *
 * Exercises the local deck store's renameDeck path end-to-end through the real
 * persistent zustand store, using the in-memory fallback storage (src/stores/
 * storage.ts) that Node/tsc resolve to. Covers the QA acceptance points:
 *   1. Successful rename updates the store.
 *   2. Rename persists and survives reload (serialized payload + rehydration).
 *   3. Empty / whitespace-only name is rejected without corrupting the name.
 *   4. Deck identity and all card / owned-count contents are preserved.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-deck-store-rename.mjs
 */
import assert from 'node:assert/strict';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const STORE_KEY = 'hunterCard-decks';

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

const sampleCard = {
  id: 'hMN-001#BASE',
  cardNumber: 'hMN-001',
  name: 'holomen 001',
  printing: 'BASE',
  printingLabel: '',
  series: 's',
  cardTypeJp: 'ホロメン',
};

function seedDeckWithContents() {
  const s = useDeckStore.getState();
  const id = s.createDeck('初始牌組');
  s.changeCard(id, 'main', sampleCard, 3);
  s.setOwned('hMN-001', 'BASE', 2);
  return id;
}

// ── 1. Successful rename updates the store ───────────────────────────────────
await test('renameDeck updates the active deck name in the store', () => {
  resetStore();
  const id = useDeckStore.getState().createDeck('舊名稱');
  useDeckStore.getState().renameDeck(id, '新名稱');
  const deck = useDeckStore.getState().decks.find((d) => d.id === id);
  assert.equal(deck.name, '新名稱');
  assert.equal(useDeckStore.getState().getActiveDeck().name, '新名稱');
});

// ── 2a. Rename trims surrounding whitespace ──────────────────────────────────
await test('renameDeck trims surrounding whitespace', () => {
  resetStore();
  const id = useDeckStore.getState().createDeck('舊名稱');
  useDeckStore.getState().renameDeck(id, '   間距牌組   ');
  const deck = useDeckStore.getState().decks.find((d) => d.id === id);
  assert.equal(deck.name, '間距牌組');
});

// ── 3. Empty / whitespace-only name is rejected, existing name intact ────────
await test('renameDeck rejects empty name without corrupting existing name', () => {
  resetStore();
  const id = useDeckStore.getState().createDeck('保留名稱');
  useDeckStore.getState().renameDeck(id, '');
  assert.equal(useDeckStore.getState().decks.find((d) => d.id === id).name, '保留名稱');
  useDeckStore.getState().renameDeck(id, '     ');
  assert.equal(useDeckStore.getState().decks.find((d) => d.id === id).name, '保留名稱');
});

// ── 4. Deck identity + card / owned-count contents are preserved ─────────────
await test('renameDeck preserves deck id and all card / owned contents', () => {
  resetStore();
  const id = seedDeckWithContents();
  const before = useDeckStore.getState().decks.find((d) => d.id === id);
  const mainBefore = JSON.parse(JSON.stringify(before.main));

  useDeckStore.getState().renameDeck(id, '重新命名後');

  const after = useDeckStore.getState().decks.find((d) => d.id === id);
  assert.equal(after.id, id, 'deck id must be unchanged');
  assert.equal(after.name, '重新命名後');
  assert.deepEqual(after.main, mainBefore, 'card slots must be preserved');
  assert.equal(after.main[0].qty, 3);
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'BASE'), 2, 'owned counts preserved');
});

// ── 2b. Rename persists to storage and survives reload / rehydration ─────────
await test('renamed deck persists and survives reload (rehydration)', async () => {
  resetStore();
  const id = seedDeckWithContents();
  useDeckStore.getState().renameDeck(id, '持久化名稱');

  // The persist middleware writes synchronously to the in-memory storage.
  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'store must have written a persisted payload');
  assert.ok(raw.includes('持久化名稱'), 'persisted payload must contain the new name');

  // Simulate an app reload: wipe live state. Because the persist middleware
  // writes on every setState, restore the captured snapshot to storage before
  // rehydrating so we rehydrate the persisted deck, not the wiped state.
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  assert.equal(useDeckStore.getState().decks.length, 0);
  platformStorage.setItem(STORE_KEY, raw);

  await useDeckStore.persist.rehydrate();

  const restored = useDeckStore.getState().decks.find((d) => d.id === id);
  assert.ok(restored, 'deck must be restored after rehydration');
  assert.equal(restored.name, '持久化名稱', 'renamed name must survive reload');
  assert.equal(restored.main[0].qty, 3, 'contents must survive reload');
  assert.equal(useDeckStore.getState().getOwned('hMN-001', 'BASE'), 2);
});

console.log(`\nDIC-957 deck-store rename: ${passed} tests passed`);
