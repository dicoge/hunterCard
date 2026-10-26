#!/usr/bin/env node
// DIC-1409 Phase 4 render evidence generator — App 04 掃描卡牌 / App 05
// 掃描估值清單 / App 06 牌組編輯器 / App 07 我的, rendered from the REAL
// shipped modules with real stores at 390 / 768 / 1440, dumped to
// `docs/pen-v2/phase4/`. `render-app47-screenshots.mjs` captures the PNGs.
//
// Real-data notes (no mocks):
//   • app04-scan renders the shipped ScanScreen; a headless DOM has no
//     camera, so the capture shows the real initializing state. The Pen
//     App/04 chrome (scan frame / tips / mode switch / controls) is
//     therefore also captured from the same shipped ScanOverlay component
//     in its camera-ready state (app04-scan-overlay).
//   • app05-scan-session adds real database cards to the real
//     scanSessionStore via its addCard API, then expands the panel.
//   • app06-deck-editor creates a real deck through the real deckStore
//     (createDeck + setActiveDeck) and renders the editor.
//   • app07-me renders the shipped SettingsScreen (guest auth state).

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase4');
mkdirSync(OUT_DIR, { recursive: true });

const ALL_WIDTHS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];

if (!process.env.APP_RENDER_WIDTH) {
  const { execFileSync } = await import('node:child_process');
  for (const { width } of ALL_WIDTHS) {
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, APP_RENDER_WIDTH: String(width) },
      stdio: 'inherit',
    });
  }
  console.log(`\nOK · Phase 4 previews written to ${OUT_DIR}`);
  process.exit(0);
}

const WIDTHS = ALL_WIDTHS.filter((w) => w.width === Number(process.env.APP_RENDER_WIDTH));

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
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });

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
  const rn = await import('react-native');
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
  const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
  const { default: ScanSessionPanel } = await import('../src/components/ScanSessionPanel.tsx');
  const { default: DeckEditorScreen } = await import('../src/screens/DeckEditorScreen.tsx');
  const { default: SettingsScreen } = await import('../src/screens/SettingsScreen.tsx');
  const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
  const { useDeckStore } = await import('../src/store/deckStore.ts');
  const searchModule = await import('../src/screens/SearchResultsScreen.tsx');
  const { loadDatabaseJson, loadSeriesNamesJson } = await import('../src/utils/staticData.ts');

  const db = await loadDatabaseJson();
  const names = await loadSeriesNamesJson();

  // Real session cards through the real store API.
  useScanSessionStore.getState().clearSession();
  for (const q of ['hBP01-081', 'hBP01-007', 'hBP03-044']) {
    const card = searchModule.searchCards(db, q, names)[0];
    // searchCards emits series as string[]; the scan-session CardInfo contract
    // is the single series code (what ScanScreen passes from recognition).
    if (card) {
      useScanSessionStore.getState().addCard(
        { ...card, series: Array.isArray(card.series) ? card.series[0] ?? '' : card.series },
        { force: true },
      );
    }
  }

  // Real deck through the real store API.
  const deckState = useDeckStore.getState();
  if (!deckState.decks.some((d) => d.name === 'Pen v2 Preview')) {
    const id = deckState.createDeck('Pen v2 Preview');
    useDeckStore.getState().setActiveDeck(id);
  } else {
    useDeckStore.getState().setActiveDeck(deckState.decks.find((d) => d.name === 'Pen v2 Preview').id);
  }

  const navigation = { navigate: () => {}, goBack: () => {}, openDrawer: () => {} };

  const SCREENS = [
    { key: 'app04-scan', element: React.createElement(ScanScreen, { navigation }) },
    {
      key: 'app04-scan-overlay',
      element: React.createElement(
        rn.View,
        { style: { flex: 1, backgroundColor: '#07070C' } },
        React.createElement(ScanOverlay, {
          scanLineAnim: new rn.Animated.Value(0.45),
          pulseAnim: new rn.Animated.Value(1),
          borderAnim: new rn.Animated.Value(0),
          isScanning: false,
          flash: false,
          autoScanEnabled: true,
          isCameraReady: true,
          cameraError: null,
          onFlash: () => {}, onScan: () => {}, onFlip: () => {},
          onGallery: () => {}, onManualSearch: () => {},
          onToggleAutoScan: () => {}, onRetry: () => {},
        }),
      ),
    },
    {
      key: 'app05-scan-session',
      element: React.createElement(
        rn.View,
        { style: { flex: 1, backgroundColor: PALETTE.appBg } },
        React.createElement(ScanSessionPanel, {
          onContinueScanning: () => {},
          preferredCurrency: 'TWD',
        }),
      ),
      expand: 'scan-session-header',
    },
    { key: 'app06-deck-editor', element: React.createElement(DeckEditorScreen) },
    { key: 'app07-me', element: React.createElement(SettingsScreen, { navigation }) },
  ];

  for (const { key, element, expand } of SCREENS) {
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
    if (expand) {
      const target = container.querySelector(`[data-testid="${expand}"]`);
      if (target) await act(async () => target.click());
    }
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
