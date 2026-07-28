/**
 * Auto-Scan Detection Service
 *
 * Analyzes camera frames to detect when a card is centered and stable
 * in the scan area. Uses canvas-based brightness + edge detection.
 *
 * Auto-scan only works on web (native camera doesn't support frame analysis).
 * Native keeps manual scan (button press).
 */

export interface FrameAnalysis {
  /** Card detected in frame */
  hasCard: boolean;
  /** Card position stabilized over multiple frames */
  isStable: boolean;
  /** Detection confidence 0-1 */
  confidence: number;
  /** Average brightness 0-1 */
  brightness: number;
  /** Edge density (card has straight edges) */
  edgeDensity: number;
}

/**
 * Analyze a single video frame for card presence
 * Uses canvas to extract pixel data and detect card characteristics
 */
export function analyzeFrame(
  videoElement: HTMLVideoElement,
  scanArea: { x: number; y: number; width: number; height: number }
): FrameAnalysis {
  const canvas = document.createElement('canvas');
  canvas.width = scanArea.width;
  canvas.height = scanArea.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { hasCard: false, isStable: false, confidence: 0, brightness: 0, edgeDensity: 0 };
  }

  // Draw the scan area portion of the video onto the canvas
  ctx.drawImage(
    videoElement,
    scanArea.x, scanArea.y, scanArea.width, scanArea.height,
    0, 0, scanArea.width, scanArea.height
  );
  const imageData = ctx.getImageData(0, 0, scanArea.width, scanArea.height);
  const pixels = imageData.data;

  // Calculate average brightness
  let totalBrightness = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    totalBrightness += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  }
  const brightness = totalBrightness / (pixels.length / 4) / 255;

  // Edge detection using Sobel-like horizontal gradient
  const width = scanArea.width;
  const height = scanArea.height;
  let edgePixels = 0;
  const threshold = 60; // Higher = fewer false positives (was 30)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const left = ((y * width + (x - 1)) * 4);
      const right = ((y * width + (x + 1)) * 4);
      const top = (((y - 1) * width + x) * 4);
      const bottom = (((y + 1) * width + x) * 4);

      const gx = Math.abs(
        (pixels[left] + pixels[left + 1] + pixels[left + 2]) / 3 -
        (pixels[right] + pixels[right + 1] + pixels[right + 2]) / 3
      );
      const gy = Math.abs(
        (pixels[top] + pixels[top + 1] + pixels[top + 2]) / 3 -
        (pixels[bottom] + pixels[bottom + 1] + pixels[bottom + 2]) / 3
      );

      if (gx + gy > threshold) edgePixels++;
    }
  }

  const edgeDensity = edgePixels / (width * height);

  // Card detection heuristic:
  // Cards typically have moderate brightness (not too dark/light) and have straight edges
  const hasCard = brightness > 0.2 && brightness < 0.8 && edgeDensity > 0.12 && edgeDensity < 0.4;
  const confidence = Math.min(1, Math.max(0,
    (hasCard ? 0.6 : 0) +
    (brightness > 0.2 && brightness < 0.8 ? 0.2 : 0) +
    (edgeDensity > 0.1 && edgeDensity < 0.4 ? 0.2 : 0)
  ));

  return { hasCard, isStable: false, confidence, brightness, edgeDensity };
}

// ── Stability Detection ──

const frameHistory: FrameAnalysis[] = [];
const STABILITY_FRAMES = 10; // Need 10 consecutive frames with card (was 5)

/**
 * Analyze frame with stability tracking
 * Keeps a buffer of recent frames and checks if a card
 * has been consistently detected with stable brightness
 */
export function analyzeFrameWithStability(
  videoElement: HTMLVideoElement,
  scanArea: { x: number; y: number; width: number; height: number }
): FrameAnalysis {
  const result = analyzeFrame(videoElement, scanArea);

  frameHistory.push(result);
  if (frameHistory.length > STABILITY_FRAMES + 3) {
    frameHistory.shift();
  }

  // Check stability: last N frames all detected card
  const recentFrames = frameHistory.slice(-STABILITY_FRAMES);
  const allDetected = recentFrames.length >= STABILITY_FRAMES &&
    recentFrames.every(f => f.hasCard);

  // Check brightness variance (if it suddenly changes, card was moved)
  const brightnessVariance = recentFrames.length > 1
    ? Math.max(...recentFrames.map(f => f.brightness)) - Math.min(...recentFrames.map(f => f.brightness))
    : 1;
  const brightnessStable = brightnessVariance < 0.15;

  result.isStable = allDetected && brightnessStable;

  return result;
}

/**
 * Reset frame history (call after successful scan or camera switch)
 */
export function resetAutoScan(): void {
  frameHistory.length = 0;
}

// ── Auto-scan lock state machine ──
//
// After a card is scanned we must stop auto-scanning it again (duplicate
// captures) while still letting a *different* card auto-scan. The lock is
// released either when the card physically leaves the frame (a stable run of
// no-card frames) OR when a visually different card is held in the frame long
// enough to be a real replacement (direct A→B swap, even with zero empty
// frames — e.g. while a result overlay is open). A single false-negative
// no-card frame, or re-detecting the same card (A→A), never releases the lock.

/** Coarse visual signature used to tell one card apart from another. */
export interface CardSignature {
  brightness: number;
  edgeDensity: number;
}

export interface ScanLockState {
  /** Locked after a successful scan; blocks duplicate auto-scans of that card. */
  locked: boolean;
  /** Consecutive frames with no card detected. */
  emptyStreak: number;
  /** Consecutive frames showing a card that differs from the locked one. */
  changedStreak: number;
  /** Visual signature of the currently locked (last-scanned) card. */
  lockedSignature: CardSignature | null;
}

/** Minimum absolute change in a signature dimension to count as a new card. */
export const CARD_CHANGE_BRIGHTNESS_DELTA = 0.18;
export const CARD_CHANGE_EDGE_DELTA = 0.06;
/** Consecutive differing frames required before accepting a card swap (noise filter). */
export const CARD_CHANGE_STABLE_FRAMES = 2;

export function createScanLockState(): ScanLockState {
  return { locked: false, emptyStreak: 0, changedStreak: 0, lockedSignature: null };
}

/** True when two signatures are far enough apart to be different cards. */
export function isDifferentCard(a: CardSignature, b: CardSignature): boolean {
  return (
    Math.abs(a.brightness - b.brightness) > CARD_CHANGE_BRIGHTNESS_DELTA ||
    Math.abs(a.edgeDensity - b.edgeDensity) > CARD_CHANGE_EDGE_DELTA
  );
}

/**
 * Advance the lock state machine by one analyzed frame. Returns a new state
 * (never mutates the input).
 *
 * @param requiredEmptyFrames consecutive no-card frames needed to unlock via
 *   "card left the frame". Callers pass a larger value for the fast live loop
 *   and a smaller one for the throttled under-overlay loop.
 */
export function advanceScanLock(
  prev: ScanLockState,
  frame: FrameAnalysis,
  requiredEmptyFrames: number
): ScanLockState {
  const next: ScanLockState = { ...prev };

  if (!frame.hasCard) {
    next.changedStreak = 0;
    next.emptyStreak = prev.emptyStreak + 1;
    if (next.locked && next.emptyStreak >= requiredEmptyFrames) {
      next.locked = false;
      next.lockedSignature = null;
      next.emptyStreak = 0;
    }
    return next;
  }

  // A card is present in this frame.
  next.emptyStreak = 0;
  if (!next.locked) {
    next.changedStreak = 0;
    return next;
  }

  const signature: CardSignature = { brightness: frame.brightness, edgeDensity: frame.edgeDensity };
  if (next.lockedSignature && isDifferentCard(signature, next.lockedSignature)) {
    next.changedStreak = prev.changedStreak + 1;
    if (next.changedStreak >= CARD_CHANGE_STABLE_FRAMES) {
      next.locked = false;
      next.lockedSignature = null;
      next.changedStreak = 0;
    }
  } else {
    // Same card (A→A) or no reference signature — keep the lock.
    next.changedStreak = 0;
  }

  return next;
}

/** Lock auto-scan after a successful capture of the card with `signature`. */
export function lockAfterScan(signature: CardSignature | null): ScanLockState {
  return { locked: true, emptyStreak: 0, changedStreak: 0, lockedSignature: signature };
}

// ── Loop decision helpers (kept pure so the auto-scan loop is testable) ──

/**
 * Whether the frame should be analyzed this tick. Under an overlay the loop is
 * throttled to `overlayThrottleMs` to keep camera CPU near idle; otherwise it
 * analyzes every animation frame.
 */
export function shouldAnalyzeFrame(params: {
  isOverlayVisible: boolean;
  nowMs: number;
  lastAnalysisMs: number;
  overlayThrottleMs: number;
}): boolean {
  return (
    !params.isOverlayVisible ||
    params.nowMs - params.lastAnalysisMs >= params.overlayThrottleMs
  );
}

/** Whether an auto-scan capture should fire for this frame. */
export function shouldTriggerAutoScan(params: {
  isOverlayVisible: boolean;
  frame: FrameAnalysis;
  locked: boolean;
  confidenceThreshold: number;
}): boolean {
  return (
    !params.isOverlayVisible &&
    params.frame.isStable &&
    params.frame.confidence > params.confidenceThreshold &&
    !params.locked
  );
}

/**
 * Single source of truth for camera/gallery mutual exclusion: a new scan job
 * may only start when neither a scan nor a gallery pick is already running.
 */
export function canAcquireScanJob(locks: {
  isScanning: boolean;
  isGalleryPicking: boolean;
}): boolean {
  return !locks.isScanning && !locks.isGalleryPicking;
}