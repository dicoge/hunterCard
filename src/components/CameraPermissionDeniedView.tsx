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

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Linking,
  AppState,
  type AppStateStatus,
} from 'react-native';
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

/**
 * Subscription seam for AppState 'change' events. Default in production
 * wraps React Native's AppState. Tests replace it with a manual trigger
 * so lifecycle assertions do not depend on the platform bridge.
 *
 * Contract: call `onActive` ONLY when the app transitions FROM a non-
 * `active` state TO `active`. Return an unsubscribe function that MUST
 * remove the underlying listener (so unmount is safe).
 */
export type SubscribeAppActive = (onActive: () => void) => () => void;

export interface CameraPermissionDeniedViewProps {
  permission: CameraPermissionShape | null | undefined;
  onRequestPermission: () => void;
  /**
   * Overridable seam so the CR-required jsdom test can assert that the
   * settings button really calls `Linking.openSettings()`. In production
   * the default implementation is invoked and the seam is invisible.
   */
  openSettingsImpl?: () => void | Promise<void>;
  /**
   * DIC-1301 CR fix: when the user has opened system settings (or the
   * app was backgrounded for any reason) and returns to us, this getter
   * is called to re-query the current OS permission WITHOUT prompting.
   * Wired to expo-camera's useCameraPermissions() silent getter in
   * ScanScreen; when present, the underlying permission-state hook
   * refreshes and the parent re-renders — the denied view then unmounts
   * on its own once permission is granted. When absent, no AppState
   * listener is attached (this preserves the pre-DIC-1301 render tree
   * for tests that do not care about the refresh path).
   */
  refreshPermission?: () => Promise<unknown> | unknown;
  /**
   * Optional AppState subscription seam. Tests inject a manual trigger.
   */
  subscribeAppActive?: SubscribeAppActive;
}

/**
 * AppState-like shape needed by the default subscribe factory. Exported
 * for tests that need to inject a fake bridge.
 */
export interface AppStateLike {
  currentState: AppStateStatus;
  addEventListener: (
    event: 'change',
    handler: (state: AppStateStatus) => void,
  ) => { remove: () => void };
}

/**
 * Factory for the default AppState-active subscribe. Fires `onActive`
 * ONLY when the app transitions FROM a non-`active` state TO `active`.
 * Guards against duplicate fires when RN emits `active` twice in a row
 * (e.g. already-active seed events on mount).
 *
 * Exported so scripts/test-scan-screen-fail-safe.mjs can drive the exact
 * production guard logic against a fake AppState — a mutation that
 * removes the transition guard (fires on every 'change') is then caught
 * by an assertion on the real implementation, not on an inline copy.
 */
export function createDefaultAppActiveSubscribe(
  appState: AppStateLike = AppState as AppStateLike,
): SubscribeAppActive {
  return (onActive) => {
    let last: AppStateStatus = appState.currentState;
    const sub = appState.addEventListener('change', (next) => {
      const prev = last;
      last = next;
      if (next === 'active' && prev !== 'active') {
        onActive();
      }
    });
    return () => sub.remove();
  };
}

const DEFAULT_SUBSCRIBE_APP_ACTIVE: SubscribeAppActive = createDefaultAppActiveSubscribe();

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
  refreshPermission,
  subscribeAppActive,
}: CameraPermissionDeniedViewProps): React.ReactElement {
  const { t } = useTranslation();
  const canAskAgain = permission?.canAskAgain !== false;
  const openSettings = openSettingsImpl ?? DEFAULT_OPEN_SETTINGS;
  const bodyKey = canAskAgain
    ? 'scan_permission_native_body'
    : 'scan_permission_native_body_permanent';

  // DIC-1301 fix: when refreshPermission is wired in, subscribe to
  // AppState 'active' transitions and re-query the OS permission silently.
  // If the user granted CAMERA in system settings and returns, expo-camera's
  // internal permission-state hook flips to granted → ScanScreen re-renders
  // → this component unmounts (cleanup below removes the listener).
  //
  // Guardrails to prevent regressions:
  //  • DEFAULT_SUBSCRIBE_APP_ACTIVE only calls onActive on transitions
  //    INTO 'active' — a duplicate 'active' event is a no-op, so no
  //    request storm.
  //  • The subscription is captured by ref so the cleanup fn matches
  //    the exact `unsubscribe` returned by `subscribeAppActive(...)` —
  //    no ghost listener survives unmount.
  //  • `refreshPermission()` is a silent getter (no OS prompt). It cannot
  //    cause a duplicate permission dialog even if fired repeatedly.
  //  • The effect depends ONLY on the stable refresh/subscribe references,
  //    so it does NOT re-subscribe on every render.
  const refreshRef = useRef(refreshPermission);
  refreshRef.current = refreshPermission;
  useEffect(() => {
    if (!refreshPermission) return undefined;
    const subscribe = subscribeAppActive ?? DEFAULT_SUBSCRIBE_APP_ACTIVE;
    const onActive = () => {
      const impl = refreshRef.current;
      if (!impl) return;
      try {
        const maybe = impl();
        if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
          (maybe as Promise<unknown>).catch((err) => {
            console.warn('[CameraPermissionDeniedView] refreshPermission rejected', err);
          });
        }
      } catch (err) {
        console.warn('[CameraPermissionDeniedView] refreshPermission threw', err);
      }
    };
    const unsubscribe = subscribe(onActive);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeAppActive, !!refreshPermission]);

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
