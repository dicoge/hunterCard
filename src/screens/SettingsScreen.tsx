import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { COLORS, APP_NAME, APP_VERSION, CURRENCIES } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
import { useDeckStore } from '../store/deckStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { APPLE_LOGIN_ENABLED } from '../services/authService';
import { friendlyAuthErrorMessage, isCancelAuthError } from '../services/authErrorMessages';
import { showAlert } from '../utils/platformAlert';
import { useTranslation } from '../i18n';
import type { AuthProvider } from '../types/auth';
import { AppShell, buildShellTabs, SHELL_TAB_LABELS } from '../components/shell';
import { PALETTE, SEMANTIC, FONTS, GRADIENTS } from '../theme/tokensV2';

const PROVIDER_LABEL: Record<AuthProvider, string> = { apple: 'Apple', google: 'Google' };
const ALL_PROVIDERS: AuthProvider[] = ['google', 'apple'];

export default function SettingsScreen({ navigation }: any) {
  const { t } = useTranslation();
  const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.logout);
  const deleteAccount = useAuthStore((s) => s.deleteUserAccount);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loginWithGoogle = useAuthStore((s) => s.loginWithGoogle);
  const loginWithApple = useAuthStore((s) => s.loginWithApple);
  const linkNewProvider = useAuthStore((s) => s.linkNewProvider);
  const removeLinkedProvider = useAuthStore((s) => s.removeLinkedProvider);
  const isLoading = useAuthStore((s) => s.isLoading);

  const linkedProviders = user?.linkedProviders ?? [];
  const linkedSet = new Set(linkedProviders.map((p) => p.provider));
  const unlinkedProviders = ALL_PROVIDERS.filter(
    (p) => !linkedSet.has(p) && !(p === 'apple' && !APPLE_LOGIN_ENABLED),
  );

  // DIC-1409 Phase 4 — Pen `App / 07 我的` (frame siVsa) shell chrome + the
  // real account card (node ZYJRw) and stats tiles (node vGwTI). Every value
  // is live store state: collection count from the deck-store inventory,
  // alert count from the price-alert store; the 收藏市值 tile in the Pen
  // frame is intentionally NOT rendered — computing it needs a price join
  // this surface does not have, and a placeholder number would be mock data.
  const collection = useDeckStore((s) => s.collection);
  const alerts = usePriceAlertStore((s) => s.alerts);
  const collectionCount = useMemo(
    () => Object.values(collection).reduce((sum, qty) => sum + (qty || 0), 0),
    [collection],
  );
  const alertCount = Object.keys(alerts).length;
  const shellTabs = useMemo(() => buildShellTabs({ navigation: navigation ?? { navigate: () => {} } }), [navigation]);
  const displayNameForCard = user?.displayName || user?.primaryEmail || t('me_guest_name');
  const avatarInitial = (displayNameForCard || 'H').trim().charAt(0).toUpperCase() || 'H';

  const handleGoogleLogin = async () => {
    try {
      await loginWithGoogle();
    } catch (err: any) {
      if (isCancelAuthError(err)) return;
      showAlert(t('settings_login_failed'), friendlyAuthErrorMessage(err, 'google'));
    }
  };

  const handleAppleLogin = async () => {
    try {
      await loginWithApple();
    } catch {}
  };

  const handleLinkProvider = async (provider: AuthProvider) => {
    if (provider === 'apple' && !APPLE_LOGIN_ENABLED) return;
    try {
      await linkNewProvider(provider);
      showAlert(t('settings_link_complete'), t('settings_link_complete_body', { provider: PROVIDER_LABEL[provider] }));
    } catch (err: any) {
      if (isCancelAuthError(err)) return;
      showAlert(t('settings_link_failed'), friendlyAuthErrorMessage(err, provider));
    }
  };

  const confirmUnlinkProvider = (provider: AuthProvider) => {
    if (linkedProviders.length <= 1) {
      showAlert(t('settings_unlink_blocked'), t('settings_unlink_blocked_body'));
      return;
    }
    showAlert(
      t('settings_account_unlink'),
      t('settings_unlink_confirm', { provider: PROVIDER_LABEL[provider] }),
      [
        { text: t('common_cancel'), style: 'cancel' },
        {
          text: t('settings_account_unlink'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeLinkedProvider(provider);
              showAlert(t('settings_unlink_complete'), t('settings_unlink_complete_body', { provider: PROVIDER_LABEL[provider] }));
            } catch (err: any) {
              showAlert(t('settings_unlink_failed'), String(err?.message ?? t('settings_unlink_failed_body')));
            }
          },
        },
      ]
    );
  };

  const confirmSignOut = () => {
    showAlert(t('settings_account_signout'), t('settings_signout_confirm'), [
      { text: t('common_cancel'), style: 'cancel' },
      { text: t('settings_account_signout'), style: 'destructive', onPress: signOut },
    ]);
  };

  const confirmDelete = () => {
    showAlert(
      t('settings_account_delete'),
      t('settings_delete_confirm'),
      [
        { text: t('common_cancel'), style: 'cancel' },
        {
          text: t('settings_account_delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount();
              showAlert(t('settings_delete_complete'), t('settings_delete_complete_body'));
            } catch {
              showAlert(
                t('settings_delete_pending'),
                t('settings_delete_pending_body')
              );
            }
          },
        },
      ]
    );
  };

  return (
    <AppShell
      appBar={{
        showBrand: false,
        // DIC-1427 QA P0: Settings is its own Pen frame (x44r8t 設定) —
        // the 我的 identity moved to MeScreen (Pen siVsa collection hub).
        title: t('nav_settings'),
        onLeadingPress: () => navigation?.openDrawer?.(),
      }}
      bottomTabBar={{ items: shellTabs, activeKey: 'me' }}
      testID="settings-shell"
    >
        {/* Pen Account card (node ZYJRw): gradient avatar + name + linked
            provider badges, backed by the real auth store. */}
        <View style={styles.accountCard} testID="settings-account-card">
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>{avatarInitial}</Text>
          </View>
          <View style={styles.accountText}>
            <Text style={styles.accountName} numberOfLines={1} testID="settings-account-name">
              {displayNameForCard}
            </Text>
            <View style={styles.accountBadges}>
              {linkedProviders.map((p) => (
                <View key={p.provider} style={styles.accountBadge}>
                  <Text style={styles.accountBadgeText}>
                    {t('me_provider_linked', { provider: PROVIDER_LABEL[p.provider] })}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* Pen Stats tiles (node vGwTI) — real store values only. */}
        {(FEATURES.favorites || FEATURES.watchlist) && (
          <View style={styles.statsRow} testID="settings-stats">
            {FEATURES.favorites && (
              <View style={styles.statTile} testID="settings-stat-collection">
                <Text style={styles.statValue}>{collectionCount}</Text>
                <Text style={styles.statLabel}>{t('me_stat_collection')}</Text>
              </View>
            )}
            {FEATURES.watchlist && (
              <View style={styles.statTile} testID="settings-stat-alerts">
                <Text style={styles.statValue}>{alertCount}</Text>
                <Text style={styles.statLabel}>{t('me_stat_alerts')}</Text>
              </View>
            )}
          </View>
        )}

        <Text style={styles.title}>{APP_NAME}</Text>
        <Text style={styles.version}>{t('settings_app_version', { version: APP_VERSION })}</Text>

        {/* ── 語言設定 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings_language_section')}</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionBtn, preferredLanguage === 'zh' && styles.optionBtnActive]}
              onPress={() => setLanguage('zh')}
            >
              <Text style={[styles.optionText, preferredLanguage === 'zh' && styles.optionTextActive]}>
                {t('settings_language_zh')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionBtn, preferredLanguage === 'ja' && styles.optionBtnActive]}
              onPress={() => setLanguage('ja')}
            >
              <Text style={[styles.optionText, preferredLanguage === 'ja' && styles.optionTextActive]}>
                {t('settings_language_ja')}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            {t('settings_language_hint')}
          </Text>
        </View>

        {/* ── 幣別設定 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings_currency_section')}</Text>
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
            {preferredCurrency === 'TWD' && t('settings_currency_hint_twd')}
            {preferredCurrency === 'JPY' && t('settings_currency_hint_jpy')}
            {preferredCurrency === 'USD' && t('settings_currency_hint_usd')}
          </Text>
        </View>

        {/* ── 價格來源資訊 ── Store MVP: 隱藏整區 (DIC-1256)。此區只列
            遊々亭 / Carousell / 匯率，Store MVP 一律不展示市場價格，區塊本身
            也不再有意義。 */}
        {FEATURES.marketData && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('settings_price_sources')}</Text>
            <Text style={styles.item}>{t('settings_price_yuyu')}</Text>
            <Text style={styles.item}>{t('settings_price_carousell')}</Text>
            <Text style={styles.item}>{t('settings_exchange_rate')}</Text>
          </View>
        )}

        {/* ── 帳號 ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('settings_account_section')}</Text>
          {isAuthenticated && user ? (
            <>
              {!!(user.displayName || user.primaryEmail) && (
                <Text style={styles.item}>
                  {user.displayName ?? user.primaryEmail}
                </Text>
              )}

              <Text style={styles.subheading}>{t('settings_account_linked_auth')}</Text>
              {linkedProviders.map((p) => (
                <View key={p.provider} style={styles.providerRow}>
                  <View style={styles.providerInfo}>
                    <Text style={styles.providerName}>{PROVIDER_LABEL[p.provider]}</Text>
                    {!!p.email && <Text style={styles.providerEmail}>{p.email}</Text>}
                  </View>
                  {linkedProviders.length > 1 && (
                    <TouchableOpacity
                      style={styles.unlinkBtn}
                      onPress={() => confirmUnlinkProvider(p.provider)}
                      disabled={isLoading}
                    >
                      <Text style={styles.unlinkBtnText}>{t('settings_account_unlink')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              {unlinkedProviders.map((provider) => (
                <TouchableOpacity
                  key={provider}
                  style={[styles.linkBtn, isLoading && styles.btnDisabled]}
                  onPress={() => handleLinkProvider(provider)}
                  disabled={isLoading}
                  activeOpacity={0.8}
                >
                  <Text style={styles.linkBtnText}>{t('settings_account_link_provider', { provider: PROVIDER_LABEL[provider] })}</Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.hint}>
                {/* Store MVP: no 收藏 / 提醒 claim in the link hint (DIC-1256). */}
                {FEATURES.watchlist
                  ? t('settings_link_hint_watchlist')
                  : FEATURES.favorites
                    ? t('settings_link_hint')
                    : t('settings_link_hint_store')}
              </Text>

              <TouchableOpacity style={styles.accountBtn} onPress={confirmSignOut}>
                <Text style={styles.accountBtnText}>{t('settings_account_signout')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.accountBtn, styles.dangerBtn]}
                onPress={confirmDelete}
              >
                <Text style={[styles.accountBtnText, styles.dangerText]}>{t('settings_account_delete')}</Text>
              </TouchableOpacity>
              <Text style={styles.hint}>{t('settings_delete_note')}</Text>
            </>
          ) : (
            <>
              <Text style={styles.hint}>
                {/* Store MVP: no 收藏 / 提醒 claim in the guest hint (DIC-1256). */}
                {FEATURES.watchlist
                  ? t('settings_guest_sync_watchlist')
                  : FEATURES.favorites
                    ? t('settings_guest_sync')
                    : t('settings_guest_sync_store')}
              </Text>
              <TouchableOpacity
                style={[styles.googleBtn, isLoading && styles.btnDisabled]}
                onPress={handleGoogleLogin}
                disabled={isLoading}
                activeOpacity={0.8}
              >
                <Text style={styles.googleBtnText}>{t('settings_google_login')}</Text>
              </TouchableOpacity>
              {APPLE_LOGIN_ENABLED && (
                <TouchableOpacity
                  style={[styles.appleBtn, isLoading && styles.btnDisabled]}
                  onPress={handleAppleLogin}
                  disabled={isLoading}
                  activeOpacity={0.8}
                >
                  <Text style={styles.appleBtnText}>{t('settings_apple_login')}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        <Text style={styles.footer}>{t('settings_footer')}</Text>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  // Pen App/07 account card (node ZYJRw: $app-surface r16 p14, 44px gradient
  // avatar, 15/700 name, badge chips)
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.appSurface,
    borderRadius: 16,
    padding: 14,
    gap: 12,
    marginTop: 6,
    marginBottom: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 999,
    backgroundColor: GRADIENTS.brandPinkPurple.colors[0],
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '700',
  },
  accountText: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  accountName: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: SEMANTIC.onBg,
    fontSize: 15,
    fontWeight: '700',
  },
  accountBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  accountBadge: {
    backgroundColor: '#FFFFFF0D',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  accountBadgeText: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: '#B9B9CE',
    fontSize: 10.5,
    fontWeight: '600',
  },
  // Pen App/07 stats tiles (node vGwTI: $app-surface r13, 16/700 value,
  // 10.5 muted label)
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  statTile: {
    flex: 1,
    backgroundColor: PALETTE.appSurface,
    borderRadius: 13,
    paddingVertical: 12,
    alignItems: 'center',
    gap: 5,
  },
  statValue: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    color: SEMANTIC.onBg,
    fontSize: 16,
    fontWeight: '700',
  },
  statLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: SEMANTIC.onBgDim,
    fontSize: 10.5,
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
  // DIC-1409 Phase 6 — Pen `App / 15 設定` (frame x44r8t): each section is a
  // $app-surface r14 group card (nodes Qpkox/Vp4g7/phxwj) headed by an 11/700
  // muted label (nodes U2n8Jp/sed7I/Ld7b7).
  section: {
    marginBottom: 16,
    backgroundColor: PALETTE.appSurface,
    borderRadius: 14,
    padding: 14,
  },
  sectionTitle: {
    color: SEMANTIC.onBgDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: 10,
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
  subheading: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 6,
    paddingLeft: 4,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  providerInfo: {
    flex: 1,
    paddingRight: 12,
  },
  providerName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
  },
  providerEmail: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  unlinkBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  unlinkBtnText: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: '600',
  },
  linkBtn: {
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  linkBtnText: {
    color: COLORS.primary,
    fontSize: 15,
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
