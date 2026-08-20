#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const editor = fs.readFileSync('src/screens/DeckEditorScreen.tsx', 'utf8');
const collection = fs.readFileSync('src/screens/CollectionScreen.tsx', 'utf8');
const detail = fs.readFileSync('src/screens/CardDetailScreen.tsx', 'utf8');
const navigation = fs.readFileSync('src/navigation/AppNavigator.tsx', 'utf8');
const breakpoint = fs.readFileSync('src/hooks/useBreakpoint.ts', 'utf8');
const e2e = fs.readFileSync('scripts/verify-dic1086-production-e2e.mjs', 'utf8');

assert.ok(editor.includes('width <= 480'), 'phone panel switching must activate at <=480px');
assert.ok(editor.includes('deck-mobile-panel-switch'));
for (const label of ['選卡', '推し', '主牌', 'エール', '缺卡']) {
  assert.ok(editor.includes(`'${label}'`), `mobile switch is missing ${label}`);
}
assert.ok(editor.includes('deck-phone-progress'));
assert.ok(editor.includes('stats.total}/{stats.totalTarget}'));
assert.match(
  editor,
  /phonePanelTab:\s*\{[^}]*minHeight:\s*44/,
  'all five primary phone panel controls must keep a >=44px touch target',
);
assert.ok(breakpoint.includes('useWindowDimensions'), 'orientation changes must use live dimensions');

assert.ok(!editor.includes('收藏擁有數量'), 'deck editor must not duplicate the Collection panel');
assert.ok(!editor.includes('onAddOwned='), 'deck picker must not edit inventory');
assert.ok(!editor.includes('gapOwned'), 'shortage rows must not render owned controls');
assert.ok(!editor.includes('setOwned(r.cardNumber'), 'shortage rows must not mutate inventory');
assert.ok(editor.includes('computeGap(activeDeck, collection'), 'shortage math must still read ownership');

assert.ok(navigation.includes('name="Collection"'));
assert.ok(navigation.includes('component={CollectionScreen}'));
assert.ok(collection.includes("from '../store/deckStore'"), 'Collection must use the deck inventory store');
assert.ok(collection.includes('loadCardDatabase'), 'Collection must browse exact catalog printings');
assert.ok(collection.includes('<Image'), 'Collection must render card images');
assert.ok(collection.includes('collection-search'));
assert.ok(collection.includes('collection-filters'));
assert.ok(collection.includes('adjustOwned(item.cardNumber, item.printing'));
assert.ok(collection.includes('setOwned(item.cardNumber, item.printing, 0)'));
assert.ok(collection.includes('legacyCard(key)'), 'persisted legacy ownership must remain visible');

assert.ok(detail.includes("from '../store/deckStore'"), 'card detail must share the deck inventory store');
assert.ok(detail.includes('ownershipKey(id, collectionVersion.printing)'));
assert.ok(detail.includes('card-detail-collection-inc'));
assert.ok(e2e.includes("DIC1086_URL || 'https://holohunter.dicoge.com'"));
assert.ok(e2e.includes("{ width: 390, height: 844"));
assert.ok(e2e.includes("editorText.includes('缺 1')"));
assert.ok(e2e.includes('assertCollectionPersists'));
assert.ok(e2e.includes('getBoundingClientRect'));
assert.ok(e2e.includes('target.height >= 44'));

console.log('DIC-1086 collection/mobile UI regression passed.');
