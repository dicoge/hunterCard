#!/usr/bin/env node
// DIC-1409 CR fix render evidence — REAL shipped routes only:
//
//   • SearchScreen at 390 / 768 / 1440.
//   • Scan pre-camera permission gate at 390 (the route's true state
//     before any camera exists).
//   • Scan CAMERA-READY at 390 / 768 / 1440 — driven through the REAL
//     `StackNavigator` (NavigationContainer → MainDrawer → Scan, exactly
//     as navigation ships it), reaching camera-ready via a deterministic
//     `navigator.mediaDevices.getUserMedia` seam: the harness installs a
//     fake MediaStream at the web-platform API boundary, then performs
//     the route's REAL permission-button gesture. No synthetic
//     ScanOverlay mount and no stubbed navigation.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase8');
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
  console.log(`\nOK · CR-fix previews written to ${OUT_DIR}`);
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
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });
  class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = NoopResizeObserver;
  dom.window.ResizeObserver = NoopResizeObserver;
  if (!dom.window.matchMedia) {
    dom.window.matchMedia = () => ({
      matches: false,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
    });
    globalThis.matchMedia = dom.window.matchMedia;
  }

  // ── Deterministic camera seam (web-platform API boundary) ──────────
  const makeFakeTrack = () => ({ kind: 'video', stop() {}, addEventListener() {}, removeEventListener() {} });
  const makeFakeStream = () => {
    const track = makeFakeTrack();
    return {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      addEventListener() {}, removeEventListener() {},
    };
  };
  Object.defineProperty(dom.window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => makeFakeStream() },
  });
  // jsdom media elements: make play()/srcObject deterministic no-ops.
  dom.window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return this.__srcObject ?? null; },
    set(v) { this.__srcObject = v; },
  });

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StyleSheet } = await import('react-native-web');
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
  const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');
  const { default: SearchScreen } = await import('../src/screens/SearchScreen.tsx');
  const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');

  const settle = async () => {
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  const writeFixture = (key, dumpedHtml) => {
    const sheet = StyleSheet.getSheet();
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
    video { background: #000; }
  </style>
  <style>${sheet.textContent}</style>
</head>
<body>
  <div id="frame">${dumpedHtml}</div>
</body>
</html>`;
    const outPath = pathResolve(OUT_DIR, `${key}-preview-${label}.html`);
    writeFileSync(outPath, doc);
    console.log(`wrote ${outPath} (${doc.length} bytes)`);
  };

  const renderScreen = async (key, element) => {
    const container = document.createElement('div');
    container.setAttribute('id', 'root');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    await settle();
    writeFixture(key, container.outerHTML);
    await act(async () => root.unmount());
    container.remove();
  };

  const navigation = { navigate: () => {}, goBack: () => {}, openDrawer: () => {} };
  await renderScreen('search', React.createElement(SearchScreen, { navigation }));
  if (width === 390) {
    await renderScreen('scan-precamera', React.createElement(ScanScreen, { navigation }));
  }

  // ── Scan CAMERA-READY through the REAL shipped route ───────────────
  {
    const navRef = createNavigationContainerRef();
    const container = document.createElement('div');
    container.setAttribute('id', 'root');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator)),
      );
    });
    await settle();
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
    await settle();
    const routeName = navRef.getCurrentRoute()?.name;
    if (routeName !== 'Scan') throw new Error(`expected the shipped Scan route, got ${routeName}`);
    const allow = container.querySelector('[data-testid="scan-permission-allow"]');
    if (!allow) throw new Error('Scan permission gate did not render its allow button');
    await act(async () => {
      allow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await settle();
    await settle();
    if (!container.querySelector('[data-testid="scan-mode-switch"]')) {
      throw new Error('Scan route did not reach camera-ready (mode switch absent)');
    }
    writeFixture('scan-camera-ready', container.outerHTML);
    await act(async () => root.unmount());
    container.remove();
  }
}

console.log(`done · ${WIDTHS.map((w) => w.label).join(', ')}`);
