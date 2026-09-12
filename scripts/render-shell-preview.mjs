#!/usr/bin/env node
// DIC-1409 Phase 2 render evidence generator.
//
// Renders the shared shell (StatusBar + AppBar + BottomTabBar with scan FAB +
// content region using CardTile / SeriesCard) at three breakpoints (390 / 768 /
// 1440) through react-native-web + JSDOM, then dumps the fully hydrated HTML +
// StyleSheet output to `docs/pen-v2/phase2/shell-preview-<width>.html`.
//
// The HTML files are deterministic given identical tokens/components and are
// self-contained: they inline the react-native-web StyleSheet rules that get
// registered during render, which makes them viewable in any browser without
// running a bundler. `render-shell-screenshots.mjs` opens each file in
// Puppeteer to take a PNG screenshot for the PR/issue.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase2');
mkdirSync(OUT_DIR, { recursive: true });

const WIDTHS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];

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

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StyleSheet } = await import('react-native-web');
  const shell = await import('../src/components/shell/index.ts');
  const cards = await import('../src/components/cards/index.ts');
  const { PALETTE, TYPE_SCALE, FONTS, LAYOUT, SPACING } =
    await import('../src/theme/tokensV2.ts');

  const container = document.createElement('div');
  container.setAttribute('id', 'root');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  const items = shell.buildShellTabs({ navigation: { navigate: () => {} } });
  const showcaseCards = [
    { name: '星街すいせい', rarity: 'SR', price: 'NT$ 1,280' },
    { name: 'ときのそら', rarity: 'CP', price: 'NT$ 980' },
    { name: 'AZKi', rarity: 'R', price: 'NT$ 240' },
  ];
  const showcaseSeries = [
    { code: 'hBP01', title: 'ブルーミングレディアンス' },
    { code: 'hBP02', title: 'ユメノシラベ' },
    { code: 'hSD01', title: 'スターターデッキ・ときのそら' },
  ];

  const Body = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING['3xl'],
        paddingTop: SPACING['2xl'],
      },
    },
    React.createElement(
      'div',
      {
        style: {
          color: PALETTE.textPrimary,
          fontFamily: FONTS.display,
          fontSize: TYPE_SCALE.display.size,
          fontWeight: '700',
        },
      },
      `Shell preview · ${width}px`,
    ),
    React.createElement(
      'div',
      {
        style: {
          color: PALETTE.textSecondary,
          fontFamily: FONTS.body,
          fontSize: TYPE_SCALE.body.size,
          lineHeight: `${TYPE_SCALE.body.lineHeight}px`,
        },
      },
      'DIC-1409 Phase 2 · AppShell + AppBar + StatusBar + BottomTabBar + CardTile + SeriesCard render at real Pen bounds.',
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: SPACING.lg, flexWrap: 'wrap' } },
      ...showcaseCards.map((card) =>
        React.createElement(cards.CardTile, { key: card.name, ...card }),
      ),
    ),
    React.createElement(
      'div',
      { style: { display: 'flex', gap: SPACING.lg, flexWrap: 'wrap' } },
      ...showcaseSeries.map((s) =>
        React.createElement(cards.SeriesCard, { key: s.code, ...s }),
      ),
    ),
  );

  const tree = React.createElement(shell.AppShell, {
    appBar: {
      title: 'HoloHunter',
      subtitle: `${label} · DIC-1409 Phase 2`,
      actions: [
        { key: 'bell', label: 'alerts' },
        { key: 'settings', label: 'settings' },
      ],
    },
    bottomTabBar: { items, activeKey: 'home' },
    children: Body,
  });

  const root = createRoot(container);
  await act(async () => root.render(tree));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const sheet = StyleSheet.getSheet();
  const dumpedHtml = container.outerHTML;

  const doc = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HoloHunter shell · ${label}</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${PALETTE.appBg}; color: ${PALETTE.textPrimary}; height: 100%; }
    body { font-family: ${FONTS.body}; display: flex; align-items: flex-start; justify-content: center; }
    #frame { width: ${width}px; height: ${height}px; box-shadow: 0 0 0 1px ${PALETTE.border}; overflow: hidden; display: flex; flex-direction: column; }
    #frame > #root { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    #frame > #root > * { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    /* react-native-web stylesheet, captured at render time */
    ${sheet.textContent}
  </style>
</head>
<body>
  <div id="frame">${dumpedHtml}</div>
</body>
</html>`;

  const outPath = pathResolve(OUT_DIR, `shell-preview-${label}.html`);
  writeFileSync(outPath, doc);
  console.log(`wrote ${outPath} (${doc.length} bytes)`);

  await act(async () => root.unmount());
  container.remove();
}

console.log(`\nOK · ${WIDTHS.length} shell previews written to ${OUT_DIR}`);
