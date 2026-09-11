#!/usr/bin/env node
// DIC-1409 Phase 7 — real browser screenshots of the Landing HTML
// fixtures produced by `render-landing-preview.mjs`. Captures the
// viewport-height crop AND a full-page capture per breakpoint so the
// Pen→Preview comparison covers every section.

import puppeteer from 'puppeteer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase7');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const WIDTHS = [
  { width: 390, height: 844, label: 'mobile-390' },
  { width: 768, height: 1024, label: 'tablet-768' },
  { width: 1440, height: 900, label: 'desktop-1440' },
];

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
let captured = 0;
try {
  for (const { width, height, label } of WIDTHS) {
    const htmlPath = pathResolve(OUT_DIR, `landing-preview-${label}.html`);
    if (!existsSync(htmlPath)) {
      throw new Error(`Missing preview HTML: ${htmlPath}. Run render:landing first.`);
    }
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    try {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch {
      // Offline / slow webfonts: layout + tokens are already in the fixture.
    }
    await page.screenshot({ path: pathResolve(OUT_DIR, `landing-render-${label}.png`), fullPage: false });
    await page.screenshot({ path: pathResolve(OUT_DIR, `landing-render-${label}-full.png`), fullPage: true });
    console.log(`captured landing-render-${label}(.png|-full.png)`);
    captured += 2;
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nOK · ${captured} landing screenshots written to ${OUT_DIR}`);
