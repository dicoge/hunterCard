import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView, Alert, Linking, Platform } from 'react-native';
import { COLORS, APP_NAME, APP_VERSION, CURRENCIES } from '../constants';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore, UserIdentity } from '../store/authStore';

export default function SettingsScreen() {
  const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
  const { 
    isLoggedIn, 
    session, 
    loginWithGoogle, 
    loginWithApple, 
    loginAsGuest,
    linkGoogle, 
    linkApple, 
    unlinkProvider, 
    logout, 
    deleteAccount,
    mergeMockIdentity,
    toggleSubscription
  } = useAuthStore();

  const handleOpenPrivacy = () => {
    Linking.openURL('https://card-hunter-mu.vercel.app/privacy');
  };

  const handleOpenSupport = () => {
    Linking.openURL('https://card-hunter-mu.vercel.app/support');
  };

  const handleLinkProvider = (provider: 'google' | 'apple') => {
    const providerName = provider === 'google' ? 'Google' : 'Apple';
    Alert.alert(
      preferredLanguage === 'zh' ? `連結 ${providerName} 帳號` : `Link ${providerName} Account`,
      preferredLanguage === 'zh'
        ? '請選擇要模擬的綁定情境：'
        : 'Please select a linking scenario to simulate:',
      [
        {
          text: preferredLanguage === 'zh' ? '1. 正常綁定 (Normal)' : '1. Normal Link',
          onPress: () => {
            const success = provider === 'google' ? linkGoogle(false) : linkApple(false);
            if (success) {
              Alert.alert(
                preferredLanguage === 'zh' ? '綁定成功' : 'Success',
                preferredLanguage === 'zh'
                  ? `已成功綁定您的 ${providerName} 帳號。`
                  : `Successfully linked your ${providerName} account.`
              );
            }
          }
        },
        {
          text: preferredLanguage === 'zh' ? '2. 帳號衝突 (Collision)' : '2. Account Collision',
          onPress: () => {
            // Trigger Collision Resolving Flow
            handleCollisionFlow(provider);
          }
        },
        {
          text: preferredLanguage === 'zh' ? '取消' : 'Cancel',
          style: 'cancel'
        }
      ]
    );
  };

  const handleCollisionFlow = (provider: 'google' | 'apple') => {
    const providerName = provider === 'google' ? 'Google' : 'Apple';
    const collidedEmail = provider === 'google' ? 'collided.user@gmail.com' : 'collided.user@icloud.com';
    const collidedId = provider === 'google' ? 'g_998877665544' : 'ap_998877665544';

    Alert.alert(
      preferredLanguage === 'zh' ? '⚠️ 帳號衝突 (Account Collision)' : '⚠️ Account Collision',
      preferredLanguage === 'zh'
        ? `此 ${providerName} 帳號 (${collidedEmail}) 已經被另一個 HoloHunter 使用者 (ID: user_collision_99) 綁定。\n\n請選擇處理策略：`
        : `This ${providerName} account (${collidedEmail}) is already linked to another HoloHunter user (ID: user_collision_99).\n\nPlease choose a resolving strategy:`,
      [
        {
          text: preferredLanguage === 'zh' ? '策略 A: 拒絕並取消' : 'Strategy A: Reject & Cancel',
          style: 'cancel',
          onPress: () => {
            Alert.alert(
              preferredLanguage === 'zh' ? '已取消綁定' : 'Cancelled',
              preferredLanguage === 'zh'
                ? '綁定已拒絕，資料未受影響。請先登出並清除衝突帳號再試。'
                : 'Linking rejected. No changes made.'
            );
          }
        },
        {
          text: preferredLanguage === 'zh' ? '策略 B: 合併資料 (Merge)' : 'Strategy B: Merge Data',
          onPress: () => {
            const mergedIdentity: UserIdentity = {
              email: collidedEmail,
              displayName: `Holo Fan (${providerName} Collided)`,
              provider,
              providerId: collidedId,
            };
            mergeMockIdentity(mergedIdentity);
            Alert.alert(
              preferredLanguage === 'zh' ? '合併成功' : 'Merge Success',
              preferredLanguage === 'zh'
                ? `已成功將衝突帳號的卡牌收藏與設定合併至此帳號，並完成 ${providerName} 帳號轉綁。`
                : `Successfully merged all collections and settings from the collided account and linked your ${providerName} identity.`
            );
          }
        }
      ]
    );
  };

  const handleUnlinkProvider = (provider: 'google' | 'apple') => {
    const providerName = provider === 'google' ? 'Google' : 'Apple';
    Alert.alert(
      preferredLanguage === 'zh' ? `解除綁定 ${providerName}` : `Unlink ${providerName}`,
      preferredLanguage === 'zh'
        ? `您確定要解除綁定 ${providerName} 帳號嗎？解除後，您將無法再使用此方式登入。`
        : `Are you sure you want to unlink ${providerName}? You will no longer be able to log in using this provider.`,
      [
        {
          text: preferredLanguage === 'zh' ? '取消' : 'Cancel',
          style: 'cancel'
        },
        {
          text: preferredLanguage === 'zh' ? '確定解除' : 'Unlink',
          style: 'destructive',
          onPress: () => {
            const success = unlinkProvider(provider);
            if (!success) {
              Alert.alert(
                preferredLanguage === 'zh' ? '解除失敗' : 'Error',
                preferredLanguage === 'zh'
                  ? '為了避免帳號成為孤兒，您必須保留至少一種登入綁定方式！'
                  : 'You must retain at least one linked login provider to prevent lockout!'
              );
            } else {
              Alert.alert(
                preferredLanguage === 'zh' ? '解除綁定成功' : 'Unlinked',
                preferredLanguage === 'zh'
                  ? `已成功解除綁定您的 ${providerName} 帳號。`
                  : `Successfully unlinked your ${providerName} account.`
              );
            }
          }
        }
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      preferredLanguage === 'zh' ? '⚠ 確定永久刪除帳號？' : '⚠ Permanently Delete Account?',
      preferredLanguage === 'zh' 
        ? '此動作將永久刪除您的 Internal User ID、所有綁定的 Google/Apple 第三方連結，以及雲端同步的所有卡牌收藏與設定。此動作無法復原！' 
        : 'This will permanently delete your Internal User ID, all linked Google/Apple identities, and all cloud synced collections and watchlists. This action is irreversible!',
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
              preferredLanguage === 'zh' ? '您的帳號、綁定關係及所有資料已成功被徹底抹除。' : 'Your account, identities, and all data have been completely deleted.'
            );
          },
        },
      ]
    );
  };

  const isGuest = session?.role === 'guest';
  const hasGoogle = session?.identities.some(id => id.provider === 'google');
  const hasApple = session?.identities.some(id => id.provider === 'apple');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView style={styles.container}>
        <Text style={styles.title}>{APP_NAME}</Text>
        <Text style={styles.version}>版本 {APP_VERSION}</Text>

        {/* ── 帳號登入與管理 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>👤 共通帳號設定</Text>
          
          {!isLoggedIn || !session ? (
            <View style={styles.authContainer}>
              <Text style={styles.authDesc}>
                {preferredLanguage === 'zh' 
                  ? '登入以同步您的卡牌收藏、使用卡牌掃描與高級價格趨勢預測。' 
                  : 'Sign in to sync your favorites, use card scanning, and unlock premium price trends.'}
              </Text>
              
              <TouchableOpacity style={styles.loginBtnGoogle} onPress={loginWithGoogle}>
                <Text style={styles.loginBtnTextGoogle}>Sign in with Google</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.loginBtnApple} onPress={loginWithApple}>
                <Text style={styles.loginBtnTextApple}> Sign in with Apple</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.loginBtnGuest} onPress={loginAsGuest}>
                <Text style={styles.loginBtnTextGuest}>
                  {preferredLanguage === 'zh' ? '以訪客身份繼續' : 'Continue as Guest'}
                </Text>
              </TouchableOpacity>

              <Text style={styles.authPrivacyNote}>
                {preferredLanguage === 'zh'
                  ? '※ 訪客模式僅能查詢與閱讀規則，無法使用相機掃描與價格預測功能。'
                  : '* Guest mode only allows searching and reading rules. Camera scanning and price forecasts require login.'}
              </Text>
            </View>
          ) : isGuest ? (
            <View style={styles.sessionContainer}>
              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '目前權限' : 'Current Tier'}</Text>
                <Text style={[styles.userValue, { color: COLORS.accent }]}>
                  {preferredLanguage === 'zh' ? '👤 訪客模式' : 'Guest Mode'}
                </Text>
              </View>
              <Text style={styles.authDesc}>
                {preferredLanguage === 'zh'
                  ? '您目前以訪客模式進入。登入即可開啟卡牌掃描、收藏同步與每月 100 次的免費掃描額度。'
                  : 'You are in Guest Mode. Sign in to enable card scanning, sync favorites, and get 100 free monthly scans.'}
              </Text>

              <View style={styles.authActionRow}>
                <TouchableOpacity style={styles.loginBtnGoogle} onPress={loginWithGoogle}>
                  <Text style={styles.loginBtnTextGoogle}>Sign in with Google</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.loginBtnApple} onPress={loginWithApple}>
                  <Text style={styles.loginBtnTextApple}> Sign in with Apple</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
                <Text style={styles.logoutBtnText}>
                  {preferredLanguage === 'zh' ? '回到首頁 Onboarding' : 'Back to Onboarding'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.sessionContainer}>
              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>Internal User ID</Text>
                <Text style={styles.userIdValue} numberOfLines={1} ellipsizeMode="middle">
                  {session.internalUserId}
                </Text>
              </View>

              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '訂閱權限' : 'Subscription Tier'}</Text>
                <View style={styles.tierContainer}>
                  <Text style={[
                    styles.userValue, 
                    session.role === 'subscriber' ? styles.subscriberText : styles.freeText
                  ]}>
                    {session.role === 'subscriber' 
                      ? (preferredLanguage === 'zh' ? '⭐ 訂閱版會員 (Subscriber)' : '⭐ Premium Subscriber')
                      : (preferredLanguage === 'zh' ? '🟢 免費版會員 (Free)' : '🟢 Free Tier')
                    }
                  </Text>
                </View>
              </View>

              <View style={styles.userInfoRow}>
                <Text style={styles.userLabel}>{preferredLanguage === 'zh' ? '每月掃描次數' : 'Monthly Scans'}</Text>
                <Text style={styles.userValue}>
                  {session.role === 'subscriber' 
                    ? (preferredLanguage === 'zh' ? '♾️ 無限 (Unlimited)' : '♾️ Unlimited')
                    : `${session.scanCount} / 100`
                  }
                </Text>
              </View>

              {/* 模擬訂閱按鈕 */}
              <TouchableOpacity style={styles.mockUpgradeBtn} onPress={toggleSubscription}>
                <Text style={styles.mockUpgradeBtnText}>
                  {session.role === 'subscriber'
                    ? (preferredLanguage === 'zh' ? '🔄 模擬降級至免費版' : '🔄 Mock Downgrade to Free')
                    : (preferredLanguage === 'zh' ? '⚡ 模擬升級訂閱版會員' : '⚡ Mock Upgrade to Premium')
                  }
                </Text>
              </TouchableOpacity>

              <Text style={styles.identitiesTitle}>
                {preferredLanguage === 'zh' ? '已綁定登入方式' : 'Linked Providers'}
              </Text>

              {session.identities.map((identity) => (
                <View key={identity.provider} style={styles.identityCard}>
                  <View style={styles.identityHeader}>
                    <Text style={styles.providerBadge}>
                      {identity.provider === 'google' ? '🟢 Google' : '⚫ Apple'}
                    </Text>
                    
                    {session.identities.length > 1 && (
                      <TouchableOpacity 
                        style={styles.unlinkBtn}
                        onPress={() => handleUnlinkProvider(identity.provider)}
                      >
                        <Text style={styles.unlinkBtnText}>
                          {preferredLanguage === 'zh' ? '解除綁定' : 'Unlink'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <View style={styles.identityBody}>
                    <Text style={styles.identityText}>📝 {identity.displayName}</Text>
                    <Text style={styles.identityText}>📧 {identity.email}</Text>
                    <Text style={styles.identityText}>🆔 {identity.providerId}</Text>
                  </View>
                </View>
              ))}

              {/* 未綁定選項 */}
              {(!hasGoogle || !hasApple) && (
                <View style={styles.unlinkedSection}>
                  <Text style={styles.unlinkedTitle}>
                    {preferredLanguage === 'zh' ? '可用帳號綁定' : 'Available to Link'}
                  </Text>
                  <View style={styles.unlinkBtnRow}>
                    {!hasGoogle && (
                      <TouchableOpacity 
                        style={styles.linkActionBtn} 
                        onPress={() => handleLinkProvider('google')}
                      >
                        <Text style={styles.linkActionText}>🔗 綁定 Google</Text>
                      </TouchableOpacity>
                    )}
                    {!hasApple && (
                      <TouchableOpacity 
                        style={styles.linkActionBtn} 
                        onPress={() => handleLinkProvider('apple')}
                      >
                        <Text style={styles.linkActionText}>🔗 綁定 Apple</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}

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
    width: '100%',
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
    width: '100%',
  },
  loginBtnTextApple: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  loginBtnGuest: {
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    width: '100%',
  },
  loginBtnTextGuest: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
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
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    maxWidth: '60%',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  tierContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  subscriberText: {
    color: '#f59e0b', // Gold color for premium
    fontWeight: 'bold',
  },
  freeText: {
    color: '#10b981', // Green for free
  },
  mockUpgradeBtn: {
    backgroundColor: COLORS.primary + '15',
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  mockUpgradeBtnText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: 'bold',
  },
  identitiesTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 10,
    marginBottom: 6,
  },
  identityCard: {
    backgroundColor: COLORS.surfaceLight,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8,
  },
  identityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  providerBadge: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: 'bold',
  },
  unlinkBtn: {
    backgroundColor: '#ef4444' + '15',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  unlinkBtnText: {
    color: '#ef4444',
    fontSize: 11,
    fontWeight: '600',
  },
  identityBody: {
    gap: 2,
  },
  identityText: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  unlinkedSection: {
    marginTop: 8,
    marginBottom: 8,
  },
  unlinkedTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  unlinkBtnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  linkActionBtn: {
    flex: 1,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.primary,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  linkActionText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: 'bold',
  },
  authActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
    width: '100%',
  },
  logoutBtn: {
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    marginTop: 8,
  },
  logoutBtnText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  deleteBtn: {
    flex: 1,
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