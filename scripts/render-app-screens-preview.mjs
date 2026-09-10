#!/usr/bin/env node
// DIC-1409 Phase 3 render evidence generator.
//
// Renders the REAL App 01 首頁 (HomeScreen), App 02 搜尋結果
// (SearchResultsScreen), and App 03 卡牌詳情 (CardDetailScreen) — the exact
// shipped modules with the real bundled card database, stores and navigation
// contract — at 390 / 768 / 1440 through react-native-web + JSDOM, and dumps
// each hydrated render to `docs/pen-v2/phase3/<screen>-preview-<label>.html`.
// `render-app-screens-screenshots.mjs` turns those into PNGs.
//
// No mock data: Home reads the bundled database through the same
// loadDatabaseJson/buildSeriesCatalog path native ships; SearchResults and
// CardDetail run the production searchCards mapper over the same database.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase3');
mkdirSync(OUT_DIR, { recursive: true });

const ALL_WIDTHS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];

// react-native-web's Dimensions captures the window that exists at first
// import, so each breakpoint must render in its own process — otherwise the
// 768/1440 renders keep the 390 breakpoint. The parent invocation fans out to
// one child per width (same node flags, so the web-render hooks stay active).
if (!process.env.APP_RENDER_WIDTH) {
  const { execFileSync } = await import('node:child_process');
  for (const { width } of ALL_WIDTHS) {
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, APP_RENDER_WIDTH: String(width) },
      stdio: 'inherit',
    });
  }
  console.log(`\nOK · app screen previews written to ${OUT_DIR}`);
  process.exit(0);
}

const WIDTHS = ALL_WIDTHS.filter((w) => w.width === Number(process.env.APP_RENDER_WIDTH));

// Pen App/02 searches for すいせい; App/03 shows hBP01-081 星街すいせい.
const SEARCH_QUERY = 'すいせい';
const DETAIL_QUERY = 'hBP01-081';

for (const { width, height, label } of WIDTHS) {
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
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  // react-native-web Dimensions reads documentElement.clientWidth/Height,
  // which JSDOM computes as 0 — patch them so useWindowDimensions /
  // useBreakpoint see the real breakpoint.
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });

  // Same layout shims as test-search-results-layout.mjs: RN-web measures via
  // ResizeObserver + offset metrics; JSDOM computes no layout, so onLayout
  // callbacks are fired manually with the viewport-derived offsetWidth.
  const observedLayoutNodes = new Set();
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(node) { observedLayoutNodes.add({ node, callback: this.callback }); }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
  dom.window.ResizeObserver = TestResizeObserver;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return Math.min(width, 1100); },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return height; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return 0; } });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StyleSheet } = await import('react-native-web');
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const HomeScreen = (await import('../src/screens/HomeScreen.tsx')).default;
  const searchModule = await import('../src/screens/SearchResultsScreen.tsx');
  const SearchResultsScreen = searchModule.default;
  const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
  const { loadDatabaseJson, loadSeriesNamesJson } = await import('../src/utils/staticData.ts');

  const db = await loadDatabaseJson();
  const names = await loadSeriesNamesJson();
  const detailCard = searchModule.searchCards(db, DETAIL_QUERY, names)[0];
  if (!detailCard) throw new Error(`No card found for ${DETAIL_QUERY} in the real database`);

  const navigation = { navigate: () => {}, goBack: () => {}, openDrawer: () => {} };

  const SCREENS = [
    {
      key: 'app01-home',
      element: React.createElement(HomeScreen, { navigation }),
    },
    {
      key: 'app02-search-results',
      element: React.createElement(SearchResultsScreen, {
        route: { params: { query: SEARCH_QUERY } },
        navigation,
      }),
    },
    {
      key: 'app03-card-detail',
      element: React.createElement(CardDetailScreen, {
        route: { params: { card: detailCard } },
        navigation,
      }),
    },
  ];

  for (const { key, element } of SCREENS) {
    observedLayoutNodes.clear();
    const container = document.createElement('div');
    container.setAttribute('id', 'root');
    document.body.appendChild(container);

    const root = createRoot(container);
    await act(async () => root.render(element));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => {
      for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    const sheet = StyleSheet.getSheet();
    const dumpedHtml = container.outerHTML;

    const doc = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HoloHunter ${key} · ${label}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    html, body { margin: 0; padding: 0; background: ${PALETTE.appBg}; color: ${PALETTE.textPrimary}; height: 100%; }
    body { font-family: ${FONTS.body}; display: flex; align-items: flex-start; justify-content: center; }
    #frame { width: ${width}px; height: ${height}px; box-shadow: 0 0 0 1px ${PALETTE.border}; overflow: hidden; display: flex; flex-direction: column; }
    #frame > #root { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    #frame > #root > * { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    ${sheet.textContent}
  </style>
</head>
<body>
  <div id="frame">${dumpedHtml}</div>
</body>
</html>`;

    const outPath = pathResolve(OUT_DIR, `${key}-preview-${label}.html`);
    writeFileSync(outPath, doc);
    console.log(`wrote ${outPath} (${doc.length} bytes)`);

    await act(async () => root.unmount());
    container.remove();
  }
}

console.log(`done · ${WIDTHS.map((w) => w.label).join(', ')}`);
