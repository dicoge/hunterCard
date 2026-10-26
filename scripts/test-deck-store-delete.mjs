#!/usr/bin/env node
import assert from 'node:assert/strict';
import { useDeckStore } from '../src/store/deckStore.ts';
import platformStorage from '../src/stores/storage.ts';

const STORE_KEY = 'hunterCard-decks';

function resetStore() {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.removeItem(STORE_KEY);
}

const sampleCard = {
  id: 'hOS-001#BASE', cardNumber: 'hOS-001', name: '推しカード',
  printing: 'BASE', printingLabel: '通常', series: 'hOS', cardTypeJp: '推しホロメン',
};

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('delete removes only the selected deck and returns active state to library', () => {
  resetStore();
  const first = useDeckStore.getState().createDeck('保留牌組');
  const deleted = useDeckStore.getState().createDeck('要刪除的牌組');
  useDeckStore.getState().changeCard(deleted, 'oshi', sampleCard, 1);
  useDeckStore.getState().setOwned(sampleCard.cardNumber, sampleCard.printing, 3);

  useDeckStore.getState().deleteDeck(deleted);

  assert.deepEqual(useDeckStore.getState().decks.map((deck) => deck.id), [first]);
  assert.equal(useDeckStore.getState().activeDeckId, null);
  assert.equal(useDeckStore.getState().getOwned(sampleCard.cardNumber, sampleCard.printing), 3);
});

await test('cancel is safe because no delete action leaves persisted data unchanged', () => {
  resetStore();
  const deckId = useDeckStore.getState().createDeck('取消刪除');
  const before = platformStorage.getItem(STORE_KEY);
  assert.ok(before?.includes(deckId));
  assert.equal(platformStorage.getItem(STORE_KEY), before);
  assert.equal(useDeckStore.getState().decks[0].name, '取消刪除');
});

await test('deletion persists after reload', async () => {
  resetStore();
  const kept = useDeckStore.getState().createDeck('重新載入後保留');
  const deleted = useDeckStore.getState().createDeck('重新載入後消失');
  useDeckStore.getState().deleteDeck(deleted);
  const persisted = platformStorage.getItem(STORE_KEY);
  const parsed = JSON.parse(persisted);
  assert.ok(parsed?.state?.decks?.some((d) => d.id === kept), 'kept deck stays in persisted decks array');
  assert.ok(!parsed?.state?.decks?.some((d) => d.id === deleted), 'deleted deck is gone from the persisted decks array');
  // DIC-1380 W6: the deleted deck id ALSO lands in the persisted
  // `deletedDeckIds` tombstone map so the account-sync 409 merge can
  // honor the deletion across a reload. That is not the same as the
  // deck still being in `decks` — the deck is gone; only the delete
  // proof-of-write survives.
  assert.ok(parsed?.state?.deletedDeckIds?.[deleted], 'delete tombstone persists (DIC-1380 W6)');

  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {}, deletedDeckIds: {}, collectionChangedKeys: {} });
  platformStorage.setItem(STORE_KEY, persisted);
  await useDeckStore.persist.rehydrate();

  assert.deepEqual(useDeckStore.getState().decks.map((deck) => deck.id), [kept]);
});

console.log(`\nDIC-1088 deck delete: ${passed} tests passed`);
