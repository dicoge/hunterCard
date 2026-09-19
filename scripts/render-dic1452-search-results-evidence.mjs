#!/usr/bin/env node
// DIC-1452 render evidence — the ACTUAL HoloHunter web app served over HTTP.
//
// No synthesized screenshots: this script never imports SearchResultsScreen,
// never renders in jsdom, and never serializes standalone fixture HTML. It
// serves the real `expo export --platform web` build (dist/) from a local
// static server and drives a real browser through the app's real entry path:
//
//   GET /  →  Landing (unauthenticated)
//   → 以訪客登入 (landing-cta-guest / landing-nav-guest)  →  Home
//   → 搜尋 bottom tab (shell-bottom-tab-search)           →  Search
//   → type query + submit (search-input / search-submit)  →  SearchResults
//
// The app has no web deep-linking config (no `linking` on the
// NavigationContainer), so the SearchResults route is reached exactly the way
// a user reaches it — through React Navigation. Data comes from the real
// bundled runtime path: the app fetches /data/database.json + series names
// from the served build, same as production.
//
// Prerequisite: a fresh build of HEAD in dist/ (EXPO_PUBLIC_STORE_MVP=0
// npm run build). The script refuses to run without dist/index.html and
// dist/data/database.json.
//
// Captures: 390×844 (top + scrolled-to-end + short result set), 768×1024,
// 1440×1000. Each capture runs in a fresh incognito browser context so the
// guest session never leaks between captures and the full entry path is
// exercised every time. Output dir comes from DIC1452_OUT (falls back to
// docs/pen-v2/dic1452); manifest.json records the server URL, route path,
// geometry measurements, and the Pen parity ledger.

import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, join, extname, normalize } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(__dirname, '..');
const DIST = join(REPO, 'dist');
const OUT_DIR = process.env.DIC1452_OUT
  ? pathResolve(process.env.DIC1452_OUT)
  : pathResolve(REPO, 'docs', 'pen-v2', 'dic1452');
mkdirSync(OUT_DIR, { recursive: true });

for (const required of ['index.html', join('data', 'database.json'), '_expo']) {
  if (!existsSync(join(DIST, required))) {
    console.error(`dist/${required} missing — build first: EXPO_PUBLIC_STORE_MVP=0 npm run build`);
    process.exit(1);
  }
}

const ROUTE_QUERY = 'hBP04';
const SHORT_QUERY = 'hBP04-001';

// Pen parity ledger — holohunter-landing-v2.pen. Status Bar component lELzX
// and every instance of it were removed; each frame's app bar moved to y=0
// and its content region grew 54px to keep the tab-bar/action-bar edge.
const PEN = {
  document: 'holohunter-landing-v2.pen',
  statusBarComponent: 'lELzX',
  statusBarComponentDeleted: true,
  framesCleared: [
    { frame: 'Z6jlE', name: 'App / 02 搜尋結果', removedInstance: 'ApjHJ', note: 'cleared in aaa9c9645 (original DIC-1452 commit)' },
    { frame: 'tmKqY', name: 'App / 01 首頁', removedInstance: 's2IWl' },
    { frame: 'o7WO3r', name: 'App / 03 卡牌詳情', removedInstance: 'qLTTt' },
    { frame: 'eurld', name: 'App / 04 掃描卡牌', removedInstance: 'mMdmS' },
    { frame: 'wC1cO', name: 'App / 05 掃描估值清單', removedInstance: 'WGd38' },
    { frame: 'uXuqo', name: 'App / 06 牌組編輯器', removedInstance: 'W1wiV' },
    { frame: 'siVsa', name: 'App / 07 我的', removedInstance: 'mcIoz' },
    { frame: 'ej9RF', name: 'App / 08 收藏', removedInstance: 'wG8OM' },
    { frame: 'sSDxQ', name: 'App / 09 我的最愛', removedInstance: 'T1vxaD' },
    { frame: 'wRgD8', name: 'App / 10 賽事月報', removedInstance: 'aSvWe' },
    { frame: 'VyzfW', name: 'App / 11 到價提醒', removedInstance: 'L0l60' },
    { frame: 'DAQIq', name: 'App / 12 規則教學', removedInstance: 'pBUDw' },
    { frame: 'rV4Za', name: 'App / 13 教學詳情', removedInstance: 'arrrc' },
    { frame: 'I6WwjY', name: 'App / 14 教學模擬', removedInstance: 'Og4IO' },
    { frame: 'x44r8t', name: 'App / 15 設定', removedInstance: 'H9QO8' },
    { frame: 'p28zL', name: 'App / 16 登入', removedInstance: 'ACZuV' },
  ],
};

const CAPTURES = [
  { key: 'search-results', query: ROUTE_QUERY, width: 390, height: 844, label: 'mobile-390x844', scrolledVariant: true },
  { key: 'search-results-short', query: SHORT_QUERY, width: 390, height: 844, label: 'mobile-390x844', scrolledVariant: false },
  { key: 'search-results', query: ROUTE_QUERY, width: 768, height: 1024, label: 'tablet-768x1024', scrolledVariant: false },
  { key: 'search-results', query: ROUTE_QUERY, width: 1440, height: 1000, label: 'desktop-1440x1000', scrolledVariant: false },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveDist() {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = normalize(join(DIST, urlPath));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    let st = existsSync(filePath) ? statSync(filePath) : null;
    if (st?.isDirectory()) {
      filePath = join(filePath, 'index.html');
      st = existsSync(filePath) ? statSync(filePath) : null;
    }
    if (!st) {
      // SPA fallback — the real deployment rewrites unknown paths to the app.
      filePath = join(DIST, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// The app's real entry path to SearchResults — the same one a user walks.
const ENTRY_STEPS = [
  'goto / (Landing, unauthenticated)',
  'click 以訪客登入 [data-testid=landing-cta-guest|landing-nav-guest]',
  'click 搜尋 bottom tab [data-testid=shell-bottom-tab-search]',
  'type query into [data-testid=search-input]',
  'click [data-testid=search-submit] → navigation.navigate(SearchResults, {query})',
];

async function enterSearchResults(page, baseUrl, query) {
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 120000 });
  const guest = await page.waitForSelector(
    '[data-testid="landing-cta-guest"], [data-testid="landing-nav-guest"]',
    { visible: true, timeout: 60000 },
  );
  await guest.click();
  const searchTab = await page.waitForSelector('[data-testid="shell-bottom-tab-search"]', { visible: true, timeout: 60000 });
  await searchTab.click();
  const input = await page.waitForSelector('[data-testid="search-input"]', { visible: true, timeout: 60000 });
  await input.type(query);
  await page.click('[data-testid="search-submit"]');
  await page.waitForSelector('[data-testid="search-result-grid-item"]', { visible: true, timeout: 60000 });
  await settleImages(page);
}

// Remote card artwork (card.yuyu-tei.jp) streams in after the grid mounts —
// hold the screenshot until the visible <img> set has finished loading.
async function settleImages(page) {
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});
  await page.waitForFunction(
    () => {
      const imgs = [...document.images];
      if (imgs.length === 0) return true;
      return imgs.every((img) => img.complete);
    },
    { timeout: 20000, polling: 500 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
}

function measure(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid="search-result-grid-item"]')];
    const last = items[items.length - 1] ?? null;
    // The native-stack keeps the underlying drawer screen mounted (hidden),
    // so several shell tab bars exist in the DOM — measure the visible one.
    const barRect = [...document.querySelectorAll('[data-testid="shell-bottom-tab-bar"]')]
      .map((el) => el.getBoundingClientRect())
      .find((r) => r.width > 0 && r.height > 0 && r.top > 0) ?? null;
    const lastRect = last?.getBoundingClientRect() ?? null;
    return {
      gridItems: items.length,
      lastRowBottomPx: lastRect ? +lastRect.bottom.toFixed(2) : null,
      tabBarTopPx: barRect ? +barRect.top.toFixed(2) : null,
      lastRowGapPx: lastRect && barRect ? +(barRect.top - lastRect.bottom).toFixed(2) : null,
      simulatedStatusTestIds: [...document.querySelectorAll('[data-testid]')]
        .filter((el) => /status/i.test(el.getAttribute('data-testid'))).length,
      fakeClockTextPresent: (document.body.innerText || '').includes('9:41'),
    };
  });
}

// FlatList virtualizes: one jump lands mid-list because more rows mount as
// the window advances. Keep jumping to the bottom until scrollHeight stops
// growing and the scroll position sticks at the end.
async function scrollResultsToEnd(page) {
  await page.evaluate(async () => {
    let el = document.querySelector('[data-testid="search-result-grid-item"]');
    while (el && !(el.scrollHeight > el.clientHeight + 1)) el = el.parentElement;
    if (!el) return;
    for (let i = 0; i < 80; i += 1) {
      const before = el.scrollHeight;
      el.scrollTop = el.scrollHeight;
      await new Promise((r) => setTimeout(r, 300));
      const atEnd = Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 2;
      if (atEnd && el.scrollHeight === before) return;
    }
  });
  await settleImages(page);
}

const server = await serveDist();
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;
console.log(`serving dist/ at ${baseUrl}`);

const { default: puppeteer } = await import('puppeteer');
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const captureResults = [];
try {
  for (const cap of CAPTURES) {
    const { key, query, width, height, label, scrolledVariant } = cap;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await enterSearchResults(page, baseUrl, query);

    const files = [];
    const topMetrics = await measure(page);
    const topFile = `${key}-${label}.png`;
    await page.screenshot({ path: join(OUT_DIR, topFile), fullPage: false });
    files.push({ file: topFile, state: 'top', metrics: topMetrics });
    console.log(`captured ${topFile} (${topMetrics.gridItems} grid items, statusTestIds=${topMetrics.simulatedStatusTestIds})`);

    if (scrolledVariant) {
      await scrollResultsToEnd(page);
      const endMetrics = await measure(page);
      const endFile = `${key}-${label}-scrolled-to-end.png`;
      await page.screenshot({ path: join(OUT_DIR, endFile), fullPage: false });
      files.push({ file: endFile, state: 'scrolled-to-end', metrics: endMetrics });
      console.log(`captured ${endFile} (lastRowGapPx=${endMetrics.lastRowGapPx})`);
    }

    captureResults.push({
      key,
      route: { name: 'SearchResults', params: { query } },
      navigation: ENTRY_STEPS,
      viewport: { width, height },
      files,
    });
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').filter((l) => l.trim().length > 0).map((l) => l.slice(3));
const manifest = {
  task: 'DIC-1452',
  generatedAt: new Date().toISOString(),
  commitSha: sha,
  dirtyPaths: dirty,
  evidenceMode: 'real-route-http',
  server: {
    command: 'node scripts/render-dic1452-search-results-evidence.mjs (built-in static file server over dist/, SPA fallback)',
    buildCommand: 'EXPO_PUBLIC_STORE_MVP=0 npm run build  # expo export --platform web + fix-html + assetlinks',
    url: baseUrl,
    servedFrom: 'dist/',
  },
  route: {
    name: 'SearchResults',
    entryUrl: baseUrl,
    note: 'No web deep-linking is configured (no `linking` on NavigationContainer), so SearchResults is reached through the app’s real navigation path on every capture; data loads from the served build’s /data/database.json at runtime.',
  },
  pen: PEN,
  penArtifacts: {
    before: ['pen-before/tmKqY.png', 'pen-before/o7WO3r.png', 'pen-before/uXuqo.png', 'pen-before/p28zL.png', 'pen-before/siVsa.png', 'pen-before/Z6jlE.png'],
    after: ['pen-after/tmKqY.png', 'pen-after/o7WO3r.png', 'pen-after/uXuqo.png', 'pen-after/p28zL.png', 'pen-after/siVsa.png', 'pen-after/Z6jlE.png'],
  },
  captures: captureResults,
  verification: JSON.parse(process.env.DIC1452_VERIFICATION ?? '{}'),
};
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nOK · DIC-1452 real-route evidence written to ${OUT_DIR}`);
