#!/usr/bin/env node
/**
 * 掃描估值的版本 fail-closed 回歸（DIC-1013）
 *
 * 跑法：npm run test:scan-fail-closed
 *
 * 走真正的 scanSessionStore（zustand + persist + 記憶體 storage），資料取自出貨用的
 * public/data/database.json —— 不是重寫的簡化版管線。
 *
 * 釘住的合約：來源無法證明是哪一筆掛牌時，掃描不得替使用者挑一個價格。hBP02-017 真的有
 * 兩筆同名「白銀ノエル(パラレル)」¥3,480／¥500；先前掃描會直接取第一筆，於是同一張實體
 * 卡的估值會隨來源掛牌順序在 ¥3,480 與 ¥500 之間跳動。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useScanSessionStore, getEffectivePrice } from '../src/stores/scanSessionStore.ts';
import { buildPriceVersions, resolveVersionForCard } from '../src/utils/versionAlignment.ts';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(dirname, '..', 'public', 'data', 'database.json');
const cards = JSON.parse(readFileSync(dbPath, 'utf8')).cards || {};
const rowFor = (cardNumber) => Object.values(cards).find((c) => c.cardNumber === cardNumber);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const reset = () => useScanSessionStore.getState().clearSession();
const scan = (card) => {
  reset();
  useScanSessionStore.getState().addCard(card, { force: true });
  const state = useScanSessionStore.getState();
  return { card: state.cards[0], total: state.totalValue };
};

// 真實出貨資料，未經修改。
const NOEL = rowFor('hBP02-017');
assert.ok(NOEL, 'hBP02-017 必須存在於出貨資料庫');
const DUPES = NOEL.prices.filter((p) => p.name === '白銀ノエル(パラレル)');
assert.equal(DUPES.length, 2, '前提：來源真的有兩筆同名 パラレル 掛牌');
assert.deepEqual(DUPES.map((p) => p.sellPrice).sort((a, b) => a - b), [500, 3480]);

console.log('=== 來源可辨識時照常計價 ===');

test('hBP02-017 完整掛牌 → 預設落在可辨識的原印 ¥120 並計入總計', () => {
  const { card, total } = scan({ ...NOEL, prices: NOEL.prices });
  assert.equal(card.versionConfident, true);
  assert.equal(getEffectivePrice(card), 120);
  assert.equal(total, 120);
});

test('hBP02-017 掛牌順序反轉後仍是 ¥120（總計不隨來源順序改變）', () => {
  const { card, total } = scan({ ...NOEL, prices: NOEL.prices.slice().reverse() });
  assert.equal(card.versionConfident, true);
  assert.equal(total, 120);
});

console.log('\n=== 預設版本本身無法辨識 → 不計價、不入總計 ===');

// 只留下那兩筆真實的重複掛牌：此時預設版本自己就是歧義的那一個。
const ambiguousCard = { ...NOEL, prices: DUPES };
const reversedCard = { ...NOEL, prices: DUPES.slice().reverse() };

test('同代碼兩筆掛牌 [¥3,480, ¥500] → 版本待確認、無價、總計 0', () => {
  const { card, total } = scan(ambiguousCard);
  assert.equal(card.versionConfident, false);
  assert.equal(getEffectivePrice(card), null);
  assert.equal(total, 0);
});

test('反轉成 [¥500, ¥3,480] → 仍是版本待確認、無價、總計 0', () => {
  const { card, total } = scan(reversedCard);
  assert.equal(card.versionConfident, false);
  assert.equal(getEffectivePrice(card), null);
  assert.equal(total, 0);
});

test('兩種來源順序的總計完全相同（不再是 ¥3,480 vs ¥500）', () => {
  assert.equal(scan(ambiguousCard).total, scan(reversedCard).total);
});

test('兩筆掛牌都仍列在清單上供使用者挑選（fail closed 不等於丟資料）', () => {
  const { card } = scan(ambiguousCard);
  assert.equal(card.priceVersions.length, 2);
  assert.deepEqual(card.priceVersions.map((v) => v.sellPrice).sort((a, b) => a - b), [500, 3480]);
});

test('多張待確認卡都不入總計，另一張可辨識的卡照常計價', () => {
  reset();
  const store = useScanSessionStore.getState();
  store.addCard(ambiguousCard, { force: true });
  store.addCard(reversedCard, { force: true });
  store.addCard({ ...NOEL, prices: NOEL.prices }, { force: true });
  const state = useScanSessionStore.getState();
  assert.equal(state.cardCount, 3);
  assert.equal(state.cards.filter((c) => !c.versionConfident).length, 2);
  assert.equal(state.totalValue, 120);
});

console.log('\n=== 只有使用者明說才解除待確認 ===');

test('使用者選定其中一筆 → 該筆價格才進總計', () => {
  const { card } = scan(ambiguousCard);
  const cheap = card.priceVersions.findIndex((v) => v.sellPrice === 500);
  useScanSessionStore.getState().setCardVersion(card.instanceId, cheap);
  const after = useScanSessionStore.getState();
  assert.equal(after.cards[0].versionConfident, true);
  assert.equal(getEffectivePrice(after.cards[0]), 500);
  assert.equal(after.totalValue, 500);
});

test('改選另一筆 → 總計跟著使用者的選擇走', () => {
  const state = useScanSessionStore.getState();
  const pricey = state.cards[0].priceVersions.findIndex((v) => v.sellPrice === 3480);
  state.setCardVersion(state.cards[0].instanceId, pricey);
  assert.equal(useScanSessionStore.getState().totalValue, 3480);
});

test('移除待確認卡後總計不變（本來就沒算它）', () => {
  reset();
  const store = useScanSessionStore.getState();
  store.addCard({ ...NOEL, prices: NOEL.prices }, { force: true });
  store.addCard(ambiguousCard, { force: true });
  const before = useScanSessionStore.getState().totalValue;
  const pending = useScanSessionStore.getState().cards.find((c) => !c.versionConfident);
  useScanSessionStore.getState().removeCard(pending.instanceId);
  assert.equal(useScanSessionStore.getState().totalValue, before);
  assert.equal(before, 120);
});

console.log('\n=== 全庫掃描 ===');

test('出貨資料庫每一張卡：有價 ⇔ 版本已確認（掃描與卡片頁同一個判定）', () => {
  let priced = 0;
  let pending = 0;
  for (const row of Object.values(cards)) {
    const resolution = resolveVersionForCard(buildPriceVersions(row));
    const { card } = scan(row);
    assert.equal(card.versionConfident, resolution.confident, `${row.cardNumber} confident 不一致`);
    if (card.versionConfident) {
      priced += 1;
    } else {
      pending += 1;
      assert.equal(getEffectivePrice(card), null, `${row.cardNumber} 待確認卻仍有價`);
    }
  }
  console.log(`    已確認 ${priced}｜待確認 ${pending}`);
});

reset();
console.log(`\n全部 ${passed} 項通過。`);
