/**
 * PriceTrendBadge
 *
 * 價格趨勢指示器元件
 * 用於在卡片列表和詳情頁中顯示趨勢預測
 *
 * Props:
 *   - trend: 'up' | 'down' | 'stable' | null
 *   - score: number | null (-1 ~ 1)
 *   - confidence: number | null (0 ~ 1)
 *   - compact: boolean (列表模式 vs 詳情模式)
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../constants';
import { AppIcon } from './common/AppIcon';
import type { IconName } from './common/iconRegistry';

interface PriceTrendBadgeProps {
  trend: 'up' | 'down' | 'stable' | null;
  score?: number | null;
  confidence?: number | null;
  compact?: boolean;
}

// ── 樣式輔助 ──

type TrendStyle = {
  color: string;
  bg: string;
  icon: IconName;
  label: string;
};

// DIC-1160: `icon` now names an AppIcon SVG shape instead of an OS emoji.
// PriceTrendBadge is the highest-frequency shared status surface in the app —
// it renders inside SearchResultsScreen list rows AND CardDetail — so the
// migration touches every trend readout in one edit.
function getTrendStyle(trend: string | null): TrendStyle {
  switch (trend) {
    case 'up':
      return { color: '#10b981', bg: '#10b98115', icon: 'trending-up', label: '看漲' };
    case 'down':
      return { color: '#ef4444', bg: '#ef444415', icon: 'trending-down', label: '看跌' };
    case 'stable':
      return { color: '#6b7280', bg: '#6b728015', icon: 'minus', label: '平穩' };
    default:
      return { color: '#a0aec0', bg: '#a0aec015', icon: 'bar-chart-2', label: '資料不足' };
  }
}

function formatScore(score: number | null | undefined): string {
  if (score == null) return '--';
  const pct = Math.round(score * 100);
  if (pct > 0) return `+${pct}%`;
  return `${pct}%`;
}

function formatConfidence(confidence: number | null | undefined): string {
  if (confidence == null) return '';
  return `信心 ${Math.round(confidence * 100)}%`;
}

// ── 主元件 ──

export default function PriceTrendBadge({
  trend,
  score,
  confidence,
  compact = false,
}: PriceTrendBadgeProps) {
  if (trend == null || score == null || !Number.isFinite(score)) return null;
  const style = getTrendStyle(trend);

  if (compact) {
    // 精簡模式（列表用）：只顯示圖示 + 分數
    return (
      <View
        style={[styles.compactContainer, { backgroundColor: style.bg, borderColor: style.color + '33' }]}
        testID={`price-trend-badge-compact-${trend}`}
      >
        <AppIcon
          name={style.icon}
          size={14}
          color={style.color}
          style={styles.compactIcon}
          testID={`price-trend-icon-${trend}`}
        />
        <Text style={[styles.compactScore, { color: style.color }]}>
          {formatScore(score)}
        </Text>
      </View>
    );
  }

  // 完整模式（詳情用）
  return (
    <View
      style={[styles.container, { backgroundColor: style.bg, borderColor: style.color + '33' }]}
      testID={`price-trend-badge-${trend}`}
    >
      <View style={styles.headerRow}>
        <AppIcon
          name={style.icon}
          size={20}
          color={style.color}
          style={styles.icon}
          testID={`price-trend-icon-${trend}`}
        />
        <Text style={[styles.label, { color: style.color }]}>
          {style.label}
        </Text>
        <Text style={[styles.score, { color: style.color }]}>
          {formatScore(score)}
        </Text>
      </View>

      {/* 信心度條 */}
      {confidence != null && confidence > 0 && (
        <View style={styles.confidenceRow}>
          <View style={styles.confidenceBarBg}>
            <View
              style={[
                styles.confidenceBarFill,
                {
                  width: `${Math.round(confidence * 100)}%`,
                  backgroundColor: style.color,
                },
              ]}
            />
          </View>
          <Text style={styles.confidenceText}>
            {formatConfidence(confidence)}
          </Text>
        </View>
      )}

      {trend == null && (
        <Text style={styles.hint}>
          需累積至少 3 天的價格資料
        </Text>
      )}
    </View>
  );
}

// ── 樣式 ──

const styles = StyleSheet.create({
  // 完整模式
  container: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginVertical: 4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    marginRight: 6,
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
  },
  score: {
    fontSize: 16,
    fontWeight: '800',
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  confidenceBarBg: {
    flex: 1,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    marginRight: 8,
    overflow: 'hidden',
  },
  confidenceBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  confidenceText: {
    fontSize: 11,
    color: COLORS.textSecondary,
    minWidth: 60,
    textAlign: 'right',
  },
  hint: {
    fontSize: 11,
    color: COLORS.textSecondary,
    marginTop: 4,
    fontStyle: 'italic',
  },

  // 精簡模式
  compactContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  compactIcon: {
    marginRight: 4,
  },
  compactScore: {
    fontSize: 11,
    fontWeight: '700',
  },
});
