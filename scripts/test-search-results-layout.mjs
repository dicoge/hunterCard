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
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const searchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const { default: SearchResultsScreen, CardListItem } = searchResultsModule;
const { uniformGridItemStyle } = await import('../src/utils/gridLayout.ts');

const LIST_PADDING_X = 16;
const GRID_GAP = 12;
const DESKTOP_MAX_WIDTH = 1100;
const DESKTOP_BREAKPOINT = 768;
const WIDE_BREAKPOINT = 1100;
const CARD_NUMBER_MIN_WIDTH = 72;

function columnsFor(viewport) {
  if (viewport >= WIDE_BREAKPOINT) return 3;
  if (viewport >= DESKTOP_BREAKPOINT) return 2;
  return 1;
}

function layoutForViewport(viewport) {
  const centerWrap = Math.min(viewport, DESKTOP_MAX_WIDTH);
  const content = centerWrap - LIST_PADDING_X * 2;
  const columns = columnsFor(viewport);
  const style = uniformGridItemStyle({ columns, containerWidth: content, gap: GRID_GAP });
  const perCard = style.width;
  const rowTotal = columns * perCard + (columns - 1) * GRID_GAP;
  return { centerWrap, content, columns, perCard, rowTotal, style };
}

function setViewport(width, height = 900) {
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('imports the real SearchResultsScreen module, not a copied helper contract', async () => {
  assert.equal(typeof SearchResultsScreen, 'function');
  assert.equal(typeof CardListItem, 'function');
});

for (const viewport of [1080, 1100, 1366, 1440]) {
  await test(`viewport ${viewport}px keeps rows inside the content area (no horizontal scrollbar)`, async () => {
    const { content, columns, rowTotal, perCard } = layoutForViewport(viewport);
    assert.ok(rowTotal <= content, `row ${rowTotal} exceeded content ${content}`);
    const slack = content - rowTotal;
    assert.ok(
      slack <= columns - 1,
      `viewport ${viewport}: rowTotal ${rowTotal} leaves ${slack}px slack on ${content}px content`
    );
    assert.ok(rowTotal + LIST_PADDING_X * 2 <= Math.min(viewport, DESKTOP_MAX_WIDTH));
    assert.ok(perCard > 0, `perCard must be positive, got ${perCard}`);
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: viewport, configurable: true });
    Object.defineProperty(document.documentElement, 'clientWidth', { value: viewport, configurable: true });
    assert.equal(document.documentElement.scrollWidth, document.documentElement.clientWidth);
  });
}

await test('1080px desktop lands on the 2-column layout with the row closing to the content width', async () => {
  const { columns, perCard, content, rowTotal } = layoutForViewport(1080);
  assert.equal(columns, 2);
  assert.equal(perCard, Math.floor((content - GRID_GAP) / 2));
  assert.ok(rowTotal <= content);
});

await test('1366px desktop stays on the 3-column layout at the desktop max width', async () => {
  const { centerWrap, columns, perCard } = layoutForViewport(1366);
  assert.equal(columns, 3);
  assert.equal(centerWrap, DESKTOP_MAX_WIDTH, 'centerWrap must be clamped to the desktop max');
  assert.equal(perCard, 348);
});

await test('390px mobile falls back to a single full-width card with no overflow', async () => {
  const { columns, perCard, content, rowTotal } = layoutForViewport(390);
  assert.equal(columns, 1);
  assert.equal(perCard, content, 'single-column card must own the whole content area');
  assert.equal(rowTotal, content);
});

await test('768px tablet lands on the 2-column layout', async () => {
  const { columns, perCard, content, rowTotal } = layoutForViewport(768);
  assert.equal(columns, 2);
  assert.equal(perCard, Math.floor((content - GRID_GAP) / 2));
  assert.ok(rowTotal <= content);
});

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
      const minWidth = Number.parseFloat(getComputedStyle(number).minWidth);
      assert.ok(minWidth >= CARD_NUMBER_MIN_WIDTH, `card number min-width ${minWidth}px is below ${CARD_NUMBER_MIN_WIDTH}px`);
      assert.equal(getComputedStyle(number).whiteSpace, 'nowrap');
    } finally { await cleanup(); }
  });
}

console.log(`\nDIC-1150 search results layout: ${passed} tests passed`);
