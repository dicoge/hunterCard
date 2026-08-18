import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';
import { donutArcs, type DonutModel } from '../utils/tournamentDonut';

const WEDGE_PRESSABLE = Platform.OS === 'web';

const MIN_SIZE = 140;
const MAX_SIZE = 260;
const HOLE_RATIO = 0.58;

export default function ObservedShareDonut({
  model,
  selectedKey,
  onSelect,
}: {
  model: DonutModel;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  const arcs = useMemo(() => donutArcs(model.slices), [model.slices]);

  const size = Math.round(
    Math.max(MIN_SIZE, Math.min(MAX_SIZE, boxWidth ?? MAX_SIZE)),
  );
  const half = size / 2;
  const hole = Math.round(size * HOLE_RATIO);
  const selected = model.slices.find((s) => s.key === selectedKey) ?? null;

  return (
    <View>
      <View
        style={styles.chartBox}
        onLayout={(e) => setBoxWidth(e.nativeEvent.layout.width)}
      >
        <View style={{ width: size, height: size }} testID="donut-chart">
          {arcs.map((arc) => {
            const dimmed = selectedKey != null && selectedKey !== arc.sliceKey;
            const slice = model.slices.find((s) => s.key === arc.sliceKey);
            const wedgeStyle = [
              styles.halfDisc,
              {
                left: half,
                width: half,
                height: size,
                backgroundColor: arc.color,
                borderTopRightRadius: half,
                borderBottomRightRadius: half,
              },
            ];
            return (
              <View
                key={arc.key}
                pointerEvents="box-none"
                style={[
                  styles.layer,
                  {
                    width: size,
                    height: size,
                    opacity: dimmed ? 0.25 : 1,
                    transform: [{ rotate: `${arc.startAngle}deg` }],
                  },
                ]}
              >
                <View
                  pointerEvents="box-none"
                  style={[styles.clip, { left: half, width: half, height: size }]}
                >
                  <View
                    pointerEvents="box-none"
                    style={[
                      styles.layer,
                      {
                        left: -half,
                        width: size,
                        height: size,
                        transform: [{ rotate: `${arc.sweep - 180}deg` }],
                      },
                    ]}
                  >
                    {WEDGE_PRESSABLE && slice ? (
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => onSelect(selectedKey === slice.key ? null : slice.key)}
                        accessibilityRole="button"
                        accessibilityLabel={`${slice.label}，${slice.count} 副，${slice.percent}%`}
                        testID={`donut-slice-${slice.key}`}
                        style={wedgeStyle}
                      />
                    ) : (
                      <View style={wedgeStyle} />
                    )}
                  </View>
                </View>
              </View>
            );
          })}

          <View
            style={[
              styles.hole,
              {
                left: (size - hole) / 2,
                top: (size - hole) / 2,
                width: hole,
                height: hole,
                borderRadius: hole / 2,
              },
            ]}
          >
            <Text style={styles.centerCaption}>已公開樣本</Text>
            <Text style={styles.centerValue} testID="donut-center">
              n={model.sampleSize}
            </Text>
            {selected ? (
              <Text style={styles.centerSelected} numberOfLines={2}>
                {selected.label} {selected.count} 副
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.legend}>
        {model.slices.map((s) => {
          const active = selectedKey === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              style={[styles.legendRow, active && styles.legendRowActive]}
              onPress={() => onSelect(active ? null : s.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${s.label}，${s.count} 副，${s.percent}%`}
              testID={`donut-legend-${s.key}`}
            >
              <View style={[styles.swatch, { backgroundColor: s.color }]} />
              <Text
                style={[styles.legendLabel, s.id == null && styles.legendUnknown]}
                numberOfLines={2}
              >
                {active ? '✓ ' : ''}
                {s.label}
              </Text>
              <Text style={styles.legendCount}>{s.count} 副</Text>
              <Text style={styles.legendPct}>{s.percent}%</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chartBox: { alignItems: 'center', justifyContent: 'center', width: '100%' },
  layer: { position: 'absolute', top: 0, left: 0 },
  clip: { position: 'absolute', top: 0, overflow: 'hidden' },
  halfDisc: { position: 'absolute', top: 0 },
  hole: {
    position: 'absolute',
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  centerCaption: { color: COLORS.textSecondary, fontSize: 12 },
  centerValue: { color: COLORS.text, fontSize: 22, fontWeight: 'bold', marginTop: 2 },
  centerSelected: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  legend: { marginTop: 14 },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  legendRowActive: { backgroundColor: COLORS.surfaceLight, borderColor: COLORS.primary },
  swatch: { width: 14, height: 14, borderRadius: 3, marginRight: 8 },
  legendLabel: { color: COLORS.text, fontSize: 13, flex: 1, paddingRight: 8 },
  legendUnknown: { color: COLORS.textSecondary, fontStyle: 'italic' },
  legendCount: { color: COLORS.textSecondary, fontSize: 13, width: 56, textAlign: 'right' },
  legendPct: { color: COLORS.text, fontSize: 13, fontWeight: '600', width: 44, textAlign: 'right' },
});
