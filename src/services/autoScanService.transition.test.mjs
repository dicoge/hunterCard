/**
 * Transition & concurrency regression tests for the auto-scan lock state machine.
 *
 * Run with:  node --test src/services/autoScanService.transition.test.mjs
 * (Node >= 22 strips the TypeScript types from the imported .ts module.)
 *
 * Covers the DIC-702 duplicate-scan cases: A→A, A→(false negative)→A,
 * A→(two stable empty frames), direct A→B — including two *different* cards
 * that share the same aggregate brightness (distinguished only by spatial
 * layout), a same-card-under-changing-light case (additive AND multiplicative
 * exposure), a repositioned same card, and a low-contrast card under sensor
 * noise — none of which may unlock — plus the CSS→intrinsic scan-box coordinate
 * mapping (object-fit: cover), overlay-throttle and camera/gallery gating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceScanLock,
  createScanLockState,
  lockAfterScan,
  isDifferentCard,
  signatureDistance,
  emptySignature,
  mapWindowRectToVideoSource,
  videoSourceRect,
  shouldAnalyzeFrame,
  shouldTriggerAutoScan,
  canAcquireScanJob,
  CARD_CHANGE_STABLE_FRAMES,
  CARD_CHANGE_DISTANCE,
  SIGNATURE_GRID,
  SIGNATURE_SHIFT_RADIUS,
} from './autoScanService.ts';

const LIVE_EMPTY = 10;
const OVERLAY_EMPTY = 2;
const CELLS = SIGNATURE_GRID * SIGNATURE_GRID;

/** Build a SIGNATURE_GRID×SIGNATURE_GRID luminance grid from a per-cell function of (col, row). */
function makeGrid(fn) {
  return Array.from({ length: CELLS }, (_, i) => fn(i % SIGNATURE_GRID, Math.floor(i / SIGNATURE_GRID)));
}

// Card A: horizontal luminance gradient. Card B: vertical gradient.
// Both average to ~0.5 (same aggregate brightness) but differ spatially — the
// exact "similar aggregate statistics, different card" case the review flagged.
const GRID_A = makeGrid((cx) => 0.3 + (cx / (SIGNATURE_GRID - 1)) * 0.4);
const GRID_B = makeGrid((_, cy) => 0.3 + (cy / (SIGNATURE_GRID - 1)) * 0.4);

const SIG_A = { grid: GRID_A };
const SIG_B = { grid: GRID_B };
const SIG_A_BRIGHTER = { grid: GRID_A.map((v) => v + 0.12) };       // uniform additive light change
const SIG_A_GAIN = { grid: GRID_A.map((v) => v * 1.4) };            // uniform exposure/gain ×1.4
const SIG_A_GAIN2 = { grid: GRID_A.map((v) => v * 1.8) };           // stronger exposure ×1.8
const SIG_A_NOISY = { grid: GRID_A.map((v, i) => v + ((i % 3) - 1) * 0.004) }; // sensor noise
// Same card slid two cells to the right in the scan box (a plausible reposition).
const SIG_A_SHIFT = { grid: makeGrid((cx) => 0.3 + (Math.max(0, cx - 2) / (SIGNATURE_GRID - 1)) * 0.4) };
// A near-uniform (low-contrast) card whose sensor noise dwarfs its own contrast.
const GRID_FLAT = makeGrid((cx) => 0.5 + (cx / (SIGNATURE_GRID - 1)) * 0.02);
const SIG_FLAT = { grid: GRID_FLAT };
const SIG_FLAT_NOISY = { grid: GRID_FLAT.map((v, i) => v + ((i * 7 % 5) - 2) * 0.008) };

const mean = (g) => g.reduce((a, b) => a + b, 0) / g.length;

// ── General (non-gradient) 2D textures, for the translation-tolerance case ──
// A monotonic gradient is an easy fixture; the review required tolerance on a
// *general* 2D texture. These sample a continuous multi-frequency luminance
// field into the grid, so we can slide the sample point by a sub-cell fraction
// of the box (a real reposition) — not just whole cells.
const TEX_FIELD = (u, v) =>
  0.5 +
  0.18 * Math.sin(2 * Math.PI * 2 * u) +
  0.15 * Math.cos(2 * Math.PI * 2.5 * v) +
  0.1 * Math.sin(2 * Math.PI * 1.5 * (u + v));
/** Sample a continuous field into the grid, offsetting the sample point by a fraction of the box. */
function sampleField(field, shiftFracX = 0, shiftFracY = 0) {
  return makeGrid((cx, cy) =>
    field((cx + 0.5) / SIGNATURE_GRID + shiftFracX, (cy + 0.5) / SIGNATURE_GRID + shiftFracY));
}
const SIG_TEX = { grid: sampleField(TEX_FIELD) };
const SIG_TEX_SHIFT_1CELL = { grid: sampleField(TEX_FIELD, 1 / SIGNATURE_GRID, 0) };
const SIG_TEX_SHIFT_6H = { grid: sampleField(TEX_FIELD, 0.06, 0) };
const SIG_TEX_SHIFT_6V = { grid: sampleField(TEX_FIELD, 0, 0.06) };
// A genuinely different texture (radial vs the directional field above).
const SIG_TEX_OTHER = {
  grid: makeGrid((cx, cy) =>
    0.5 + 0.35 * Math.cos(2 * Math.PI * 2.5 * Math.hypot((cx - 5.5) / SIGNATURE_GRID, (cy - 5.5) / SIGNATURE_GRID))),
};

/** Build a FrameAnalysis-shaped object. */
function frame(hasCard, sig = SIG_A, { isStable = true, confidence = 0.95 } = {}) {
  return {
    hasCard,
    isStable,
    confidence,
    brightness: 0.5,
    edgeDensity: 0.2,
    signature: hasCard ? sig : emptySignature(),
  };
}

const cardA = () => frame(true, SIG_A);
const cardB = () => frame(true, SIG_B);
const cardAGain = () => frame(true, SIG_A_GAIN);
const cardAShift = () => frame(true, SIG_A_SHIFT);
const cardFlatNoisy = () => frame(true, SIG_FLAT_NOISY);
const empty = () => frame(false);

function run(state, frames, requiredEmpty) {
  let s = state;
  for (const f of frames) s = advanceScanLock(s, f, requiredEmpty);
  return s;
}

test('A and B share the same aggregate brightness but are still different cards', () => {
  assert.ok(Math.abs(mean(GRID_A) - mean(GRID_B)) < 1e-9, 'A and B must have equal mean brightness');
  assert.equal(isDifferentCard(SIG_A, SIG_A), false);
  assert.equal(isDifferentCard(SIG_A, SIG_B), true, 'different spatial layout ⇒ different card');
  assert.ok(signatureDistance(SIG_A, SIG_B) > CARD_CHANGE_DISTANCE * 1.5, 'A/B distance keeps a healthy margin above the threshold');
});

test('same card under an additive lighting change is NOT a different card', () => {
  assert.ok(Math.abs(mean(GRID_A) - mean(SIG_A_BRIGHTER.grid)) > 0.1, 'brightness really shifted');
  assert.ok(signatureDistance(SIG_A, SIG_A_BRIGHTER) < 1e-9, 'mean-centring cancels a uniform additive shift');
  assert.equal(isDifferentCard(SIG_A, SIG_A_BRIGHTER), false);
  assert.equal(isDifferentCard(SIG_A, SIG_A_NOISY), false, 'small sensor noise stays the same card');
});

test('same card under a multiplicative exposure/gain change is NOT a different card', () => {
  // The prior mean-centred-only distance grew with gain (×1.4 ≈ 0.0457 > 0.04)
  // and spuriously unlocked; scale-normalising the fingerprint cancels it.
  assert.ok(signatureDistance(SIG_A, SIG_A_GAIN) < 1e-9, 'scale-normalising cancels an exposure gain (×1.4)');
  assert.ok(signatureDistance(SIG_A, SIG_A_GAIN2) < 1e-9, 'and a stronger gain (×1.8)');
  assert.equal(isDifferentCard(SIG_A, SIG_A_GAIN), false);
  assert.equal(isDifferentCard(SIG_A, SIG_A_GAIN2), false);
});

test('a repositioned same card (2-cell shift) is NOT a different card', () => {
  assert.ok(signatureDistance(SIG_A, SIG_A_SHIFT) < CARD_CHANGE_DISTANCE, 'a modest reposition stays under the threshold');
  assert.equal(isDifferentCard(SIG_A, SIG_A_SHIFT), false);
});

test('a low-contrast card under sensor noise is NOT a different card', () => {
  // Its noise exceeds its own contrast; without a scale floor, normalisation
  // would amplify that noise and spuriously flag a "different card" every frame.
  assert.ok(signatureDistance(SIG_FLAT, SIG_FLAT_NOISY) < CARD_CHANGE_DISTANCE, 'low-contrast noise stays under the threshold');
  assert.equal(isDifferentCard(SIG_FLAT, SIG_FLAT_NOISY), false);
});

test('general 2D texture: a small reposition is NOT a different card (translation tolerance)', () => {
  // Without alignment, a rigid grid reads a one-cell / 6% slide of a general
  // texture as a whole new layout (measured ~0.16 for one cell, ~0.10 for 6%),
  // both above the threshold — a false A→B. The shift-search compare must keep
  // all of these well under it.
  assert.equal(SIGNATURE_SHIFT_RADIUS >= 1, true, 'a translation search must be enabled');
  assert.ok(signatureDistance(SIG_TEX, SIG_TEX_SHIFT_1CELL) < CARD_CHANGE_DISTANCE, 'one-cell slide stays same card');
  assert.ok(signatureDistance(SIG_TEX, SIG_TEX_SHIFT_6H) < CARD_CHANGE_DISTANCE, '6% horizontal slide stays same card');
  assert.ok(signatureDistance(SIG_TEX, SIG_TEX_SHIFT_6V) < CARD_CHANGE_DISTANCE, '6% vertical slide stays same card');
  assert.equal(isDifferentCard(SIG_TEX, SIG_TEX_SHIFT_1CELL), false);
  assert.equal(isDifferentCard(SIG_TEX, SIG_TEX_SHIFT_6H), false);
  assert.equal(isDifferentCard(SIG_TEX, SIG_TEX_SHIFT_6V), false);
});

test('general 2D texture: a genuinely different texture is still a different card', () => {
  // Alignment must not collapse real differences: no shift brings an unrelated
  // texture into agreement, so A→B separation survives on general textures too.
  assert.ok(signatureDistance(SIG_TEX, SIG_TEX_OTHER) > CARD_CHANGE_DISTANCE, 'different textures stay above the threshold');
  assert.ok(signatureDistance(SIG_TEX, SIG_TEX_OTHER) > CARD_CHANGE_DISTANCE * 1.5, 'with a healthy margin');
  assert.equal(isDifferentCard(SIG_TEX, SIG_TEX_OTHER), true);
});

test('an empty/absent signature never matches a card', () => {
  assert.equal(signatureDistance(SIG_A, emptySignature()), Infinity);
  assert.equal(isDifferentCard(SIG_A, emptySignature()), true);
});

test('A→A: same card held stays locked (no duplicate scan)', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, [cardA(), cardA(), cardA(), cardA(), cardA()], LIVE_EMPTY);
  assert.equal(s.locked, true, 'lock must survive re-detecting the same card');
});

test('A→(exposure gain drifts up repeatedly): a gain-only change does not cause a duplicate', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: 20 }, cardAGain), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a multiplicative exposure change must keep A deduplicated');
});

test('A→(repositioned A repeatedly): sustained same card is not judged a new card', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: 20 }, cardAShift), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a small reposition must keep A deduplicated');
});

test('A→(low-contrast card under noise repeatedly): no sustained false unlock', () => {
  let s = lockAfterScan(SIG_FLAT);
  s = run(s, Array.from({ length: 20 }, cardFlatNoisy), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a low-contrast card held steady must not drift into a false different-card unlock');
});

test('A→(one false-negative empty frame)→A: single dropout does not unlock', () => {
  let s = lockAfterScan(SIG_A);
  s = advanceScanLock(s, empty(), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a single empty frame must not release the lock');
  assert.equal(s.emptyStreak, 1);
  s = advanceScanLock(s, cardA(), LIVE_EMPTY);
  assert.equal(s.locked, true, 'returning to the same card keeps the lock');
  assert.equal(s.emptyStreak, 0);
});

test('A→(two stable empty frames): unlocks once the card truly leaves', () => {
  let s = lockAfterScan(SIG_A);
  s = advanceScanLock(s, empty(), OVERLAY_EMPTY);
  assert.equal(s.locked, true, 'one empty frame is not yet enough (need 2)');
  s = advanceScanLock(s, empty(), OVERLAY_EMPTY);
  assert.equal(s.locked, false, 'two stable empty frames release the lock');
  assert.equal(s.lockedSignature, null);
});

test('needs the full live empty streak (10) before unlocking', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: LIVE_EMPTY - 1 }, empty), LIVE_EMPTY);
  assert.equal(s.locked, true, `${LIVE_EMPTY - 1} empty frames must not unlock`);
  s = advanceScanLock(s, empty(), LIVE_EMPTY);
  assert.equal(s.locked, false, `${LIVE_EMPTY} empty frames unlock`);
});

test('direct A→B (no empty frames): a stable different card unlocks', () => {
  let s = lockAfterScan(SIG_A);
  assert.ok(CARD_CHANGE_STABLE_FRAMES >= 2);
  s = advanceScanLock(s, cardB(), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a single differing frame must not unlock');
  for (let i = 1; i < CARD_CHANGE_STABLE_FRAMES; i++) {
    s = advanceScanLock(s, cardB(), LIVE_EMPTY);
  }
  assert.equal(s.locked, false, 'a stable different card unlocks with zero empty frames');
  assert.equal(s.lockedSignature, null);
});

test('direct A→B under an overlay (no empty frame ever) still unlocks', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: CARD_CHANGE_STABLE_FRAMES }, cardB), OVERLAY_EMPTY);
  assert.equal(s.locked, false, 'A→B must unlock even when no empty frame is sampled under overlay');
});

test('manual scan records a signature, so a following B unlocks without empty frames', () => {
  // Manual/auto captures now lock with the real card fingerprint.
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: CARD_CHANGE_STABLE_FRAMES }, cardB), LIVE_EMPTY);
  assert.equal(s.locked, false, 'a signed lock allows visual A→B replacement');
});

test('a null-signature lock (gallery/native) only unlocks via empty frames', () => {
  let s = lockAfterScan(null);
  s = run(s, Array.from({ length: 20 }, cardB), LIVE_EMPTY);
  assert.equal(s.locked, true, 'without a reference signature, visual swap cannot unlock');
  s = run(s, Array.from({ length: LIVE_EMPTY }, empty), LIVE_EMPTY);
  assert.equal(s.locked, false, 'empty frames still release a null-signature lock');
});

test('a card-present frame carrying an empty signature never unlocks (degenerate mapping)', () => {
  // If the scan box briefly maps off-frame (video unsized / box off the visible
  // frame), analyzeFrame reports no real fingerprint. Such a frame must not be
  // read as a *different* card and spuriously release a signed lock.
  const cardNoSig = () => ({
    hasCard: true, isStable: true, confidence: 0.95, brightness: 0.5, edgeDensity: 0.2,
    signature: emptySignature(),
  });
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: 20 }, cardNoSig), LIVE_EMPTY);
  assert.equal(s.locked, true, 'an empty live signature must not be treated as an A→B swap');
  assert.equal(s.changedStreak, 0);
});

test('A→(one B false positive)→A: transient different frame does not unlock A', () => {
  let s = lockAfterScan(SIG_A);
  s = advanceScanLock(s, cardB(), LIVE_EMPTY);
  s = advanceScanLock(s, cardA(), LIVE_EMPTY);
  assert.equal(s.locked, true, 'A stays deduplicated through a single B false-positive');
  assert.equal(s.changedStreak, 0);
});

test('unlocked state never spuriously relocks', () => {
  let s = createScanLockState();
  s = run(s, [cardA(), cardB(), empty(), cardA()], LIVE_EMPTY);
  assert.equal(s.locked, false, 'advancing frames must not create a lock');
});

// ── Scan-box coordinate mapping (CSS/window → intrinsic video, object-fit: cover) ──

test('cover mapping: a centred scan box maps to the centre of the video frame', () => {
  // Landscape video centre-cropped horizontally inside a taller element at a
  // non-zero window origin.
  const videoRect = { x: 100, y: 200, width: 200, height: 400 };
  const videoWidth = 1000, videoHeight = 500;
  // A box centred on the element (element centre = 200,400).
  const scanArea = { x: 150, y: 300, width: 100, height: 200 };
  const src = mapWindowRectToVideoSource({ scanArea, videoRect, videoWidth, videoHeight });
  // Its centre must land on the video's intrinsic centre (500,250).
  assert.ok(Math.abs((src.x + src.width / 2) - videoWidth / 2) < 1e-9, 'x centre maps to frame centre');
  assert.ok(Math.abs((src.y + src.height / 2) - videoHeight / 2) < 1e-9, 'y centre maps to frame centre');
});

test('cover mapping (horizontal crop, non-zero origin): exact source rect', () => {
  const videoRect = { x: 100, y: 200, width: 200, height: 400 };
  const src = mapWindowRectToVideoSource({
    scanArea: { x: 150, y: 300, width: 100, height: 100 },
    videoRect,
    videoWidth: 1000,
    videoHeight: 500,
  });
  // scale = max(200/1000, 400/500) = 0.8; contentLeft = -200, contentTop = 200.
  assert.deepEqual(src, { x: 437.5, y: 125, width: 125, height: 125 });
  assert.ok(src.x >= 0 && src.x + src.width <= 1000, 'stays within intrinsic width');
  assert.ok(src.y >= 0 && src.y + src.height <= 500, 'stays within intrinsic height');
});

test('cover mapping (vertical crop): portrait video centre-cropped in a landscape box', () => {
  const src = mapWindowRectToVideoSource({
    scanArea: { x: 50, y: 50, width: 100, height: 100 },
    videoRect: { x: 0, y: 0, width: 400, height: 300 },
    videoWidth: 500,
    videoHeight: 1000,
  });
  // scale = max(400/500, 300/1000) = 0.8; displayed 400×800, contentTop = -250.
  assert.deepEqual(src, { x: 62.5, y: 375, width: 125, height: 125 });
  assert.ok(src.y >= 0 && src.y + src.height <= 1000, 'vertical crop stays within intrinsic height');
});

test('cover mapping: a visible scan box yields a non-degenerate in-frame source rect', () => {
  // Representative phone-ish case: 1280×720 sensor rendered into a 390×844 view.
  const videoRect = { x: 0, y: 0, width: 390, height: 844 };
  const scanArea = { x: 49, y: 126, width: 292, height: 184 };
  const src = mapWindowRectToVideoSource({ scanArea, videoRect, videoWidth: 1280, videoHeight: 720 });
  assert.ok(src.width > 1 && src.height > 1, 'produces a real region to fingerprint');
  assert.ok(src.x >= 0 && src.y >= 0, 'origin within frame');
  assert.ok(src.x + src.width <= 1280 + 1e-9 && src.y + src.height <= 720 + 1e-9, 'clamped to the frame');
});

test('cover mapping: a box entirely off the frame clamps to an empty rect', () => {
  const off = mapWindowRectToVideoSource({
    scanArea: { x: 5000, y: 5000, width: 100, height: 100 },
    videoRect: { x: 0, y: 0, width: 400, height: 800 },
    videoWidth: 1000,
    videoHeight: 2000,
  });
  assert.equal(off.width, 0);
  assert.equal(off.height, 0);
});

test('cover mapping: an unsized video (0×0) returns an empty rect', () => {
  const src = mapWindowRectToVideoSource({
    scanArea: { x: 10, y: 10, width: 100, height: 100 },
    videoRect: { x: 0, y: 0, width: 400, height: 800 },
    videoWidth: 0,
    videoHeight: 0,
  });
  assert.deepEqual(src, { x: 0, y: 0, width: 0, height: 0 });
});

// ── Consumer integration: videoSourceRect (the path analyzeFrame / computeCardSignature use) ──
// Exercises the real resolution the capture/live loop runs — measuring the video
// element's layout + intrinsic size and inverting object-fit:cover — including
// the guarantee that a degenerate/off-frame map returns null (no legacy
// CSS-as-intrinsic fallback), so a bad map yields *no* fingerprint, not a wrong one.

/** A fake <video> element: intrinsic size + a fixed layout rect. */
function fakeVideo(videoWidth, videoHeight, rect) {
  return {
    videoWidth,
    videoHeight,
    getBoundingClientRect: () => rect,
  };
}

test('videoSourceRect: horizontal crop at a non-zero window origin maps to intrinsic pixels', () => {
  // Same geometry as the pure-mapping test, but resolved through the consumer
  // entrypoint using the element's own getBoundingClientRect + videoWidth/Height.
  const video = fakeVideo(1000, 500, { left: 100, top: 200, width: 200, height: 400 });
  const src = videoSourceRect(video, { x: 150, y: 300, width: 100, height: 100 });
  assert.deepEqual(src, { x: 437.5, y: 125, width: 125, height: 125 });
});

test('videoSourceRect: vertical crop maps to intrinsic pixels', () => {
  const video = fakeVideo(500, 1000, { left: 0, top: 0, width: 400, height: 300 });
  const src = videoSourceRect(video, { x: 50, y: 50, width: 100, height: 100 });
  assert.deepEqual(src, { x: 62.5, y: 375, width: 125, height: 125 });
});

test('videoSourceRect: a representative phone aspect ratio yields an in-frame region', () => {
  const video = fakeVideo(1280, 720, { left: 0, top: 0, width: 390, height: 844 });
  const src = videoSourceRect(video, { x: 49, y: 126, width: 292, height: 184 });
  assert.ok(src, 'a visible box resolves to a region');
  assert.ok(src.width > 1 && src.height > 1, 'produces a real region to fingerprint');
  assert.ok(src.x >= 0 && src.y >= 0, 'origin within frame');
  assert.ok(src.x + src.width <= 1280 + 1e-9 && src.y + src.height <= 720 + 1e-9, 'clamped to the frame');
});

test('videoSourceRect: an off-frame scan box returns null (NO legacy CSS fallback)', () => {
  const video = fakeVideo(1000, 2000, { left: 0, top: 0, width: 400, height: 800 });
  const src = videoSourceRect(video, { x: 5000, y: 5000, width: 100, height: 100 });
  assert.equal(src, null, 'a box off the visible frame must not fall back to CSS coords as source pixels');
});

test('videoSourceRect: an unsized video (0×0) returns null', () => {
  const video = fakeVideo(0, 0, { left: 0, top: 0, width: 400, height: 800 });
  assert.equal(videoSourceRect(video, { x: 10, y: 10, width: 100, height: 100 }), null);
});

test('videoSourceRect: a zero-area layout rect returns null', () => {
  const video = fakeVideo(1280, 720, { left: 0, top: 0, width: 0, height: 0 });
  assert.equal(videoSourceRect(video, { x: 10, y: 10, width: 100, height: 100 }), null);
});

test('overlay throttle: analysis is gated to the throttle window under an overlay', () => {
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: false, nowMs: 100, lastAnalysisMs: 90, overlayThrottleMs: 500 }),
    true
  );
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: true, nowMs: 400, lastAnalysisMs: 100, overlayThrottleMs: 500 }),
    false
  );
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: true, nowMs: 700, lastAnalysisMs: 100, overlayThrottleMs: 500 }),
    true
  );
});

test('auto-scan trigger gating: overlay, instability, low confidence and lock all block a capture', () => {
  const base = { frame: cardA(), locked: false, confidenceThreshold: 0.85 };
  assert.equal(shouldTriggerAutoScan({ ...base, isOverlayVisible: false }), true);
  assert.equal(shouldTriggerAutoScan({ ...base, isOverlayVisible: true }), false, 'overlay blocks trigger');
  assert.equal(shouldTriggerAutoScan({ ...base, isOverlayVisible: false, locked: true }), false, 'lock blocks trigger');
  assert.equal(
    shouldTriggerAutoScan({ isOverlayVisible: false, frame: frame(true, SIG_A, { isStable: false }), locked: false, confidenceThreshold: 0.85 }),
    false,
    'unstable frame blocks trigger'
  );
  assert.equal(
    shouldTriggerAutoScan({ isOverlayVisible: false, frame: frame(true, SIG_A, { confidence: 0.5 }), locked: false, confidenceThreshold: 0.85 }),
    false,
    'low confidence blocks trigger'
  );
});

test('camera/gallery concurrency: a running job blocks the other from starting', () => {
  assert.equal(canAcquireScanJob({ isScanning: false, isGalleryPicking: false }), true);
  assert.equal(canAcquireScanJob({ isScanning: true, isGalleryPicking: false }), false, 'scan in flight blocks a new job');
  assert.equal(canAcquireScanJob({ isScanning: false, isGalleryPicking: true }), false, 'gallery pick blocks a new job');
  assert.equal(canAcquireScanJob({ isScanning: true, isGalleryPicking: true }), false);
});
