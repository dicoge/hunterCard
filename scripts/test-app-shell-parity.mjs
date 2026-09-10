#!/usr/bin/env node
// DIC-1409 Phase 3 mutation-sensitive tests: App 01 首頁 / App 02 搜尋結果 /
// App 03 卡牌詳情 render the shared Pen v2 shell with their real data,
// stores, and navigation wiring.
//
// Every assertion is pinned to a value read from the Pen file
// (`docs/pen-v2/holohunter-landing-v2-updated.pen`, frames tmKqY / Z6jlE /
// o7WO3r) or to a navigation contract of the shipped AppNavigator — renaming a
// route, dropping a chip, or drifting a Pen-derived style fails a specific
// line, not a DOM count.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const homeModule = await import('../src/screens/HomeScreen.tsx');
const HomeScreen = homeModule.default;
const { __seedHomeSeriesCacheForTest, HOME_COLOR_CHIPS } = homeModule;
const searchModule = await import('../src/screens/SearchResultsScreen.tsx');
const SearchResultsScreen = searchModule.default;
const seedSearchCache = searchModule.__seedSearchResultsCacheForTest;
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
const { CATEGORY_COLORS, PALETTE } = await import('../src/theme/tokensV2.ts');
const { SHELL_TAB_LABELS } = await import('../src/components/shell/tabRegistry.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1409 Phase 3 · App 01–03 shell parity ──');

// ── App / 01 首頁 (Pen frame tmKqY) ────────────────────────────────────────

const SEED_CATALOG = {
  boosters: [
    { label: 'hBP01', query: 'hBP01', name: 'ブルーミングレディアンス' },
    { label: 'hBP02', query: 'hBP02', name: 'クインテットスペクトラム' },
  ],
  starters: [
    { label: 'hSD01', query: 'hSD01', name: 'スタートデッキ ときのそら' },
  ],
  special: [
    { label: 'hPR', query: 'hPR', name: 'プロモ' },
  ],
};

async function renderHome(navigate = () => {}, extra = {}) {
  __seedHomeSeriesCacheForTest(SEED_CATALOG);
  return render(React.createElement(HomeScreen, {
    navigation: { navigate, ...extra },
  }));
}

await test('Home renders the shared shell landmarks with 首頁 tab active', async () => {
  const { container, cleanup } = await renderHome();
  try {
    assert.ok(container.querySelector('[data-testid="shell-status-bar"]'), 'status bar');
    assert.ok(container.querySelector('[data-testid="shell-app-bar"]'), 'app bar');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      'HoloHunter',
    );
    assert.ok(container.querySelector('[data-testid="shell-bottom-tab-bar"]'), 'bottom tab bar');
    const homeTab = container.querySelector('[data-testid="shell-bottom-tab-home"]');
    assert.ok(homeTab, 'home tab');
    assert.equal(homeTab.getAttribute('aria-selected'), 'true', '首頁 tab selected');
    assert.equal(SHELL_TAB_LABELS.home, '首頁');
  } finally { await cleanup(); }
});

await test('Home search field opens Search and carries Pen $app-elev / r14 chrome', async () => {
  const calls = [];
  const { container, cleanup } = await renderHome((route, params) => calls.push([route, params]));
  try {
    const field = container.querySelector('[data-testid="home-search-field"]');
    assert.ok(field, 'search field renders');
    const style = dom.window.getComputedStyle(field);
    assert.equal(style.backgroundColor, hexToRgb(PALETTE.appElev), 'Pen $app-elev fill (#1C1C2B)');
    assert.equal(style.borderTopLeftRadius, '14px', 'Pen r14 corner');
    await act(async () => field.click());
    assert.deepEqual(calls, [['Search', undefined]]);
  } finally { await cleanup(); }
});

await test('Home quick actions dispatch Scan / TournamentReport / Tutorial / Watchlist', async () => {
  const calls = [];
  const { container, cleanup } = await renderHome((route) => calls.push(route));
  try {
    for (const key of ['scan', 'tournament', 'tutorial', 'watchlist']) {
      const tile = container.querySelector(`[data-testid="home-quick-${key}"]`);
      assert.ok(tile, `quick tile ${key} renders (web profile keeps watchlist on)`);
      const style = dom.window.getComputedStyle(tile);
      assert.equal(style.backgroundColor, hexToRgb(PALETTE.appSurface), 'Pen $app-surface tile');
      await act(async () => tile.click());
    }
    assert.deepEqual(calls, ['Scan', 'TournamentReport', 'Tutorial', 'Watchlist']);
  } finally { await cleanup(); }
});

await test('Home color chips carry the six Pen labels, category dot colors, and real queries', async () => {
  assert.deepEqual(
    HOME_COLOR_CHIPS.map((c) => c.label),
    ['白', '藍', '綠', '赤', '紫', '黃'],
    'Pen Color Chips row labels (node gfXsp)',
  );
  assert.equal(HOME_COLOR_CHIPS[1].color, CATEGORY_COLORS.blue);
  assert.equal(CATEGORY_COLORS.blue, '#4C8DFF');
  const calls = [];
  const { container, cleanup } = await renderHome((route, params) => calls.push([route, params]));
  try {
    const chips = container.querySelectorAll('[data-testid^="home-color-"]:not([data-testid="home-color-chips"])');
    assert.equal(chips.length, 6, 'six chips render');
    const blue = container.querySelector('[data-testid="home-color-藍"]');
    assert.ok(blue, '藍 chip renders');
    await act(async () => blue.click());
    assert.deepEqual(calls, [['SearchResults', { query: '藍色' }]]);
  } finally { await cleanup(); }
});

await test('Home booster/starter/special sections render SeriesCard rows from the seeded catalog', async () => {
  const calls = [];
  const { container, cleanup } = await renderHome((route, params) => calls.push([route, params]));
  try {
    for (const section of ['home-boosters', 'home-starters', 'home-special']) {
      assert.ok(container.querySelector(`[data-testid="${section}"]`), `${section} renders`);
    }
    const bp01 = container.querySelector('[data-testid="home-booster-hBP01"]');
    assert.ok(bp01, 'hBP01 series card renders');
    assert.ok(bp01.textContent.includes('ブルーミングレディアンス'), 'series display name from catalog');
    await act(async () => bp01.click());
    assert.deepEqual(calls, [['SearchResults', { query: 'hBP01' }]]);
    assert.ok(
      container.querySelector('[data-testid="home-starter-hSD01"]'),
      'starter series card renders',
    );
  } finally { await cleanup(); }
});

// ── App / 02 搜尋結果 (Pen frame Z6jlE) ────────────────────────────────────

const SEED_DB = {
  cards: {
    'hBP01-007_hBP01': {
      id: 'hBP01-007_hBP01', cardNumber: 'hBP01-007', name: 'ときのそら',
      series: 'hBP01', type: 'Member', rarity: 'RR', color: 'blue',
      sellPrice: 500, prices: [{ name: 'RR', sellPrice: 500, rarity: 'RR' }],
    },
    'hBP01-081_hBP01': {
      id: 'hBP01-081_hBP01', cardNumber: 'hBP01-081', name: '星街すいせい',
      series: 'hBP01', type: 'Member', rarity: 'UR', color: 'blue',
      sellPrice: 3600, prices: [{ name: 'UR', sellPrice: 3600, rarity: 'UR' }],
    },
  },
  totalCards: 2,
  lastUpdated: '2026-09-10',
};

async function renderSearchResults(navigation) {
  seedSearchCache(SEED_DB, { hBP01: 'ブルーミングレディアンス' });
  return render(React.createElement(SearchResultsScreen, {
    route: { params: { query: 'hBP01' } },
    navigation,
  }));
}

await test('SearchResults renders inside the shell with query in the app bar and 搜尋 tab active', async () => {
  const { container, cleanup } = await renderSearchResults({ navigate() {}, goBack() {} });
  try {
    assert.ok(container.querySelector('[data-testid="search-results-shell"]'), 'shell root');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      'hBP01',
      'app bar carries the live query (Pen node j5Et8)',
    );
    const searchTab = container.querySelector('[data-testid="shell-bottom-tab-search"]');
    assert.equal(searchTab.getAttribute('aria-selected'), 'true', '搜尋 tab selected');
    const items = container.querySelectorAll('[data-testid="search-result-grid-item"]');
    assert.equal(items.length, 2, 'both real cards render as grid items');
    assert.ok(container.textContent.includes('hBP01-081'), 'card number renders');
  } finally { await cleanup(); }
});

await test('SearchResults back arrow dispatches navigation.goBack', async () => {
  const events = [];
  const { container, cleanup } = await renderSearchResults({
    navigate: (r) => events.push(['navigate', r]),
    goBack: () => events.push(['goBack']),
  });
  try {
    const back = container.querySelector('[data-testid="search-results-back"]');
    assert.ok(back, 'back arrow renders (Pen node A2SWo)');
    await act(async () => back.click());
    assert.deepEqual(events, [['goBack']]);
  } finally { await cleanup(); }
});

// ── App / 03 卡牌詳情 (Pen frame o7WO3r) ───────────────────────────────────

const DETAIL_CARD = {
  id: 'hBP01-081_hBP01',
  cardNumber: 'hBP01-081',
  name: '星街すいせい',
  type: 'Member',
  grade: '2nd',
  rarity: 'UR',
  sourceRarity: 'UR',
  colors: ['blue'],
  colorNames: ['藍色'],
  series: ['hBP01'],
  seriesNames: ['ブルーミングレディアンス'],
  tags: [],
  imageUrl: '',
  yuyuPrice: 3600,
  prices: [{ name: 'UR', sellPrice: 3600, rarity: 'UR' }],
  searchKeywords: [],
  normalized: { category: 'holomen', categoryLabel: 'Holomen', stage: '2nd', stageLabel: '2nd' },
};

async function renderDetail(navigation) {
  return render(React.createElement(CardDetailScreen, {
    route: { params: { card: DETAIL_CARD } },
    navigation,
  }));
}

await test('CardDetail renders inside the shell with the card number in the app bar and no tab bar', async () => {
  const { container, cleanup } = await renderDetail({ navigate() {}, goBack() {} });
  try {
    assert.ok(container.querySelector('[data-testid="card-detail-shell"]'), 'shell root');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      'hBP01-081',
      'app bar shows the card number (Pen node QhPGe)',
    );
    assert.equal(
      container.querySelector('[data-testid="shell-bottom-tab-bar"]'),
      null,
      'Pen App/03 has no bottom tab bar',
    );
    assert.ok(container.textContent.includes('星街すいせい'), 'real card name renders');
  } finally { await cleanup(); }
});

await test('CardDetail back arrow dispatches goBack and the official-list action renders', async () => {
  const events = [];
  const { container, cleanup } = await renderDetail({
    navigate: (r) => events.push(['navigate', r]),
    goBack: () => events.push(['goBack']),
  });
  try {
    assert.ok(
      container.querySelector('[data-testid="shell-app-bar-action-official"]'),
      'official cardlist app-bar action (Pen node CE6L7)',
    );
    const back = container.querySelector('[data-testid="card-detail-back"]');
    await act(async () => back.click());
    assert.deepEqual(events, [['goBack']]);
  } finally { await cleanup(); }
});

await test('CardDetail price value carries Pen 30/700 $text-primary styling (web full profile)', async () => {
  const { container, cleanup } = await renderDetail({ navigate() {}, goBack() {} });
  try {
    const priceSection = container.querySelector('[data-testid="card-detail-price-section"]');
    assert.ok(priceSection, 'price section renders on the web full profile');
    assert.ok(container.textContent.includes('¥3,600'), 'real price renders');
    const nodes = Array.from(priceSection.querySelectorAll('*'));
    const priceNode = nodes.find((n) => n.textContent === '¥3,600' && n.children.length === 0);
    assert.ok(priceNode, 'price value node found');
    const style = dom.window.getComputedStyle(priceNode);
    assert.equal(style.fontSize, '30px', 'Pen Value Row 30px (node x0c32A)');
    assert.equal(style.fontWeight, '700', 'Pen Value Row weight 700');
    assert.equal(style.color, hexToRgb(PALETTE.textPrimary), 'Pen $text-primary — not the legacy mint green');
  } finally { await cleanup(); }
});

seedSearchCache(null, null);
__seedHomeSeriesCacheForTest(null);

console.log(`\nPassed ${passed} tests.`);
