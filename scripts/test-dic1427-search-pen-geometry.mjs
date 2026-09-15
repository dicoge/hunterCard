#!/usr/bin/env node
// DIC-1427 CR fix — REAL-BROWSER geometry contract for Pen `App / 02 搜尋結果`
// (frame Z6jlE, 390×844) on the shipped SearchResultsScreen.
//
// The jsdom parity suite (test-dic1427-search-pen-parity.mjs) proves function,
// tokens and horizontal width math, but jsdom has no layout engine — vertical
// geometry there is mocked, so a `height: 358` wrapper mutation (the giant
// blank/crop class) passed it. This suite closes that gap:
//
//   Phase A (node/jsdom): render the REAL SearchResultsScreen over a seeded
//   real-shaped dataset so RN-web emits its actual inline pixel styles, then
//   serialize the DOM + RN-web StyleSheet into a standalone fixture (the same
//   established pattern as render-scan-search-preview.mjs).
//
//   Phase B (puppeteer / real Chrome): load the fixture at 390×844 and assert
//   MEASURED getBoundingClientRect geometry:
//     • 3 tiles per row, each ~113px wide, x-gaps ≈ Pen 9px, rows y-aligned;
//     • wrapper height HUGS the tile (no vertical inflation) — kills the
//       `height: 358` mutation;
//     • row pitch and inter-row gap bounded (no giant blank rows, no crop);
//     • search field / filter affordance / count / sort bounds per Pen CXGih
//       + xKkbE (field h≈38 centered in the 56px app bar, filter at the right
//       edge, sort right-aligned on the count row);
//     • bottom tab bar hugs the frame bottom and the 64px scan FAB is
//       horizontally centered popping above the bar — kills a displaced-FAB
//       mutation;
//     • no horizontal overflow.
// Runs as TWO processes: the default entry renders the fixture under the
// register-web-render loader, then re-spawns itself PLAIN (`--measure`) so the
// puppeteer import is not distorted by the RN-web loader hooks.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const WIDTH = 390;
const HEIGHT = 844;

// 9 seeded cards → exactly 3 Pen grid rows of 3. Shared by both phases.
const SEED_COUNT = 9;

const MEASURE = process.argv[2] === '--measure';
if (MEASURE) {
  await runMeasurePhase(process.argv[3]);
  process.exit(0);
}

const { JSDOM } = await import('jsdom');

// ── Phase A: render the real screen in jsdom and serialize the fixture ──

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
Object.defineProperty(window, 'innerWidth', { value: WIDTH, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: HEIGHT, configurable: true });
Object.defineProperty(document.documentElement, 'clientWidth', { value: WIDTH, configurable: true });
Object.defineProperty(document.documentElement, 'clientHeight', { value: HEIGHT, configurable: true });
// offsetWidth only feeds the FlatList onLayout width measurement so RN-web
// emits exact numeric tile widths; ALL asserted geometry below is measured by
// the real browser engine in Phase B, never by these seams.
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return WIDTH; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return HEIGHT; },
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { StyleSheet } = await import('react-native-web');
const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
const searchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const { default: SearchResultsScreen, __seedSearchResultsCacheForTest: seedCache } = searchResultsModule;

const SEED_CARDS = [
  ['hBP01-007', '星街すいせい', 'blue', 'OSR', 12800],
  ['hBP01-014', '星街すいせい', 'blue', 'UR', 4200],
  ['hBP01-081', '星街すいせい', 'blue', 'SR', 3600],
  ['hBP01-080', 'ときのそら', 'white', 'RR', 1980],
  ['hBP01-079', 'ロボ子さん', 'purple', 'R', 880],
  ['hBP01-078', 'さくらみこ', 'red', 'U', 520],
  ['hBP01-077', 'AZKi', 'green', 'C', 320],
  ['hBP01-076', 'アキロゼ', 'blue', 'C', 210],
  ['hBP01-075', '赤井はあと', 'red', 'C', 120],
];
const cards = {};
for (const [cardNumber, name, color, rarity, sellPrice] of SEED_CARDS) {
  const id = `${cardNumber}_hBP01`;
  cards[id] = {
    id, cardNumber, name, nameZh: name, series: 'hBP01', type: 'ホロメン',
    rarity, color, sellPrice, prices: [{ name: rarity, sellPrice, rarity }],
  };
}
seedCache({ cards, totalCards: SEED_CARDS.length, lastUpdated: '2026-09-13' }, { hBP01: 'ブルーミングレディアンス' });

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const fireObservedLayouts = async () => {
  await act(async () => {
    for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
    await new Promise((r) => setTimeout(r, 0));
  });
};

const container = document.createElement('div');
container.setAttribute('id', 'root');
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => root.render(React.createElement(SearchResultsScreen, {
  route: { params: { query: 'hBP01' } },
  navigation: { navigate() {}, goBack() {} },
})));
await flush();
await fireObservedLayouts();
await flush();
assert.ok(
  container.querySelectorAll('[data-testid="search-result-grid-item"]').length >= SEED_CARDS.length,
  'fixture render must include the full seeded grid',
);

const sheet = StyleSheet.getSheet();
const fixtureHtml = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DIC-1427 geometry fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${PALETTE.appBg}; color: ${PALETTE.textPrimary}; }
    body { font-family: ${FONTS.body}; }
    #root { width: ${WIDTH}px; height: ${HEIGHT}px; display: flex; flex-direction: column; overflow: hidden; }
    #root > * { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  </style>
  <style>${sheet.textContent}</style>
</head>
<body>${container.outerHTML}</body>
</html>`;
await act(async () => root.unmount());
seedCache(null, null);

const tmp = mkdtempSync(join(tmpdir(), 'dic1427-geometry-'));
const fixturePath = join(tmp, 'fixture.html');
writeFileSync(fixturePath, fixtureHtml);

// ── Phase B: measure in a real browser (plain child process, no loader) ──
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--measure', fixturePath],
    { stdio: 'inherit' },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function runMeasurePhase(fixture) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }

  try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.goto(pathToFileURL(fixture).href, { waitUntil: 'load', timeout: 30000 });

  const rectsOf = (selector) => page.evaluate((sel) => (
    Array.from(document.querySelectorAll(sel)).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    })
  ), selector);
  const rectOf = async (selector) => {
    const all = await rectsOf(selector);
    assert.equal(all.length, 1, `expected exactly one ${selector}, got ${all.length}`);
    return all[0];
  };

  const wrappers = await rectsOf('[data-testid="search-result-grid-item"]');
  const tiles = await rectsOf('[data-testid="search-card-tile"]');
  const arts = await rectsOf('[data-testid="search-card-tile-art"]');

  await test('grid: 9 seeded cards render as 3 measured rows of 3 Pen tiles (113px, ~9px x-gaps)', async () => {
    assert.equal(wrappers.length, SEED_COUNT);
    const rows = new Map();
    for (const r of wrappers) {
      const key = Math.round(r.top / 10) * 10;
      rows.set(key, [...(rows.get(key) || []), r]);
    }
    const rowList = Array.from(rows.values());
    assert.equal(rowList.length, 3, `9 tiles must land on 3 rows, got ${rowList.length}`);
    for (const row of rowList) {
      assert.equal(row.length, 3, `each row must hold 3 tiles, got ${row.length}`);
      row.sort((a, b) => a.left - b.left);
      for (const r of row) {
        assert.ok(r.width >= 111 && r.width <= 115, `tile wrapper width ${r.width} outside Pen 113±2`);
      }
      assert.ok(Math.abs(row[0].top - row[2].top) <= 2, 'tiles in a row must be y-aligned');
      const gap1 = row[1].left - row[0].right;
      const gap2 = row[2].left - row[1].right;
      assert.ok(gap1 >= 6 && gap1 <= 13 && gap2 >= 6 && gap2 <= 13,
        `x-gaps ${gap1.toFixed(1)}/${gap2.toFixed(1)} outside the Pen ~9px gap`);
      assert.ok(row[0].left >= 14 && row[0].left <= 18, `row must start at the 16px content inset, got ${row[0].left}`);
      assert.ok(row[2].right <= WIDTH - 14, `row must end inside the right content inset, got ${row[2].right}`);
    }
  });

  await test('vertical truth: wrapper hugs the tile — no 358px blank inflation (giant-blank/crop mutation killer)', async () => {
    assert.equal(tiles.length, SEED_COUNT);
    for (let i = 0; i < wrappers.length; i += 1) {
      const w = wrappers[i];
      assert.ok(w.height >= 180 && w.height <= 235,
        `wrapper height ${w.height.toFixed(1)} outside the Pen tile envelope [180, 235] — vertical inflation/crop`);
    }
    for (let i = 0; i < tiles.length; i += 1) {
      const slack = wrappers[i].height - tiles[i].height;
      assert.ok(Math.abs(slack) <= 4,
        `wrapper must hug its tile — ${slack.toFixed(1)}px of vertical dead space on tile ${i}`);
    }
    for (const a of arts) {
      const ratio = a.height / a.width;
      assert.ok(Math.abs(ratio - 156 / 112) < 0.03, `art aspect ${ratio.toFixed(3)} deviates from Pen 156/112`);
    }
  });

  await test('vertical truth: row pitch ≈ Pen 199-tile + 14 gap; inter-row gaps bounded (no giant blank rows)', async () => {
    const tops = Array.from(new Set(wrappers.map((r) => Math.round(r.top)))).sort((a, b) => a - b);
    const bottoms = new Map();
    for (const r of wrappers) {
      const key = Math.round(r.top);
      bottoms.set(key, Math.max(bottoms.get(key) || 0, r.bottom));
    }
    for (let i = 1; i < tops.length; i += 1) {
      const pitch = tops[i] - tops[i - 1];
      assert.ok(pitch >= 195 && pitch <= 245, `row pitch ${pitch} outside the Pen 213±30 envelope`);
      const gap = tops[i] - bottoms.get(tops[i - 1]);
      assert.ok(gap >= 6 && gap <= 26, `inter-row gap ${gap.toFixed(1)} outside [6, 26] — blank-row regression`);
    }
  });

  await test('Pen lELzX + CXGih chrome: single status row band, search field h≈38 centered in the app bar below it', async () => {
    const statusBars = await rectsOf('[data-testid="shell-status-bar"]');
    assert.equal(statusBars.length, 1, 'exactly ONE status row (duplicate = original P0)');
    assert.ok(statusBars[0].top <= 2 && Math.abs(statusBars[0].height - 54) <= 2,
      `status row must be the Pen 54px band at the top, got top=${statusBars[0].top} h=${statusBars[0].height}`);
    const APP_BAR_TOP = 54;
    const field = await rectOf('[data-testid="search-results-search-field"]');
    assert.ok(field.height >= 36 && field.height <= 40, `search field height ${field.height} outside 38±2`);
    assert.ok(field.top >= APP_BAR_TOP + 6 && field.top <= APP_BAR_TOP + 13,
      `search field top ${field.top} not centered in the app bar band`);
    assert.ok(field.left >= 38 && field.left <= 62, `search field must start after the back arrow, got ${field.left}`);
    const filter = await rectOf('[data-testid="search-results-filter-button"]');
    assert.ok(filter.right >= WIDTH - 36, `filter affordance must sit at the right edge, right=${filter.right}`);
    assert.ok(filter.top + filter.height / 2 <= APP_BAR_TOP + 56, 'filter affordance must sit inside the app bar band');
    assert.ok(field.right <= filter.left, 'search field must end before the filter affordance');
    const back = await rectOf('[data-testid="search-results-back"]');
    assert.ok(back.left <= 22 && back.right <= field.left, 'back arrow leads the app bar');
  });

  await test('Pen xKkbE count row: count left / sort right on one row, above the grid, below the app bar', async () => {
    const count = await rectOf('[data-testid="search-results-count"]');
    const sort = await rectOf('[data-testid="search-results-sort"]');
    const firstRowTop = Math.min(...wrappers.map((r) => r.top));
    assert.ok(count.top >= 110, 'count row sits below the status + app bar bands');
    assert.ok(count.bottom <= firstRowTop, 'count row sits above the grid');
    assert.ok(firstRowTop - count.bottom <= 30, `grid must follow the count row closely, gap ${(firstRowTop - count.bottom).toFixed(1)}`);
    assert.ok(count.left >= 14 && count.left <= 18, 'count text starts at the 16px inset');
    assert.ok(sort.right >= WIDTH - 20, `sort control must be right-aligned, right=${sort.right}`);
    const dy = Math.abs((count.top + count.height / 2) - (sort.top + sort.height / 2));
    assert.ok(dy <= 8, `count and sort must share the row, centerY delta ${dy.toFixed(1)}`);
  });

  await test('Pen H8TW7 tab bar: bar hugs the frame bottom; 64px scan FAB centered and popping above the bar', async () => {
    const bar = await rectOf('[data-testid="shell-bottom-tab-bar-bar"]');
    assert.ok(bar.height >= 80 && bar.height <= 88, `tab bar height ${bar.height} outside Pen 84±4`);
    assert.ok(Math.abs(bar.bottom - HEIGHT) <= 3, `tab bar must hug the frame bottom, bottom=${bar.bottom}`);
    const fab = await rectOf('[data-testid="shell-bottom-tab-bar-scan-fab"]');
    assert.ok(Math.abs(fab.width - 64) <= 2 && Math.abs(fab.height - 64) <= 2, `FAB ${fab.width}×${fab.height} not the Pen 64×64`);
    const fabCenterX = fab.left + fab.width / 2;
    assert.ok(Math.abs(fabCenterX - WIDTH / 2) <= 3, `FAB centerX ${fabCenterX.toFixed(1)} not centered on 195`);
    assert.ok(fab.top < bar.top, 'FAB must pop ABOVE the bar top (Pen i4fpf at y=0 of the 96px tab-bar frame)');
    assert.ok(bar.top - fab.top >= 8 && bar.top - fab.top <= 18, `FAB pop-above offset ${(bar.top - fab.top).toFixed(1)} outside Pen 12±6`);
    const lastRowBottom = Math.max(...wrappers.map((r) => r.bottom));
    assert.ok(lastRowBottom > 400, 'grid content must actually fill the viewport height — cropped/empty list regression');
  });

  await test('no horizontal overflow at 390 in the real engine', async () => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= WIDTH, `scrollWidth ${sw} exceeds the 390 frame`);
  });

  await page.close();
  } finally {
    await browser.close();
  }

  console.log(`\nDIC-1427 Pen Z6jlE real-browser geometry: ${passed} tests passed`);
}
