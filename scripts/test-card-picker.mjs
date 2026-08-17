#!/usr/bin/env node
/**
 * DIC-1067 visual card picker — player-facing browse, filter and add.
 *
 * The acceptance this guards: a player can reach a complete, legal draft by
 * looking at cards and using filters, never by typing a card number. Card
 * Number stays reachable as an advanced mode but is never the primary path.
 *
 * Covers: zone/category classification and legal placement, card-name and
 * skill-text search, combined product/colour/rarity/parallel filters, the
 * filter options being derived from the real catalog (no fake options), the
 * add/decrement/remove quantity path, the lowest-ordinary printing the picker
 * adds, save + reload persistence, imported tournament decks staying intact,
 * and the retired explanatory copy being absent from the editor.
 *
 * Run: npm run test:card-picker
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildFacetIndex, categoryOf, collectFilterOptions, filterCatalog, hasActiveFilters,
  normalizeRarity, splitColors, zoneOfCategory, EMPTY_CRITERIA,
} from '../src/utils/cardCatalog.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { groupVariantsByCardNumber } from '../src/utils/deckVariants.ts';
import { eligibleZone, deckStats, isDeckLegal, ownershipKey } from '../src/utils/deckRules.ts';
import { isPlainPrinting } from '../src/utils/printingIdentity.ts';
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

// ── Real shipped catalog ─────────────────────────────────────────────────────
const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const rawRows = Object.values(rawDb.cards || {});
const db = adaptDatabase(rawRows);
const facets = db.facets;
const groups = groupVariantsByCardNumber(db.cards, db.priceRecords);

const search = (patch) => filterCatalog(groups, facets, { ...EMPTY_CRITERIA, ...patch });
const zoneOf = (categories) => search({ categories });

console.log('DIC-1067 visual card picker');

// ── 1. Classification and legal placement ────────────────────────────────────
await test('每個卡片種類都對應到規則引擎接受的牌組區域', () => {
  assert.equal(categoryOf('推しホロメン'), 'oshi');
  assert.equal(categoryOf('Buzzホロメン'), 'holomen');
  assert.equal(categoryOf('ホロメン'), 'holomen');
  assert.equal(categoryOf('サポート・アイテム・LIMITED'), 'support');
  assert.equal(categoryOf('エール'), 'yell');
  assert.equal(categoryOf(''), null);
  // 推しホロメン contains ホロメン, so order of testing matters.
  assert.notEqual(categoryOf('推しホロメン'), 'holomen');

  assert.equal(zoneOfCategory('oshi'), 'oshi');
  assert.equal(zoneOfCategory('holomen'), 'main');
  assert.equal(zoneOfCategory('support'), 'main');
  assert.equal(zoneOfCategory('yell'), 'yell');
});

await test('每個分頁提供的卡片，規則引擎都能放進該分頁的區域', () => {
  for (const [categories, zone] of [
    [['oshi'], 'oshi'],
    [['holomen', 'support'], 'main'],
    [['yell'], 'yell'],
  ]) {
    const offered = zoneOf(categories);
    assert.ok(offered.length > 0, `${zone} 分頁必須有卡可選`);
    for (const g of offered) {
      assert.equal(
        eligibleZone(g.card), zone,
        `${g.cardNumber} 出現在 ${zone} 分頁，但規則引擎判定為 ${eligibleZone(g.card)}`,
      );
    }
  }
});

await test('分頁之間互斥：一張卡不會同時出現在兩個區域的清單裡', () => {
  const seen = new Map();
  for (const [label, categories] of [
    ['oshi', ['oshi']], ['main', ['holomen', 'support']], ['yell', ['yell']],
  ]) {
    for (const g of zoneOf(categories)) {
      assert.equal(seen.get(g.cardNumber), undefined,
        `${g.cardNumber} 同時出現在 ${seen.get(g.cardNumber)} 與 ${label}`);
      seen.set(g.cardNumber, label);
    }
  }
});

// ── 2. Search modes ──────────────────────────────────────────────────────────
await test('卡片名稱搜尋同時比對日文與中文名稱', () => {
  const jp = search({ query: 'ラプラス', mode: 'name' });
  const zh = search({ query: '拉普拉斯', mode: 'name' });
  assert.ok(jp.length > 0, '日文名稱必須搜得到');
  assert.ok(zh.length > 0, '中文名稱必須搜得到');
  assert.ok(
    jp.some((g) => zh.some((z) => z.cardNumber === g.cardNumber)),
    '同一張卡用日文或中文名稱都要找得到',
  );
});

await test('名稱搜尋不會被技能文字誤觸發', () => {
  const byName = search({ query: 'エール', mode: 'name' });
  const byText = search({ query: 'エール', mode: 'text' });
  assert.ok(byText.length > byName.length,
    '「エール」出現在大量技能敘述中，技能搜尋的結果必須遠多於名稱搜尋');
});

await test('技能／效果搜尋找得到只寫在技能文字裡的關鍵字', () => {
  const hits = search({ query: 'アーツ+20', mode: 'text' });
  assert.ok(hits.length > 0, '技能敘述中的關鍵字必須搜得到');
  for (const g of hits) {
    assert.ok(
      !g.card.name.includes('アーツ+20'),
      '這個關鍵字只存在於技能文字，不應該只是名稱命中',
    );
  }
  assert.equal(search({ query: 'アーツ+20', mode: 'name' }).length, 0);
});

await test('卡號搜尋是進階選項，只在 number 模式比對卡號', () => {
  const byNumber = search({ query: 'hBP04-005', mode: 'number' });
  assert.equal(byNumber.length, 1);
  assert.equal(byNumber[0].cardNumber, 'hBP04-005');
  // A card number typed into the DEFAULT (name) mode does not silently work as
  // a number search — the primary flow is names, not numbers.
  assert.equal(search({ query: 'hBP04-005', mode: 'name' }).length, 0);
  assert.equal(EMPTY_CRITERIA.mode, 'name', '預設搜尋模式必須是卡片名稱');
});

await test('空查詢回傳整個分頁的卡片，不需要先打字才看得到卡', () => {
  assert.equal(search({ query: '' }).length, groups.length);
  assert.ok(zoneOf(['oshi']).length > 100, '推し分頁一開啟就要看得到卡片');
});

// ── 3. Filters ───────────────────────────────────────────────────────────────
await test('顏色篩選涵蓋多色卡：白緑的卡在白與緑兩個篩選下都出現', () => {
  assert.deepEqual(splitColors('白緑'), ['白', '緑']);
  assert.deepEqual(splitColors('◇'), ['◇']);
  assert.deepEqual(splitColors(''), []);
  assert.deepEqual(splitColors('青赤'), ['青', '赤']);

  const multi = [...facets.values()].filter((f) => f.colors.length > 1);
  assert.ok(multi.length > 0, '資料庫中必須有多色卡，否則這個行為無從驗證');
  const sample = multi[0];
  for (const color of sample.colors) {
    const hits = search({ colors: [color] });
    assert.ok(
      hits.some((g) => g.cardNumber === sample.cardNumber),
      `${sample.cardNumber}（${sample.colors.join('')}）必須出現在 ${color} 篩選`,
    );
  }
});

await test('同一個維度內多選是聯集，跨維度是交集', () => {
  const white = search({ colors: ['白'] });
  const blue = search({ colors: ['青'] });
  const both = search({ colors: ['白', '青'] });
  assert.equal(both.length, new Set([...white, ...blue].map((g) => g.cardNumber)).size);
  assert.ok(both.length > white.length);

  const whiteInSet = search({ colors: ['白'], sets: ['hBP04'] });
  assert.ok(whiteInSet.length > 0 && whiteInSet.length < white.length);
  for (const g of whiteInSet) {
    assert.ok(facets.get(g.cardNumber).colors.includes('白'));
    assert.ok(facets.get(g.cardNumber).sets.includes('hBP04'));
  }
});

await test('稀有度的改版拼法收斂成同一個選項', () => {
  assert.equal(normalizeRarity('P_02'), 'P');
  assert.equal(normalizeRarity('02_C'), 'C');
  assert.equal(normalizeRarity('C_re'), 'C');
  assert.equal(normalizeRarity('S_2'), 'S');
  assert.equal(normalizeRarity('SEC'), 'SEC');
  assert.equal(normalizeRarity(''), '');
  const options = collectFilterOptions(facets.values());
  for (const r of options.rarities) {
    assert.ok(!/_\d|^\d/.test(r), `稀有度選項 ${r} 仍帶著改版後綴`);
  }
});

await test('商品／系列篩選只提供真實的商品代號，不提供內部抓取分類', () => {
  const options = collectFilterOptions(facets.values());
  assert.ok(options.sets.includes('hBP04'));
  assert.ok(options.sets.includes('hPR'));
  assert.ok(!options.sets.includes('ent07'), 'ent07 是抓取來源分類，不是玩家認得的商品');
  for (const s of options.sets) assert.match(s, /^h/);
});

await test('篩選選項全部來自載入的卡表，沒有無資料的假選項', () => {
  const oshiFacets = zoneOf(['oshi']).map((g) => facets.get(g.cardNumber));
  const options = collectFilterOptions(oshiFacets);
  for (const color of options.colors) {
    assert.ok(
      search({ categories: ['oshi'], colors: [color] }).length > 0,
      `推し分頁提供了 ${color} 篩選，卻沒有任何一張卡符合`,
    );
  }
  for (const rarity of options.rarities) {
    assert.ok(search({ categories: ['oshi'], rarities: [rarity] }).length > 0);
  }
  for (const s of options.sets) {
    assert.ok(search({ categories: ['oshi'], sets: [s] }).length > 0);
  }
});

await test('平行版篩選依卡號實際擁有的版本分流', () => {
  const hasParallel = search({ parallel: 'hasParallel' });
  const noParallel = search({ parallel: 'noParallel' });
  assert.ok(hasParallel.length > 0 && noParallel.length > 0);
  assert.equal(hasParallel.length + noParallel.length, groups.length, '兩者必須互補且不重疊');
  for (const g of hasParallel) {
    assert.ok(g.variants.some((v) => !isPlainPrinting(v.printing)));
  }
  for (const g of noParallel) {
    assert.ok(g.variants.every((v) => isPlainPrinting(v.printing)));
  }
  for (const g of search({ parallel: 'hasBase' })) {
    assert.ok(g.variants.some((v) => isPlainPrinting(v.printing)));
  }
});

await test('組合篩選：商品＋顏色＋稀有度＋版本同時生效', () => {
  const combined = search({
    categories: ['holomen', 'support'],
    sets: ['hBP04'],
    colors: ['紫'],
    parallel: 'hasParallel',
  });
  assert.ok(combined.length > 0, '這組條件必須在真實卡表中有結果');
  for (const g of combined) {
    const f = facets.get(g.cardNumber);
    assert.ok(f.sets.includes('hBP04'));
    assert.ok(f.colors.includes('紫'));
    assert.ok(['holomen', 'support'].includes(f.category));
    assert.ok(g.variants.some((v) => !isPlainPrinting(v.printing)));
  }
  // Narrowing further never widens the result.
  const narrower = search({
    categories: ['holomen', 'support'], sets: ['hBP04'], colors: ['紫'],
    parallel: 'hasParallel', query: 'シオン', mode: 'name',
  });
  assert.ok(narrower.length <= combined.length);
});

await test('清除全部只在真的有條件時才需要出現', () => {
  assert.equal(hasActiveFilters(EMPTY_CRITERIA), false);
  assert.equal(hasActiveFilters({ ...EMPTY_CRITERIA, colors: ['白'] }), true);
  assert.equal(hasActiveFilters({ ...EMPTY_CRITERIA, query: 'ラプラス' }), true);
  assert.equal(hasActiveFilters({ ...EMPTY_CRITERIA, parallel: 'hasParallel' }), true);
  // The zone tab alone is not a "filter" the player has to clear.
  assert.equal(hasActiveFilters({ ...EMPTY_CRITERIA, categories: ['oshi'] }), false);
  assert.deepEqual(
    filterCatalog(groups, facets, EMPTY_CRITERIA).map((g) => g.cardNumber),
    groups.map((g) => g.cardNumber),
    '清除後必須回到完整清單',
  );
});

// ── 4. Adding cards: quantities and the printing that gets added ─────────────
await test('點卡片加入的一律是同卡號最低普通版本，不是最便宜的平行版', () => {
  const lap = search({ query: 'hBP04-005', mode: 'number' })[0];
  assert.equal(lap.card.printing, 'BASE');
  assert.ok(lap.variants.some((v) => v.printing === 'PARALLEL/SIGN'));
  for (const g of groups) {
    const hasPlain = g.variants.some((v) => isPlainPrinting(v.printing) && eligibleZone(v));
    if (hasPlain) {
      assert.ok(
        isPlainPrinting(g.card.printing),
        `${g.cardNumber} 有可出賽的原印版，預設卻選了 ${g.card.printing}`,
      );
    }
  }
});

await test('加入、增減與移除都作用在正確的區域與張數', () => {
  resetStore();
  const store = useDeckStore.getState();
  const deckId = store.createDeck('DIC-1067 數量測試');
  const holo = zoneOf(['holomen', 'support'])[0].card;

  useDeckStore.getState().changeCard(deckId, 'main', holo, 1);
  useDeckStore.getState().changeCard(deckId, 'main', holo, 1);
  const afterAdd = useDeckStore.getState().decks[0];
  assert.equal(afterAdd.main[0].qty, 2);

  useDeckStore.getState().changeCard(deckId, 'main', holo, -1);
  assert.equal(useDeckStore.getState().decks[0].main[0].qty, 1);

  useDeckStore.getState().removeCard(deckId, 'main', holo.id);
  assert.equal(useDeckStore.getState().decks[0].main.length, 0);

  // Dropping to zero also removes the slot rather than leaving a 0-quantity row.
  useDeckStore.getState().changeCard(deckId, 'main', holo, 1);
  useDeckStore.getState().changeCard(deckId, 'main', holo, -1);
  assert.equal(useDeckStore.getState().decks[0].main.length, 0);
});

// ── 5. A complete draft without ever typing a card number ────────────────────
await test('玩家只用圖像與篩選就能組出合法牌組，全程沒有輸入卡號', () => {
  resetStore();
  const deckId = useDeckStore.getState().createDeck('DIC-1067 圖像組牌');

  // Everything below goes through the SAME criteria object the UI builds, with
  // the default (name) search mode and no card-number query anywhere.
  const usedCriteria = [];
  const pick = (patch) => {
    const criteria = { ...EMPTY_CRITERIA, ...patch };
    usedCriteria.push(criteria);
    return filterCatalog(groups, facets, criteria);
  };

  const oshi = pick({ categories: ['oshi'], colors: ['白'] })[0];
  useDeckStore.getState().changeCard(deckId, 'oshi', oshi.card, 1);

  let placed = 0;
  for (const g of pick({ categories: ['holomen', 'support'], colors: ['白'] })) {
    if (placed >= 50) break;
    const qty = Math.min(4, 50 - placed);
    useDeckStore.getState().changeCard(deckId, 'main', g.card, qty);
    placed += qty;
  }

  const yell = pick({ categories: ['yell'], colors: ['白'] })[0];
  useDeckStore.getState().changeCard(deckId, 'yell', yell.card, 20);

  const deck = useDeckStore.getState().decks[0];
  const stats = deckStats(deck);
  assert.deepEqual(
    [stats.oshi, stats.main, stats.yell],
    [stats.oshiTarget, stats.mainTarget, stats.yellTarget],
  );
  assert.equal(isDeckLegal(deck), true, '這副牌必須通過完整規則驗證');

  for (const c of usedCriteria) {
    assert.notEqual(c.mode, 'number', '主要流程不得使用卡號搜尋');
    assert.equal(c.query, '', '主要流程不需要打任何字');
  }
});

// ── 6. Persistence and imported decks ────────────────────────────────────────
await test('未完成的牌組存成草稿，重新載入後張數與版本都不變', async () => {
  resetStore();
  const deckId = useDeckStore.getState().createDeck('DIC-1067 草稿');
  const oshi = zoneOf(['oshi'])[0].card;
  const holo = zoneOf(['holomen', 'support'])[0].card;
  useDeckStore.getState().changeCard(deckId, 'oshi', oshi, 1);
  useDeckStore.getState().changeCard(deckId, 'main', holo, 3);
  useDeckStore.getState().adjustOwned(holo.cardNumber, holo.printing, 2);
  assert.equal(isDeckLegal(useDeckStore.getState().decks[0]), false, '未完成的牌組是草稿');

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, '牌組必須寫入持久化儲存');
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  const reloaded = useDeckStore.getState().decks[0];
  assert.equal(reloaded.name, 'DIC-1067 草稿');
  assert.equal(reloaded.oshi[0].card.id, oshi.id);
  assert.equal(reloaded.main[0].qty, 3);
  assert.equal(reloaded.main[0].card.printing, holo.printing);
  assert.equal(
    useDeckStore.getState().collection[ownershipKey(holo.cardNumber, holo.printing)], 2,
    '收藏擁有數量必須跟著保存',
  );
});

await test('賽事匯入的牌組在選牌器改版後仍完整可編輯', () => {
  resetStore();
  const oshi = zoneOf(['oshi'])[0].card;
  const holo = zoneOf(['holomen', 'support'])[0].card;
  const deckId = useDeckStore.getState().importDeck({
    name: '匯入牌組',
    oshi: [{ card: oshi, qty: 1 }],
    main: [{ card: holo, qty: 4 }],
    yell: [],
    origin: {
      kind: 'tournament',
      eventId: 'e1', eventName: '測試賽事', sourceDeckId: 'd1',
      decklogCode: 'ABCDE', sourceUrl: 'https://example.test/d1',
      importedAt: '2026-08-17T00:00:00.000Z',
    },
  });
  const imported = useDeckStore.getState().decks[0];
  assert.equal(imported.origin.kind, 'tournament');
  assert.equal(imported.main[0].qty, 4);

  // The picker's add path edits an imported deck exactly like a hand-built one.
  useDeckStore.getState().changeCard(deckId, 'main', holo, 1);
  assert.equal(useDeckStore.getState().decks[0].main[0].qty, 5);
  assert.equal(useDeckStore.getState().decks[0].origin.eventName, '測試賽事');
});

// ── 7. The editor's own wiring ───────────────────────────────────────────────
const editor = fs.readFileSync('src/screens/DeckEditorScreen.tsx', 'utf8');
const picker = fs.readFileSync('src/components/CardPicker.tsx', 'utf8');

await test('已下架的說明文案不再出現在編輯器', () => {
  const retired = [
    '每個卡號只顯示一列',
    '預設低配版本',
    'DEFAULTED_PRINTING_NOTE',
    '來源只註明卡號與稀有度',
    '不使用「店家收購價」估算缺卡成本',
    '不採用店家收購價',
    '編輯中不中斷提示',
  ];
  for (const copy of retired) {
    assert.ok(!editor.includes(copy), `編輯器仍顯示已下架文案：${copy}`);
    assert.ok(!picker.includes(copy), `選牌器仍顯示已下架文案：${copy}`);
  }
});

await test('編輯中不跳出完整規則視窗，只有完成組牌會驗證', () => {
  assert.ok(editor.includes('onPress={finalizeDeck}'));
  assert.ok(
    /setFinalizeIssues\(validateDeck\(activeDeck\)\)/.test(editor),
    '完整規則驗證只能由 finalizeDeck 觸發',
  );
  const validateCalls = editor.match(/validateDeck\(/g) ?? [];
  assert.equal(validateCalls.length, 1, '編輯流程中不得有第二處呼叫完整驗證');
});

await test('版面依 useWindowDimensions 的寬度切換，手機至少兩欄', () => {
  assert.ok(editor.includes('useBreakpoint'), '響應式版面沿用既有的 useBreakpoint');
  assert.ok(
    /isWide \? 4 : isDesktop \? 3 : 2/.test(editor),
    '手機必須至少兩欄，桌機加寬到三／四欄',
  );
  const hook = fs.readFileSync('src/hooks/useBreakpoint.ts', 'utf8');
  assert.ok(hook.includes('useWindowDimensions'), '轉向改變必須由 useWindowDimensions 驅動');
});

await test('清單有虛擬化與分頁，不會一次渲染整個卡表', () => {
  assert.ok(picker.includes('FlatList'), '沿用既有的清單虛擬化');
  assert.ok(/PAGE_SIZE = \d+/.test(picker) && picker.includes('onEndReached'));
  assert.ok(groups.length > 500, '卡表夠大，分頁才有意義');
});

await test('圖片有載入失敗的退場顯示', () => {
  assert.ok(picker.includes('onError'), '圖片載入失敗必須有處理');
  assert.ok(picker.includes('thumbFallback'), '失敗時要顯示替代內容而不是空白');
});

await test('卡表中每張可選的卡都有圖片可顯示', () => {
  const missing = groups.filter((g) => !g.card.imageUrl);
  assert.equal(missing.length, 0, `${missing.length} 張可選卡沒有圖片來源`);
});

console.log(`\nDIC-1067 visual card picker: ${passed} tests passed`);
