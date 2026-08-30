#!/usr/bin/env node
// DIC-1160 PNG capture. Consumes the SVG snapshots emitted by
// scripts/preview-dic1160-icons.mjs and produces PNG artefacts sized to
// desktop (1366px) and 390px viewports so the reviewer can attach them
// directly to the DIC-1160 CR/QA hand-off without an external viewer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const INPUT_DIR = path.join(repoRoot, 'docs/dic1160-preview');
const OUT_DIR = process.env.PNG_OUT || INPUT_DIR;

const files = [
  { file: 'drawer-desktop-1366.svg', png: 'drawer-desktop-1366.png', viewport: { width: 1366, height: 768 } },
  { file: 'drawer-mobile-390.svg', png: 'drawer-mobile-390.png', viewport: { width: 390, height: 780 } },
  { file: 'price-trend-desktop-1366.svg', png: 'price-trend-desktop-1366.png', viewport: { width: 1366, height: 320 } },
  { file: 'price-trend-mobile-390.svg', png: 'price-trend-mobile-390.png', viewport: { width: 390, height: 340 } },
];

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
try {
  for (const { file, png, viewport } of files) {
    const svg = fs.readFileSync(path.join(INPUT_DIR, file), 'utf8');
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#0f0f23;}svg{display:block;}</style></head><body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(OUT_DIR, png), fullPage: false, omitBackground: false });
    await page.close();
    console.log(`wrote ${path.relative(repoRoot, path.join(OUT_DIR, png))}`);
  }
} finally {
  await browser.close();
}
