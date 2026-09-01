// Denied-camera-permission UI for the Scan screen (DIC-1286 CR fix).
//
// The DIC-1289 CR flagged that Android permanent camera-permission denial
// had no working recovery: `Linking.openURL('app-settings:')` is iOS-only,
// so the rendered "打開設定 / 設定を開く" button was a no-op on Android after
// the user selected "Don't ask again". This view fixes both halves:
//
//   1. It calls `Linking.openSettings()` (cross-platform, RN >= 0.60) so
//      the same button opens the OS app-settings screen on both platforms.
//      That is the ONLY way for a user with `canAskAgain === false` to
//      re-enable the camera permission, so it must always work.
//   2. It gates the "允許相機權限 / カメラを許可" button on
//      `canAskAgain !== false`. Once Android has flipped canAskAgain to
//      false, `requestPermission` cannot re-open the OS prompt — the
//      button was silently a no-op. Removing it forces the user toward
//      the settings action, which is the only real recovery path.
//
// Extracted from the inline JSX in ScanScreen so the CR-required
// behavioural test (jsdom + react-dom + real Linking mock) can drive it
// without spinning up the whole scan render tree.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';

export interface CameraPermissionShape {
  granted?: boolean;
  /**
   * expo-camera's PermissionResponse.canAskAgain. Once Android returns
   * false, calling `requestPermission()` cannot re-open the OS prompt —
   * the user has to open system settings and toggle the permission on.
   * We treat missing/undefined as `true` (retry-able) so the first render
   * before the permission hook resolves still exposes the request path.
   */
  canAskAgain?: boolean;
}

export interface CameraPermissionDeniedViewProps {
  permission: CameraPermissionShape | null | undefined;
  onRequestPermission: () => void;
  /**
   * Overridable seam so the CR-required jsdom test can assert that the
   * settings button really calls `Linking.openSettings()`. In production
   * the default implementation is invoked and the seam is invisible.
   */
  openSettingsImpl?: () => void | Promise<void>;
}

const DEFAULT_OPEN_SETTINGS = (): void => {
  // Linking.openSettings() is available on both iOS and Android since
  // RN 0.60 and is the RN-idiomatic way to open the app-scoped settings
  // screen. Wrapped in try/catch so a rare native throw does not bubble
  // as an unhandled rejection from an event handler.
  try {
    const maybePromise = Linking.openSettings();
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
      (maybePromise as Promise<void>).catch((err) => {
        console.warn('[CameraPermissionDeniedView] Linking.openSettings rejected', err);
      });
    }
  } catch (err) {
    console.warn('[CameraPermissionDeniedView] Linking.openSettings threw', err);
  }
};

export function CameraPermissionDeniedView({
  permission,
  onRequestPermission,
  openSettingsImpl,
}: CameraPermissionDeniedViewProps): React.ReactElement {
  const { t } = useTranslation();
  const canAskAgain = permission?.canAskAgain !== false;
  const openSettings = openSettingsImpl ?? DEFAULT_OPEN_SETTINGS;
  const bodyKey = canAskAgain
    ? 'scan_permission_native_body'
    : 'scan_permission_native_body_permanent';

  return (
    <View style={styles.container} testID="camera-permission-denied">
      <Text style={styles.icon}>📷</Text>
      <Text style={styles.title}>{t('scan_permission_title')}</Text>
      <Text style={styles.body}>{t(bodyKey)}</Text>
      {canAskAgain ? (
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={onRequestPermission}
          activeOpacity={0.7}
          testID="camera-permission-request"
        >
          <Text style={styles.primaryButtonText}>{t('scan_permission_allow')}</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={canAskAgain ? styles.settingsButton : styles.primaryButton}
        onPress={openSettings}
        activeOpacity={0.7}
        testID="camera-permission-open-settings"
      >
        <Text
          style={canAskAgain ? styles.settingsButtonText : styles.primaryButtonText}
        >
          {t('scan_open_settings')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  icon: {
    fontSize: 64,
    marginBottom: 20,
  },
  title: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  primaryButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 25,
    marginBottom: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  settingsButton: {
    paddingVertical: 12,
    paddingHorizontal: 30,
  },
  settingsButtonText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
});

export default CameraPermissionDeniedView;
