#!/usr/bin/env node
/**
 * Generate the Google Play store-listing graphics that Play requires but the
 * app itself does not ship (DIC-1248 / DIC-1259): the 512x512 listing icon and
 * the 1024x500 feature graphic.
 *
 * The graphic is generated rather than hand-drawn so it can be regenerated
 * verbatim when the wording or palette changes, and so the palette stays tied
 * to assets/icon.png instead of drifting into a second, unofficial brand.
 *
 * PNG formats are pinned to what Play requires: the 512x512 icon is written as
 * a 32-bit RGBA PNG (colour type 6), the 1024x500 feature graphic is written
 * as a 24-bit RGB PNG (colour type 2). The earlier revision produced the icon
 * from macOS `sips`, which stripped the alpha channel; Play then rejects the
 * upload with "must be a 32-bit PNG". The generator is now pure Node.js and
 * behaves the same way on macOS and CI Linux.
 *
 * Deliberately contains no card artwork and no screenshot: the hololive card
 * art in this app is COVER Corporation's IP, and a store graphic built around
 * it invites a takedown that a text-and-logo graphic does not. It also carries
 * the unofficial disclaimer, which Play reviewers look for on fan-made
 * companion apps.
 *
 *   node scripts/generate-play-store-assets.mjs
 *
 * Outputs into docs/play/store-listing/. Formats are then verified end-to-end
 * by `npm run test:play-store-assets`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs/play/store-listing');

const NAVY = '#1E3A5F';
const NAVY_DEEP = '#132840';
const GOLD = '#D4AF37';
const INK = '#0F1620';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------- 512x512 listing icon
//
// Play requires a 32-bit PNG (colour type 6, RGBA). The source assets/icon.png
// is 1024x1024 8-bit RGB; pngjs decodes to a 4-channel buffer with the missing
// alpha filled to 255, so the output already carries the alpha channel Play
// requires. Downscale by exactly 2x with a 2x2 box filter — the ratio is
// integer so no bilinear approximation is needed and the result is
// deterministic across platforms.

function readPngAsRgba(filePath) {
  const buffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(buffer);
  if (png.data.length !== png.width * png.height * 4) {
    throw new Error(
      `pngjs decoded ${filePath} to ${png.data.length} bytes; expected ${png.width * png.height * 4} for RGBA — refusing to guess`,
    );
  }
  return png;
}

function downscale2xBox(src) {
  if (src.width % 2 !== 0 || src.height % 2 !== 0) {
    throw new Error(
      `downscale2xBox requires an even source; got ${src.width}x${src.height} — pick a source that halves cleanly instead of interpolating`,
    );
  }
  const dstWidth = src.width / 2;
  const dstHeight = src.height / 2;
  const dst = new PNG({ width: dstWidth, height: dstHeight, colorType: 6, inputHasAlpha: true });
  for (let y = 0; y < dstHeight; y += 1) {
    for (let x = 0; x < dstWidth; x += 1) {
      const dstIdx = (y * dstWidth + x) * 4;
      const sx = x * 2;
      const sy = y * 2;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const srcIdx = ((sy + dy) * src.width + (sx + dx)) * 4;
          r += src.data[srcIdx];
          g += src.data[srcIdx + 1];
          b += src.data[srcIdx + 2];
          a += src.data[srcIdx + 3];
        }
      }
      dst.data[dstIdx] = Math.round(r / 4);
      dst.data[dstIdx + 1] = Math.round(g / 4);
      dst.data[dstIdx + 2] = Math.round(b / 4);
      dst.data[dstIdx + 3] = Math.round(a / 4);
    }
  }
  return dst;
}

function generateIcon() {
  const source = path.join(ROOT, 'assets/icon.png');
  const target = path.join(OUT_DIR, 'icon-512.png');
  const src = readPngAsRgba(source);
  // The source is authored 1024x1024; halving twice gives 256, which is too
  // small. Halve once and we are already at 512 — the desired size for Play.
  if (src.width !== 1024 || src.height !== 1024) {
    throw new Error(
      `assets/icon.png is expected to be 1024x1024 (got ${src.width}x${src.height}); if the source ever changes, update this generator so the target stays exactly 512x512`,
    );
  }
  const scaled = downscale2xBox(src);
  const buffer = PNG.sync.write(scaled, { colorType: 6, inputHasAlpha: true });
  fs.writeFileSync(target, buffer);
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

// Puppeteer's PNG output preserves whatever alpha the page requested. The
// feature graphic body is fully opaque (a linear gradient over the whole
// viewport), so puppeteer already writes a 24-bit RGB PNG. We re-encode
// through pngjs to strip any alpha channel unconditionally rather than trust
// browser behaviour to stay this way across chromium upgrades.

function stripAlphaToRgb(png) {
  const dst = new PNG({ width: png.width, height: png.height, colorType: 2, inputColorType: 2 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const src = (y * png.width + x) * 4;
      const out = (y * png.width + x) * 4;
      dst.data[out] = png.data[src];
      dst.data[out + 1] = png.data[src + 1];
      dst.data[out + 2] = png.data[src + 2];
      dst.data[out + 3] = 255;
    }
  }
  return dst;
}

async function generateFeatureGraphic() {
  const target = path.join(OUT_DIR, 'feature-graphic-1024x500.png');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  let raw;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 500, deviceScaleFactor: 1 });
    await page.setContent(featureGraphicHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    raw = await page.screenshot({ type: 'png', omitBackground: false });
  } finally {
    await browser.close();
  }
  const decoded = PNG.sync.read(raw);
  const rgb = stripAlphaToRgb(decoded);
  fs.writeFileSync(target, PNG.sync.write(rgb, { colorType: 2, inputColorType: 2 }));
  return target;
}

// -------------------------------------------------------- optional utilities
//
// Phone screenshots are not generated here — they are captured with
// `adb exec-out screencap -p` from the running app. That tool writes 8-bit
// RGBA, and Play requires 24-bit RGB. Run:
//
//   node scripts/generate-play-store-assets.mjs --recode-screenshots
//
// to re-encode every phone-*.png under docs/play/store-listing/ in-place with
// the alpha channel stripped. Dimensions and pixel data are preserved.

function recodePhoneScreenshots() {
  const targets = fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^phone-.*\.png$/i.test(name))
    .map((name) => path.join(OUT_DIR, name));
  for (const target of targets) {
    const decoded = PNG.sync.read(fs.readFileSync(target));
    const rgb = stripAlphaToRgb(decoded);
    fs.writeFileSync(target, PNG.sync.write(rgb, { colorType: 2, inputColorType: 2 }));
    process.stdout.write(`re-encoded ${path.relative(ROOT, target)} as 24-bit RGB\n`);
  }
  return targets.length;
}

// ------------------------------------------------------------------- entrypoint

const args = process.argv.slice(2);
if (args.includes('--recode-screenshots')) {
  const count = recodePhoneScreenshots();
  process.stdout.write(`recoded ${count} phone screenshot(s)\n`);
} else {
  const icon = generateIcon();
  const feature = await generateFeatureGraphic();
  for (const file of [icon, feature]) {
    const png = PNG.sync.read(fs.readFileSync(file));
    process.stdout.write(`${path.relative(ROOT, file)} — ${png.width}x${png.height}, colorType=${png.colorType}\n`);
  }
}
