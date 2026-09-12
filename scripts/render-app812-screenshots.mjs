#!/usr/bin/env node
// DIC-1409 Phase 3 — real browser screenshots of the App 01–03 HTML fixtures
// produced by `render-app812-preview.mjs`, at their intended breakpoints.

import puppeteer from 'puppeteer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase5');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const WIDTHS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];
const SCREENS = ['app08-collection', 'app09-favorites', 'app10-tournament', 'app11-watchlist', 'app12-tutorial'];

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
let captured = 0;
try {
  for (const screen of SCREENS) {
    for (const { width, height, label } of WIDTHS) {
      const htmlPath = pathResolve(OUT_DIR, `${screen}-preview-${label}.html`);
      if (!existsSync(htmlPath)) {
        throw new Error(`Missing preview HTML: ${htmlPath}. Run render:app812 first.`);
      }
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 2 });
      try {
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 30000 });
      } catch {
        // Offline / slow remote assets: the layout and tokens are already in
        // the fixture; capture whatever has settled.
      }
      const screenshotPath = pathResolve(OUT_DIR, `${screen}-render-${label}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`captured ${screenshotPath}`);
      captured += 1;
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`\nOK · ${captured} app screenshots written to ${OUT_DIR}`);
