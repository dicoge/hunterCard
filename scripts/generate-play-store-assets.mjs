#!/usr/bin/env node
/**
 * Generate the Google Play store-listing graphics that Play requires but the
 * app itself does not ship (DIC-1248): the 512x512 listing icon and the
 * 1024x500 feature graphic.
 *
 * The graphic is generated rather than hand-drawn so it can be regenerated
 * verbatim when the wording or palette changes, and so the palette stays tied
 * to assets/icon.png instead of drifting into a second, unofficial brand.
 *
 * Deliberately contains no card artwork and no screenshot: the hololive card
 * art in this app is COVER Corporation's IP, and a store graphic built around
 * it invites a takedown that a text-and-logo graphic does not. It also carries
 * the unofficial disclaimer, which Play reviewers look for on fan-made
 * companion apps.
 *
 *   node scripts/generate-play-store-assets.mjs
 *
 * Outputs into docs/play/store-listing/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs/play/store-listing');

const NAVY = '#1E3A5F';
const NAVY_DEEP = '#132840';
const GOLD = '#D4AF37';
const INK = '#0F1620';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------- 512x512 listing icon

function generateIcon() {
  const source = path.join(ROOT, 'assets/icon.png');
  const target = path.join(OUT_DIR, 'icon-512.png');
  const result = spawnSync('sips', ['-z', '512', '512', source, '--out', target], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`sips failed to resize the icon: ${result.stderr || result.stdout}`);
  }
  return target;
}

// --------------------------------------------------- 1024x500 feature graphic

// Play may crop the outer edges of a feature graphic on some surfaces, so
// everything that must remain readable is kept inside a centred safe area.
const featureGraphicHtml = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1024px; height: 500px; }
  body {
    display: flex;
    align-items: center;
    background: linear-gradient(120deg, ${NAVY_DEEP} 0%, ${NAVY} 55%, #24486F 100%);
    font-family: "PingFang TC", "Hiragino Sans", "Noto Sans TC", system-ui, sans-serif;
    color: #fff;
    overflow: hidden;
  }
  .glow {
    position: absolute;
    width: 620px; height: 620px;
    right: -170px; top: -160px;
    background: radial-gradient(circle, rgba(212,175,55,0.20) 0%, rgba(212,175,55,0) 68%);
  }
  .safe {
    position: relative;
    display: flex;
    align-items: center;
    gap: 54px;
    width: 924px;
    height: 400px;
    margin: 0 auto;
  }
  .mark {
    flex: 0 0 auto;
    width: 214px; height: 292px;
    border: 9px solid ${GOLD};
    border-radius: 30px;
    background: ${INK};
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mark span {
    font-size: 118px;
    font-weight: 700;
    color: ${GOLD};
    letter-spacing: -6px;
    line-height: 1;
  }
  .pip {
    position: absolute;
    width: 24px; height: 24px;
    background: ${GOLD};
    transform: rotate(45deg);
    bottom: 26px;
  }
  .pip.l { left: 44px; }
  .pip.r { right: 44px; }
  .copy { flex: 1 1 auto; }
  .badge {
    display: inline-block;
    padding: 7px 18px;
    border: 2px solid rgba(212,175,55,0.75);
    border-radius: 999px;
    color: ${GOLD};
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 1.5px;
    margin-bottom: 22px;
  }
  h1 {
    font-size: 88px;
    font-weight: 800;
    letter-spacing: -1.5px;
    line-height: 1;
    margin-bottom: 20px;
  }
  h1 em { font-style: normal; color: ${GOLD}; }
  .tagline {
    font-size: 33px;
    font-weight: 600;
    color: #E8EEF7;
    margin-bottom: 14px;
  }
  .sub {
    font-size: 23px;
    color: rgba(232,238,247,0.72);
    letter-spacing: 0.3px;
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="safe">
    <div class="mark">
      <span>HH</span>
      <i class="pip l"></i>
      <i class="pip r"></i>
    </div>
    <div class="copy">
      <div class="badge">非官方 · UNOFFICIAL</div>
      <h1>Holo<em>Hunter</em></h1>
      <div class="tagline">卡牌查詢 · 掃描辨識 · 參考價格</div>
      <div class="sub">Card search, scanning and reference prices for hololive TCG players</div>
    </div>
  </div>
</body>
</html>`;

async function generateFeatureGraphic() {
  const target = path.join(OUT_DIR, 'feature-graphic-1024x500.png');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 500, deviceScaleFactor: 1 });
    await page.setContent(featureGraphicHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: target, type: 'png' });
  } finally {
    await browser.close();
  }
  return target;
}

const icon = generateIcon();
const feature = await generateFeatureGraphic();

for (const file of [icon, feature]) {
  const dimensions = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
    encoding: 'utf8',
  }).stdout.trim().split('\n').slice(1).map((line) => line.trim()).join(', ');
  process.stdout.write(`${path.relative(ROOT, file)} — ${dimensions}\n`);
}
