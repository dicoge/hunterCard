/**
 * v42 Android frame scanner geometry (dependency-free; used by src/services/nativeCardScanner
 * and the scan screen). The native HoloHunterCardScanner view binds preview, analysis and
 * still capture with ONE CameraX ViewPort, so each analysed frame carries the crop rect the
 * preview shows (sensor-buffer coordinates) and the still is cropped to it.
 */
import { planNativeCrop, type NativeCropPlan } from './scanFrame';

export interface FrameTextEvent {
  seq: number;
  /** The JS analysis session the frame STARTED in (stale completions carry an old one). */
  session?: number;
  /** Upright frame size (ML Kit boxes are in this space). */
  width: number;
  height: number;
  /** Sensor buffer → upright: clockwise degrees; buffer size; CameraX view-port crop (buffer coords). */
  rotation?: number;
  bufferWidth?: number;
  bufferHeight?: number;
  cropRect?: { x: number; y: number; width: number; height: number };
  blocks: unknown;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * The part of an analysed frame the preview actually shows, in the UPRIGHT frame's pixel
 * space (where ML Kit's boxes are). CameraX gives it as the shared view-port crop rect in
 * SENSOR BUFFER coordinates; the buffer must be turned `rotation` degrees clockwise to be
 * upright. No crop rect (older native) → the whole frame.
 */
export function visibleUprightRect(event: FrameTextEvent): Box {
  const full = { x: 0, y: 0, width: event.width, height: event.height };
  const c = event.cropRect;
  const W = event.bufferWidth;
  const H = event.bufferHeight;
  if (!c || !(c.width > 0) || !(c.height > 0) || !(W! > 0) || !(H! > 0)) return full;
  switch (((event.rotation ?? 0) % 360 + 360) % 360) {
    case 90: return { x: H! - (c.y + c.height), y: c.x, width: c.height, height: c.width };
    case 180: return { x: W! - (c.x + c.width), y: H! - (c.y + c.height), width: c.width, height: c.height };
    case 270: return { x: c.y, y: W! - (c.x + c.width), width: c.height, height: c.width };
    default: return { x: c.x, y: c.y, width: c.width, height: c.height };
  }
}

/**
 * Where the on-screen scan frame (plus the usual crop pad) lies in an analysed frame, in
 * upright frame pixels. The preview shows exactly the visible rect (same view port), so
 * the preview → visible-rect mapping is planNativeCrop's cover-fit onto a source of the
 * visible rect's size, then shifted by its origin.
 */
export function frameCropInFrame(preview: Box | null, frame: Box | null, event: FrameTextEvent): NativeCropPlan {
  const visible = visibleUprightRect(event);
  const plan = planNativeCrop(preview, frame, { width: visible.width, height: visible.height });
  if (!plan.ok) return plan;
  return { ok: true, crop: { ...plan.crop, x: plan.crop.x + visible.x, y: plan.crop.y + visible.y } };
}

