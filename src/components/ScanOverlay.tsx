/**
 * ScanOverlay.tsx
 *
 * Reusable scan overlay for both WebCamera and CameraView.
 * Eliminates the 2x duplicated overlay code in ScanScreen.
 *
 * Contains:
 * - Scan area with animated scan line
 * - Corner decorations
 * - The primary scan action plus a gallery entry point so a card that cannot
 *   be pointed at (e.g. a photo the user already has) still has a scan path
 *   on native. The flash toggle rides the Pen `x7iIL` top bar (DIC-1409).
 *
 * DIC-1319: the normal flow is one primary action. Camera flip, manual search
 * and the auto-scan mode toggle used to sit under the viewfinder and were what
 * the v21 tester read as "many unnecessary buttons"; the auto-scan toggle was
 * inert on Android to begin with (the auto-scan loop is web-only). Those are
 * gone; manual search stays reachable from the scan-failure and low-confidence
 * recovery panels.
 *
 * DIC-1336: the gallery entry is back, but this time it is here for a reason.
 * The release-like Android QA (DIC-1332) found that the shipped APK had no
 * reachable gallery path — both `pickFromGallery` invocation sites in
 * ScanScreen were gated by `isWeb`, so on native there was no way to scan a
 * card from a photo the user already had. It is rendered here as an icon-only
 * secondary control beside the shutter so it does not compete with the
 * primary scan action, and it is ALSO exposed on the camera-permission-denied
 * surface (CameraPermissionDeniedView) so gallery scanning remains a real
 * recovery path when the camera is unavailable.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
  LayoutChangeEvent,
} from 'react-native';
import { COLORS } from '../constants';
import { PALETTE } from '../theme/tokensV2';
import { useTranslation } from '../i18n';
import ScanTopBar from './ScanTopBar';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
// DIC-1409 Phase 4 — Pen `App / 04 掃描卡牌` (frame eurld) scan frame is a
// PORTRAIT card window (node Aj73G, 250×350 at 390 ≈ 0.64 screen width,
// 1.4 aspect). The crop pipeline measures the frame via onLayout, so the
// aspect change flows through recognition without any constant duplication.
const SCAN_AREA_SIZE = Math.min(SCREEN_WIDTH * 0.64, 280);
const SCAN_AREA_HEIGHT = SCAN_AREA_SIZE * 1.4;

export interface ScanOverlayProps {
  // Animation values
  scanLineAnim: Animated.Value;
  pulseAnim: Animated.Value;
  borderAnim: Animated.Value;

  // Scan state
  isScanning: boolean;
  flash: boolean;
  // Whether the frame-stability auto-scan loop is actually running. ScanScreen
  // only runs it on web, so this is false on Android/iOS and the hint text
  // stops promising an automatic capture the platform never performs.
  autoScanActive: boolean;
  isCameraReady: boolean;
  cameraError: string | null;

  // Callbacks
  onFlash: () => void;
  onScan: () => void;
  onRetry: () => void;
  // Gallery entry — mounted unconditionally (no `isWeb` gate) so the shipped
  // Android APK exposes a native gallery scan path. ScanScreen wires this to
  // its own `pickFromGallery`; if the platform later cannot fulfil the pick
  // (no photo library permission, no picker), the handler itself is
  // responsible for surfacing that error — never this overlay.
  onGallery: () => void;
  onScanAreaLayout?: (event: LayoutChangeEvent) => void;
  /** Pen `x7iIL` top-bar close — dismisses the scan flow (back to Home). */
  onClose?: () => void;
}

export default function ScanOverlay({
  scanLineAnim,
  pulseAnim,
  borderAnim,
  isScanning,
  flash,
  autoScanActive,
  isCameraReady,
  cameraError,
  onFlash,
  onScan,
  onRetry,
  onGallery,
  onScanAreaLayout,
  onClose,
}: ScanOverlayProps) {
  const { t } = useTranslation();
  return (
    <>
      {/* Camera loading overlay */}
      {!isCameraReady && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>{t('scan_camera_initializing')}</Text>
            {cameraError && (
              <View style={resultStyles.errorContainer}>
                <Text style={resultStyles.errorText}>❌ {cameraError}</Text>
                <TouchableOpacity
                  style={resultStyles.retryButton}
                  onPress={onRetry}
                >
                  <Text style={resultStyles.retryText}>{t('common_retry')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Overlay with scan area — DIC-1286 (DIC-1294 QA crash fix +
          DIC-1296 CR round-2 UX fix).
          Two nested Animated.View nodes so JS-driver and native-driver
          animations never share a single node:
            • outer node (`scanAreaPulse`) carries the native-driven
              `transform: [{ scale: pulseAnim }]` and NO JS-driven props.
              Because the transform is applied at the parent, the entire
              visible frame — border, `overflow: hidden` clip, corners,
              scan line — scales together as it did before the split.
            • inner node (`styles.scanArea`) carries the JS-driven
              `borderColor: borderAnim.interpolate(...)` and NO native
              props. width / height / borderWidth / borderRadius / overflow
              are STATIC on this node, so they are safe on either driver.
              onLayout stays here so `scanAreaViewportRef` measures the
              same layout-space rect as before (transform is visual-only,
              never affects onLayout measurements).
          Mixing `transform` (native) with `borderColor` (JS-only) on the
          SAME Animated.View triggered
          `Attempting to run JS driven animation on animated node that has
          been moved to "native"` FATAL EXCEPTION mqt_v_native — reproduced
          by DIC-1294 on API-36 emulator. Two-node split preserves the
          full pulse UX AND fixes the crash. */}
      <View style={styles.overlay}>
        <View style={styles.overlayTop}>
          {/* Pen `x7iIL` Top Bar — Close / quota pill / Flash. The flash
              control moved here from the bottom controls row per the Pen
              composition; same real onFlash contract. */}
          <ScanTopBar onClose={onClose} onFlash={onFlash} flashOn={flash} />
        </View>
        <View style={styles.scanAreaContainer}>
          <View style={styles.overlaySide} />
          <Animated.View
            style={[
              styles.scanAreaPulse,
              { transform: [{ scale: pulseAnim }] },
            ]}
            pointerEvents="box-none"
          >
            <Animated.View
              style={[
                styles.scanArea,
                {
                  borderColor: borderAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [COLORS.primary, COLORS.primaryLight],
                  }),
                },
              ]}
              onLayout={onScanAreaLayout}
            >
              <Animated.View
                style={[
                  styles.scanLine,
                  {
                    transform: [{
                      translateY: scanLineAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, SCAN_AREA_HEIGHT - 4],
                      }),
                    }],
                    opacity: scanLineAnim.interpolate({
                      inputRange: [0, 0.5, 1],
                      outputRange: [0, 1, 0],
                    }),
                  },
                ]}
              />
              <View style={[styles.corner, styles.topLeft]} />
              <View style={[styles.corner, styles.topRight]} />
              <View style={[styles.corner, styles.bottomLeft]} />
              <View style={[styles.corner, styles.bottomRight]} />
              {isScanning && (
                <View style={styles.scanningIndicator}>
                  <Animated.Text
                    style={[styles.scanningText, { transform: [{ scale: pulseAnim }] }]}
                  >
                    {t('scan_recognizing')}
                  </Animated.Text>
                </View>
              )}
            </Animated.View>
          </Animated.View>
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom}>
          <Text style={styles.hintText}>
            {autoScanActive ? t('scan_frame_auto') : t('scan_frame_manual')}
          </Text>
          {/* Pen Tips row (node Cc84X): three pill chips */}
          <View style={styles.tipsRow} testID="scan-tips-row">
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_number')}</Text></View>
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_glare')}</Text></View>
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_flat')}</Text></View>
          </View>
          {/* DIC-1319 × DIC-1409: one primary action. Camera flip, manual
              search and the auto-scan mode switch stay out of the viewfinder
              (the auto-scan loop is web-only, so the switch was inert on
              Android; manual search remains reachable from the scan-failure
              and low-confidence recovery panels). The flash control rides the
              Pen `x7iIL` top bar, so this row is the scan action plus the
              gallery entry only. */}
          <View style={styles.controls} testID="scan-primary-controls">
            {/* The single scan action. */}
            <TouchableOpacity
              style={[styles.scanButton, isScanning && styles.scanButtonDisabled]}
              onPress={onScan}
              disabled={isScanning}
              activeOpacity={0.7}
              accessibilityRole="button"
              testID="scan-primary-action"
            >
              <View style={styles.scanButtonInner}>
                <Text style={styles.scanButtonIcon}>{isScanning ? '⏳' : '📷'}</Text>
              </View>
              <Text style={styles.scanButtonLabel}>
                {isScanning ? t('scan_recognizing') : autoScanActive ? t('scan_manual') : t('scan_scan_action')}
              </Text>
            </TouchableOpacity>

            {/* Gallery — icon-only secondary control beside the shutter.
                Rendered unconditionally so the Android APK
                has a reachable gallery scan path (DIC-1336); the previous
                `isWeb`-gated call sites left the shipped Android build with
                no way to scan a photo the user already had. Any inability
                to fulfil the picker (permissions, missing native module) is
                the handler's problem, not the overlay's — the button stays
                present so the flow starts. */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={onGallery}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={t('scan_gallery_action')}
              testID="scan-gallery-action"
            >
              <Text style={styles.controlIcon}>🖼️</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },
  // DIC-1409 CR fix: the overlay chrome sits ABSOLUTELY over the camera
  // element instead of flowing after the 100%-height <video> as a flex
  // sibling — normal flow pushed the whole scan UI below the fold.
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scanAreaContainer: {
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  // Pen scan frame (node Aj73G): portrait card window, #FFFFFF08 fill, r16.
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_HEIGHT,
    position: 'relative',
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 16,
    backgroundColor: '#FFFFFF08',
    overflow: 'hidden',
  },
  // Outer pulse wrapper (DIC-1294 + DIC-1296 CR round-2): owns the layout
  // box (width / height match the scanArea) and receives the native-driven
  // `scale` transform. Because the transform is applied here — the parent
  // of the border-styled scanArea — the border, the `overflow: hidden`
  // clipping boundary, the corners and the scan line ALL scale together,
  // preserving the original visible pulse UX. Kept separate from the
  // borderColor-animated child so JS-driven `borderColor` and native-driven
  // `transform` never share a single Animated.View — the crash pattern from
  // the API-36 emulator logcat.
  scanAreaPulse: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_HEIGHT,
  },
  scanLine: {
    position: 'absolute',
    left: 10,
    right: 10,
    height: 3,
    backgroundColor: COLORS.primary,
    borderRadius: 2,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  // Pen corner brackets (nodes K3Ja4K…): white, 32px, r10.
  corner: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderColor: '#FFFFFF',
  },
  topLeft: {
    top: -1,
    left: -1,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 10,
  },
  topRight: {
    top: -1,
    right: -1,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 10,
  },
  bottomLeft: {
    bottom: -1,
    left: -1,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 10,
  },
  bottomRight: {
    bottom: -1,
    right: -1,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 10,
  },
  scanningIndicator: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  scanningText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 15,
  },
  overlayBottom: {
    flex: 1.2,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingTop: 30,
    alignItems: 'center',
  },
  // Pen Hint title (node RrYjs): 14/600 white.
  hintText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Pen Tips chips (node Cc84X): #FFFFFF0F pills, 11 muted text.
  tipsRow: {
    flexDirection: 'row',
    gap: 7,
    marginBottom: 16,
  },
  tipChip: {
    backgroundColor: '#FFFFFF0F',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  tipChipText: {
    color: '#C6C6DE',
    fontSize: 11,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 12,
  },
  // Pen side controls (相簿 node TOYLP): #FFFFFF14 boxes, r14.
  controlBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
    padding: 8,
    backgroundColor: '#FFFFFF14',
    borderRadius: 14,
    minWidth: 52,
  },
  controlBtnActive: {
    opacity: 1,
  },
  controlIcon: {
    fontSize: 26,
  },
  scanButton: {
    alignItems: 'center',
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  // Pen Shutter (node TbHVE): 72px accent circle with glow, no white ring.
  scanButtonInner: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: PALETTE.accent,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  scanButtonIcon: {
    fontSize: 30,
  },
  scanButtonLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
});

// Keep resultStyles for the error container inside the overlay
const resultStyles = StyleSheet.create({
  errorContainer: {
    marginTop: 12,
    alignItems: 'center',
  },
  errorText: {
    color: '#ff6b9d',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 10,
  },
  retryButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 16,
  },
  retryText: {
    color: '#FF5252',
    fontSize: 14,
    fontWeight: '600',
  },
});
