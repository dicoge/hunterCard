#!/usr/bin/env node
// DIC-1409 Phase 6 render evidence generator — App 13 教學詳情 / App 14
// 教學模擬 / App 15 設定 / App 16 登入, rendered from the REAL shipped screens
// at 390 / 768 / 1440, dumped to `docs/pen-v2/phase6/`.
//
// Real-data notes (no mocks): TutorialDetail renders a real section from the
// shipped tutorial dataset via its real route param; TutorialSimulation runs
// the shipped simulation phases; Settings renders the live guest auth state
// with real deck/price-alert stats; Login renders the real auth store's
// signed-out state.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase6');
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
  console.log(`\nOK · Phase 6 previews written to ${OUT_DIR}`);
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
  // Serve /data/* from the same public/ artifacts the deployed site serves,
  // so TournamentReport renders its real report data instead of a network
  // error in the offline render harness.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/data/')) {
      const local = pathResolve(__dirname, '..', 'public', path.slice(1));
      if (existsSync(local)) {
        return new Response(readFileSync(local), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }
    return realFetch(input, init);
  };
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
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const { default: TutorialDetailScreen } = await import('../src/screens/TutorialDetailScreen.tsx');
  const { default: TutorialSimulationScreen } = await import('../src/screens/TutorialSimulationScreen.tsx');
  const { default: SettingsScreen } = await import('../src/screens/SettingsScreen.tsx');
  const { default: LoginScreen } = await import('../src/screens/LoginScreen.tsx');
  const { getTutorialData } = await import('../src/data/tutorialData.ts');

  const sections = getTutorialData('zh');
  const detailSection = sections[1] ?? sections[0];

  const navigation = { navigate: () => {}, goBack: () => {}, openDrawer: () => {} };

  const SCREENS = [
    {
      key: 'app13-tutorial-detail',
      element: React.createElement(TutorialDetailScreen, {
        route: { params: { sectionId: detailSection.id } },
        navigation,
      }),
    },
    { key: 'app14-tutorial-simulation', element: React.createElement(TutorialSimulationScreen, { navigation }) },
    { key: 'app15-settings', element: React.createElement(SettingsScreen, { navigation }) },
    { key: 'app16-login', element: React.createElement(LoginScreen) },
  ];

  for (const { key, element } of SCREENS) {
    observedLayoutNodes.clear();
    const container = document.createElement('div');
    container.setAttribute('id', 'root');
    document.body.appendChild(container);

    const root = createRoot(container);
    await act(async () => root.render(element));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => {
      for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
      await new Promise((r) => setTimeout(r, 50));
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
