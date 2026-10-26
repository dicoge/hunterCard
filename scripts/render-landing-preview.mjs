#!/usr/bin/env node
// DIC-1409 Phase 7 render evidence generator — the REAL shipped
// LandingScreen (Pen frames `XwzSU` Desktop 1440 / `D2SGVB` Mobile 390)
// rendered at 390 / 768 / 1440 and dumped to `docs/pen-v2/phase7/`.
//
// Real-data notes (no mocks): the screen renders against the real
// signed-out auth store (guest + Google CTAs drive `useAuthStore`); the
// hero/chart/deck marketing content is the Pen artifact's own static
// composition, exactly as the Landing ships it.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase7');
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
  console.log(`\nOK · Phase 7 Landing previews written to ${OUT_DIR}`);
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

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StyleSheet } = await import('react-native-web');
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const { default: LandingScreen } = await import('../src/screens/LandingScreen.tsx');

  const container = document.createElement('div');
  container.setAttribute('id', 'root');
  document.body.appendChild(container);

  const root = createRoot(container);
  await act(async () => root.render(React.createElement(LandingScreen)));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const sheet = StyleSheet.getSheet();
  // The web-render hook stubs bundled asset imports as
  // `/__test-asset__/<file>`; rewrite them to a relative `assets/` copy
  // so the offline fixture shows the real Pen-anchored card artwork.
  const assetsDir = pathResolve(OUT_DIR, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const dumpedHtml = container.outerHTML.replace(/\/__test-asset__\/([A-Za-z0-9._-]+)/g, (_, file) => {
    const source = pathResolve(__dirname, '..', 'assets', 'landing-cards', file);
    if (existsSync(source)) copyFileSync(source, pathResolve(assetsDir, file));
    return `assets/${file}`;
  });

  const doc = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HoloHunter landing · ${label}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    html, body { margin: 0; padding: 0; background: ${PALETTE.bg}; color: ${PALETTE.textPrimary}; }
    body { font-family: ${FONTS.body}; display: flex; align-items: flex-start; justify-content: center; }
    #frame { width: ${width}px; box-shadow: 0 0 0 1px ${PALETTE.border}; display: flex; flex-direction: column; }
    #frame > #root { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    #frame > #root > * { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  </style>
  <style>${sheet.textContent}</style>
</head>
<body>
  <div id="frame">${dumpedHtml}</div>
</body>
</html>`;

  const outPath = pathResolve(OUT_DIR, `landing-preview-${label}.html`);
  writeFileSync(outPath, doc);
  console.log(`wrote ${outPath} (${doc.length} bytes)`);

  await act(async () => root.unmount());
  container.remove();
}

console.log(`done · ${WIDTHS.map((w) => w.label).join(', ')}`);
