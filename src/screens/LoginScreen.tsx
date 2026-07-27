import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
  Image,
} from 'react-native';
import { COLORS, APP_NAME } from '../constants';
import { useAuthStore } from '../store/authStore';

export default function LoginScreen() {
  const { login, isLoading, error, clearError } = useAuthStore();

  const handleLogin = useCallback(async () => {
    try {
      await login();
    } catch {
      // Error stored in authStore.error
    }
  }, [login]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.brand}>
          <Text style={styles.appName}>{APP_NAME}</Text>
          <Text style={styles.tagline}>hololive TCG 卡牌查價 App</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.welcome}>歡迎使用 HoloHunter Web</Text>
          <Text style={styles.description}>
            使用 Google 帳號快速登入，開始追蹤你的卡牌收藏與價格
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
            style={[styles.googleButton, isLoading && styles.googleButtonDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.googleButtonText}>使用 Google 帳號登入</Text>
              </>
            )}
          </TouchableOpacity>
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
    marginBottom: 48,
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
    padding: 32,
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
    marginBottom: 12,
  },
  description: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  errorBox: {
    backgroundColor: COLORS.error + '22',
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
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
  },
  googleButtonDisabled: {
    opacity: 0.7,
  },
  googleIcon: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#4285F4',
    backgroundColor: '#fff',
    width: 32,
    height: 32,
    lineHeight: 32,
    textAlign: 'center',
    borderRadius: 16,
    overflow: 'hidden',
  },
  googleButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 32,
  },
});
