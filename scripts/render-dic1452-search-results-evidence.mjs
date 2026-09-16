#!/usr/bin/env node
// DIC-1452 render evidence — the REAL shipped SearchResults route over the
// REAL bundled database (public/data/database.json + data/series-names.json),
// captured in a real browser at 390×844 / 768×1024 / 1440×1000.
//
// Same two-phase pattern as test-dic1427-search-pen-geometry.mjs:
//   Phase A (jsdom, per viewport in a child process so RN-web emits that
//   viewport's breakpoint styles): render SearchResultsScreen, serialize the
//   DOM + RN-web StyleSheet into a standalone fixture.
//   Phase B (puppeteer): screenshot each fixture — top state, scrolled-to-end
//   state at 390 (the void regression surface), and a short-result-set query
//   at 390 (last row must render unobscured without scrolling).
//
// Output dir comes from DIC1452_OUT (falls back to docs/pen-v2/dic1452).
// A machine-readable manifest.json (viewport, route, commit SHA, Pen frame
// ids, per-capture files) is written next to the screenshots.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

process.env.EXPO_PUBLIC_STORE_MVP = process.env.EXPO_PUBLIC_STORE_MVP ?? '0';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(__dirname, '..');
const OUT_DIR = process.env.DIC1452_OUT
  ? pathResolve(process.env.DIC1452_OUT)
  : pathResolve(REPO, 'docs', 'pen-v2', 'dic1452');
mkdirSync(OUT_DIR, { recursive: true });

const ROUTE_QUERY = 'hBP04';
const SHORT_QUERY = 'hBP04-001';
const PEN = {
  document: 'holohunter-landing-v2.pen',
  frame: 'Z6jlE',
  frameName: 'App / 02 搜尋結果',
  removedStatusBarInstance: 'ApjHJ',
  statusBarComponent: 'lELzX',
  appBar: 'CXGih',
  content: 'L6STi',
  tabBar: 'qg6IZ',
};

const CAPTURES = [
  { key: 'search-results', query: ROUTE_QUERY, width: 390, height: 844, label: 'mobile-390x844', scrolledVariant: true },
  { key: 'search-results', query: ROUTE_QUERY, width: 768, height: 1024, label: 'tablet-768x1024', scrolledVariant: false },
  { key: 'search-results', query: ROUTE_QUERY, width: 1440, height: 1000, label: 'desktop-1440x1000', scrolledVariant: false },
  { key: 'search-results-short', query: SHORT_QUERY, width: 390, height: 844, label: 'mobile-390x844', scrolledVariant: false },
];

// ── Screenshot phase runs PLAIN (no RN-web loader hooks — puppeteer's deps
// break under them, same as test-dic1427-search-pen-geometry.mjs) ──
if (process.env.DIC1452_SCREENSHOT) {
  await screenshotPhase();
  writeManifest();
  console.log(`\nOK · DIC-1452 evidence written to ${OUT_DIR}`);
  process.exit(0);
}

// ── Orchestrator: Phase A per viewport in a child, then Phase B plain ──
if (!process.env.DIC1452_RENDER_ONE) {
  for (const cap of CAPTURES) {
    execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        DIC1452_RENDER_ONE: JSON.stringify(cap),
        DIC1452_OUT: OUT_DIR,
      },
      stdio: 'inherit',
      cwd: REPO,
    });
  }
  execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, DIC1452_SCREENSHOT: '1', DIC1452_OUT: OUT_DIR },
    stdio: 'inherit',
    cwd: REPO,
  });
  process.exit(0);
}

// ── Phase A: render one fixture in jsdom ──
{
  const { key, query, width, height, label } = JSON.parse(process.env.DIC1452_RENDER_ONE);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://holohunter.dicoge.com/',
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (k in globalThis) continue;
    try { globalThis[k] = dom.window[k]; } catch {}
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(node) { observed.add({ node, callback: this.callback }); }
    unobserve() {}
    disconnect() {}
  }
  const observed = new Set();
  globalThis.ResizeObserver = TestResizeObserver;
  dom.window.ResizeObserver = TestResizeObserver;
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  // The FlatList onLayout width seam: the real screen clamps the results
  // wrap to SEARCH_RESULTS_LAYOUT.desktopMaxWidth (1100) on >=768 widths, so
  // the serialized inline tile widths must be computed against the clamped
  // width or the fixture overflows the real browser's clamped container.
  const layoutWidth = Math.min(width, 1100);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return layoutWidth; },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return height; },
  });

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StyleSheet } = await import('react-native-web');
  const { PALETTE, FONTS } = await import('../src/theme/tokensV2.ts');
  const mod = await import('../src/screens/SearchResultsScreen.tsx');
  const { default: SearchResultsScreen, __seedSearchResultsCacheForTest: seedCache } = mod;

  // REAL data, not fixtures: the exact sanitized database native ships and
  // the real series-name map, loaded from the repo.
  const database = JSON.parse(readFileSync(join(REPO, 'public', 'data', 'database.json'), 'utf8'));
  const seriesNames = JSON.parse(readFileSync(join(REPO, 'data', 'series-names.json'), 'utf8'));
  seedCache(database, seriesNames);

  const container = document.createElement('div');
  container.setAttribute('id', 'root');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(SearchResultsScreen, {
    route: { params: { query } },
    navigation: { navigate() {}, goBack() {} },
  })));
  const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await flush();
  await act(async () => {
    for (const { node, callback } of Array.from(observed)) callback([{ target: node }]);
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush();

  const gridItems = container.querySelectorAll('[data-testid="search-result-grid-item"]').length;
  if (gridItems === 0) throw new Error(`no grid items rendered for query ${query}`);
  console.log(`  rendered ${key} ${label} query=${query}: ${gridItems} grid items`);

  const sheet = StyleSheet.getSheet();
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DIC-1452 evidence · ${key} · ${label}</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${PALETTE.appBg}; color: ${PALETTE.textPrimary}; }
    body { font-family: ${FONTS.body}; }
    #root { width: ${width}px; height: ${height}px; display: flex; flex-direction: column; overflow: hidden; }
    #root > * { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  </style>
  <style>${sheet.textContent}</style>
</head>
<body>${container.outerHTML}</body>
</html>`;
  await act(async () => root.unmount());
  seedCache(null, null);
  writeFileSync(join(OUT_DIR, `${key}-${label}.fixture.html`), html);
  process.exit(0);
}

// ── Phase B: real-browser screenshots ──
async function screenshotPhase() {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    for (const { key, width, height, label, scrolledVariant } of CAPTURES) {
      const fixture = join(OUT_DIR, `${key}-${label}.fixture.html`);
      if (!existsSync(fixture)) throw new Error(`missing fixture ${fixture}`);
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      await page.goto(pathToFileURL(fixture).href, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.screenshot({ path: join(OUT_DIR, `${key}-${label}.png`), fullPage: false });
      console.log(`captured ${key}-${label}.png`);
      if (scrolledVariant) {
        await page.evaluate(() => {
          let el = document.querySelector('[data-testid="search-result-grid-item"]');
          while (el && !(el.scrollHeight > el.clientHeight + 1)) el = el.parentElement;
          if (el) el.scrollTop = el.scrollHeight;
        });
        await new Promise((r) => setTimeout(r, 120));
        await page.screenshot({ path: join(OUT_DIR, `${key}-${label}-scrolled-to-end.png`), fullPage: false });
        console.log(`captured ${key}-${label}-scrolled-to-end.png`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

function writeManifest() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim();
  const manifest = {
    task: 'DIC-1452',
    generatedAt: new Date().toISOString(),
    commitSha: sha,
    worktreeDirty: dirty.length > 0,
    route: 'SearchResults',
    pen: PEN,
    penArtifacts: {
      before: 'pen-before/Z6jlE.png',
      after: 'pen-after/Z6jlE.png',
    },
    captures: CAPTURES.map((c) => ({
      key: c.key,
      route: `SearchResults?query=${encodeURIComponent(c.query)}`,
      viewport: { width: c.width, height: c.height },
      files: [
        `${c.key}-${c.label}.png`,
        ...(c.scrolledVariant ? [`${c.key}-${c.label}-scrolled-to-end.png`] : []),
      ],
    })),
    verification: JSON.parse(process.env.DIC1452_VERIFICATION ?? '{}'),
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('wrote manifest.json');
}
