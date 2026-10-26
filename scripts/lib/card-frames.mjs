// Test helpers (v44): build the native frame-scanner event payload from IMAGE PIXELS —
// a decoded PNG, or a synthetic scene drawn here — through the production reference
// sampler `lumaGridFromRgba` (the contract CardFrameLuma.kt implements). Nothing here
// knows where a card is: the detector under test has to find it in the pixels.
import { decodePng } from './png-decode.mjs';

const { lumaGridFromRgba } = await import('../../src/utils/cardRegionDetector.ts');

let seq = 0;
export function frameFromRgba(rgba, width, height, extra = {}) {
  const grid = lumaGridFromRgba(rgba, width, height);
  return { seq: ++seq, width, height, luma: { width: grid.width, height: grid.height, data: grid.data }, ...extra };
}

export function frameFromPng(file, extra = {}) {
  const { width, height, rgba } = decodePng(file);
  return frameFromRgba(rgba, width, height, extra);
}

/** A synthetic scene: dark table, optional card rectangles (outline, art panel, a line). */
export function sceneRgba(width, height, cards = [], background = [40, 44, 49]) {
  const rgba = Buffer.alloc(width * height * 4);
  const put = (x, y, c) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const i = (y * width + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, background);
  for (const { x, y, w, h, color = [170, 70, 110] } of cards) {
    for (let j = 0; j < h; j += 1) {
      for (let i = 0; i < w; i += 1) {
        const edge = i < 3 || j < 3 || i >= w - 3 || j >= h - 3;
        const art = i >= 15 && i < w - 15 && j >= 20 && j < h / 2;
        put(Math.round(x + i), Math.round(y + j), edge ? [230, 230, 235] : art ? [75, 105, 135] : color);
      }
    }
  }
  return rgba;
}

export function sceneFrame(width, height, cards = [], extra = {}) {
  return frameFromRgba(sceneRgba(width, height, cards), width, height, extra);
}

const { DEFAULT_FRAME_REGION } = await import('../../src/services/autoCapture.ts');
const memo = new Map();
/**
 * A frame of `size` (upright, = the visible frame unless `visible` is given) with ONE card
 * covering 85 % of the scan frame region of `crop` (crop in upright frame coords), moved by
 * (dx, dy) crop fractions. Memoised: drawing a 960×1280 scene is not free.
 */
export function cardInCropFrame(size, crop, { dx = 0, dy = 0, color, visible = null, card = true, extra = {} } = {}) {
  const vis = visible ?? { x: 0, y: 0, width: size.width, height: size.height };
  const key = JSON.stringify([size, crop, dx, dy, color, vis, card]);
  if (!memo.has(key)) {
    const r = DEFAULT_FRAME_REGION;
    const fw = r.width * crop.width, fh = r.height * crop.height;
    const w = fw * 0.85, h = fh * 0.85;
    const x = crop.x + r.x * crop.width + (fw - w) / 2 + dx * crop.width - vis.x;
    const y = crop.y + r.y * crop.height + (fh - h) / 2 + dy * crop.height - vis.y;
    const cards = card ? [{ x, y, w: Math.round(w), h: Math.round(h), ...(color ? { color } : {}) }] : [];
    const { luma } = frameFromRgba(sceneRgba(vis.width, vis.height, cards), vis.width, vis.height);
    memo.set(key, luma);
  }
  return { seq: ++seq, width: size.width, height: size.height, luma: memo.get(key), ...extra };
}
