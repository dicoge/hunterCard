#!/usr/bin/env node
// DIC-1427 evidence capture — drives the REAL built web app (dist/) through
// the shipped navigation path (Home → search field → submit → SearchResults)
// and captures the live route at 390 / 768 / 1440. No synthetic previews:
// the page under the camera is the same bundle production serves.
//
// Outputs (docs/pen-v2/dic1427/):
//   search-results-<query>-<label>.png      — live route captures
//   side-by-side-Z6jlE-vs-live-390.png      — Pen frame vs live route composite
//   visual-diff-Z6jlE-vs-live-390.png       — pixel difference (art regions are
//                                             real card scans vs Pen checkers,
//                                             so chrome/layout is the signal)
import puppeteer from 'puppeteer';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve, extname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = pathResolve(__dirname, '..', 'dist');
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'dic1427');
const PEN_FRAME = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'Z6jlE.png');
mkdirSync(OUT_DIR, { recursive: true });
if (!existsSync(DIST)) throw new Error('dist/ missing — run `npm run build` first');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json', '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let filePath = join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!existsSync(filePath)) filePath = join(DIST, 'index.html');
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/`;

const VIEWPORTS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];
const QUERIES = ['すいせい', 'hSD04'];

const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let captured = 0;
try {
  for (const query of QUERIES) {
    for (const { width, height, label } of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 });
      // Real shipped path: Landing → 以訪客登入 → Home 搜尋 tab → Search
      // screen → type → submit. Same journey a real visitor takes. The guest
      // session persists in the browser origin after the first viewport, so
      // later loads legitimately land on Home directly.
      await page.waitForSelector(
        '[data-testid="landing-cta-guest"], [data-testid="shell-bottom-tab-search"]',
        { timeout: 45000 },
      );
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate(() => {
        document.querySelector('[data-testid="landing-cta-guest"]')?.click();
      });
      await page.waitForSelector('[data-testid="shell-bottom-tab-search"]', { timeout: 45000 });
      await new Promise((r) => setTimeout(r, 800));
      await page.evaluate(() => document.querySelector('[data-testid="shell-bottom-tab-search"]').click());
      await page.waitForSelector('[data-testid="search-input"]', { timeout: 30000 });
      await page.click('[data-testid="search-input"]');
      await page.type('[data-testid="search-input"]', query);
      await page.evaluate(() => document.querySelector('[data-testid="search-submit"]').click());
      await page.waitForSelector('[data-testid="search-results-count"]', { timeout: 60000 });
      // Let card art requests settle (external CDN images may 404 locally —
      // the tile placeholder is part of the real behavior then).
      await new Promise((r) => setTimeout(r, 2500));
      const slug = query === 'すいせい' ? 'suisei' : query.toLowerCase();
      const out = pathResolve(OUT_DIR, `search-results-${slug}-${label}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`captured ${out}`);
      captured += 1;
      await page.close();
    }
  }

  // Side-by-side + pixel diff vs the Pen frame at 390.
  const live390 = pathResolve(OUT_DIR, 'search-results-suisei-mobile-390.png');
  const penB64 = readFileSync(PEN_FRAME).toString('base64');
  const liveB64 = readFileSync(live390).toString('base64');
  const compositePage = await browser.newPage();
  await compositePage.setViewport({ width: 860, height: 940, deviceScaleFactor: 2 });
  await compositePage.setContent(`<!doctype html><html><body style="margin:0;background:#0A0A13;font-family:sans-serif;color:#F6F6FB">
    <div style="display:flex;gap:20px;padding:20px;align-items:flex-start">
      <figure style="margin:0"><figcaption style="font-size:13px;margin-bottom:8px">Pen Z6jlE · App / 02 搜尋結果 (390×844)</figcaption>
        <img src="data:image/png;base64,${penB64}" width="390"></figure>
      <figure style="margin:0"><figcaption style="font-size:13px;margin-bottom:8px">Live shipped route @390 (query すいせい)</figcaption>
        <img src="data:image/png;base64,${liveB64}" width="390"></figure>
    </div></body></html>`, { waitUntil: 'networkidle0' });
  const sideBySide = pathResolve(OUT_DIR, 'side-by-side-Z6jlE-vs-live-390.png');
  await compositePage.screenshot({ path: sideBySide, fullPage: true });
  console.log(`captured ${sideBySide}`);
  captured += 1;

  // Pixel diff (red = differing pixels).
  const diff = await compositePage.evaluate(async (a, b) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(`data:image/png;base64,${a}`), load(`data:image/png;base64,${b}`)]);
    const w = 390, h = 844;
    const canvas = (img) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    };
    const da = canvas(ia), db = canvas(ib);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const od = octx.createImageData(w, h);
    let diffPx = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const dr = Math.abs(da.data[i] - db.data[i]);
      const dg = Math.abs(da.data[i + 1] - db.data[i + 1]);
      const dbl = Math.abs(da.data[i + 2] - db.data[i + 2]);
      const delta = (dr + dg + dbl) / 3;
      if (delta > 24) {
        od.data[i] = 255; od.data[i + 1] = 40; od.data[i + 2] = 60; od.data[i + 3] = 255;
        diffPx += 1;
      } else {
        const g = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
        od.data[i] = g; od.data[i + 1] = g; od.data[i + 2] = g; od.data[i + 3] = 90;
      }
    }
    octx.putImageData(od, 0, 0);
    return { url: out.toDataURL('image/png'), diffPx, total: w * h };
  }, penB64, liveB64);
  const diffPath = pathResolve(OUT_DIR, 'visual-diff-Z6jlE-vs-live-390.png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(diffPath, Buffer.from(diff.url.split(',')[1], 'base64'));
  console.log(`captured ${diffPath} — ${(100 * diff.diffPx / diff.total).toFixed(1)}% differing pixels (art regions included)`);
  captured += 1;
  await compositePage.close();
} finally {
  await browser.close();
  server.close();
}
console.log(`\nOK · ${captured} evidence files written to ${OUT_DIR}`);
