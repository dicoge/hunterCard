import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { COLORS } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useAuthStore } from '../store/authStore';
import { useScanQuotaStore } from '../store/scanQuotaStore';
import { getRoleLabel } from '../services/permissionService';

export default function ScanQuotaBanner() {
  const role = useAuthStore((s) => s.role);
  const remaining = useScanQuotaStore((s) => s.getRemaining());
  const scanCount = useScanQuotaStore((s) => s.scanCount);

  // 訂閱會員狀態 — Store MVP 不賣訂閱，隱藏此入口（DIC-908）。
  if (FEATURES.premium && role === 'subscriber') {
    return (
      <View style={styles.bannerUnlimited}>
        <Text style={styles.icon}>♾️</Text>
        <Text style={styles.text}>訂閱會員 — 無限掃描</Text>
      </View>
    );
  }

  if (role === 'guest') {
    return (
      <View style={styles.bannerGuest}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={styles.text}>請登入以使用掃描功能</Text>
      </View>
    );
  }

  const isLow = remaining <= 10;
  const isExhausted = remaining <= 0;

  return (
    <View style={[
      styles.banner,
      isExhausted ? styles.bannerExhausted : isLow ? styles.bannerLow : styles.bannerNormal,
    ]}>
      <Text style={styles.quotaText}>
        {isExhausted
          ? `⚠️ 本月掃描額度已用完 (${scanCount}/100)`
          : `📷 本月剩餘掃描：${remaining}/100`}
      </Text>
      <Text style={styles.roleTag}>{getRoleLabel(role)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginHorizontal: 16,
    marginVertical: 8,
  },
  bannerNormal: {
    backgroundColor: COLORS.surfaceLight,
  },
  bannerLow: {
    backgroundColor: COLORS.warning + '22',
    borderWidth: 1,
    borderColor: COLORS.warning + '44',
  },
  bannerExhausted: {
    backgroundColor: COLORS.error + '22',
    borderWidth: 1,
    borderColor: COLORS.error + '44',
  },
  bannerUnlimited: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    backgroundColor: COLORS.success + '22',
  },
  bannerGuest: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    backgroundColor: COLORS.surfaceLight,
  },
  icon: {
    fontSize: 16,
    marginRight: 8,
  },
  text: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  quotaText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  roleTag: {
    color: COLORS.textSecondary,
    fontSize: 11,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
});
