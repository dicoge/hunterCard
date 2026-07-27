import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView } from 'react-native';
import { COLORS, APP_NAME, APP_VERSION, CURRENCIES } from '../constants';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';

export default function SettingsScreen() {
  const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

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
        {isAuthenticated && user && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>🔐 帳號</Text>
            <View style={styles.accountInfo}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(user.name || user.email || '?')[0].toUpperCase()}
                </Text>
              </View>
              <View style={styles.accountDetails}>
                <Text style={styles.accountName}>{user.name}</Text>
                <Text style={styles.accountEmail}>{user.email}</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.logoutButton} onPress={logout}>
              <Text style={styles.logoutText}>登出</Text>
            </TouchableOpacity>
          </View>
        )}

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