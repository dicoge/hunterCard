#!/usr/bin/env node
/**
 * v42 CR fea33de geometry gate: preview / analysis / still must share ONE field of view.
 * The native view binds Preview + ImageAnalysis + ImageCapture as a CameraX UseCaseGroup
 * with the PreviewView's ViewPort, so each analysed frame carries the visible crop rect
 * (sensor-buffer coordinates) and the still is cropped to it. These checks exercise the
 * real JS mapping (visibleUprightRect, frameCropInFrame) against an INDEPENDENT reference:
 * corner points rotated one by one, for every rotation, off-centre crops and an
 * aspect-ratio fallback buffer. Pure math — no camera.
 */
import assert from 'node:assert/strict';

const { visibleUprightRect, frameCropInFrame } = await import('../src/utils/frameGeometry.ts');
const { planNativeCrop, CROP_PAD } = await import('../src/utils/scanFrame.ts');

let passed = 0;
const test = (label, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${label}`); } catch (e) { process.exitCode = 1; console.error(`  ✗ ${label} — ${e.message}`); } };

// Reference: turn a buffer point upright by `rot` degrees clockwise (buffer W×H).
const rotatePoint = (x, y, W, H, rot) => {
  switch (rot) {
    case 90: return [H - y, x];
    case 180: return [W - x, H - y];
    case 270: return [y, W - x];
    default: return [x, y];
  }
};
const reference = (c, W, H, rot) => {
  const pts = [[c.x, c.y], [c.x + c.width, c.y], [c.x, c.y + c.height], [c.x + c.width, c.y + c.height]].map(([x, y]) => rotatePoint(x, y, W, H, rot));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const crops = [
  { name: '4:3 buffer, centred crop', W: 1280, H: 960, c: { x: 166, y: 0, width: 948, height: 960 } },
  { name: '4:3 buffer, off-centre crop', W: 1280, H: 960, c: { x: 100, y: 50, width: 1100, height: 544 } },
  { name: '16:9 fallback buffer, off-centre crop', W: 1920, H: 1080, c: { x: 300, y: 120, width: 1500, height: 742 } },
];
for (const { name, W, H, c } of crops) {
  for (const rot of [0, 90, 180, 270]) {
    test(`${name}, rotation ${rot}: visible rect = reference corner rotation`, () => {
      const upright = rot % 180 === 0 ? { width: W, height: H } : { width: H, height: W };
      const got = visibleUprightRect({ ...upright, rotation: rot, bufferWidth: W, bufferHeight: H, cropRect: c, seq: 1, blocks: [] });
      assert.deepEqual(got, reference(c, W, H, rot));
      assert.ok(got.x >= 0 && got.y >= 0 && got.x + got.width <= upright.width && got.y + got.height <= upright.height, 'inside the upright frame');
    });
  }
}

test('no crop rect (older native) → the whole upright frame (previous behaviour)', () => {
  assert.deepEqual(visibleUprightRect({ width: 960, height: 1280, seq: 1, blocks: [] }), { x: 0, y: 0, width: 960, height: 1280 });
});

// The on-screen geometry: preview box and scan frame in window coordinates.
const PREVIEW = { x: 0, y: 56, width: 390, height: 788 };
const FRAME = { x: 28, y: 150, width: 335, height: 468 };
for (const { name, W, H, c } of crops.slice(1)) {
  for (const rot of [90, 270]) {
    test(`${name}, rotation ${rot}: the scan frame's centre and size land where the preview shows them (independent proportion)`, () => {
      const ev = { width: H, height: W, rotation: rot, bufferWidth: W, bufferHeight: H, cropRect: c, seq: 1, blocks: [] };
      const vis = reference(c, W, H, rot);
      const plan = frameCropInFrame(PREVIEW, FRAME, ev);
      assert.ok(plan.ok);
      // Independent: the preview shows exactly `vis`, uniformly scaled (same aspect → cover = exact).
      const sx = vis.width / PREVIEW.width, sy = vis.height / PREVIEW.height;
      assert.ok(Math.abs(sx - sy) / sx < 0.01, `view-port aspect equals the preview's (${sx.toFixed(4)} vs ${sy.toFixed(4)})`);
      const cx = vis.x + (FRAME.x + FRAME.width / 2 - PREVIEW.x) * sx;
      const cy = vis.y + (FRAME.y + FRAME.height / 2 - PREVIEW.y) * sy;
      assert.ok(Math.abs(plan.crop.x + plan.crop.width / 2 - cx) <= 2, `centre x ${plan.crop.x + plan.crop.width / 2} vs ${cx}`);
      assert.ok(Math.abs(plan.crop.y + plan.crop.height / 2 - cy) <= 2, `centre y ${plan.crop.y + plan.crop.height / 2} vs ${cy}`);
      assert.ok(Math.abs(plan.crop.width - FRAME.width * sx * (1 + 2 * CROP_PAD.padXRatio)) <= 3, 'width = frame + pad');
      // ...and it differs from treating the whole frame as the preview (the fea33de assumption).
      const naive = planNativeCrop(PREVIEW, FRAME, { width: ev.width, height: ev.height }).crop;
      assert.ok(Math.abs(naive.x - plan.crop.x) > 20 || Math.abs(naive.y - plan.crop.y) > 20, 'an off-centre view port is NOT the full-frame cover-fit');
    });
  }
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-frame-geometry: ${passed} checks passed`);
else console.error('\n❌ scan-frame-geometry failed');
