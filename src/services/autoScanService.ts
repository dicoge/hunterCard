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
  /** Spatial luminance fingerprint of the scan area (used to tell cards apart) */
  signature: CardSignature;
}

/** Side of the square luminance fingerprint grid (SIGNATURE_GRID² cells). */
export const SIGNATURE_GRID = 8;

/**
 * Coarse *spatial* fingerprint used to tell one card apart from another.
 * `grid` is a row-major SIGNATURE_GRID×SIGNATURE_GRID array of average
 * luminance (0-1) per cell. Two different cards differ in their spatial layout
 * even when their frame-wide average brightness/edge density are similar, which
 * a single aggregate number cannot capture.
 */
export interface CardSignature {
  grid: number[];
}

/** A signature for a frame with no card (empty grid → never matches a card). */
export function emptySignature(): CardSignature {
  return { grid: [] };
}

/** Downsample raw RGBA pixels into a SIGNATURE_GRID² luminance grid (0-1). */
function luminanceGrid(pixels: Uint8ClampedArray, width: number, height: number): number[] {
  const cells = SIGNATURE_GRID * SIGNATURE_GRID;
  const sums = new Array(cells).fill(0);
  const counts = new Array(cells).fill(0);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(SIGNATURE_GRID - 1, Math.floor((y / height) * SIGNATURE_GRID));
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const lum = (pixels[idx] + pixels[idx + 1] + pixels[idx + 2]) / 3;
      const cell = cy * SIGNATURE_GRID + Math.min(SIGNATURE_GRID - 1, Math.floor((x / width) * SIGNATURE_GRID));
      sums[cell] += lum;
      counts[cell] += 1;
    }
  }
  return sums.map((s, i) => (counts[i] ? s / counts[i] / 255 : 0));
}

/** An axis-aligned rectangle in pixels. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Map a scan rectangle expressed in CSS/window coordinates to the intrinsic
 * source-pixel rectangle of a video rendered with `object-fit: cover`.
 *
 * The on-screen scan box is laid out in CSS pixels, but `drawImage`'s source
 * rectangle must be in the video's intrinsic pixels (`videoWidth`×`videoHeight`).
 * Under `cover` the frame is uniformly scaled by the larger of the two axis
 * ratios so it fills the element, then centre-cropped. This inverts that
 * mapping and clamps the result to the intrinsic frame, so the fingerprint is
 * taken from exactly the region the user sees inside the scan box.
 */
export function mapWindowRectToVideoSource(params: {
  scanArea: PixelRect;
  videoRect: PixelRect;
  videoWidth: number;
  videoHeight: number;
}): PixelRect {
  const { scanArea, videoRect, videoWidth, videoHeight } = params;
  if (
    videoWidth <= 0 || videoHeight <= 0 ||
    videoRect.width <= 0 || videoRect.height <= 0
  ) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const scale = Math.max(videoRect.width / videoWidth, videoRect.height / videoHeight);
  const displayedW = videoWidth * scale;
  const displayedH = videoHeight * scale;
  // Top-left of the displayed (post-cover) video content in window coords.
  const contentLeft = videoRect.x + (videoRect.width - displayedW) / 2;
  const contentTop = videoRect.y + (videoRect.height - displayedH) / 2;

  const srcX = (scanArea.x - contentLeft) / scale;
  const srcY = (scanArea.y - contentTop) / scale;
  const srcW = scanArea.width / scale;
  const srcH = scanArea.height / scale;

  const x0 = Math.max(0, Math.min(videoWidth, srcX));
  const y0 = Math.max(0, Math.min(videoHeight, srcY));
  const x1 = Math.max(0, Math.min(videoWidth, srcX + srcW));
  const y1 = Math.max(0, Math.min(videoHeight, srcY + srcH));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Resolve the intrinsic source rectangle to sample for `scanArea`. Uses the
 * live element layout (`getBoundingClientRect` + `videoWidth`/`videoHeight`) to
 * account for `object-fit: cover`. Falls back to treating `scanArea` as source
 * pixels when layout/intrinsic size is unavailable (e.g. video not yet sized).
 */
function videoSourceRect(
  videoElement: HTMLVideoElement,
  scanArea: PixelRect
): PixelRect {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  const rect =
    typeof videoElement.getBoundingClientRect === 'function'
      ? videoElement.getBoundingClientRect()
      : null;
  if (!rect || !vw || !vh || rect.width <= 0 || rect.height <= 0) {
    return { x: scanArea.x, y: scanArea.y, width: scanArea.width, height: scanArea.height };
  }
  const mapped = mapWindowRectToVideoSource({
    scanArea,
    videoRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    videoWidth: vw,
    videoHeight: vh,
  });
  // Degenerate mapping (scan box entirely off the visible frame) → legacy path.
  if (mapped.width < 1 || mapped.height < 1) {
    return { x: scanArea.x, y: scanArea.y, width: scanArea.width, height: scanArea.height };
  }
  return mapped;
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
    return { hasCard: false, isStable: false, confidence: 0, brightness: 0, edgeDensity: 0, signature: emptySignature() };
  }

  // Draw the scan-box region (mapped from CSS/window coords to intrinsic video
  // pixels) into the analysis canvas at its CSS size, so brightness/edge/
  // fingerprint all sample the same region the user sees.
  const src = videoSourceRect(videoElement, scanArea);
  ctx.drawImage(
    videoElement,
    src.x, src.y, src.width, src.height,
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
  const signature: CardSignature = { grid: luminanceGrid(pixels, width, height) };

  // Card detection heuristic:
  // Cards typically have moderate brightness (not too dark/light) and have straight edges
  const hasCard = brightness > 0.2 && brightness < 0.8 && edgeDensity > 0.12 && edgeDensity < 0.4;
  const confidence = Math.min(1, Math.max(0,
    (hasCard ? 0.6 : 0) +
    (brightness > 0.2 && brightness < 0.8 ? 0.2 : 0) +
    (edgeDensity > 0.1 && edgeDensity < 0.4 ? 0.2 : 0)
  ));

  return { hasCard, isStable: false, confidence, brightness, edgeDensity, signature };
}

/**
 * Compute just the card fingerprint for the current video frame. Used at
 * capture time (including manual scans) so the lock records the *actual*
 * scanned card, enabling direct A→B replacement detection afterwards.
 */
export function computeCardSignature(
  videoElement: HTMLVideoElement,
  scanArea: { x: number; y: number; width: number; height: number }
): CardSignature {
  const canvas = document.createElement('canvas');
  canvas.width = scanArea.width;
  canvas.height = scanArea.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return emptySignature();
  // Sample the same mapped scan-box region as the live loop so a manual capture
  // records the card the user actually framed (not the raw top-left of the
  // intrinsic frame), keeping capture-time and live fingerprints comparable.
  const src = videoSourceRect(videoElement, scanArea);
  ctx.drawImage(
    videoElement,
    src.x, src.y, src.width, src.height,
    0, 0, scanArea.width, scanArea.height
  );
  const { data } = ctx.getImageData(0, 0, scanArea.width, scanArea.height);
  return { grid: luminanceGrid(data, scanArea.width, scanArea.height) };
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

/**
 * Distance below which two fingerprints are treated as the same card. Same-card
 * perturbations measured on synthetic gradients stay well under this
 * (exposure ×1.4/×1.8 → 0, additive offset → 0, a two-cell reposition ≈ 0.026,
 * a near-blank frame under sensor noise ≈ 0.041) while a genuinely different
 * spatial layout sits far above it (≈ 0.14), giving ~2× margin on both sides.
 */
export const CARD_CHANGE_DISTANCE = 0.08;
/** Consecutive differing frames required before accepting a card swap (noise filter). */
export const CARD_CHANGE_STABLE_FRAMES = 2;
/**
 * Contrast floor used when normalizing a fingerprint. A grid whose mean-centred
 * L2 magnitude is below this is treated as low-information (a near-uniform or
 * blank frame): its noise is NOT amplified to unit scale, so a low-contrast card
 * held steady does not drift into a false "different card". Real cards carry far
 * more spatial contrast than this, so their normalization — and thus the
 * exposure/brightness invariance — is unaffected.
 */
export const MIN_SIGNATURE_SCALE = 0.3;

export function createScanLockState(): ScanLockState {
  return { locked: false, emptyStreak: 0, changedStreak: 0, lockedSignature: null };
}

/**
 * Mean-centre a grid and divide by its own L2 magnitude (floored at
 * MIN_SIGNATURE_SCALE). Centring removes an additive brightness offset; dividing
 * by the magnitude removes a multiplicative exposure/illumination scale — so the
 * same card under any linear lighting change maps to the same normalized vector,
 * while a different spatial layout does not.
 */
function normalizedGrid(grid: number[]): number[] {
  if (grid.length === 0) return grid;
  const mean = grid.reduce((sum, v) => sum + v, 0) / grid.length;
  const centered = grid.map(v => v - mean);
  let sumSq = 0;
  for (const v of centered) sumSq += v * v;
  const scale = Math.max(Math.sqrt(sumSq), MIN_SIGNATURE_SCALE);
  return centered.map(v => v / scale);
}

/** Distance between two card fingerprints; Infinity if either has no grid. */
export function signatureDistance(a: CardSignature, b: CardSignature): number {
  if (a.grid.length === 0 || b.grid.length === 0 || a.grid.length !== b.grid.length) {
    return Infinity;
  }
  const na = normalizedGrid(a.grid);
  const nb = normalizedGrid(b.grid);
  let sum = 0;
  for (let i = 0; i < na.length; i++) sum += Math.abs(na[i] - nb[i]);
  return sum / na.length;
}

/** True when two signatures are far enough apart to be different cards. */
export function isDifferentCard(a: CardSignature, b: CardSignature): boolean {
  return signatureDistance(a, b) > CARD_CHANGE_DISTANCE;
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

  if (next.lockedSignature && isDifferentCard(frame.signature, next.lockedSignature)) {
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