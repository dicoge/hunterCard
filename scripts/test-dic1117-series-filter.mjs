#!/usr/bin/env node
/**
 * DIC-1117 — the deck picker's series filter is a CARD-NUMBER filter.
 *
 * The production regression this guards: selecting hBP04 returned 101 cards
 * whose first tiles were hBP04-088, hBP02-084, hSD01-017, hBP04-096 — a
 * reprint's scraped `series` had been merged into the card's own identity, and
 * the results were in insertion order rather than card-number order.
 *
 * Every assertion here is mutation-sensitive: it fails if the series test is
 * widened back to the row-level `series` field, if the sort drops back to
 * lexicographic, or if a card number with several printings is allowed to
 * occupy more than one tile.
 *
 * Run: npm run test:series-filter
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildFacetIndex, cardNumberSortKey, collectFilterOptions, compareCardNumbers,
  filterCatalog, hasActiveFilters, isSeriesCardNumber, matchesSeries,
  seriesOfCardNumber, sortByCardNumber, EMPTY_CRITERIA,
} from '../src/utils/cardCatalog.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { groupVariantsByCardNumber } from '../src/utils/deckVariants.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── The real shipped catalog ─────────────────────────────────────────────────
const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const rawRows = Object.values(rawDb.cards || {});
const db = adaptDatabase(rawRows);
const facets = db.facets;
const groups = groupVariantsByCardNumber(db.cards, db.priceRecords);
const search = (patch) => filterCatalog(groups, facets, { ...EMPTY_CRITERIA, ...patch });

console.log('DIC-1117 卡號系列篩選＋數字排序');

// ── 1. The exact production evidence ────────────────────────────────────────
test('選 hBP04 只會得到卡號為 hBP04-### 的卡', () => {
  const hits = search({ series: ['hBP04'] });
  assert.ok(hits.length > 0, 'hBP04 必須有結果');
  const strays = hits.map((g) => g.cardNumber).filter((n) => !/^hBP04-\d+$/.test(n));
  assert.deepEqual(strays, [], `混入了非 hBP04 卡號：${strays.join(', ')}`);
});

test('production 截圖中的三張混入卡號都被排除', () => {
  const numbers = new Set(search({ series: ['hBP04'] }).map((g) => g.cardNumber));
  for (const stray of ['hBP02-084', 'hSD01-017', 'hY01-006']) {
    assert.ok(!numbers.has(stray), `${stray} 仍出現在 hBP04 選擇中`);
  }
});

test('資料庫確實有 series=hBP04 但卡號不是 hBP04 的列（否則這組測試沒有意義）', () => {
  const mismatched = rawRows.filter(
    (r) => String(r.series || '').toLowerCase() === 'hbp04'
      && !/^hBP04-/i.test(String(r.cardNumber || '')),
  );
  assert.ok(
    mismatched.length > 0,
    'negative control：卡表若已無跨系列轉載列，這個回歸就無法證明篩選是嚴格的',
  );
  const numbers = mismatched.map((r) => r.cardNumber);
  assert.ok(numbers.includes('hBP02-084'), 'hBP02-084 是 production 截圖的證據列');
  assert.ok(numbers.includes('hSD01-017'), 'hSD01-017 是 production 截圖的證據列');
});

test('轉載列的 series 不會寫進卡片自己的系列身分', () => {
  for (const cardNumber of ['hBP02-084', 'hSD01-017', 'hY01-006']) {
    const f = facets.get(cardNumber);
    assert.ok(f, `${cardNumber} 必須存在於卡表`);
    assert.equal(
      f.series, seriesOfCardNumber(cardNumber),
      `${cardNumber} 的系列必須來自卡號本身，而不是抓取來源`,
    );
  }
});

test('每個系列選擇的結果都嚴格等於該卡號前綴的卡片集合', () => {
  const options = collectFilterOptions(facets.values());
  for (const series of options.series) {
    const hits = search({ series: [series] }).map((g) => g.cardNumber);
    const expected = groups
      .map((g) => g.cardNumber)
      .filter((n) => seriesOfCardNumber(n) === series)
      .sort(compareCardNumbers);
    assert.deepEqual(hits, expected, `${series} 的結果與卡號前綴集合不一致`);
  }
});

// ── 2. Prefix matching is exact, not a substring ────────────────────────────
test('系列比對是完整前綴，不是字串包含', () => {
  assert.equal(seriesOfCardNumber('hBP04-088'), 'hBP04');
  assert.equal(seriesOfCardNumber('hBP0-001'), 'hBP0');
  assert.equal(matchesSeries('hBP040-001', ['hBP04']), false, 'hBP040 不是 hBP04');
  assert.equal(matchesSeries('hBP4-001', ['hBP04']), false, 'hBP4 不是 hBP04');
  assert.equal(matchesSeries('hSD01-017', ['hBP04']), false);
  assert.equal(matchesSeries('hBP04-088', ['hBP04']), true);
});

test('系列比對忽略大小寫', () => {
  assert.equal(matchesSeries('hbp04-088', ['hBP04']), true);
  assert.equal(matchesSeries('HBP04-088', ['hbp04']), true);
  assert.equal(seriesOfCardNumber('HBP04-088'), 'hBP04', '顯示用的系列代號收斂成卡表的寫法');
});

test('沒有卡號前綴的畸形列不屬於任何系列', () => {
  assert.equal(isSeriesCardNumber('202'), false);
  assert.equal(isSeriesCardNumber('hBP04'), false, '沒有數字尾碼就不是系列成員');
  assert.equal(isSeriesCardNumber('hBP04-088'), true);
  assert.equal(matchesSeries('202', ['hBP04']), false);
  assert.equal(matchesSeries('', ['hBP04']), false);
});

test('沒有選任何系列時不篩掉任何卡', () => {
  assert.equal(matchesSeries('hBP02-084', []), true);
  assert.equal(search({}).length, groups.length);
});

// ── 3. Numeric ordering ─────────────────────────────────────────────────────
test('卡號尾碼以數字排序，不是字典序', () => {
  const scrambled = [
    'hBP04-096', 'hBP04-010', 'hBP04-002', 'hBP04-088', 'hBP04-001', 'hBP04-100',
    'hBP04-009', 'hBP04-020',
  ];
  assert.deepEqual(
    scrambled.slice().sort(compareCardNumbers),
    [
      'hBP04-001', 'hBP04-002', 'hBP04-009', 'hBP04-010', 'hBP04-020',
      'hBP04-088', 'hBP04-096', 'hBP04-100',
    ],
  );
  assert.equal(cardNumberSortKey('hBP04-002').number, 2);
  assert.equal(cardNumberSortKey('hBP04-010').number, 10);
  assert.ok(compareCardNumbers('hBP04-002', 'hBP04-010') < 0, '2 必須排在 10 前面');
});

test('未補零的卡號證明排序真的是數字，不是字典序', () => {
  // The catalog ships unpadded yell card numbers (hY01-01 … hY01-14), where a
  // lexicographic sort and a numeric sort genuinely disagree. This is the
  // mutation-sensitive control: a string comparison puts -14 before -9.
  const unpadded = ['hY01-14', 'hY01-9', 'hY01-2', 'hY01-10', 'hY01-1'];
  assert.deepEqual(
    unpadded.slice().sort(compareCardNumbers),
    ['hY01-1', 'hY01-2', 'hY01-9', 'hY01-10', 'hY01-14'],
  );
  assert.notDeepEqual(
    unpadded.slice().sort(compareCardNumbers),
    unpadded.slice().sort(),
    '數字排序必須與字典序不同，否則這個回歸證明不了任何事',
  );
  assert.ok(compareCardNumbers('hY01-9', 'hY01-14') < 0, '9 必須排在 14 前面');

  // The same disagreement must survive the whole picker path, not just the
  // comparator: a lexicographic sort inside filterCatalog would return
  // -14 before -9 here.
  const rows = unpadded.map((cardNumber) => ({
    cardNumber, name: cardNumber, rarity: 'C', series: 'hY01',
    type: 'エール', skillsJp: { cardType: 'エール', color: '白' },
  }));
  const hits = filterCatalog(
    rows.map((r) => ({ cardNumber: r.cardNumber, card: r, variants: [{ ...r, printing: 'BASE' }] })),
    buildFacetIndex(rows),
    { ...EMPTY_CRITERIA, series: ['hY01'] },
  );
  assert.deepEqual(
    hits.map((g) => g.cardNumber),
    ['hY01-1', 'hY01-2', 'hY01-9', 'hY01-10', 'hY01-14'],
  );
});

test('打散順序的假卡表會被排成卡號遞增', () => {
  const rows = [
    'hBP04-096', 'hBP02-084', 'hBP04-010', 'hSD01-017', 'hBP04-002',
    'hBP04-088', 'hBP04-001',
  ].map((cardNumber, i) => ({
    cardNumber,
    name: `card-${i}`,
    rarity: 'C',
    // Every fixture row claims hBP04 as its scrape source — exactly the
    // production data shape that leaked cross-series cards into the picker.
    series: 'hBP04',
    type: 'ホロメン',
    skillsJp: { cardType: 'ホロメン', color: '白' },
  }));
  const fixtureFacets = buildFacetIndex(rows);
  const fixtureGroups = rows.map((r) => ({
    cardNumber: r.cardNumber,
    card: { cardNumber: r.cardNumber, name: r.name },
    variants: [{ cardNumber: r.cardNumber, name: r.name, printing: 'BASE' }],
  }));

  const hits = filterCatalog(fixtureGroups, fixtureFacets, {
    ...EMPTY_CRITERIA, series: ['hBP04'],
  });
  assert.deepEqual(
    hits.map((g) => g.cardNumber),
    ['hBP04-001', 'hBP04-002', 'hBP04-010', 'hBP04-088', 'hBP04-096'],
    'hBP04 只留下 hBP04 卡號，並且遞增排序',
  );
  assert.equal(hits.length, 5, '結果數必須等於實際符合的唯一卡號數');
});

test('真實 hBP04 結果的順序完全遞增，且開頭是 001', () => {
  const hits = search({ series: ['hBP04'] }).map((g) => g.cardNumber);
  const suffix = (n) => Number(n.split('-')[1]);
  assert.equal(hits[0], 'hBP04-001', `首張應為 hBP04-001，實際為 ${hits[0]}`);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(
      suffix(hits[i]) > suffix(hits[i - 1]),
      `順序在 ${hits[i - 1]} → ${hits[i]} 處不是遞增`,
    );
  }
});

test('排序不會改動輸入陣列，且跨系列時系列先於編號', () => {
  const input = groups.slice(0, 20);
  const snapshot = input.map((g) => g.cardNumber);
  sortByCardNumber(input);
  assert.deepEqual(input.map((g) => g.cardNumber), snapshot, '排序必須回傳新陣列');

  const mixed = ['hSD01-002', 'hBP04-010', 'hBP04-002', 'hSD01-001'].sort(compareCardNumbers);
  assert.deepEqual(mixed, ['hBP04-002', 'hBP04-010', 'hSD01-001', 'hSD01-002']);
});

test('每個分頁的結果也都是卡號遞增', () => {
  for (const categories of [['oshi'], ['holomen', 'support'], ['yell']]) {
    const hits = search({ categories }).map((g) => g.cardNumber);
    assert.deepEqual(hits, hits.slice().sort(compareCardNumbers), `${categories} 分頁未排序`);
  }
});

// ── 4. One tile per card number; the count is the truth ─────────────────────
test('同一卡號的多個印刷版本只佔一個選擇格', () => {
  const hits = search({ series: ['hBP04'] });
  const numbers = hits.map((g) => g.cardNumber);
  assert.equal(new Set(numbers).size, numbers.length, 'hBP04 出現了重複卡號的格子');

  const multiPrinting = hits.filter((g) => g.variants.length > 1);
  assert.ok(
    multiPrinting.length > 0,
    'negative control：hBP04 必須有多版本的卡，否則去重無從證明',
  );
  for (const g of multiPrinting) {
    assert.equal(
      numbers.filter((n) => n === g.cardNumber).length, 1,
      `${g.cardNumber} 有 ${g.variants.length} 個版本，卻不只一個格子`,
    );
  }
});

test('顯示的張數等於實際唯一卡號數，不被轉載列膨脹', () => {
  const hits = search({ series: ['hBP04'] });
  const uniqueOwn = new Set(
    rawRows
      .map((r) => String(r.cardNumber || ''))
      .filter((n) => /^hBP04-\d+$/i.test(n)),
  );
  assert.equal(hits.length, uniqueOwn.size, 'hBP04 的張數與卡表中的唯一卡號數不符');

  // The pre-fix behaviour counted every row whose scrape source said hBP04.
  const inflated = new Set(
    rawRows
      .filter((r) => String(r.series || '').toLowerCase() === 'hbp04')
      .map((r) => r.cardNumber),
  );
  assert.ok(
    hits.length < inflated.size,
    `修復後的張數 ${hits.length} 必須小於以來源列計算的 ${inflated.size}`,
  );
});

// ── 5. The criteria dimension itself ───────────────────────────────────────
test('系列是玩家可以清除的篩選條件', () => {
  assert.equal(hasActiveFilters({ ...EMPTY_CRITERIA, series: ['hBP04'] }), true);
  assert.equal(hasActiveFilters(EMPTY_CRITERIA), false);
  assert.deepEqual(EMPTY_CRITERIA.series, [], '預設不篩任何系列');
});

test('多選系列是聯集，且仍然嚴格依卡號', () => {
  const bp04 = search({ series: ['hBP04'] });
  const sd01 = search({ series: ['hSD01'] });
  const both = search({ series: ['hBP04', 'hSD01'] });
  assert.equal(both.length, bp04.length + sd01.length, '兩個系列沒有交集');
  for (const g of both) {
    assert.match(g.cardNumber, /^(hBP04|hSD01)-\d+$/);
  }
  assert.deepEqual(both.map((g) => g.cardNumber), both.map((g) => g.cardNumber).sort(compareCardNumbers));
});

// ── 6. The UI wiring and its label ─────────────────────────────────────────
const picker = fs.readFileSync('src/components/CardPicker.tsx', 'utf8');
const editor = fs.readFileSync('src/screens/DeckEditorScreen.tsx', 'utf8');

test('篩選面板用的是卡號系列維度，不再有商品／來源維度', () => {
  assert.match(picker, /options\.series/, '面板必須渲染卡號系列選項');
  assert.match(picker, /criteria\.series/, '面板必須讀取卡號系列條件');
  assert.match(picker, /filter-series-\$\{s\}/, '系列 chip 需要可測試的 testID');
  assert.ok(!/options\.sets|criteria\.sets/.test(picker), '面板仍殘留舊的商品／來源維度');
  assert.match(picker, /picker_series_title/, '標籤必須用系列語彙的 i18n key');
  assert.ok(!picker.includes('picker_set_title'), '舊的商品／系列標籤 key 仍在使用');
});

test('清除全部會一併清掉系列條件', () => {
  const reset = picker.match(/set\(\{\s*query: ''[^}]*\}\)/);
  assert.ok(reset, '找不到清除全部的動作');
  assert.match(reset[0], /series: \[\]/, '清除全部沒有重置系列條件');
  assert.ok(!/sets: \[\]/.test(reset[0]), '清除全部仍在重置已移除的欄位');
});

test('編輯器顯示的張數就是篩選結果的張數', () => {
  assert.match(editor, /resultCount=\{results\.length\}/, '桌機張數必須來自篩選結果');
  assert.match(
    editor,
    /card-result-count-mobile[\s\S]{0,200}count: results\.length/,
    '手機張數必須來自同一個篩選結果',
  );
});

console.log(`\nDIC-1117 卡號系列篩選＋數字排序: ${passed} tests passed`);
