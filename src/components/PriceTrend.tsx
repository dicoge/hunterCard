import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';
import type { ValidatedPriceTrend } from '../utils/priceTrend';

interface PriceTrendProps {
  trend: ValidatedPriceTrend | null;
}

export const PriceTrend: React.FC<PriceTrendProps> = ({ trend }) => {
  const { t } = useTranslation();
  if (!trend) return null;
  const color = trend.direction === 'up' ? COLORS.error : trend.direction === 'down' ? COLORS.success : COLORS.textSecondary;
  const arrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→';
  const percentage = `${trend.percentage >= 0 ? '+' : ''}${trend.percentage.toFixed(1)}%`;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('price_trend_title')}</Text>
      <View style={styles.row}>
        <View
          style={styles.item}
          accessible
          accessibilityLabel={`${t('card_detail_previous_week')} ¥${Math.round(trend.priorAverage).toLocaleString()}`}
        >
          <Text style={styles.period}>{t('card_detail_previous_week')}</Text>
          <Text style={styles.value}>¥{Math.round(trend.priorAverage).toLocaleString()}</Text>
        </View>
        <View
          style={styles.item}
          accessible
          accessibilityLabel={`${t('card_detail_recent_week')} ¥${Math.round(trend.recentAverage).toLocaleString()}`}
        >
          <Text style={styles.period}>{t('card_detail_recent_week')}</Text>
          <Text style={styles.value}>¥{Math.round(trend.recentAverage).toLocaleString()}</Text>
        </View>
        <View style={styles.item}>
          <Text style={styles.period}>{t('card_detail_change')}</Text>
          <Text style={[styles.value, { color }]}>{arrow} {percentage}</Text>
        </View>
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
});
