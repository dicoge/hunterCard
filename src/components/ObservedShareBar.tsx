// Mobile-first horizontal bar chart for the observed-sample distribution
// (DIC-1142). Same DonutModel input as the desktop donut so the two are
// interchangeable at the responsive boundary. Reads far better on 390px than
// the giant donut it replaces: each bar is a single row that names the slice,
// its deck count, and its share, and the whole row is the tap target so
// filtering works without hunting a wedge.
//
// Honesty invariants inherited from the donut:
//   • The denominator is the verified sample from the model (`sampleSize`),
//     never inflated to observed or fabricated.
//   • Percentages come from `slice.percent`, which sums to exactly 100 via
//     largest-remainder rounding in tournamentDonut.integerPercents.
//   • The unknown slice takes its own muted color and never blends into a
//     named archetype.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';
import type { DonutModel } from '../utils/tournamentDonut';

const MIN_BAR_WIDTH_PCT = 4;

export default function ObservedShareBar({
  model,
  selectedKey,
  onSelect,
}: {
  model: DonutModel;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const { t } = useTranslation();

  return (
    <View testID="observed-share-bar">
      <View style={styles.header}>
        <Text style={styles.headerCaption}>{t('tournament_published_sample')}</Text>
        <Text style={styles.headerValue}>n={model.sampleSize}</Text>
      </View>
      <View style={styles.rows}>
        {model.slices.map((slice) => {
          const active = selectedKey === slice.key;
          const dimmed = selectedKey != null && !active;
          const width = Math.max(MIN_BAR_WIDTH_PCT, slice.percent);
          return (
            <TouchableOpacity
              key={slice.key}
              onPress={() => onSelect(active ? null : slice.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t('tournament_slice_a11y', {
                label: slice.label,
                count: slice.count,
                percent: slice.percent,
              })}
              testID={`bar-slice-${slice.key}`}
              activeOpacity={0.75}
              style={[
                styles.row,
                active && styles.rowActive,
                dimmed && styles.rowDimmed,
              ]}
            >
              <View style={styles.rowLabelLine}>
                <View style={[styles.swatch, { backgroundColor: slice.color }]} />
                <Text
                  style={[
                    styles.rowLabel,
                    slice.id == null && styles.rowLabelUnknown,
                  ]}
                  numberOfLines={2}
                >
                  {active ? '✓ ' : ''}
                  {slice.label}
                </Text>
                <Text style={styles.rowCount}>
                  {t('common_decks_count', { count: slice.count })}
                </Text>
                <Text style={styles.rowPct}>{slice.percent}%</Text>
              </View>
              <View style={styles.track} accessibilityElementsHidden>
                <View
                  style={[
                    styles.fill,
                    { width: `${width}%`, backgroundColor: slice.color },
                  ]}
                />
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerCaption: { color: COLORS.textSecondary, fontSize: 12 },
  headerValue: { color: COLORS.text, fontSize: 16, fontWeight: 'bold' },
  rows: { gap: 8 },
  row: {
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  rowActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.surfaceLight,
  },
  rowDimmed: { opacity: 0.55 },
  rowLabelLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  swatch: { width: 12, height: 12, borderRadius: 3, marginRight: 8 },
  rowLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    paddingRight: 6,
  },
  rowLabelUnknown: { color: COLORS.textSecondary, fontStyle: 'italic' },
  rowCount: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginRight: 8,
    minWidth: 48,
    textAlign: 'right',
  },
  rowPct: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: 'bold',
    minWidth: 40,
    textAlign: 'right',
  },
  track: {
    height: 8,
    backgroundColor: COLORS.background,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 999 },
});
