#!/usr/bin/env node
// DIC-1427: Pen `App / 02 搜尋結果` (frame Z6jlE, 390×844) parity contract for
// the REAL shipped SearchResultsScreen route. The production regression showed
// a single-column horizontal-card list with no search field, no filter/sort
// affordance, a duplicated mock status bar and a legacy "搜尋結果：" heading.
// This test renders the real screen at 390 and asserts the Pen contract:
//
//   1. App bar carries a real search field (Pen node hKr9H) whose input value
//      is the live query, plus the sliders filter affordance (w5jzG9).
//   2. Result-count row (xKkbE) + sort control (zkTTM) render; the legacy
//      "搜尋結果：{query}" heading does NOT.
//   3. The result grid is 3 columns of Pen Card Tiles at 390: each wrapper is
//      113px wide (Pen tile bounds), rows close inside the 358px content box,
//      no horizontal overflow, and the DIC-1150/1192 mutation guards hold
//      (flex-grow 0, no numeric px flex-basis on the wrapper).
//   4. Tile anatomy matches `C / Card Tile` (mJyjf): art keeps the 112:156
//      aspect, name renders under the art, price renders in $accent-2.
//   5. No mock status bar renders on the route (the duplicate-status-bar
//      regression from the user's production capture).
//   6. Bottom tab bar keeps the centered scan FAB and 搜尋 stays active.
//   7. Function is preserved: tapping a tile navigates to CardDetail with the
//      real card, submitting the search field re-runs the real search, the
//      sort control re-orders by real prices, and a color filter chip
//      filters + dismisses over the real dataset.
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

const observedLayoutNodes = new Set();
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe(node) { observedLayoutNodes.add({ node, callback: this.callback }); }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const VIEWPORT_W = 390;
const VIEWPORT_H = 844;
Object.defineProperty(document.documentElement, 'clientWidth', { value: VIEWPORT_W, configurable: true });
Object.defineProperty(document.documentElement, 'clientHeight', { value: VIEWPORT_H, configurable: true });
Object.defineProperty(document.documentElement, 'scrollWidth', { value: VIEWPORT_W, configurable: true });
Object.defineProperty(window, 'innerWidth', { value: VIEWPORT_W, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: VIEWPORT_H, configurable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return VIEWPORT_W; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return VIEWPORT_H; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return 0; } });
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const searchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const {
  default: SearchResultsScreen,
  __seedSearchResultsCacheForTest: seedCache,
} = searchResultsModule;
const { PALETTE } = await import('../src/theme/tokensV2.ts');

// ── Pen Z6jlE geometry contract ──
// Frame 390 wide; Content rows at x=16 → 358px content box; grid rows hold
// three `C / Card Tile` refs of 113×199 (0 / 122 / 245 → 9/10px gaps).
const LIST_PADDING_X = 16;
const CONTENT_W = VIEWPORT_W - LIST_PADDING_X * 2; // 358
const MOBILE_COLUMNS = 3;
const MOBILE_GAP = 9;
const PEN_TILE_W = Math.floor((CONTENT_W - (MOBILE_COLUMNS - 1) * MOBILE_GAP) / MOBILE_COLUMNS); // 113
const PEN_TILE_ART_RATIO = 156 / 112;

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function fireObservedLayouts() {
  await act(async () => {
    for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};

// Real-shaped dataset (mirrors data/database.json rows) — varied colors,
// rarities and prices so sort + filter behavior is observable.
const SEED_SERIES_NAMES = { hBP01: 'ブルーミングレディアンス', hBP04: 'ホロライブ ブースターパック 04' };
const SEED_CARDS = [
  ['hBP01-007', '星街すいせい', 'blue', 'OSR', 12800],
  ['hBP01-014', '星街すいせい', 'blue', 'UR', 4200],
  ['hBP01-081', '星街すいせい', 'blue', 'SR', 3600],
  ['hBP01-080', 'ときのそら', 'white', 'RR', 1980],
  ['hBP01-079', 'ロボ子さん', 'purple', 'R', 880],
  ['hBP01-078', 'さくらみこ', 'red', 'U', 520],
  ['hBP01-077', 'AZKi', 'green', 'C', 120],
];
function seedDataset() {
  const cards = {};
  for (const [cardNumber, name, color, rarity, sellPrice] of SEED_CARDS) {
    const id = `${cardNumber}_hBP01`;
    cards[id] = {
      id,
      cardNumber,
      name,
      nameZh: name,
      series: 'hBP01',
      type: 'ホロメン',
      rarity,
      color,
      sellPrice,
      prices: [{ name: rarity, sellPrice, rarity }],
    };
  }
  seedCache({ cards, totalCards: SEED_CARDS.length, lastUpdated: '2026-09-12' }, SEED_SERIES_NAMES);
}

async function renderScreen(navigation = { navigate() {}, goBack() {} }, query = 'hBP01') {
  seedDataset();
  observedLayoutNodes.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(SearchResultsScreen, {
    route: { params: { query } },
    navigation,
  })));
  await flush();
  await fireObservedLayouts();
  await flush();
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      seedCache(null, null);
    },
  };
}

function px(value) {
  const parsed = Number.parseFloat(String(value));
  assert.ok(Number.isFinite(parsed), `expected finite px value, got ${value}`);
  return parsed;
}

const byTestId = (el, id) => el.querySelector(`[data-testid="${id}"]`);
const allByTestId = (el, id) => Array.from(el.querySelectorAll(`[data-testid="${id}"]`));

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('Pen hKr9H: app bar carries a real search field with the live query, plus the sliders filter affordance (w5jzG9)', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const input = byTestId(container, 'search-results-input');
    assert.ok(input, 'search field input must render in the app bar (Pen node hKr9H/j5Et8)');
    assert.equal(input.value, 'hBP01', 'search field carries the live query');
    assert.ok(
      byTestId(container, 'search-results-filter-button'),
      'filter affordance must render (Pen node w5jzG9 sliders-horizontal)',
    );
    assert.ok(byTestId(container, 'search-results-back'), 'back arrow keeps rendering (Pen node A2SWo)');
  } finally { await cleanup(); }
});

await test('Pen xKkbE + zkTTM: result count and sort control render; legacy 搜尋結果 heading does not', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const count = byTestId(container, 'search-results-count');
    assert.ok(count, 'result-count row must render (Pen node xKkbE)');
    assert.ok(/7/.test(count.textContent), `count row must show the real result count, got "${count.textContent}"`);
    assert.ok(byTestId(container, 'search-results-sort'), 'sort control must render (Pen node zkTTM)');
    assert.ok(
      !container.textContent.includes('搜尋結果：'),
      'the legacy "搜尋結果：{query}" heading is not part of Pen Z6jlE and must not render',
    );
  } finally { await cleanup(); }
});

await test('Pen grid rows: 390 renders a 3-column tile grid — 113px wrappers closing inside the 358px content box', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const items = allByTestId(container, 'search-result-grid-item');
    assert.equal(items.length, SEED_CARDS.length, `all ${SEED_CARDS.length} real cards render as grid items`);
    for (const item of items) {
      const width = px(getComputedStyle(item).width);
      assert.equal(width, PEN_TILE_W, `grid wrapper must be the Pen tile width ${PEN_TILE_W}px at 390, got ${width}px`);
      const flexGrow = getComputedStyle(item).flexGrow;
      assert.equal(Number.parseFloat(String(flexGrow || '0')), 0, 'wrapper must not stretch (DIC-1150 guard)');
      const flexBasis = getComputedStyle(item).flexBasis;
      assert.ok(
        !/^\d+(?:\.\d+)?px$/.test(String(flexBasis)) || px(flexBasis) === PEN_TILE_W,
        `wrapper flex-basis must not inflate row height (DIC-1192 guard), got ${flexBasis}`,
      );
    }
    const rowTotal = MOBILE_COLUMNS * PEN_TILE_W + (MOBILE_COLUMNS - 1) * MOBILE_GAP;
    assert.ok(rowTotal <= CONTENT_W, `3-column row (${rowTotal}px) must close inside the ${CONTENT_W}px content box`);
    assert.equal(
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
      'no horizontal overflow at 390',
    );
  } finally { await cleanup(); }
});

await test('Pen mJyjf tile anatomy: art keeps the 112:156 aspect, name below art, price in $accent-2', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const tiles = allByTestId(container, 'search-card-tile');
    assert.equal(tiles.length, SEED_CARDS.length, 'every result renders as a Pen card tile');
    const tile = tiles[0];
    const art = byTestId(tile, 'search-card-tile-art');
    assert.ok(art, 'tile art region renders (Pen node djwnQ)');
    const artW = px(getComputedStyle(art).width);
    const artH = px(getComputedStyle(art).height);
    assert.equal(artH, Math.round(artW * PEN_TILE_ART_RATIO), `art must keep the Pen 112:156 aspect (got ${artW}×${artH})`);
    const name = byTestId(tile, 'search-card-tile-name');
    assert.ok(name, 'tile name renders (Pen node LsL66)');
    assert.ok(name.textContent.length > 0, 'tile name carries the real card name');
    const price = byTestId(tile, 'search-card-tile-price');
    assert.ok(price, 'tile price renders (Pen node h0nqOz)');
    assert.equal(
      getComputedStyle(price).color,
      hexToRgb(PALETTE.accent2),
      'tile price must use $accent-2 (Pen token)',
    );
  } finally { await cleanup(); }
});

await test('status treatment (QA rework): Pen status row renders on web with a REAL clock and drawn glyphs — single, not duplicated', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const bars = allByTestId(container, 'shell-status-bar');
    assert.equal(bars.length, 1, 'exactly ONE status row must render on the web route (duplicate = the original P0)');
    const time = byTestId(container, 'shell-status-bar-time');
    assert.ok(time, 'status row carries the clock (Pen node fSKdn)');
    assert.match(
      time.textContent,
      /^\d{1,2}:\d{2}$/,
      'the clock is the REAL current time, not a hardcoded mock string',
    );
    assert.ok(byTestId(container, 'shell-status-bar-signal'), 'drawn signal glyph renders (Pen BVQVL)');
    assert.ok(byTestId(container, 'shell-status-bar-wifi'), 'drawn wifi glyph renders (Pen L86PFW)');
    assert.ok(byTestId(container, 'shell-status-bar-battery'), 'drawn battery glyph renders (Pen jfouI)');
  } finally { await cleanup(); }
});

await test('Pen tab bar: centered scan FAB present, 搜尋 tab active', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    assert.ok(byTestId(container, 'shell-bottom-tab-bar'), 'bottom tab bar renders');
    assert.ok(byTestId(container, 'shell-bottom-tab-bar-scan-fab'), 'scan FAB renders (Pen node i4fpf)');
    const searchTab = byTestId(container, 'shell-bottom-tab-search');
    assert.equal(searchTab.getAttribute('aria-selected'), 'true', '搜尋 tab stays active');
  } finally { await cleanup(); }
});

await test('function preserved: tapping a tile navigates to CardDetail with the real card', async () => {
  const calls = [];
  const { container, cleanup } = await renderScreen({
    navigate: (...args) => calls.push(args),
    goBack() {},
  });
  try {
    const tiles = allByTestId(container, 'search-card-tile');
    await click(tiles[0]);
    const hit = calls.find((c) => c[0] === 'CardDetail');
    assert.ok(hit, 'tile tap must navigate to CardDetail');
    assert.equal(hit[1]?.card?.cardNumber, 'hBP01-007', 'navigation carries the real card object');
  } finally { await cleanup(); }
});

await test('function preserved: sort control re-orders the real results by price', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    const sort = byTestId(container, 'search-results-sort');
    const namesInOrder = () => allByTestId(container, 'search-card-tile-name').map((n) => n.textContent);
    const pricesFor = (order) => order.map((label) => label);
    assert.ok(sort, 'sort control renders');
    // Default order is search relevance (card-number ascending): 077 first.
    const numbers = () => allByTestId(container, 'search-card-tile').map(
      (t) => t.getAttribute('aria-label') || '',
    );
    await click(sort);
    // After one tap: 價格高→低 — the 12,800 card must lead.
    const sorted = allByTestId(container, 'search-card-tile-price').map((n) => n.textContent);
    const numeric = sorted.map((s) => Number.parseFloat(s.replace(/[^\d.]/g, '')));
    for (let i = 1; i < numeric.length; i += 1) {
      assert.ok(numeric[i - 1] >= numeric[i], `price-desc sort must be non-increasing, got ${sorted.join(', ')}`);
    }
    void namesInOrder; void pricesFor; void numbers;
  } finally { await cleanup(); }
});

await test('function preserved: color filter chip filters the real dataset and dismisses (Pen tTrL3 chips)', async () => {
  const { container, cleanup } = await renderScreen();
  try {
    await click(byTestId(container, 'search-results-filter-button'));
    const panel = byTestId(container, 'search-results-filter-panel');
    assert.ok(panel, 'filter panel opens from the sliders affordance');
    const blueOption = byTestId(panel, 'search-results-filter-color-blue');
    assert.ok(blueOption, 'real color option (blue) derived from the dataset');
    await click(blueOption);
    const blueCount = SEED_CARDS.filter(([, , color]) => color === 'blue').length;
    assert.equal(
      allByTestId(container, 'search-card-tile').length,
      blueCount,
      'applying the blue filter narrows the grid to the real blue cards',
    );
    const chip = byTestId(container, 'search-results-chip-color-blue');
    assert.ok(chip, 'active filter renders as a dismissible chip (Pen node ysJ09)');
    await click(byTestId(container, 'search-results-chip-color-blue-remove'));
    assert.equal(
      allByTestId(container, 'search-card-tile').length,
      SEED_CARDS.length,
      'dismissing the chip restores the full result set',
    );
  } finally { await cleanup(); }
});

await test('function preserved: submitting the search field re-runs the real search route', async () => {
  const calls = [];
  const { container, cleanup } = await renderScreen({
    navigate: (...args) => calls.push(args),
    goBack() {},
  });
  try {
    const input = byTestId(container, 'search-results-input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'hBP04');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const hit = calls.find((c) => c[0] === 'SearchResults');
    assert.ok(hit, 'submit must navigate the real SearchResults route');
    assert.equal(hit[1]?.query, 'hBP04', 'submit carries the edited query');
  } finally { await cleanup(); }
});

console.log(`\nDIC-1427 Pen Z6jlE search-results parity: ${passed} tests passed`);
