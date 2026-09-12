/**
 * ScanOverlay.tsx
 *
 * Reusable scan overlay for both WebCamera and CameraView.
 * Eliminates the 2x duplicated overlay code in ScanScreen.
 *
 * Contains:
 * - Scan area with animated scan line
 * - Corner decorations
 * - Camera controls (flash, scan button, flip)
 * - Auto-scan mode toggle
 * - Gallery button
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
  autoScanEnabled: boolean;
  isCameraReady: boolean;
  cameraError: string | null;

  // Callbacks
  onFlash: () => void;
  onScan: () => void;
  onFlip: () => void;
  onGallery: () => void;
  onManualSearch: () => void;
  onToggleAutoScan: () => void;
  onRetry: () => void;
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
  autoScanEnabled,
  isCameraReady,
  cameraError,
  onFlash,
  onScan,
  onFlip,
  onGallery,
  onManualSearch,
  onToggleAutoScan,
  onRetry,
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
            {autoScanEnabled ? t('scan_frame_auto') : t('scan_frame_manual')}
          </Text>
          {/* Pen Tips row (node Cc84X): three pill chips */}
          <View style={styles.tipsRow} testID="scan-tips-row">
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_number')}</Text></View>
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_glare')}</Text></View>
            <View style={styles.tipChip}><Text style={styles.tipChipText}>{t('scan_tip_flat')}</Text></View>
          </View>
          <View style={styles.controls}>
            {/* Gallery button */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={onGallery}
              activeOpacity={0.7}
            >
              <Text style={styles.controlIcon}>🖼️</Text>
              <Text style={styles.controlLabel}>{t('scan_gallery')}</Text>
            </TouchableOpacity>

            {/* Scan button */}
            <TouchableOpacity
              style={[styles.scanButton, isScanning && styles.scanButtonDisabled]}
              onPress={onScan}
              disabled={isScanning}
              activeOpacity={0.7}
            >
              <View style={styles.scanButtonInner}>
                <Text style={styles.scanButtonIcon}>{isScanning ? '⏳' : '📷'}</Text>
              </View>
              <Text style={styles.scanButtonLabel}>
                {isScanning ? t('scan_recognizing') : autoScanEnabled ? t('scan_manual') : t('scan_scan_action')}
              </Text>
            </TouchableOpacity>

            {/* Flip camera */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={onFlip}
              activeOpacity={0.7}
            >
              <Text style={styles.controlIcon}>🔄</Text>
              <Text style={styles.controlLabel}>{t('scan_flip')}</Text>
            </TouchableOpacity>

            {/* Manual search */}
            <TouchableOpacity
              style={styles.controlBtn}
              onPress={onManualSearch}
              activeOpacity={0.7}
            >
              <Text style={styles.controlIcon}>🔤</Text>
              <Text style={styles.controlLabel}>{t('common_search')}</Text>
            </TouchableOpacity>
          </View>

          {/* Auto-scan toggle — Pen Mode Switch (node Cys7V): segmented
              自動掃描 / 手動 pill. Both segments dispatch the same
              onToggleAutoScan contract; tapping the already-active segment
              is a no-op. */}
          <View style={styles.autoScanToggleContainer}>
            <View style={styles.modeSwitch} testID="scan-mode-switch">
              <TouchableOpacity
                style={[styles.modeSegment, autoScanEnabled && styles.modeSegmentActive]}
                onPress={() => { if (!autoScanEnabled) onToggleAutoScan(); }}
                activeOpacity={0.7}
                accessibilityRole="tab"
                accessibilityState={{ selected: autoScanEnabled }}
                {...{ 'aria-selected': autoScanEnabled }}
                testID="scan-mode-auto"
              >
                <Text style={[styles.modeSegmentText, autoScanEnabled && styles.modeSegmentTextActive]}>
                  {t('scan_auto_mode')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeSegment, !autoScanEnabled && styles.modeSegmentActive]}
                onPress={() => { if (autoScanEnabled) onToggleAutoScan(); }}
                activeOpacity={0.7}
                accessibilityRole="tab"
                accessibilityState={{ selected: !autoScanEnabled }}
                {...{ 'aria-selected': !autoScanEnabled }}
                testID="scan-mode-manual"
              >
                <Text style={[styles.modeSegmentText, !autoScanEnabled && styles.modeSegmentTextActive]}>
                  {t('scan_manual_mode')}
                </Text>
              </TouchableOpacity>
            </View>
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
    marginBottom: 4,
  },
  controlLabel: {
    color: COLORS.textSecondary,
    fontSize: 11,
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
  autoScanToggleContainer: {
    marginTop: 12,
    alignItems: 'center',
  },
  // Pen Mode Switch (node Cys7V): #00000080 pill, active segment #FFFFFF1F.
  modeSwitch: {
    flexDirection: 'row',
    backgroundColor: '#00000080',
    borderRadius: 999,
    padding: 3,
    gap: 2,
  },
  modeSegment: {
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
  },
  modeSegmentActive: {
    backgroundColor: '#FFFFFF1F',
  },
  modeSegmentText: {
    color: '#9A9AB8',
    fontSize: 11.5,
    fontWeight: '500',
  },
  modeSegmentTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
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
