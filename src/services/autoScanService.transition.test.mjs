/**
 * Transition & concurrency regression tests for the auto-scan lock state machine.
 *
 * Run with:  node --test src/services/autoScanService.transition.test.mjs
 * (Node >= 22 strips the TypeScript types from the imported .ts module.)
 *
 * Covers the DIC-702 duplicate-scan cases: A→A, A→(false negative)→A,
 * A→(two stable empty frames), direct A→B, plus overlay-throttle and
 * camera/gallery concurrency gating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceScanLock,
  createScanLockState,
  lockAfterScan,
  isDifferentCard,
  shouldAnalyzeFrame,
  shouldTriggerAutoScan,
  canAcquireScanJob,
  CARD_CHANGE_STABLE_FRAMES,
} from './autoScanService.ts';

const LIVE_EMPTY = 10;
const OVERLAY_EMPTY = 2;

const SIG_A = { brightness: 0.5, edgeDensity: 0.2 };
const SIG_B = { brightness: 0.78, edgeDensity: 0.2 }; // brightness far from A → different card

/** Build a FrameAnalysis-shaped object. */
function frame(hasCard, sig = SIG_A, { isStable = true, confidence = 0.95 } = {}) {
  return {
    hasCard,
    isStable,
    confidence,
    brightness: sig.brightness,
    edgeDensity: sig.edgeDensity,
  };
}

const cardA = () => frame(true, SIG_A);
const cardB = () => frame(true, SIG_B);
const empty = () => frame(false, { brightness: 0, edgeDensity: 0 });

/** Feed a list of frames through the state machine. */
function run(state, frames, requiredEmpty) {
  let s = state;
  for (const f of frames) s = advanceScanLock(s, f, requiredEmpty);
  return s;
}

test('signature distance: A vs A is same, A vs B is different', () => {
  assert.equal(isDifferentCard(SIG_A, SIG_A), false);
  assert.equal(isDifferentCard(SIG_A, SIG_B), true);
});

test('A→A: same card held stays locked (no duplicate scan)', () => {
  let s = lockAfterScan(SIG_A);
  s = run(s, [cardA(), cardA(), cardA(), cardA(), cardA()], LIVE_EMPTY);
  assert.equal(s.locked, true, 'lock must survive re-detecting the same card');
});

test('A→(one false-negative empty frame)→A: single dropout does not unlock', () => {
  let s = lockAfterScan(SIG_A);
  s = advanceScanLock(s, empty(), LIVE_EMPTY); // one spurious no-card frame
  assert.equal(s.locked, true, 'a single empty frame must not release the lock');
  assert.equal(s.emptyStreak, 1);
  s = advanceScanLock(s, cardA(), LIVE_EMPTY); // card A reappears
  assert.equal(s.locked, true, 'returning to the same card keeps the lock');
  assert.equal(s.emptyStreak, 0, 'empty streak resets when the card returns');
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
  // One differing frame alone must not unlock (noise filter).
  s = advanceScanLock(s, cardB(), LIVE_EMPTY);
  assert.equal(s.locked, true, 'a single differing frame must not unlock');
  // Held long enough → treated as a real replacement.
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

test('A→(one B false positive)→A: transient different frame does not unlock A', () => {
  let s = lockAfterScan(SIG_A);
  s = advanceScanLock(s, cardB(), LIVE_EMPTY); // one noisy differing frame
  s = advanceScanLock(s, cardA(), LIVE_EMPTY); // back to A before the swap is confirmed
  assert.equal(s.locked, true, 'A stays deduplicated through a single B false-positive');
  assert.equal(s.changedStreak, 0, 'the change streak resets when A returns');
});

test('unlocked state never spuriously relocks', () => {
  let s = createScanLockState();
  s = run(s, [cardA(), cardB(), empty(), cardA()], LIVE_EMPTY);
  assert.equal(s.locked, false, 'advancing frames must not create a lock');
});

test('overlay throttle: analysis is gated to the throttle window under an overlay', () => {
  // No overlay → always analyze.
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: false, nowMs: 100, lastAnalysisMs: 90, overlayThrottleMs: 500 }),
    true
  );
  // Overlay + within throttle window → skip.
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: true, nowMs: 400, lastAnalysisMs: 100, overlayThrottleMs: 500 }),
    false
  );
  // Overlay + past throttle window → analyze.
  assert.equal(
    shouldAnalyzeFrame({ isOverlayVisible: true, nowMs: 700, lastAnalysisMs: 100, overlayThrottleMs: 500 }),
    true
  );
});

test('auto-scan trigger gating: overlay, instability and lock all block a capture', () => {
  const base = { frame: cardA(), locked: false, confidenceThreshold: 0.85 };
  assert.equal(shouldTriggerAutoScan({ ...base, isOverlayVisible: false }), true);
  assert.equal(shouldTriggerAutoScan({ ...base, isOverlayVisible: true }), false, 'overlay blocks trigger');
  assert.equal(
    shouldTriggerAutoScan({ ...base, isOverlayVisible: false, locked: true }),
    false,
    'a locked card blocks trigger'
  );
  assert.equal(
    shouldTriggerAutoScan({
      isOverlayVisible: false,
      frame: frame(true, SIG_A, { isStable: false }),
      locked: false,
      confidenceThreshold: 0.85,
    }),
    false,
    'an unstable frame blocks trigger'
  );
  assert.equal(
    shouldTriggerAutoScan({
      isOverlayVisible: false,
      frame: frame(true, SIG_A, { confidence: 0.5 }),
      locked: false,
      confidenceThreshold: 0.85,
    }),
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
