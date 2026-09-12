import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Platform,
} from 'react-native';
import { COLORS, APP_NAME } from '../constants';
import { FEATURES, STORE_MVP } from '../config/releaseFlags';
import { useAuthStore } from '../store/authStore';
import { APPLE_LOGIN_ENABLED } from '../services/authService';
import { useTranslation } from '../i18n';
import { AppStatusBar } from '../components/shell';
import { PALETTE, SEMANTIC, FONTS, GRADIENTS } from '../theme/tokensV2';

/**
 * DIC-1409 Phase 6 — Pen `App / 16 登入` (frame p28zL). Full-bleed auth flow
 * on the v2 tokens: status bar only (no tab bar in the Pen frame), gradient
 * logo tile (node FTEuu, 104×104 r26), brand label on $accent-2 (node c9cMr),
 * white Google button (node ilZGG, r14), dark Apple button (node TU4oT),
 * divider (node y24cJ), guest link on $accent-2 (node qfrcy), terms footer
 * (node d7fA7X). All auth-store actions, the Store-MVP description swap, and
 * the APPLE_LOGIN_ENABLED gate are unchanged.
 */
export default function LoginScreen() {
  const { t } = useTranslation();
  const {
    loginWithGoogle,
    loginWithApple,
    continueAsGuest,
    isLoading,
    error,
    clearError,
  } = useAuthStore();

  const handleGoogleLogin = useCallback(async () => {
    try {
      await loginWithGoogle();
    } catch {}
  }, [loginWithGoogle]);

  const handleAppleLogin = useCallback(async () => {
    try {
      await loginWithApple();
    } catch {}
  }, [loginWithApple]);

  return (
    <SafeAreaView style={styles.container} testID="login-shell">
      <AppStatusBar />
      <View style={styles.glow} pointerEvents="none" />
      <View style={styles.content}>
        <View style={styles.brand}>
          <View style={styles.logoTile} testID="login-logo-tile">
            <View style={styles.logoInner} />
          </View>
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.welcome}>{t('login_welcome')}</Text>
          <Text style={styles.tagline}>{t('login_tagline')}</Text>
        </View>

        <View style={styles.card}>
          {/* Store MVP: don't promise favorites / price trend / cross-device
              alerts on the login screen (DIC-1256). */}
          <Text style={styles.description}>
            {t(STORE_MVP ? 'login_description_store' : 'login_description')}
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
            style={[styles.googleButton, isLoading && styles.buttonDisabled]}
            onPress={handleGoogleLogin}
            disabled={isLoading}
            activeOpacity={0.8}
            testID="login-google"
          >
            {isLoading ? (
              <ActivityIndicator color={PALETTE.appBg} size="small" />
            ) : (
              <>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.googleButtonText}>{t('settings_google_login')}</Text>
              </>
            )}
          </TouchableOpacity>

          {APPLE_LOGIN_ENABLED && (
          <TouchableOpacity
            style={[styles.appleButton, isLoading && styles.buttonDisabled]}
            onPress={handleAppleLogin}
            disabled={isLoading}
            activeOpacity={0.8}
            testID="login-apple"
          >
            <Text style={styles.appleIcon}></Text>
            <Text style={styles.buttonText}>{t('settings_apple_login')}</Text>
          </TouchableOpacity>
          )}

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('login_or')}</Text>
            <View style={styles.dividerLine} />
          </View>

          <TouchableOpacity
            style={styles.guestButton}
            onPress={continueAsGuest}
            activeOpacity={0.8}
            testID="login-guest"
          >
            <Text style={styles.guestButtonText}>{t('login_guest_button')} ›</Text>
          </TouchableOpacity>

          <Text style={styles.guestHint}>{t('login_guest_hint')}</Text>
        </View>

        <Text style={styles.footer}>{t('login_terms_footer')}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.appBg,
  },
  // Pen radial glow (node wPWUr) — soft $accent-3 wash behind the logo.
  glow: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    width: 270,
    height: 270,
    borderRadius: 999,
    backgroundColor: PALETTE.accent3 + '1F',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  brand: {
    alignItems: 'center',
    marginBottom: 28,
  },
  // Pen logo tile (node FTEuu): gradient square r26 with glyph.
  logoTile: {
    width: 104,
    height: 104,
    borderRadius: 26,
    backgroundColor: GRADIENTS.brandPinkPurple.colors[0],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    shadowColor: PALETTE.accent,
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  logoInner: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    opacity: 0.92,
  },
  // Pen brand label (node c9cMr): 14/700 on $accent-2.
  appName: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    color: PALETTE.accent2,
    marginBottom: 6,
  },
  // Pen headline (node tumk0): 26/700 $text-primary.
  welcome: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 26,
    fontWeight: '700',
    color: SEMANTIC.onBg,
    marginBottom: 8,
  },
  tagline: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 13,
    color: SEMANTIC.onBgMuted,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  description: {
    fontSize: 13,
    color: SEMANTIC.onBgMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
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
  // Pen Google button (node ilZGG): white fill, r14, dark 14/700 label.
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    width: '100%',
    gap: 10,
    marginBottom: 12,
  },
  // Pen Apple button (node TU4oT): #101018 fill, r14.
  appleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101018',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    width: '100%',
    gap: 10,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  googleIcon: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#FFFFFF',
    backgroundColor: PALETTE.accent3,
    width: 22,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    borderRadius: 11,
    overflow: 'hidden',
  },
  appleIcon: {
    fontSize: 20,
    color: '#fff',
    lineHeight: 24,
  },
  googleButtonText: {
    color: PALETTE.appBg,
    fontSize: 14,
    fontWeight: '700',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
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
    backgroundColor: PALETTE.border,
  },
  dividerText: {
    color: SEMANTIC.onBgDim,
    fontSize: 11,
    marginHorizontal: 12,
  },
  // Pen guest link (node qfrcy): $accent-2 text action, no boxed border.
  guestButton: {
    paddingVertical: 8,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  guestButtonText: {
    color: PALETTE.accent2,
    fontSize: 13,
    fontWeight: '600',
  },
  guestHint: {
    color: SEMANTIC.onBgDim,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    opacity: 0.9,
  },
  // Pen terms footer (node d7fA7X): 10.5 $text-muted.
  footer: {
    color: SEMANTIC.onBgDim,
    fontSize: 10.5,
    marginTop: 24,
    textAlign: 'center',
  },
});
