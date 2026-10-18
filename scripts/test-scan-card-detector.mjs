#!/usr/bin/env node
/**
 * v44: the card-region detector (src/utils/cardRegionDetector) on decoded IMAGE PIXELS —
 * the 12 prepared number-free card images and synthetic edge scenes — through the
 * production reference sampler. The scan frame comes from the trace spec; nothing tells
 * the detector where a card is. Pure, offline.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { frameFromPng, frameFromRgba, sceneRgba } from './lib/card-frames.mjs';

const { detectCardRegion } = await import('../src/utils/cardRegionDetector.ts');
const DIR = new URL('./fixtures/v44-card-frames/', import.meta.url);
const SPEC = JSON.parse(fs.readFileSync(new URL('auto-frame-traces.json', DIR), 'utf8'));

let passed = 0;
function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
// scan frame (image px) → crop (frame + the 6 % / 4 % pad) and frame, in grid cells
const regions = (frame, f) => {
  const sx = frame.luma.width / frame.width, sy = frame.luma.height / frame.height;
  const px = 0.06 * f.width, py = 0.04 * f.height;
  return [
    { x: (f.x - px) * sx, y: (f.y - py) * sy, width: (f.width + 2 * px) * sx, height: (f.height + 2 * py) * sy },
    { x: f.x * sx, y: f.y * sy, width: f.width * sx, height: f.height * sy },
  ];
};
const detect = (frame, f = SPEC.initialState.scanFrame) => detectCardRegion(frame.luma, ...regions(frame, f));

const EXPECT = { blank: 'none', cardA: 'card', cardB: 'card', jitter: 'card', moveLeft: 'card', moveRight: 'card', outside: 'outside', twoCards: 'multiple', wrongAspect: 'shape', small: 'none', landscapePreview: 'card', tallPreview: 'card' };
for (const [name, asset] of Object.entries(SPEC.assets)) {
  test(`fixture ${name} (decoded PNG ${asset.size.join('×')}) → ${EXPECT[name]}`, () => {
    const f = SPEC.frameOverrides[name]?.scanFrame ?? SPEC.initialState.scanFrame;
    assert.equal(detect(frameFromPng(new URL(asset.path, DIR)), f).status, EXPECT[name]);
  });
}
test('hand jitter keeps the card box within the stability tolerance; a real move does not', () => {
  const a = detect(frameFromPng(new URL('images/cardA.png', DIR))).box;
  const j = detect(frameFromPng(new URL('images/jitter.png', DIR))).box;
  const m = detect(frameFromPng(new URL('images/moveRight.png', DIR))).box;
  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const d = (p, q) => Math.max(Math.abs(centre(p)[0] - centre(q)[0]), Math.abs(centre(p)[1] - centre(q)[1]));
  assert.ok(d(a, j) <= 0.03, `jitter ${d(a, j)}`);
  assert.ok(d(a, m) > 0.03, `move ${d(a, m)}`);
});

const W = 320, H = 480, F = SPEC.initialState.scanFrame;
const noisy = (cards, seed = 7) => {
  const rgba = sceneRgba(W, H, cards);
  let s = seed;
  for (let i = 0; i < rgba.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = (s % 21) - 10;                                   // ±10 grain on the table
    for (let c = 0; c < 3; c += 1) rgba[i + c] = Math.max(0, Math.min(255, rgba[i + c] + n));
  }
  return frameFromRgba(rgba, W, H);
};
test('textured table (±10 grain), no card → none', () => assert.equal(detect(noisy([])).status, 'none'));
test('textured table with a card → card', () => assert.equal(detect(noisy([{ x: 70, y: 95, w: 180, h: 250 }])).status, 'card'));
test('bright uniform scene (white sheet) → none', () => {
  const rgba = Buffer.alloc(W * H * 4, 235);
  assert.equal(detect(frameFromRgba(rgba, W, H)).status, 'none');
});
test('a card larger than the scan crop (held too close) → outside, not a card', () => {
  assert.equal(detect(frameFromRgba(sceneRgba(W, H, [{ x: 5, y: 20, w: 310, h: 440 }]), W, H)).status, 'outside');
});
test('a small object next to the card (a coin) does not make it ambiguous', () => {
  const r = detect(frameFromRgba(sceneRgba(W, H, [{ x: 70, y: 95, w: 180, h: 250 }, { x: 270, y: 440, w: 20, h: 20 }]), W, H));
  assert.equal(r.status, 'card');
});
test('known limit: a card the same tone as the table is not detected (no false card either)', () => {
  const rgba = sceneRgba(W, H, [{ x: 70, y: 95, w: 180, h: 250, color: [45, 48, 52] }]);
  // its outline and art panel separate from the body → not ONE solid card region
  assert.notEqual(detect(frameFromRgba(rgba, W, H)).status, 'card');
});
void F;

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-card-detector: ${passed} checks passed`);
else console.error('\n❌ scan-card-detector failed');
