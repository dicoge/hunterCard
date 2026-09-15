import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { COLORS, APP_VERSION, CURRENCIES } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useSettingsStore, CurrencyCode, LanguageCode } from '../store/settingsStore';
import { useAuthStore } from '../store/authStore';
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

  // DIC-1427 — Pen `App / 15 設定` (frame x44r8t): AccountCard (node mVopl)
  // over the real auth store, then the Pen 偏好 / 帳號 / 應用 group cards.
  // The App/07 stat tiles that used to render here belong to the MeScreen hub
  // (Pen siVsa) and are no longer duplicated on Settings.
  const shellTabs = useMemo(() => buildShellTabs({ navigation: navigation ?? { navigate: () => {} } }), [navigation]);
  const displayNameForCard = user?.displayName || user?.primaryEmail || t('me_guest_name');
  const avatarInitial = (displayNameForCard || 'H').trim().charAt(0).toUpperCase() || 'H';
  // Pen 偏好 rows disclose their real option chips in place: the row shows
  // the live store value, tapping expands the existing selectors.
  const [expandedRow, setExpandedRow] = useState<'language' | 'currency' | null>(null);
  const toggleRow = (row: 'language' | 'currency') =>
    setExpandedRow((current) => (current === row ? null : row));
  const accountMeta = isAuthenticated && user
    ? [user.primaryEmail, linkedProviders.map((p) => PROVIDER_LABEL[p.provider]).join(' / ')]
        .filter(Boolean)
        .join(' ・ ')
    : t('settings_guest_meta');

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
        {/* Pen x44r8t AccountCard (node mVopl): gradient avatar + name +
            email ・ provider meta, backed by the real auth store. */}
        <View style={styles.accountCard} testID="settings-account-card">
          <View style={styles.avatar}>
            <Text style={styles.avatarInitial}>{avatarInitial}</Text>
          </View>
          <View style={styles.accountText}>
            <Text style={styles.accountName} numberOfLines={1} testID="settings-account-name">
              {displayNameForCard}
            </Text>
            <Text style={styles.accountMeta} numberOfLines={1} testID="settings-account-meta">
              {accountMeta}
            </Text>
          </View>
        </View>

        {/* ── 帳號 (Pen group Qpkox) — the real linked-auth surface. The Pen
            變更密碼 / 訂閱管理 rows have no real backing feature (OAuth-only
            auth, subscription gated off) and are honestly omitted. ── */}
        <Text style={styles.groupHeading}>{t('settings_group_account')}</Text>
        <View style={styles.groupCard} testID="settings-group-account">
          {isAuthenticated && user ? (
            <>
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

        {/* ── 偏好 (Pen group Vp4g7): 語言 / 貨幣 rows showing the live store
            value; tapping a row discloses the real selector in place. The Pen
            深色模式 / 價格通知 / 賽事快訊 toggles have no real switchable
            backing (single dark theme, no push channel) and are honestly
            omitted rather than rendered as dead controls. ── */}
        <Text style={styles.groupHeading}>{t('settings_group_preferences')}</Text>
        <View style={styles.groupCard} testID="settings-group-preferences">
          <TouchableOpacity
            style={styles.rowItem}
            onPress={() => toggleRow('language')}
            accessibilityRole="button"
            accessibilityState={{ expanded: expandedRow === 'language' }}
            testID="settings-row-language"
          >
            <Text style={styles.rowLabel}>{t('settings_row_language')}</Text>
            <Text style={styles.rowValue} testID="settings-language-value">
              {preferredLanguage === 'zh' ? t('settings_language_zh') : t('settings_language_ja')}
            </Text>
            <Text style={styles.rowChevron}>{expandedRow === 'language' ? '▾' : '›'}</Text>
          </TouchableOpacity>
          {expandedRow === 'language' && (
            <View style={styles.rowExpand}>
              <View style={styles.optionRow}>
                {(['zh', 'ja'] as LanguageCode[]).map((code) => (
                  <TouchableOpacity
                    key={code}
                    style={[styles.optionBtn, preferredLanguage === code && styles.optionBtnActive]}
                    onPress={() => setLanguage(code)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferredLanguage === code }}
                    testID={`settings-language-${code}`}
                  >
                    <Text style={[styles.optionText, preferredLanguage === code && styles.optionTextActive]}>
                      {code === 'zh' ? t('settings_language_zh') : t('settings_language_ja')}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.hint}>{t('settings_language_hint')}</Text>
            </View>
          )}
          <View style={styles.rowDivider} />
          <TouchableOpacity
            style={styles.rowItem}
            onPress={() => toggleRow('currency')}
            accessibilityRole="button"
            accessibilityState={{ expanded: expandedRow === 'currency' }}
            testID="settings-row-currency"
          >
            <Text style={styles.rowLabel}>{t('settings_row_currency')}</Text>
            <Text style={styles.rowValue} testID="settings-currency-value">
              {CURRENCIES.find((cur) => cur.code === preferredCurrency)?.symbol ?? preferredCurrency}
            </Text>
            <Text style={styles.rowChevron}>{expandedRow === 'currency' ? '▾' : '›'}</Text>
          </TouchableOpacity>
          {expandedRow === 'currency' && (
            <View style={styles.rowExpand}>
              <View style={styles.optionRow}>
                {CURRENCIES.map((cur) => (
                  <TouchableOpacity
                    key={cur.code}
                    style={[styles.optionBtn, preferredCurrency === cur.code && styles.optionBtnActive]}
                    onPress={() => setCurrency(cur.code as CurrencyCode)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: preferredCurrency === cur.code }}
                    testID={`settings-currency-${cur.code}`}
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
          )}
        </View>

        {/* ── 應用 (Pen group phxwj): price-source disclosure (Store MVP hides
            the whole block, DIC-1256) + the real version on the 關於 row. The
            Pen 離線資料 row has no real sync-state source and is omitted. ── */}
        <Text style={styles.groupHeading}>{t('settings_group_app')}</Text>
        <View style={styles.groupCard} testID="settings-group-app">
          {FEATURES.marketData && (
            <>
              <Text style={styles.subheading}>{t('settings_price_sources')}</Text>
              <Text style={styles.item}>{t('settings_price_yuyu')}</Text>
              <Text style={styles.item}>{t('settings_price_carousell')}</Text>
              <Text style={styles.item}>{t('settings_exchange_rate')}</Text>
              <View style={styles.rowDivider} />
            </>
          )}
          <View style={styles.rowItem} testID="settings-row-about">
            <Text style={styles.rowLabel}>{t('settings_row_about')}</Text>
            <Text style={styles.rowValue}>{t('settings_app_version', { version: APP_VERSION })}</Text>
          </View>
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
  accountMeta: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: SEMANTIC.onBgDim,
    fontSize: 11,
  },
  // Pen x44r8t group IA: an 11 muted heading OUTSIDE each $app-surface r14
  // group card (headings 帳號/偏好/應用; cards Qpkox/Vp4g7/phxwj), rows as
  // 13 label + 12 muted value + chevron.
  groupHeading: {
    color: SEMANTIC.onBgDim,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginBottom: 8,
    marginLeft: 4,
  },
  groupCard: {
    marginBottom: 16,
    backgroundColor: PALETTE.appSurface,
    borderRadius: 14,
    padding: 14,
  },
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    color: SEMANTIC.onBg,
    fontSize: 13,
    fontWeight: '600',
  },
  rowValue: {
    color: SEMANTIC.onBgDim,
    fontSize: 12,
  },
  rowChevron: {
    color: SEMANTIC.onBgDim,
    fontSize: 14,
  },
  rowExpand: {
    paddingBottom: 10,
  },
  rowDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginVertical: 4,
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
