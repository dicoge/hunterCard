/**
 * Card-region detector for the Android automatic scan (v44 P0, user: "the camera is on
 * the card and steady, but it never scans").
 *
 * v42/v43 only triggered after the on-device text reader had parsed a whole card number
 * inside the frame — a card whose small number print the reader could not read never
 * triggered at all. The automatic trigger now comes from the PREVIEW PIXELS: the native
 * view (HoloHunterCardScannerView, CardFrameLuma.kt) sends a small luminance grid of the
 * visible frame with every analysed frame, and this module finds ONE card-shaped region
 * in it. src/services/autoCapture then requires that region to stay put on consecutive
 * frames before the single still is taken. Card numbers are still read only by the
 * normal recognition of that still (strict token rules unchanged).
 *
 * What counts as a card here (dependency-free, deterministic):
 *   • background = the median luminance of the grid's outer ring; a cell is "object"
 *     when it differs from it by more than max(22, 4 × the ring's median deviation);
 *   • objects are 4-connected components; one that is portrait card-shaped (height /
 *     width 1.2–1.7), solid (≥ 60 % of its bounding box), large (≥ 25 % of the scan
 *     frame) and inside the scan crop (frame + its pad) is the card;
 *   • two or more large objects = ambiguous (no card), as is nothing at all.
 * A uniform scene therefore never yields a card, however long it stays still.
 * Limits (UNTESTED on devices): a card whose colours match the table, a card filling
 * the whole view, or a landscape-held card is not detected — the shutter still works.
 */

/** Sampling grid: the long side of the visible frame gets this many cells. */
export const LUMA_GRID_LONG_SIDE = 64;

export interface LumaGrid { width: number; height: number; data: ArrayLike<number> }
export interface GridRect { x: number; y: number; width: number; height: number }
export type CardRegionStatus = 'card' | 'none' | 'multiple' | 'outside' | 'small' | 'shape';
export interface CardRegion {
  status: CardRegionStatus;
  /** the card's box normalised to the crop (0..1), only for status 'card' */
  box?: GridRect;
}

const MIN_DIFF = 22;
const ASPECT_MIN = 1.2;
const ASPECT_MAX = 1.7;
const MIN_FILL = 0.6;
const MIN_FRAME_SHARE = 0.25;
const SIGNIFICANT_FRAME_SHARE = 0.08;

/** Grid size for a visible frame of this size (same rule as CardFrameLuma.kt). */
export function lumaGridSize(visibleWidth: number, visibleHeight: number): { width: number; height: number } {
  if (visibleWidth >= visibleHeight) {
    return { width: LUMA_GRID_LONG_SIDE, height: Math.max(1, Math.round(LUMA_GRID_LONG_SIDE * visibleHeight / visibleWidth)) };
  }
  return { width: Math.max(1, Math.round(LUMA_GRID_LONG_SIDE * visibleWidth / visibleHeight)), height: LUMA_GRID_LONG_SIDE };
}

/**
 * Reference sampler for an UPRIGHT RGBA image (tests, and the contract CardFrameLuma.kt
 * implements on the camera's Y plane): each cell = the mean of 2 × 2 sample points at
 * ((cell + (s + 0.5) / 2) × size / cells), luminance ≈ BT.601.
 */
export function lumaGridFromRgba(rgba: ArrayLike<number>, width: number, height: number): LumaGrid {
  const { width: gw, height: gh } = lumaGridSize(width, height);
  const data = new Array<number>(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      let sum = 0;
      for (let sy = 0; sy < 2; sy += 1) {
        for (let sx = 0; sx < 2; sx += 1) {
          const u = Math.min(width - 1, Math.floor(((gx + (sx + 0.5) / 2) * width) / gw));
          const v = Math.min(height - 1, Math.floor(((gy + (sy + 0.5) / 2) * height) / gh));
          const i = (v * width + u) * 4;
          sum += (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) >> 8;
        }
      }
      data[gy * gw + gx] = sum >> 2;
    }
  }
  return { width: gw, height: gh, data };
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * Find the one card in `grid`. `crop` is the scan crop (frame + pad) and `frame` the
 * scan frame, both in grid cells.
 */
export function detectCardRegion(grid: LumaGrid, crop: GridRect, frame: GridRect): CardRegion {
  const { width: W, height: H, data } = grid;
  if (W < 4 || H < 4 || data.length < W * H) return { status: 'none' };
  const ring: number[] = [];
  for (let x = 0; x < W; x += 1) { ring.push(data[x], data[(H - 1) * W + x]); }
  for (let y = 1; y < H - 1; y += 1) { ring.push(data[y * W], data[y * W + W - 1]); }
  const bg = median(ring);
  const mad = median(ring.map((v) => Math.abs(v - bg)));
  const threshold = Math.max(MIN_DIFF, 4 * mad);
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i += 1) raw[i] = Math.abs(data[i] - bg) > threshold ? 1 : 0;
  // A card whose face is close to the table tone still shows its border. Close 1-cell gaps
  // (a thin border can fall between sample points), then count everything ENCLOSED by an
  // object as part of it: the background is what is reachable from the grid edge.
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy += 1) {
        for (let dx = -1; dx <= 1 && !on; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && raw[yy * W + xx]) on = 1;
        }
      }
      mask[y * W + x] = on;
    }
  }
  const outside = new Uint8Array(W * H);
  const flood: number[] = [];
  for (let i = 0; i < W * H; i += 1) {
    const x = i % W, y = (i - x) / W;
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && !mask[i]) { outside[i] = 1; flood.push(i); }
  }
  while (flood.length) {
    const i = flood.pop() as number;
    const x = i % W, y = (i - x) / W;
    for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (n >= 0 && !mask[n] && !outside[n]) { outside[n] = 1; flood.push(n); }
    }
  }
  for (let i = 0; i < W * H; i += 1) if (!outside[i]) mask[i] = 1;

  const frameArea = Math.max(1, frame.width * frame.height);
  const seen = new Uint8Array(W * H);
  const objects: Array<{ x0: number; y0: number; x1: number; y1: number; cells: number }> = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, cells = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % W, y = (i - x) / W;
      cells += 1;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const near = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const n of near) if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
    if ((x1 - x0 + 1) * (y1 - y0 + 1) >= SIGNIFICANT_FRAME_SHARE * frameArea) objects.push({ x0, y0, x1, y1, cells });
  }
  if (objects.length === 0) return { status: 'none' };
  if (objects.length > 1) return { status: 'multiple' };
  const o = objects[0];
  const bw = o.x1 - o.x0 + 1, bh = o.y1 - o.y0 + 1;
  const tol = 0.5;
  if (o.x0 < crop.x - tol || o.y0 < crop.y - tol || o.x1 + 1 > crop.x + crop.width + tol || o.y1 + 1 > crop.y + crop.height + tol) {
    return { status: 'outside' };
  }
  if (bw * bh < MIN_FRAME_SHARE * frameArea) return { status: 'small' };
  const aspect = bh / bw;
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX || o.cells / (bw * bh) < MIN_FILL) return { status: 'shape' };
  return {
    status: 'card',
    box: { x: (o.x0 - crop.x) / crop.width, y: (o.y0 - crop.y) / crop.height, width: bw / crop.width, height: bh / crop.height },
  };
}
