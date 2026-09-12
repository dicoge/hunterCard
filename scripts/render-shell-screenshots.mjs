#!/usr/bin/env node
// DIC-1409 Phase 2 — takes real browser screenshots of the shell HTML fixtures
// produced by `render-shell-preview.mjs`, at their intended breakpoints:
//   • 390 × 844  (Pen mobile canvas)
//   • 768 × 1024 (tablet breakpoint)
//   • 1440 × 900 (desktop, Pen `HoloHunter Landing / Desktop 1440`)
//
// Puppeteer is already a repo devDependency (used by other visual regressions)
// so this fits into the existing CI-safe toolchain.

import puppeteer from 'puppeteer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = pathResolve(__dirname, '..', 'docs', 'pen-v2', 'phase2');
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
try {
  for (const { width, height, label } of WIDTHS) {
    const htmlPath = pathResolve(OUT_DIR, `shell-preview-${label}.html`);
    if (!existsSync(htmlPath)) {
      throw new Error(`Missing preview HTML: ${htmlPath}. Run render:shell-preview first.`);
    }
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    const screenshotPath = pathResolve(OUT_DIR, `shell-render-${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`captured ${screenshotPath}`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\nOK · ${WIDTHS.length} shell screenshots written to ${OUT_DIR}`);
