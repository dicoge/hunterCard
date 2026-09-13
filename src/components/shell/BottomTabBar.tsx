import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import {
  PALETTE,
  SEMANTIC,
  LAYOUT,
  FONTS,
  RADII,
  SPACING,
  TYPE_SCALE,
  SHADOWS,
} from '../../theme/tokensV2';
import { HouseGlyph, SearchGlyph, LayersGlyph, UserGlyph, ScanLineGlyph } from './icons';

export type BottomTabKey = 'home' | 'search' | 'scan' | 'deck' | 'me';

export interface BottomTabItem {
  key: BottomTabKey;
  label: string;
  icon?: React.ReactNode;
  glyph?: string;
  onPress?: () => void;
  destinationRoute?: string;
  testID?: string;
}

export interface BottomTabBarProps {
  items: BottomTabItem[];
  activeKey: BottomTabKey;
  onChange?: (item: BottomTabItem) => void;
  scanFabTint?: 'pink-purple' | 'pink-cyan';
  testID?: string;
}

const DEFAULT_ORDER: BottomTabKey[] = ['home', 'search', 'scan', 'deck', 'me'];

/**
 * Pen `C / Tab Bar` (id `H8TW7`, 390×96). Four labeled tabs plus a centered
 * scan FAB that pops above the bar (Pen: `Scan FAB` 64×64 with pink→purple
 * gradient). The FAB is treated as a route trigger, not a decorative element,
 * so the caller must supply an `onPress` that routes to Scan.
 */
export function BottomTabBar({
  items,
  activeKey,
  onChange,
  scanFabTint = 'pink-purple',
  testID = 'shell-bottom-tab-bar',
}: BottomTabBarProps) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const ordered = DEFAULT_ORDER.map((key) => byKey.get(key)).filter(Boolean) as BottomTabItem[];
  const scanItem = ordered.find((it) => it.key === 'scan');
  const laterals = ordered.filter((it) => it.key !== 'scan');
  const left = laterals.slice(0, 2);
  const right = laterals.slice(2, 4);

  const handlePress = (item: BottomTabItem) => {
    item.onPress?.();
    onChange?.(item);
  };

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.bar} testID={`${testID}-bar`}>
        {left.map((item) => renderTab(item, item.key === activeKey, handlePress))}
        <View style={styles.spacer} accessibilityElementsHidden />
        {right.map((item) => renderTab(item, item.key === activeKey, handlePress))}
      </View>
      {scanItem ? (
        <TouchableOpacity
          onPress={() => handlePress(scanItem)}
          activeOpacity={0.9}
          style={[
            styles.fab,
            scanFabTint === 'pink-cyan' ? styles.fabPinkCyan : styles.fabPinkPurple,
            SHADOWS.glowPink,
          ]}
          accessibilityRole="button"
          accessibilityLabel={scanItem.label}
          testID={scanItem.testID ?? `${testID}-scan-fab`}
        >
          {scanItem.icon ?? <ScanLineGlyph color="#FFFFFF" size={28} />}
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// DIC-1427: default per-slot icons matching the Pen `C / Tab Bar` lucide set
// (house / search / layers / user, 22×22). Callers can still override with
// `item.icon`; the emoji `glyph` fallback only survives for unknown keys.
const TAB_GLYPHS: Partial<Record<BottomTabKey, (color: string) => React.ReactNode>> = {
  home: (color) => <HouseGlyph color={color} size={20} />,
  search: (color) => <SearchGlyph color={color} size={19} />,
  deck: (color) => <LayersGlyph color={color} size={20} />,
  me: (color) => <UserGlyph color={color} size={20} />,
};

function renderTab(
  item: BottomTabItem,
  active: boolean,
  onPress: (item: BottomTabItem) => void,
) {
  const ariaProps: Record<string, unknown> = { 'aria-selected': active };
  const tint = active ? PALETTE.accent : '#5A5A75';
  const defaultIcon = TAB_GLYPHS[item.key]?.(tint);
  return (
    <TouchableOpacity
      key={item.key}
      onPress={() => onPress(item)}
      activeOpacity={0.7}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={item.label}
      testID={item.testID ?? `shell-bottom-tab-${item.key}`}
      {...ariaProps}
    >
      <View
        style={[styles.iconWrap, active && styles.iconWrapActive]}
        testID={`shell-bottom-tab-${item.key}-icon`}
      >
        {item.icon ?? defaultIcon ?? (
          <Text style={[styles.iconGlyph, active && styles.iconGlyphActive]}>
            {item.glyph ?? '•'}
          </Text>
        )}
      </View>
      <Text
        style={[styles.label, active && styles.labelActive]}
        numberOfLines={1}
        testID={`shell-bottom-tab-${item.key}-label`}
      >
        {item.label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: LAYOUT.bottomTab.height + 12,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    height: LAYOUT.bottomTab.height,
    backgroundColor: PALETTE.surface + 'F2',
    borderTopWidth: 1,
    borderColor: PALETTE.border,
    paddingHorizontal: 12,
    paddingTop: SPACING.md,
    paddingBottom: SPACING['2xl'],
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  spacer: {
    width: 78,
    height: LAYOUT.bottomTab.fab,
  },
  tab: {
    width: 78,
    height: 42,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
  },
  iconWrap: {
    width: 22,
    height: 22,
    borderRadius: RADII.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: PALETTE.accent + '22',
  },
  iconGlyph: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 18,
    lineHeight: 18,
    color: '#5A5A75',
  },
  iconGlyphActive: {
    color: PALETTE.accent,
  },
  label: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.micro.size,
    lineHeight: TYPE_SCALE.micro.lineHeight,
    color: SEMANTIC.onBgMuted,
  },
  labelActive: {
    color: PALETTE.accent,
    fontWeight: '600',
  },
  fab: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    width: LAYOUT.bottomTab.fab,
    height: LAYOUT.bottomTab.fab,
    borderRadius: LAYOUT.bottomTab.fab / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: PALETTE.appBg,
  },
  // Pen `Scan FAB` (i4fpf): linear gradient #FF4D9D → #8B5CF6. RN core has no
  // gradient primitive and the app ships no gradient dependency, so web gets
  // the exact CSS gradient and native keeps the accent base tone.
  fabPinkPurple: {
    backgroundColor: PALETTE.accent,
    ...(Platform.OS === 'web'
      ? ({ backgroundImage: `linear-gradient(150deg, ${PALETTE.accent} 0%, ${PALETTE.accent3} 100%)` } as object)
      : null),
  },
  fabPinkCyan: {
    backgroundColor: PALETTE.accent,
    ...(Platform.OS === 'web'
      ? ({ backgroundImage: `linear-gradient(150deg, ${PALETTE.accent} 0%, ${PALETTE.accent2} 100%)` } as object)
      : null),
  },
  fabGlyph: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 28,
    lineHeight: 28,
    color: '#FFFFFF',
    fontWeight: '700',
  },
});

export default BottomTabBar;
