import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { COLORS, APP_NAME } from '../constants';
import { useAuthStore } from '../store/authStore';
import { showAlert } from '../utils/platformAlert';
import {
  GOOGLE_LOGIN_CONFIGURED,
  APPLE_LOGIN_ENABLED,
  APPLE_COMING_SOON_LABEL,
  APPLE_COMING_SOON_MESSAGE,
} from '../services/authService';

// __DEV__ is a React Native global; declare it so this compiles under plain tsc.
declare const __DEV__: boolean;

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

export default function LoginScreen() {
  const {
    loginWithGoogle,
    loginWithApple,
    continueAsGuest,
    isLoading,
    error,
    clearError,
  } = useAuthStore();

  // Keep the button tappable in dev even without env so the raw "Missing client
  // ID" message still surfaces for debugging; in production a missing client id
  // means the button is disabled with a friendly note instead (DIC-824).
  const googleTappable = GOOGLE_LOGIN_CONFIGURED || IS_DEV;

  const handleGoogleLogin = useCallback(async () => {
    if (!googleTappable) return;
    try {
      await loginWithGoogle();
    } catch {}
  }, [googleTappable, loginWithGoogle]);

  const handleAppleLogin = useCallback(async () => {
    try {
      await loginWithApple();
    } catch (err: any) {
      showAlert('Apple 登入', String(err?.message ?? '無法完成 Apple 登入，請稍後再試。'));
    }
  }, [loginWithApple]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.tagline}>hololive TCG 卡牌查價 App</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.welcome}>歡迎使用 HoloHunter</Text>
          <Text style={styles.description}>
            登入後可追蹤卡牌收藏、掃描卡牌、查看價格趨勢
          </Text>

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity onPress={clearError}>
                <Text style={styles.errorDismiss}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={[styles.googleButton, (isLoading || !googleTappable) && styles.buttonDisabled]}
            onPress={handleGoogleLogin}
            disabled={isLoading || !googleTappable}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.buttonText}>使用 Google 帳號登入</Text>
              </>
            )}
          </TouchableOpacity>

          {!GOOGLE_LOGIN_CONFIGURED && (
            <Text style={styles.providerNote}>
              Google 登入尚未開放，請稍後再試。
            </Text>
          )}

          {APPLE_LOGIN_ENABLED ? (
          <TouchableOpacity
            style={[styles.appleButton, isLoading && styles.buttonDisabled]}
            onPress={handleAppleLogin}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            <Text style={styles.appleIcon}></Text>
            <Text style={styles.buttonText}>使用 Apple 帳號登入</Text>
          </TouchableOpacity>
          ) : (
            <View
              style={[styles.appleButton, styles.appleButtonDisabled]}
              accessibilityRole="button"
              accessibilityState={{ disabled: true }}
            >
              <Text style={styles.appleIcon}>{''}</Text>
              <Text style={styles.buttonText}>使用 Apple 帳號登入</Text>
              <View style={styles.comingSoonPill}>
                <Text style={styles.comingSoonPillText}>{APPLE_COMING_SOON_LABEL}</Text>
              </View>
            </View>
          )}

          {!APPLE_LOGIN_ENABLED && (
            <Text style={styles.providerNote}>{APPLE_COMING_SOON_MESSAGE}</Text>
          )}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>或</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={styles.guestButton}
            onPress={continueAsGuest}
            activeOpacity={0.8}
          >
            <Text style={styles.guestButtonText}>以訪客身份進入</Text>
          </TouchableOpacity>

          <Text style={styles.guestHint}>
            訪客可瀏覽規則與查詢卡片，但無法使用掃描功能
          </Text>
        </View>

        <Text style={styles.footer}>
          登入即表示同意隱私權政策與服務條款
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  brand: {
    alignItems: 'center',
    marginBottom: 40,
  },
  appName: {
    fontSize: 48,
    fontWeight: 'bold',
    color: COLORS.primary,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 16,
    color: COLORS.textSecondary,
  },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 28,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  welcome: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.text,
    marginBottom: 10,
  },
  description: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  errorBox: {
    backgroundColor: COLORS.error + '22',
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  errorText: {
    color: COLORS.error,
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  errorDismiss: {
    color: COLORS.error,
    fontSize: 16,
    fontWeight: 'bold',
    paddingLeft: 12,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4285F4',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 24,
    width: '100%',
    gap: 12,
    marginBottom: 12,
  },
  appleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 24,
    width: '100%',
    gap: 12,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  appleButtonDisabled: {
    opacity: 0.45,
    marginBottom: 4,
  },
  providerNote: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    width: '100%',
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 18,
  },
  comingSoonPill: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 4,
  },
  comingSoonPillText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  googleIcon: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#4285F4',
    backgroundColor: '#fff',
    width: 30,
    height: 30,
    lineHeight: 30,
    textAlign: 'center',
    borderRadius: 15,
    overflow: 'hidden',
  },
  appleIcon: {
    fontSize: 22,
    color: '#fff',
    lineHeight: 30,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginVertical: 16,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dividerText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginHorizontal: 12,
  },
  guestButton: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 24,
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  guestButtonText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  guestHint: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
    opacity: 0.8,
  },
  footer: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 24,
  },
});
