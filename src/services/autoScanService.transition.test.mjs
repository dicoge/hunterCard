/**
 * Transition & concurrency regression tests for the auto-scan lock state machine.
 *
 * Run with:  node --test src/services/autoScanService.transition.test.mjs
 * (Node >= 22 strips the TypeScript types from the imported .ts module.)
 *
 * Covers the DIC-702 duplicate-scan cases: A→A, A→(false negative)→A,
 * A→(two stable empty frames), direct A→B — including two *different* cards
 * that share the same aggregate brightness (distinguished only by spatial
 * layout) and a same-card-under-changing-light case that must NOT unlock —
 * plus overlay-throttle and camera/gallery concurrency gating.
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
  shouldAnalyzeFrame,
  shouldTriggerAutoScan,
  canAcquireScanJob,
  CARD_CHANGE_STABLE_FRAMES,
  SIGNATURE_GRID,
} from './autoScanService.ts';

const LIVE_EMPTY = 10;
const OVERLAY_EMPTY = 2;
const CELLS = SIGNATURE_GRID * SIGNATURE_GRID;

/** Build an 8×8 luminance grid from a per-cell function of (col, row). */
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
const SIG_A_BRIGHTER = { grid: GRID_A.map((v) => v + 0.12) }; // same card, uniform light change
const SIG_A_NOISY = { grid: GRID_A.map((v, i) => v + ((i % 3) - 1) * 0.004) }; // same card, sensor noise

const mean = (g) => g.reduce((a, b) => a + b, 0) / g.length;

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
const cardABrighter = () => frame(true, SIG_A_BRIGHTER);
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
});

test('same card under a uniform lighting change is NOT a different card', () => {
  assert.ok(Math.abs(mean(GRID_A) - mean(SIG_A_BRIGHTER.grid)) > 0.1, 'brightness really shifted');
  assert.ok(signatureDistance(SIG_A, SIG_A_BRIGHTER) < 1e-9, 'mean-centring cancels a uniform shift');
  assert.equal(isDifferentCard(SIG_A, SIG_A_BRIGHTER), false);
  assert.equal(isDifferentCard(SIG_A, SIG_A_NOISY), false, 'small sensor noise stays the same card');
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

test('A→(uniform brighter A repeatedly): lighting drift does not cause a duplicate', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, Array.from({ length: 20 }, cardABrighter), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a brightness-only change must keep A deduplicated');
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
