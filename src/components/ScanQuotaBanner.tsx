import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { FEATURES } from '../config/releaseFlags';
import { useAuthStore } from '../store/authStore';
import { useScanQuotaStore } from '../store/scanQuotaStore';
import { getRoleLabel } from '../services/permissionService';
import { useTranslation } from '../i18n';
import { PALETTE, SEMANTIC, FONTS } from '../theme/tokensV2';

/**
 * Pen App/04 `LQDgk` quota pill — the compact top-bar chip that carries
 * the REAL scan-quota state. DIC-1409 CR fix: restyled from the legacy
 * COLORS banner onto the Pen v2 tokens and moved into the scan top bar;
 * every state branch (subscriber-unlimited under FEATURES.premium, guest
 * login prompt, low/exhausted tints, role tag) is behavior-identical.
 */
export default function ScanQuotaBanner() {
  const { t, language } = useTranslation();
  const role = useAuthStore((s) => s.role);
  const remaining = useScanQuotaStore((s) => s.getRemaining());
  const scanCount = useScanQuotaStore((s) => s.scanCount);

  // 訂閱會員狀態 — Store MVP 不賣訂閱，隱藏此入口（DIC-908）。
  if (FEATURES.premium && role === 'subscriber') {
    return (
      <View style={[styles.pill, styles.pillUnlimited]} testID="scan-quota-pill">
        <Text style={styles.icon}>♾️</Text>
        <Text style={styles.text}>{t('scan_quota_unlimited')}</Text>
      </View>
    );
  }

  if (role === 'guest') {
    return (
      <View style={styles.pill} testID="scan-quota-pill">
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.text}>{t('scan_quota_login')}</Text>
      </View>
    );
  }

  const isLow = remaining <= 10;
  const isExhausted = remaining <= 0;

  return (
    <View
      style={[
        styles.pill,
        isExhausted ? styles.pillExhausted : isLow ? styles.pillLow : null,
      ]}
      testID="scan-quota-pill"
    >
      <Text style={styles.icon}>◉</Text>
      <Text style={styles.text} numberOfLines={1}>
        {isExhausted
          ? t('scan_quota_exhausted', { count: scanCount })
          : t('scan_quota_remaining_banner', { count: remaining })}
      </Text>
      <Text style={styles.roleTag} numberOfLines={1}>
        {language === 'ja'
          ? (role === 'subscriber' ? t('scan_role_subscriber') : t('scan_role_free'))
          : getRoleLabel(role)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(20,20,31,0.85)',
    borderWidth: 1,
    borderColor: PALETTE.border,
    maxWidth: 240,
  },
  pillLow: {
    borderColor: 'rgba(251,191,36,0.5)',
    backgroundColor: 'rgba(251,191,36,0.12)',
  },
  pillExhausted: {
    borderColor: 'rgba(248,113,113,0.5)',
    backgroundColor: 'rgba(248,113,113,0.12)',
  },
  pillUnlimited: {
    borderColor: 'rgba(52,211,153,0.5)',
    backgroundColor: 'rgba(52,211,153,0.12)',
  },
  icon: {
    fontSize: 11,
    color: PALETTE.accent2,
  },
  text: {
    color: SEMANTIC.onBg,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
  roleTag: {
    color: SEMANTIC.onBgDim,
    fontSize: 10,
    backgroundColor: 'rgba(246,246,251,0.08)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
});
