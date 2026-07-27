import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView, Alert, Linking, Platform } from 'react-native';
import { COLORS, APP_NAME, APP_VERSION, CURRENCIES } from '../constants';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';

export default function SettingsScreen() {
  const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
  const { isLoggedIn, user, loginWithGoogle, loginWithApple, logout, deleteAccount } = useAuthStore();

  const handleOpenPrivacy = () => {
    Linking.openURL('https://card-hunter-mu.vercel.app/privacy');
  };

  const handleOpenSupport = () => {
    Linking.openURL('https://card-hunter-mu.vercel.app/support');
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      preferredLanguage === 'zh' ? '⚠ 確定刪除帳號與資料？' : '⚠ Delete Account and Data?',
      preferredLanguage === 'zh' 
        ? '此動作將永久刪除您的帳號以及所有同步的收藏、追蹤清單與偏好設定。此動作無法復原！' 
        : 'This will permanently delete your account, synced watchlists, favorites, and settings. This action is irreversible!',
      [
        {
          text: preferredLanguage === 'zh' ? '取消' : 'Cancel',
          style: 'cancel',
        },
        {
          text: preferredLanguage === 'zh' ? '確認刪除' : 'Confirm Delete',
          style: 'destructive',
          onPress: () => {
            deleteAccount();
            Alert.alert(
              preferredLanguage === 'zh' ? '帳號已刪除' : 'Account Deleted',
              preferredLanguage === 'zh' ? '您的帳號及所有相關資料已成功清除。' : 'Your account and data have been successfully removed.'
            );
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

        {/* ── 帳號登入與管理 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>👤 帳號設定</Text>
          
          {!isLoggedIn ? (
            <View style={styles.authContainer}>
              <Text style={styles.authDesc}>
                {preferredLanguage === 'zh' 
                  ? '登入以同步您的卡牌收藏、追蹤清單與個人設定。' 
                  : 'Sign in to sync your favorites, watchlists, and settings.'}
              </Text>
              
              <TouchableOpacity style={styles.loginBtnGoogle} onPress={loginWithGoogle}>
                <Text style={styles.loginBtnTextGoogle}>Sign in with Google</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.loginBtnApple} onPress={loginWithApple}>
                <Text style={styles.loginBtnTextApple}> Sign in with Apple</Text>
              </TouchableOpacity>

              <Text style={styles.authPrivacyNote}>
                {preferredLanguage === 'zh'
                  ? '※ 本 App 僅支援 Google/Apple 登入，不提供且不收集自家密碼，確保您的密碼安全性。'
                  : '* We only support Google/Apple sign-in. We do not store or collect passwords to ensure security.'}
              </Text>
            </View>
          ) : (
            <View style={styles.sessionContainer}>
              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '目前登入' : 'Logged in via'}</Text>
                <Text style={styles.userValue}>
                  {user?.provider === 'google' ? '🟢 Google' : '⚫ Apple'}
                </Text>
              </View>
              
              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '使用者名稱' : 'Name'}</Text>
                <Text style={styles.userValue}>{user?.displayName}</Text>
              </View>
              
              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '電子郵件' : 'Email'}</Text>
                <Text style={styles.userValue}>{user?.email}</Text>
              </View>

              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>User ID</Text>
                <Text style={styles.userIdValue} numberOfLines={1} ellipsizeMode="middle">
                  {user?.providerId}
                </Text>
              </View>

              <View style={styles.authActionRow}>
                <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
                  <Text style={styles.logoutBtnText}>
                    {preferredLanguage === 'zh' ? '登出' : 'Sign Out'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.deleteBtn} onPress={handleDeleteAccount}>
                  <Text style={styles.deleteBtnText}>
                    {preferredLanguage === 'zh' ? '刪除帳號與資料' : 'Delete Account'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

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
            {preferredCurrency === 'TWD' && '價格以新台幣顯示（¥100 ≈ NT$0.22）'}
            {preferredCurrency === 'JPY' && '價格以日圓原價顯示'}
            {preferredCurrency === 'USD' && '價格以美元顯示（¥100 ≈ $0.0067）'}
          </Text>
        </View>

        {/* ── 價格來源資訊 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 價格來源</Text>
          <Text style={styles.item}>🏪 遊々亭（日本二手卡牌市場）</Text>
          <Text style={styles.item}>🔄 Carousell（旋轉拍賣）</Text>
          <Text style={styles.item}>📈 匯率：JP¥1 = NT$0.22 = $0.0067</Text>
        </View>

        {/* ── 條款與支援 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📄 條款與政策</Text>
          <TouchableOpacity style={styles.policyRow} onPress={handleOpenPrivacy}>
            <Text style={styles.policyLink}>🔒 隱私權政策 (Privacy Policy)</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.policyRow} onPress={handleOpenSupport}>
            <Text style={styles.policyLink}>🛠️ 技術支援與常見問題 (Support & FAQ)</Text>
          </TouchableOpacity>
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
  authContainer: {
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  authDesc: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  loginBtnGoogle: {
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
    elevation: 2,
  },
  loginBtnTextGoogle: {
    color: '#1f1f1f',
    fontSize: 15,
    fontWeight: 'bold',
  },
  loginBtnApple: {
    backgroundColor: '#000000',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#333333',
  },
  loginBtnTextApple: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  authPrivacyNote: {
    color: COLORS.textSecondary + 'aa',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  sessionContainer: {
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  userInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  userLabel: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  userValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  userIdValue: {
    color: COLORS.textSecondary,
    fontSize: 12,
    maxWidth: '60%',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  authActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  logoutBtn: {
    flex: 1,
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  logoutBtnText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  deleteBtn: {
    flex: 1.5,
    backgroundColor: '#ef4444' + '15',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  deleteBtnText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
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
  policyRow: {
    backgroundColor: COLORS.surface,
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  policyLink: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 20,
  },
});