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

      {/* Overlay with scan area */}
      <View style={styles.overlay}>
        <View style={styles.overlayTop} />
        <View style={styles.scanAreaContainer}>
          <View style={styles.overlaySide} />
          <Animated.View
            style={[
              styles.scanArea,
              {
                transform: [{ scale: pulseAnim }],
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
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom}>
          <Text style={styles.hintText}>
            {autoScanEnabled ? t('scan_frame_auto') : t('scan_frame_manual')}
          </Text>
          <View style={styles.controls}>
            {/* Flash toggle */}
            <TouchableOpacity
              style={[styles.controlBtn, flash && styles.controlBtnActive]}
              onPress={onFlash}
              activeOpacity={0.7}
            >
              <Text style={styles.controlIcon}>{flash ? '🔦' : '💡'}</Text>
              <Text style={styles.controlLabel}>{flash ? t('scan_flash_on') : t('scan_flash')}</Text>
            </TouchableOpacity>

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

          {/* Auto-scan toggle */}
          <View style={styles.autoScanToggleContainer}>
            <TouchableOpacity
              style={[
                styles.autoScanToggle,
                autoScanEnabled && styles.autoScanToggleActive,
              ]}
              onPress={onToggleAutoScan}
              activeOpacity={0.7}
            >
              <Text style={[styles.autoScanToggleText, autoScanEnabled && styles.autoScanToggleTextActive]}>
                {autoScanEnabled ? t('scan_auto_mode') : t('scan_manual_mode')}
              </Text>
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
    padding: 8,
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
  autoScanToggleContainer: {
    marginTop: 12,
    alignItems: 'center',
  },
  autoScanToggle: {
    paddingHorizontal: 20,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  autoScanToggleActive: {
    backgroundColor: 'rgba(255, 107, 157, 0.2)',
    borderColor: COLORS.primary,
  },
  autoScanToggleText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  autoScanToggleTextActive: {
    color: COLORS.primary,
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
