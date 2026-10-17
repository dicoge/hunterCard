/**
 * Android automatic card scanner (v42): the native view `HoloHunterCardScanner` from the
 * tracked local module modules/holohunter-ocr-geometry. A continuous CameraX preview whose
 * frames are read ON THE DEVICE (ML Kit, line/element geometry) while `active`; it sends
 * `onFrameText` events and takes ONE still only when asked (`takePicture`). No files, no
 * shutter overlay and no flash while it only looks.
 *
 * Absent on iOS, on the web and in any build without the module → null, and the scan
 * screen keeps its previous paths (expo-camera; still-photo probes as the fallback).
 */
import { Platform } from 'react-native';

type RequireImpl = (name: string) => any;

const DEFAULT_REQUIRE: RequireImpl = () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-modules-core');
};

export const NATIVE_CARD_SCANNER = 'HoloHunterCardScanner';
/** One analysed preview frame at most this often (the native side also enforces ≥ 250 ms). */
export const FRAME_ANALYSIS_INTERVAL_MS = 700;
/** v43: no streaming preview within this time → the camera start counts as failed (retry /
 *  manual camera are offered). Only surfaces the failure; it never captures anything. */
export const FRAME_SCANNER_STARTUP_TIMEOUT_MS = 8000;

export { visibleUprightRect, frameCropInFrame, type FrameTextEvent } from '../utils/frameGeometry';

export interface NativeCardScannerPhoto {
  uri: string;
  width: number;
  height: number;
  base64?: string;
}

export function loadNativeCardScannerView(requireImpl: RequireImpl = DEFAULT_REQUIRE): any | null {
  if (Platform.OS !== 'android') return null;
  try {
    const core = requireImpl('expo-modules-core');
    if (!core?.requireOptionalNativeModule?.(NATIVE_CARD_SCANNER)) return null;
    return core.requireNativeViewManager?.(NATIVE_CARD_SCANNER) ?? null;
  } catch {
    return null;
  }
}
