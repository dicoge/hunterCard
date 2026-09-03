/**
 * ScanOverlay.tsx
 *
 * Reusable scan overlay for both WebCamera and CameraView.
 * Eliminates the 2x duplicated overlay code in ScanScreen.
 *
 * Contains:
 * - Scan area with animated scan line
 * - Corner decorations
 * - The primary scan action, plus a torch toggle for framing in low light
 *
 * DIC-1319: the normal flow is deliberately one action. Gallery import, camera
 * flip, manual search and the auto-scan mode toggle used to sit under the
 * viewfinder and were what the v21 tester read as "many unnecessary buttons".
 * None of them were the primary path, and the auto-scan toggle was inert on
 * Android to begin with (the auto-scan loop is web-only). They are gone from
 * here; manual search stays reachable from the scan-failure and low-confidence
 * recovery panels, and gallery import stays on the permission-denied and
 * web-camera-unavailable fallbacks in ScanScreen — so removing them does not
 * weaken permission or error recovery.
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
import { useTranslation } from '../i18n';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SCAN_AREA_SIZE = SCREEN_WIDTH * 0.75;

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
  onScanAreaLayout?: (event: LayoutChangeEvent) => void;
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
  onScanAreaLayout,
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
        <View style={styles.overlayTop} />
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
                        outputRange: [0, SCAN_AREA_SIZE - 4],
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
          <View style={styles.controls} testID="scan-primary-controls">
            {/* Torch — a framing aid for the card in hand, not a second flow.
                Icon-only so the primary action stays the one labelled control. */}
            <TouchableOpacity
              style={[styles.controlBtn, flash && styles.controlBtnActive]}
              onPress={onFlash}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={flash ? t('scan_flash_on') : t('scan_flash')}
              testID="scan-flash-toggle"
            >
              <Text style={styles.controlIcon}>{flash ? '🔦' : '💡'}</Text>
            </TouchableOpacity>

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

            {/* Spacer keeps the scan button optically centred against the
                torch control on the other side. */}
            <View style={styles.controlBtnSpacer} />
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
  overlay: {
    flex: 1,
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
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE * 0.63,
    position: 'relative',
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 8,
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
    height: SCAN_AREA_SIZE * 0.63,
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
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: COLORS.primary,
  },
  topLeft: {
    top: -1,
    left: -1,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 8,
  },
  topRight: {
    top: -1,
    right: -1,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 8,
  },
  bottomLeft: {
    bottom: -1,
    left: -1,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 8,
  },
  bottomRight: {
    bottom: -1,
    right: -1,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 8,
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
  hintText: {
    color: COLORS.text,
    fontSize: 16,
    marginBottom: 20,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 12,
  },
  controlBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
    padding: 8,
  },
  controlBtnActive: {
    opacity: 1,
  },
  controlBtnSpacer: {
    width: 48,
    height: 48,
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
  scanButtonInner: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#fff',
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
