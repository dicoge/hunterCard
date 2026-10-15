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
