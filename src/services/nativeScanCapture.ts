/**
 * Native capture → the two images recognition sends (scan best-match fix 2026-10-15).
 *
 * v37 native sent one full camera photo, so the card was a small part of a large frame
 * and the bottom-edge card number often too small to read. This crops the photo to the
 * on-screen scan frame (planNativeCrop) and sends [downscaled full photo for context,
 * frame crop] — the same two-image shape the web scanner sends.
 *
 * expo-image-manipulator is required lazily and every failure falls back to the
 * original single photo, so a missing / broken native module can never crash a scan.
 * Diagnostics are reason codes only: no uri, no pixels, no base64.
 */
import type { NativeCropPlan } from '../utils/scanFrame';

/** Long edge of the context photo; the crop keeps up to CROP_LONG_EDGE. */
export const CONTEXT_LONG_EDGE = 1280;
export const CROP_LONG_EDGE = 1600;

export interface CapturedPhoto {
  uri: string;
  width?: number;
  height?: number;
  base64?: string | null;
}

export interface NativeScanImages {
  /** Context photo base64 (raw, no data: prefix). */
  base64: string | null;
  /** Frame crop base64, when the crop could be made. */
  cropBase64: string | null;
  /** Local file of the frame crop, so on-device OCR reads the same card area. */
  cropUri?: string | null;
  /** Why there is no crop (sanitised code), for diagnostics. */
  cropSkipped?: string;
}

type RequireImpl = (name: string) => unknown;

interface ManipulatorContextLike {
  crop(rect: { originX: number; originY: number; width: number; height: number }): ManipulatorContextLike;
  resize(size: { width?: number | null; height?: number | null }): ManipulatorContextLike;
  renderAsync(): Promise<{ saveAsync(o: { base64?: boolean; compress?: number; format?: unknown }): Promise<{ base64?: string; uri?: string }> }>;
}
interface ManipulatorModuleLike {
  ImageManipulator?: { manipulate(uri: string): ManipulatorContextLike };
  SaveFormat?: { JPEG?: unknown };
}

const DEFAULT_REQUIRE: RequireImpl = () => {
  // Static literal for Metro; lazily so a missing module degrades instead of crashing.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-image-manipulator');
};

function resizeFor(width: number, height: number, longEdge: number): { width?: number; height?: number } | null {
  if (Math.max(width, height) <= longEdge) return null;
  return width >= height ? { width: longEdge } : { height: longEdge };
}

export async function prepareNativeScanImages(
  photo: CapturedPhoto,
  plan: NativeCropPlan,
  deps: { requireImpl?: RequireImpl; log?: (msg: string) => void } = {},
): Promise<NativeScanImages> {
  const original: NativeScanImages = { base64: photo.base64 ?? null, cropBase64: null };
  const log = deps.log ?? ((msg: string) => console.warn(`[nativeScanCapture] ${msg}`));
  if (!plan.ok) {
    log(`crop skipped: ${plan.reason}`);
    return { ...original, cropSkipped: plan.reason };
  }

  let mod: ManipulatorModuleLike | null = null;
  try {
    mod = (deps.requireImpl ?? DEFAULT_REQUIRE)('expo-image-manipulator') as ManipulatorModuleLike;
  } catch {
    mod = null;
  }
  const manipulate = mod?.ImageManipulator?.manipulate;
  if (typeof manipulate !== 'function') {
    log('crop skipped: manipulator_unavailable');
    return { ...original, cropSkipped: 'manipulator_unavailable' };
  }

  const save = { base64: true, compress: 0.85, format: mod?.SaveFormat?.JPEG ?? 'jpeg' };
  try {
    const { crop } = plan;
    let cropCtx = manipulate.call(mod!.ImageManipulator, photo.uri)
      .crop({ originX: crop.x, originY: crop.y, width: crop.width, height: crop.height });
    const cropResize = resizeFor(crop.width, crop.height, CROP_LONG_EDGE);
    if (cropResize) cropCtx = cropCtx.resize(cropResize);
    const cropped = await (await cropCtx.renderAsync()).saveAsync(save);

    let fullCtx = manipulate.call(mod!.ImageManipulator, photo.uri);
    const fullResize = resizeFor(photo.width ?? 0, photo.height ?? 0, CONTEXT_LONG_EDGE);
    if (fullResize) fullCtx = fullCtx.resize(fullResize);
    const full = await (await fullCtx.renderAsync()).saveAsync(save);

    if (typeof cropped?.base64 !== 'string' || !cropped.base64) {
      log('crop skipped: crop_render_empty');
      return { ...original, cropSkipped: 'crop_render_empty' };
    }
    return {
      base64: typeof full?.base64 === 'string' && full.base64 ? full.base64 : original.base64,
      cropBase64: cropped.base64,
      cropUri: typeof cropped.uri === 'string' && cropped.uri ? cropped.uri : null,
    };
  } catch (e: any) {
    log(`crop skipped: manipulator_failed (${e?.name || 'Error'})`);
    return { ...original, cropSkipped: 'manipulator_failed' };
  }
}

/** Long edge of an automatic-capture probe crop: enough for the on-device reader. */
// v42 (Android 41 user report "never detects"): the probe crop is read by ML Kit, which
// needs roughly ≥16 px per character; a hOCG card number is ≈2 % of the card height, so a
// 900 px crop of a quality-0.3 still left it at the edge of readability. The probe now
// keeps the frame crop at up to 1600 px from a quality-0.7 still (local only, deleted).
export const PROBE_LONG_EDGE = 1600;
/** JPEG quality of the silent probe still (expo-camera takePictureAsync). */
export const PROBE_JPEG_QUALITY = 0.7;

/**
 * v41 automatic capture: the scan frame of a silent probe photo, small, as a local file
 * for the on-device text reader. No base64 — a probe is never uploaded. null when the
 * frame cannot be cropped (no measurement, no manipulator): then the probe says nothing,
 * it never falls back to reading the whole camera view.
 */
export interface ProbeCrop {
  uri: string;
  /** Pixel size of the saved crop — the space the on-device reader's boxes are in. */
  width: number;
  height: number;
}

export async function cropProbeToFrame(
  photo: CapturedPhoto,
  plan: NativeCropPlan,
  deps: { requireImpl?: RequireImpl } = {},
): Promise<ProbeCrop | null> {
  if (!plan.ok) return null;
  let mod: ManipulatorModuleLike | null = null;
  try {
    mod = (deps.requireImpl ?? DEFAULT_REQUIRE)('expo-image-manipulator') as ManipulatorModuleLike;
  } catch {
    return null;
  }
  const manipulate = mod?.ImageManipulator?.manipulate;
  if (typeof manipulate !== 'function') return null;
  try {
    const { crop } = plan;
    let ctx = manipulate.call(mod!.ImageManipulator, photo.uri)
      .crop({ originX: crop.x, originY: crop.y, width: crop.width, height: crop.height });
    const r = resizeFor(crop.width, crop.height, PROBE_LONG_EDGE);
    if (r) ctx = ctx.resize(r);
    const out = await (await ctx.renderAsync()).saveAsync({ base64: false, compress: 0.7, format: mod?.SaveFormat?.JPEG ?? 'jpeg' }) as { uri?: string; width?: number; height?: number };
    if (typeof out?.uri !== 'string' || !out.uri) return null;
    // The manipulator reports the saved size; otherwise derive it from the crop + resize.
    const scale = r ? (r.width ? r.width / crop.width : (r.height ?? crop.height) / crop.height) : 1;
    const width = Number.isFinite(out.width) && (out.width as number) > 0 ? out.width as number : Math.round(crop.width * scale);
    const height = Number.isFinite(out.height) && (out.height as number) > 0 ? out.height as number : Math.round(crop.height * scale);
    return { uri: out.uri, width, height };
  } catch {
    return null;
  }
}

const AUTO_REQUIRE: RequireImpl = (name) => {
  // Static literals for Metro; a missing module throws and auto capture is not offered.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (name === 'expo-ocr-kit') return require('expo-ocr-kit');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-image-manipulator');
};

/** Automatic capture needs the frame crop and the on-device reader on this build. */
export function nativeAutoCaptureAvailable(requireImpl: RequireImpl = AUTO_REQUIRE): boolean {
  try {
    const m = requireImpl('expo-image-manipulator') as ManipulatorModuleLike;
    const o = requireImpl('expo-ocr-kit') as { recognizeText?: unknown };
    return typeof m?.ImageManipulator?.manipulate === 'function' && typeof o?.recognizeText === 'function';
  } catch {
    return false;
  }
}

const FS_REQUIRE: RequireImpl = () => {
  // expo-file-system ships with the `expo` package (SDK 54) and is autolinked; static
  // literal for Metro, lazily so a missing module only means "nothing deleted".
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-file-system/legacy');
};

/**
 * Delete the temporary files of ONE automatic-capture probe (its silent photo and its
 * frame crop) so continuous probing never accumulates photos on the device. Only the
 * probe's own file:// URIs are passed in — never the photo of a real scan, a retry or
 * a result. Best effort, idempotent, never throws.
 */
export async function deleteProbeFiles(
  uris: Array<string | null | undefined>,
  requireImpl: RequireImpl = FS_REQUIRE,
): Promise<number> {
  const unique = [...new Set(uris.filter((u): u is string => typeof u === 'string' && u.startsWith('file://')))];
  if (unique.length === 0) return 0;
  type Fs = { deleteAsync?: (uri: string, o?: { idempotent?: boolean }) => Promise<void> };
  let mod: Fs | null = null;
  try { mod = requireImpl('expo-file-system/legacy') as Fs; } catch { return 0; }
  const del = mod?.deleteAsync;
  if (typeof del !== 'function') return 0;
  let deleted = 0;
  for (const uri of unique) {
    try { await del.call(mod, uri, { idempotent: true }); deleted += 1; } catch { /* best effort */ }
  }
  return deleted;
}
