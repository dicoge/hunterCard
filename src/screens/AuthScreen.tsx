import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';

import { COLORS, APP_NAME } from '../constants';
import { useAuthStore } from '../store/authStore';
import {
  isAppleAuthAvailable,
} from '../services/auth';

const PRIVACY_POLICY_URL = 'https://holocard-hunter.vercel.app/privacy';

export default function AuthScreen() {
  const loginWithApple = useAuthStore((s) => s.loginWithApple);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    isAppleAuthAvailable().then(setAppleAvailable);
  }, []);

  const handleApple = async () => {
    setBusy(true);
    try {
      await loginWithApple();
    } catch (err) {
      Alert.alert('登入失敗', '無法完成 Apple 登入，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    setBusy(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      Alert.alert('登入失敗', '無法完成 Google 登入，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{APP_NAME}</Text>
        <Text style={styles.subtitle}>登入以同步收藏與入手提醒</Text>
      </View>

      <View style={styles.buttons}>
        {busy ? (
          <ActivityIndicator color={COLORS.primary} size="large" />
        ) : (
          <>
            {appleAvailable && (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={handleApple}
              />
            )}

            <TouchableOpacity
              style={styles.googleButton}
              onPress={handleGoogle}
            >
              <Text style={styles.googleButtonText}>
                使用 Google 登入
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      <TouchableOpacity onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
        <Text style={styles.privacy}>隱私權政策與資料刪除說明</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  header: {
    alignItems: 'center',
    marginBottom: 48,
  },
  title: {
    color: COLORS.primary,
    fontSize: 40,
    fontWeight: 'bold',
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 15,
    marginTop: 8,
  },
  buttons: {
    gap: 16,
    minHeight: 120,
    justifyContent: 'center',
  },
  appleButton: {
    height: 52,
  },
  googleButton: {
    height: 52,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  googleButtonText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.5,
  },
  privacy: {
    color: COLORS.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 40,
    textDecorationLine: 'underline',
  },
});
