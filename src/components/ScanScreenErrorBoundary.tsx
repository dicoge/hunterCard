// Class-based React error boundary for the ScanScreen subtree (DIC-1286).
//
// The distributed Android APK hard-crashes when the user opens the Scan screen.
// Root cause is native (the crash surfaces before any onMountError JS callback
// is reached, e.g. a synchronous throw from a native module during Fabric
// component mount), so a JS-only fix cannot eliminate the crash origin — but
// it CAN convert an unhandled render-time error into a recoverable fallback
// UI, matching the DIC-1286 delivery gate:
//
//   "add explicit onMountError/error boundary so failures no longer hard-crash"
//   "QA evidence must show opening camera no longer crashes and permission
//    denial produces recoverable UI."
//
// The boundary catches synchronous errors thrown during React rendering,
// commit, and lifecycle callbacks of every descendant of ScanScreen — most
// importantly the CameraView native host component, permission hooks that
// throw when the native module is missing, and any downstream import that
// resolves to a broken module. It cannot catch native (C++/Kotlin) crashes
// that bypass JS, async rejections outside a component, or event handlers.
//
// Fallback UX gives the user a way OUT of the failed screen (retry + return
// home) instead of an app-wide crash, so a scan-only failure never turns the
// entire APK into a black screen.

import React, { Component, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { COLORS } from '../constants';
import { t as translate } from '../i18n';
import { useSettingsStore } from '../store/settingsStore';

export interface ScanScreenErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional test seam. When provided, invoked with the raw error so tests
   * can assert the boundary caught it. Never used in production render.
   */
  onError?: (error: Error) => void;
  /**
   * Optional navigation hook so the "return home" affordance can dispatch
   * back to the drawer's Home route. When absent the button is hidden.
   */
  onGoHome?: () => void;
}

interface ScanScreenErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ScanScreenErrorBoundary extends Component<
  ScanScreenErrorBoundaryProps,
  ScanScreenErrorBoundaryState
> {
  constructor(props: ScanScreenErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ScanScreenErrorBoundaryState {
    return { hasError: true, message: error?.message || 'unknown scan error' };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (this.props.onError) this.props.onError(error);
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[ScanScreenErrorBoundary] caught render error:', error, info?.componentStack);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <ScanScreenErrorFallback message={this.state.message} onRetry={this.handleRetry} onGoHome={this.props.onGoHome} />;
  }
}

interface ScanScreenErrorFallbackProps {
  message: string;
  onRetry: () => void;
  onGoHome?: () => void;
}

function ScanScreenErrorFallback({ message, onRetry, onGoHome }: ScanScreenErrorFallbackProps) {
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const lang = preferredLanguage === 'ja' ? 'ja' : 'zh';
  const title = translate('scan_error_boundary_title', lang);
  const body = translate('scan_error_boundary_body', lang);
  const retry = translate('scan_error_boundary_retry', lang);
  const home = translate('scan_error_boundary_home', lang);
  const detailsPrefix = translate('scan_error_boundary_details', lang);

  return (
    <View style={styles.container} testID="scan-error-boundary-fallback">
      <Text style={styles.icon}>⚠️</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {message ? (
        <Text style={styles.details} numberOfLines={3}>
          {detailsPrefix}
          {message}
        </Text>
      ) : null}
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={onRetry}
        activeOpacity={0.7}
        testID="scan-error-boundary-retry"
      >
        <Text style={styles.primaryButtonText}>{retry}</Text>
      </TouchableOpacity>
      {onGoHome ? (
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={onGoHome}
          activeOpacity={0.7}
          testID="scan-error-boundary-home"
        >
          <Text style={styles.secondaryButtonText}>{home}</Text>
        </TouchableOpacity>
      ) : null}
      {Platform.OS === 'android' ? (
        <Text style={styles.platformNote} testID="scan-error-boundary-platform-note">
          Android
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    backgroundColor: COLORS.background,
  },
  icon: {
    fontSize: 56,
    marginBottom: 16,
  },
  title: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 18,
  },
  details: {
    color: COLORS.textSecondary,
    fontSize: 12,
    opacity: 0.7,
    textAlign: 'center',
    marginBottom: 20,
  },
  primaryButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 24,
    marginBottom: 10,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  secondaryButtonText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  platformNote: {
    marginTop: 24,
    fontSize: 10,
    color: COLORS.textSecondary,
    opacity: 0.5,
  },
});

export default ScanScreenErrorBoundary;
