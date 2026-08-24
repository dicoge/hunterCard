#!/usr/bin/env node
// DIC-1150: mutation-sensitive layout contract for the real SearchResultsScreen path.
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
  unobserve(node) {
    for (const entry of Array.from(observedLayoutNodes)) {
      if (entry.node === node && entry.callback === this.callback) observedLayoutNodes.delete(entry);
    }
  }
  disconnect() {
    for (const entry of Array.from(observedLayoutNodes)) {
      if (entry.callback === this.callback) observedLayoutNodes.delete(entry);
    }
  }
}
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const searchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const {
  default: SearchResultsScreen,
  CardListItem,
  SEARCH_RESULTS_LAYOUT,
  __seedSearchResultsCacheForTest: seedCache,
} = searchResultsModule;

const LIST_PADDING_X = SEARCH_RESULTS_LAYOUT.listPaddingX;
const GRID_GAP = SEARCH_RESULTS_LAYOUT.gridGap;
const DESKTOP_MAX_WIDTH = SEARCH_RESULTS_LAYOUT.desktopMaxWidth;
const DESKTOP_BREAKPOINT = 768;
const WIDE_BREAKPOINT = 1100;
const CARD_NUMBER_MIN_WIDTH = 72;
let viewportWidth = 1366;
let viewportHeight = 900;

function columnsFor(viewport) {
  if (viewport >= WIDE_BREAKPOINT) return 3;
  if (viewport >= DESKTOP_BREAKPOINT) return 2;
  return 1;
}

function expectedLayoutForViewport(viewport) {
  const centerWrap = Math.min(viewport, DESKTOP_MAX_WIDTH);
  const content = centerWrap - LIST_PADDING_X * 2;
  const columns = columnsFor(viewport);
  const perCard = Math.floor((content - (columns - 1) * GRID_GAP) / columns);
  const rowTotal = columns * perCard + (columns - 1) * GRID_GAP;
  return { centerWrap, content, columns, perCard, rowTotal };
}

function setViewport(width, height = 900) {
  viewportWidth = width;
  viewportHeight = height;
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
}

Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return Math.min(viewportWidth, DESKTOP_MAX_WIDTH); },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return viewportHeight; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return 0; } });
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function fireObservedLayouts() {
  await act(async () => {
    for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const card = {
  id: 'hBP03-010_BASE',
  cardNumber: 'hBP03-010',
  name: 'ラプラス・ダークネス',
  nameZh: '拉普拉斯・達克妮絲',
  type: 'holomen',
  grade: '1st',
  rarity: 'R',
  sourceRarity: 'R',
  colors: ['purple'],
  colorNames: ['紫色'],
  series: ['hBP03'],
  seriesNames: ['測試系列'],
  tags: [],
  imageUrl: '',
  yuyuUrl: '',
  carousellUrl: '',
  officialUrl: '',
  yuyuPrice: 1200,
  prices: [{ name: 'R', sellPrice: 1200, rarity: 'R' }],
  searchKeywords: [],
  normalized: {
    category: 'holomen',
    categoryLabel: 'Holomen',
    stage: '1st',
    stageLabel: '1st',
  },
};

async function renderCardAt(viewport) {
  setViewport(viewport, viewport === 390 ? 844 : 900);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardListItem, { card, onPress: () => {} })));
  await flush();
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

async function renderScreenAt(viewport, count) {
  setViewport(viewport, viewport === 390 ? 844 : 900);
  observedLayoutNodes.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(SearchResultsScreen, {
    route: { params: { query: 'hBP03' } },
    navigation: { navigate() {} },
  })));
  await flush();
  await fireObservedLayouts();
  await flush();
  const items = Array.from(container.querySelectorAll('[data-testid="search-result-grid-item"]'));
  assert.ok(items.length >= count, `expected at least ${count} rendered grid items, got ${items.length}`);
  return { container, items: items.slice(0, count), cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

// DIC-1150 CR: `renderScreenAt` above slices `count` from a full production DB,
// so every rendered item is inside a full row. The `flexGrow: 1` mutation only
// visibly stretches the LAST card of a partial row, which needs a dataset of
// exactly `count` cards. We seed the module cache with a hand-rolled dataset
// so the real screen path — same `useEffect`, `searchCards`, `FlatList`,
// `onLayout`, and wrapper — renders exactly `count` grid items.
const SEED_SERIES_NAMES = { hBP03: '測試系列' };
function seedDatabaseForCount(count) {
  const cards = {};
  for (let i = 0; i < count; i += 1) {
    const suffix = String(i + 10).padStart(3, '0');
    const id = `hBP03-${suffix}_BASE`;
    cards[id] = {
      id,
      cardNumber: `hBP03-${suffix}`,
      name: `Test Card ${i + 1}`,
      nameZh: `測試卡 ${i + 1}`,
      series: 'hBP03',
      type: 'holomen',
      rarity: 'R',
      color: 'purple',
      sellPrice: 100 + i,
      prices: [{ name: 'R', sellPrice: 100 + i, rarity: 'R' }],
    };
  }
  const db = { cards, totalCards: count, lastUpdated: '2026-08-24' };
  seedCache(db, SEED_SERIES_NAMES);
}

async function renderScreenWithExactCount(viewport, count) {
  seedDatabaseForCount(count);
  setViewport(viewport, viewport === 390 ? 844 : 900);
  observedLayoutNodes.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(SearchResultsScreen, {
    route: { params: { query: 'hBP03' } },
    navigation: { navigate() {} },
  })));
  await flush();
  await fireObservedLayouts();
  await flush();
  const items = Array.from(container.querySelectorAll('[data-testid="search-result-grid-item"]'));
  return {
    container,
    items,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      // Clear the seeded cache so subsequent tests that call `renderScreenAt`
      // fall back to the real production database.
      seedCache(null, null);
    },
  };
}

function computedFlexGrow(node) {
  const raw = getComputedStyle(node).flexGrow;
  if (raw === '' || raw == null) return null;
  return Number.parseFloat(String(raw));
}

function px(value) {
  const parsed = Number.parseFloat(String(value));
  assert.ok(Number.isFinite(parsed), `expected finite px value, got ${value}`);
  return parsed;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('imports the real SearchResultsScreen module and shared layout constants', async () => {
  assert.equal(typeof SearchResultsScreen, 'function');
  assert.equal(typeof CardListItem, 'function');
  assert.equal(SEARCH_RESULTS_LAYOUT.gridGap, 12);
  assert.equal(SEARCH_RESULTS_LAYOUT.listPaddingX, 16);
  assert.equal(SEARCH_RESULTS_LAYOUT.desktopMaxWidth, 1100);
});

for (const viewport of [1080, 1100, 1366, 1440]) {
  await test(`real SearchResultsScreen grid geometry at ${viewport}px closes without horizontal overflow`, async () => {
    const expected = expectedLayoutForViewport(viewport);
    const { items, cleanup } = await renderScreenAt(viewport, expected.columns + 2);
    try {
      const widths = items.map((item) => px(getComputedStyle(item).width));
      assert.ok(widths.every((width) => width === expected.perCard), `got widths ${widths.join(', ')}, expected ${expected.perCard}`);
      const rowTotal = expected.columns * widths[0] + (expected.columns - 1) * GRID_GAP;
      assert.equal(rowTotal, expected.rowTotal);
      assert.ok(rowTotal <= expected.content, `row ${rowTotal} exceeded content ${expected.content}`);
      assert.ok(expected.content - rowTotal <= expected.columns - 1);
      assert.equal(document.documentElement.scrollWidth, document.documentElement.clientWidth);
      // DIC-1150 CR: mutation guard. The wrapper style must resolve to
      // flex-grow: 0 on the rendered DOM node. If the production wrapper is
      // ever rewritten to `style={[gridItemStyle, { flexGrow: 1 }]}` this
      // assertion fails immediately, because RN Web serialises the inline
      // override into the computed style.
      for (const item of items) {
        assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
      }
    } finally { await cleanup(); }
  });
}

await test('1068px content, 3 columns, 12px gap gives fixed 348px cards via the rendered screen path', async () => {
  const { items, cleanup } = await renderScreenAt(1366, 5);
  try {
    assert.equal(expectedLayoutForViewport(1366).content, 1068);
    assert.ok(items.every((item) => px(getComputedStyle(item).width) === 348));
    assert.equal(3 * 348 + 2 * GRID_GAP, 1068);
    for (const item of items) {
      assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
    }
  } finally { await cleanup(); }
});

await test('736px content, 2 columns, 12px gap gives fixed 362px cards via the rendered screen path', async () => {
  const { items, cleanup } = await renderScreenAt(768, 4);
  try {
    assert.equal(expectedLayoutForViewport(768).content, 736);
    assert.ok(items.every((item) => px(getComputedStyle(item).width) === 362));
    assert.equal(2 * 362 + GRID_GAP, 736);
    for (const item of items) {
      assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
    }
  } finally { await cleanup(); }
});

await test('390px mobile renders single-column full-width cards with no horizontal overflow', async () => {
  const { items, cleanup } = await renderScreenAt(390, 2);
  try {
    const expected = expectedLayoutForViewport(390);
    assert.equal(expected.columns, 1);
    assert.ok(items.every((item) => px(getComputedStyle(item).width) === expected.content));
    assert.equal(document.documentElement.scrollWidth, document.documentElement.clientWidth);
    for (const item of items) {
      assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
    }
  } finally { await cleanup(); }
});

// DIC-1150 CR: exact-N datasets rendered through the real screen so the
// partial row actually exists in the DOM. At numColumns=3, N=1 leaves a
// 2-slot gap on the last (only) row; N=2 leaves a 1-slot gap; N=4 puts a
// single card on row 2; N=5 puts two cards on row 2. In every case the
// last card must keep its fixed 348px width AND its flex-grow must remain
// 0. If the wrapper ever regains flex-grow, the partial-row card stretches
// to fill the empty space — the bug the ticket forbids.
for (const count of [1, 2, 4, 5]) {
  await test(`exact ${count}-card dataset at 1366px keeps the final-row card fixed (no stretch)`, async () => {
    const { items, cleanup } = await renderScreenWithExactCount(1366, count);
    try {
      assert.equal(items.length, count, `seeded dataset must render exactly ${count} grid items`);
      const widths = items.map((item) => px(getComputedStyle(item).width));
      assert.ok(
        widths.every((width) => width === 348),
        `expected every card 348px, got ${widths.join(', ')}`
      );
      // The last card is the one that would stretch under `flexGrow: 1`.
      const last = items[items.length - 1];
      assert.equal(px(getComputedStyle(last).width), 348, 'partial-row card must not stretch its width');
      assert.equal(
        computedFlexGrow(last),
        0,
        'partial-row card wrapper flex-grow must stay 0 — the mutation the CR flagged is `flexGrow: 1`'
      );
      // And every wrapper — not just the last one — must stay unstretchable.
      for (const item of items) {
        assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
      }
    } finally { await cleanup(); }
  });
}

// DIC-1150 CR: also lock exact-N behavior on the 2-column desktop breakpoint,
// because the 1-card row is a partial row there too and the same mutation
// would visibly stretch it.
for (const count of [1, 3]) {
  await test(`exact ${count}-card dataset at 900px (2 cols) keeps the final-row card fixed (no stretch)`, async () => {
    const { items, cleanup } = await renderScreenWithExactCount(900, count);
    try {
      assert.equal(items.length, count);
      const expected = expectedLayoutForViewport(900);
      const widths = items.map((item) => px(getComputedStyle(item).width));
      assert.ok(
        widths.every((width) => width === expected.perCard),
        `expected every card ${expected.perCard}px, got ${widths.join(', ')}`
      );
      for (const item of items) {
        assert.equal(computedFlexGrow(item), 0, 'grid item wrapper must not stretch (flex-grow must be 0)');
      }
    } finally { await cleanup(); }
  });
}

for (const viewport of [390, 1100, 1366, 1440]) {
  await test(`real CardListItem keeps hBP03-010 on its own non-overlapping header row at ${viewport}px`, async () => {
    const { container, cleanup } = await renderCardAt(viewport);
    try {
      assert.ok(container.textContent.includes('hBP03-010'), 'complete card number text renders');
      assert.ok(container.textContent.includes('1st'), 'identity badge still renders');
      assert.ok(container.textContent.includes('Holomen'), 'category badge still renders');
      const header = container.querySelector('[data-testid="search-card-header"]');
      const number = container.querySelector('[data-testid="search-card-number"]');
      const badgeLine = container.querySelector('[data-testid="search-card-identity-badges"]');
      assert.ok(header, 'real cardHeader style path renders');
      assert.ok(number, 'real cardNumber style path renders');
      assert.ok(badgeLine, 'badges render on their own row');
      assert.ok(!header.textContent.includes('1st'), 'badge text must not share the card-number row');
      const minWidth = px(getComputedStyle(number).minWidth);
      assert.ok(minWidth >= CARD_NUMBER_MIN_WIDTH, `card number min-width ${minWidth}px is below ${CARD_NUMBER_MIN_WIDTH}px`);
      assert.equal(getComputedStyle(number).whiteSpace, 'nowrap');
    } finally { await cleanup(); }
  });
}

console.log(`\nDIC-1150 search results layout: ${passed} tests passed`);
