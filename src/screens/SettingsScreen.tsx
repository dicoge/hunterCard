import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView } from 'react-native';
import { COLORS, APP_NAME, APP_VERSION, CURRENCIES } from '../constants';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { showAlert } from '../utils/platformAlert';

const PROVIDER_LABEL: Record<string, string> = { apple: 'Apple', google: 'Google' };

export default function SettingsScreen() {
  const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.logout);
  const deleteAccount = useAuthStore((s) => s.deleteUserAccount);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const loginWithApple = useAuthStore((s) => s.loginWithApple);
  const isLoading = useAuthStore((s) => s.isLoading);

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle();
    } catch (err: any) {
      const raw = String(err?.message ?? '');
      const friendly = /client id|not configured|尚未設定/i.test(raw)
        ? '目前無法使用 Google 登入（登入服務尚未設定），請稍後再試。'
        : '無法完成 Google 登入，請稍後再試。';
      showAlert('登入失敗', friendly);
    }
  };

  const handleAppleLogin = async () => {
    try {
      await loginWithApple();
    } catch (err: any) {
      // authService throws an explanatory message when web Apple login is not
      // yet available (needs server-side token verification) — surface it.
      showAlert('Apple 登入', String(err?.message ?? '無法完成 Apple 登入，請稍後再試。'));
    }
  };

  const confirmSignOut = () => {
    showAlert('登出', '確定要登出嗎？', [
      { text: '取消', style: 'cancel' },
      { text: '登出', style: 'destructive', onPress: signOut },
    ]);
  };

  const confirmDelete = () => {
    showAlert(
      '刪除帳號',
      '這會永久刪除你的帳號與同步資料，且無法復原。確定要刪除嗎？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '刪除帳號',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
              showAlert('帳號已刪除', '你的帳號與 Apple 授權已撤銷。');
            } catch {
              showAlert(
                '刪除尚未完成',
                '目前無法確認伺服器端已撤銷 Apple 授權，帳號並未刪除，你仍為登入狀態。請稍後再試或聯絡我們。'
              );
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView style={styles.container}>
        <Text style={styles.title}>{APP_NAME}</Text>
        <Text style={styles.version}>版本 {APP_VERSION}</Text>

        {/* ── 語言設定 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🌐 顯示語言</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionBtn, preferredLanguage === 'zh' && styles.optionBtnActive]}
              onPress={() => setLanguage('zh')}
            >
              <Text style={[styles.optionText, preferredLanguage === 'zh' && styles.optionTextActive]}>
                中文
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionBtn, preferredLanguage === 'ja' && styles.optionBtnActive]}
              onPress={() => setLanguage('ja')}
            >
              <Text style={[styles.optionText, preferredLanguage === 'ja' && styles.optionTextActive]}>
                日本語
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {preferredLanguage === 'zh'
              ? '卡牌名稱將顯示中文翻譯（如：セシリア → 塞西莉亞·伊瑪格林）'
              : 'カード名は日本語で表示されます'}
          </Text>
        </View>

        {/* ── 幣別設定 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>💰 顯示幣別</Text>
          <View style={styles.optionRow}>
            {CURRENCIES.map((cur) => (
              <TouchableOpacity
                key={cur.code}
                style={[styles.optionBtn, preferredCurrency === cur.code && styles.optionBtnActive]}
                onPress={() => setCurrency(cur.code as CurrencyCode)}
              >
                <Text style={[styles.optionText, preferredCurrency === cur.code && styles.optionTextActive]}>
                  {cur.symbol} {cur.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>
            {preferredCurrency === 'TWD' && '價格以新台幣顯示（¥100 ≈ NT$22）'}
            {preferredCurrency === 'JPY' && '價格以日圓原價顯示'}
            {preferredCurrency === 'USD' && '價格以美元顯示（¥100 ≈ $0.67）'}
          </Text>
        </View>

        {/* ── 價格來源資訊 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 價格來源</Text>
          <Text style={styles.item}>🏪 遊々亭（日本二手卡牌市場）</Text>
          <Text style={styles.item}>🔄 Carousell（旋轉拍賣）</Text>
          <Text style={styles.item}>📈 匯率：JP¥1 = NT$0.22 = $0.0067</Text>
        </View>

        {/* ── 帳號 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>👤 帳號</Text>
          {isAuthenticated && user ? (
            <>
              <Text style={styles.item}>
                以 {PROVIDER_LABEL[user.linkedProviders?.[0]?.provider ?? ''] ?? ''} 登入
              </Text>
              {!!(user.displayName || user.primaryEmail) && (
                <Text style={styles.item}>
                  {user.displayName ?? user.primaryEmail}
                </Text>
              )}
              <TouchableOpacity style={styles.accountBtn} onPress={confirmSignOut}>
                <Text style={styles.accountBtnText}>登出</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.accountBtn, styles.dangerBtn]}
                onPress={confirmDelete}
              >
                <Text style={[styles.accountBtnText, styles.dangerText]}>刪除帳號</Text>
              </TouchableOpacity>
              <Text style={styles.hint}>
                註：帳號刪除的伺服器端撤銷仍在建置中，尚未上線。若後端尚未設定，
                刪除會顯示「尚未完成」並維持登入狀態，不會誤示為已刪除。
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.hint}>尚未登入。登入後可跨裝置同步收藏與入手提醒。</Text>
              <TouchableOpacity
                style={[styles.googleBtn, isLoading && styles.btnDisabled]}
                onPress={handleGoogleLogin}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.googleBtnText}>使用 Google 帳號登入</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.appleBtn, isLoading && styles.btnDisabled]}
                onPress={handleAppleLogin}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.appleBtnText}>使用 Apple 帳號登入</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        <Text style={styles.footer}>專為 hololive PCG 玩家打造</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    padding: 20,
  },
  title: {
    color: COLORS.primary,
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 4,
    marginTop: 20,
  },
  version: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 30,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  optionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  optionBtn: {
    flex: 1,
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionBtnActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '18',
  },
  optionText: {
    color: COLORS.textSecondary,
    fontSize: 16,
    fontWeight: '600',
  },
  optionTextActive: {
    color: COLORS.primary,
  },
  hint: {
    color: COLORS.textSecondary + 'cc',
    fontSize: 12,
    paddingLeft: 4,
    marginTop: 4,
  },
  item: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 8,
    paddingLeft: 8,
  },
  accountBtn: {
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  accountBtnText: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  dangerBtn: {
    borderColor: COLORS.error,
    backgroundColor: COLORS.error + '18',
  },
  googleBtn: {
    backgroundColor: '#4285F4',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  googleBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  appleBtn: {
    backgroundColor: '#000',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  appleBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  dangerText: {
    color: COLORS.error,
  },
  footer: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 20,
  },
  accountInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  avatarText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
  },
  accountDetails: {
    flex: 1,
  },
  accountName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  accountEmail: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  logoutButton: {
    backgroundColor: COLORS.error + '22',
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: {
    color: COLORS.error,
    fontSize: 16,
    fontWeight: '600',
  },
});