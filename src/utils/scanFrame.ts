/**
 * Scan frame geometry shared by the overlay, the web ROI crop and the native capture
 * crop (scan best-match fix 2026-10-15, Pen `docs/pen-scan/holohunter-scan-best-match.pen`).
 *
 * The frame is a portrait card window at the real card ratio (63 × 88 mm), as large as
 * the viewport allows after the top bar and the bottom controls. One function decides
 * the size so the visible frame, the web crop and the native crop cannot drift apart
 * again (v37 had a 0.64-width portrait overlay but a 0.75-width LANDSCAPE fallback crop).
 *
 * Dependency-free so Node regressions drive this exact code.
 */
import { mapCoverRectToSource, type Rect, type Size } from './scanGeometry';

/** Card height / width (63 × 88 mm). */
export const CARD_ASPECT = 88 / 63;

/** Space kept for the top bar and for hint + controls below the frame. */
export const FRAME_RESERVED = { top: 72, bottom: 260 } as const;
/** Never wider than this share of the viewport, never wider than MAX_FRAME_WIDTH. */
export const FRAME_MAX_WIDTH_RATIO = 0.86;
export const MAX_FRAME_WIDTH = 460;
export const MIN_FRAME_WIDTH = 160;

/** Crop margin around the frame, so a card held slightly off-centre keeps its edges. */
export const CROP_PAD = { padXRatio: 0.06, padYRatio: 0.04 } as const;

export interface Insets { top?: number; bottom?: number }

/** Used when the runtime reports no usable viewport yet (0 / NaN on a first web render). */
export const FALLBACK_VIEWPORT: Size = { width: 390, height: 844 };

export function computeScanFrameSize(rawViewport: Size, insets: Insets = {}): Size {
  // An unmeasured viewport must not collapse the frame to 0×0 (nothing to aim at, and the
  // web ROI would be empty); size it for a typical phone until real dimensions arrive.
  const viewport = rawViewport.width > 0 && rawViewport.height > 0 ? rawViewport : FALLBACK_VIEWPORT;
  const availableHeight = viewport.height - (insets.top ?? 0) - (insets.bottom ?? 0)
    - FRAME_RESERVED.top - FRAME_RESERVED.bottom;
  const byWidth = Math.min(viewport.width * FRAME_MAX_WIDTH_RATIO, MAX_FRAME_WIDTH);
  const byHeight = availableHeight / CARD_ASPECT;
  let width = Math.min(byWidth, byHeight);
  if (width < MIN_FRAME_WIDTH) {
    // Short viewport (landscape phone / small browser window): grow towards the
    // minimum, but never past the viewport itself — the controls may then overlap the
    // frame's lower edge, the frame never leaves the screen.
    const hardMaxHeight = viewport.height - (insets.top ?? 0) - (insets.bottom ?? 0) - FRAME_RESERVED.top - 40;
    width = Math.max(0, Math.min(MIN_FRAME_WIDTH, byWidth, hardMaxHeight / CARD_ASPECT));
  }
  return { width: Math.round(width), height: Math.round(width * CARD_ASPECT) };
}

/** The frame rect in viewport coordinates when it has not been measured yet. */
export function defaultScanFrameRect(rawViewport: Size, insets: Insets = {}): Rect {
  const viewport = rawViewport.width > 0 && rawViewport.height > 0 ? rawViewport : FALLBACK_VIEWPORT;
  const size = computeScanFrameSize(viewport, insets);
  const top = (insets.top ?? 0) + FRAME_RESERVED.top;
  const free = viewport.height - (insets.bottom ?? 0) - FRAME_RESERVED.bottom - top;
  return {
    x: Math.round((viewport.width - size.width) / 2),
    y: Math.round(top + Math.max(0, (free - size.height) / 2)),
    ...size,
  };
}

export type NativeCropPlan =
  | { ok: true; crop: Rect }
  | { ok: false; reason: 'no_layout' | 'no_photo_size' | 'orientation_mismatch' | 'frame_outside_preview' | 'crop_too_small' };

/**
 * Where the on-screen frame lands in the captured photo. The camera preview fills its
 * view with aspect-fill (cover), so the frame is mapped through the same cover transform
 * the web path uses. Both rects are in WINDOW coordinates (measureInWindow), so any
 * non-zero offset of the preview or the frame is accounted for.
 *
 * The photo must already be upright (expo-camera rotates to the capture orientation
 * unless skipProcessing): if the preview is portrait but the photo is landscape (or the
 * reverse) the pixels were not rotated and any crop would be wrong, so this refuses and
 * the caller sends the full photo instead.
 */
export function planNativeCrop(preview: Rect | null, frame: Rect | null, photo: Size | null): NativeCropPlan {
  if (!preview || !frame || preview.width <= 0 || preview.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { ok: false, reason: 'no_layout' };
  }
  if (!photo || !(photo.width > 0) || !(photo.height > 0)) return { ok: false, reason: 'no_photo_size' };
  const previewPortrait = preview.height >= preview.width;
  const photoPortrait = photo.height >= photo.width;
  if (previewPortrait !== photoPortrait) return { ok: false, reason: 'orientation_mismatch' };

  const local = { x: frame.x - preview.x, y: frame.y - preview.y, width: frame.width, height: frame.height };
  if (local.x + local.width <= 0 || local.y + local.height <= 0 || local.x >= preview.width || local.y >= preview.height) {
    return { ok: false, reason: 'frame_outside_preview' };
  }
  const mapped = mapCoverRectToSource({ width: preview.width, height: preview.height }, photo, local, CROP_PAD);
  const crop = {
    x: Math.floor(mapped.x),
    y: Math.floor(mapped.y),
    width: Math.floor(Math.min(mapped.width, photo.width - Math.floor(mapped.x))),
    height: Math.floor(Math.min(mapped.height, photo.height - Math.floor(mapped.y))),
  };
  if (crop.width < 64 || crop.height < 64) return { ok: false, reason: 'crop_too_small' };
  return { ok: true, crop };
}
