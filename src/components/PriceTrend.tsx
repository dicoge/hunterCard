import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../constants';

interface PriceTrendProps {
  priceHistory: Record<string, number>;
}

function calcTrend(history: Record<string, number>, days: number): { pct: number; dir: 'up' | 'down' | 'flat'; label: string } {
  const sorted = Object.entries(history).sort((a, b) => a[0].localeCompare(b[0]));
  if (sorted.length < 2) return { pct: 0, dir: 'flat', label: '資料不足' };

  const latest = sorted[sorted.length - 1][1];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  // 找最接近 cutoff 日期的價格
  const past = sorted.find(([d]) => d >= cutoffStr);
  if (!past) return { pct: 0, dir: 'flat', label: '資料不足' };

  const pastPrice = past[1];
  if (pastPrice <= 0) return { pct: 0, dir: 'flat', label: '資料不足' };

  const pct = ((latest - pastPrice) / pastPrice) * 100;

  const dir = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
  const label = pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
  return { pct, dir, label };
}

export const PriceTrend: React.FC<PriceTrendProps> = ({ priceHistory }) => {
  const d1 = useMemo(() => calcTrend(priceHistory, 1), [priceHistory]);
  const d7 = useMemo(() => calcTrend(priceHistory, 7), [priceHistory]);
  const d30 = useMemo(() => calcTrend(priceHistory, 30), [priceHistory]);

  const hasData = Object.keys(priceHistory || {}).length >= 2;

  if (!hasData) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>📈 價格趨勢</Text>
        <Text style={styles.noData}>歷史資料累積中，明日起顯示趨勢</Text>
      </View>
    );
  }

  const renderItem = (label: string, trend: ReturnType<typeof calcTrend>) => {
    const color = trend.dir === 'up' ? COLORS.error : trend.dir === 'down' ? COLORS.success : COLORS.textSecondary;
    const arrow = trend.dir === 'up' ? '↑' : trend.dir === 'down' ? '↓' : '→';
    return (
      <View style={styles.item} key={label}>
        <Text style={styles.period}>{label}</Text>
        <Text style={[styles.value, { color }]}>
          {trend.label === '資料不足' ? '—' : `${arrow} ${trend.label}`}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>📈 價格趨勢</Text>
      <View style={styles.row}>
        {renderItem('1天', d1)}
        {renderItem('7天', d7)}
        {renderItem('30天', d30)}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.border + '66',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    marginBottom: 12,
  },
  title: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  item: {
    alignItems: 'center',
  },
  period: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginBottom: 4,
  },
  value: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  noData: {
    color: COLORS.textSecondary + '99',
    fontSize: 12,
    textAlign: 'center',
  },
});
