#!/usr/bin/env node
// DIC-1409 CR fix — real browser screenshots of the Search/Scan route
// fixtures produced by `render-scan-search-preview.mjs`.

import puppeteer from 'puppeteer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase8');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const CAPTURES = [
  { key: 'search', width: 390, height: 844, label: 'mobile-390' },
  { key: 'search', width: 768, height: 1024, label: 'tablet-768' },
  { key: 'search', width: 1440, height: 900, label: 'desktop-1440' },
  { key: 'scan-precamera', width: 390, height: 844, label: 'mobile-390' },
  // Camera-ready through the REAL shipped route (deterministic
  // getUserMedia seam) at all three required viewports.
  { key: 'scan-camera-ready', width: 390, height: 844, label: 'mobile-390' },
  { key: 'scan-camera-ready', width: 768, height: 1024, label: 'tablet-768' },
  { key: 'scan-camera-ready', width: 1440, height: 900, label: 'desktop-1440' },
];

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
let captured = 0;
try {
  for (const { key, width, height, label } of CAPTURES) {
    const htmlPath = pathResolve(OUT_DIR, `${key}-preview-${label}.html`);
    if (!existsSync(htmlPath)) {
      throw new Error(`Missing preview HTML: ${htmlPath}. Run render:scan-search first.`);
    }
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    try {
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch {}
    await page.screenshot({ path: pathResolve(OUT_DIR, `${key}-render-${label}.png`), fullPage: false });
    console.log(`captured ${key}-render-${label}.png`);
    captured += 1;
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nOK · ${captured} screenshots written to ${OUT_DIR}`);
