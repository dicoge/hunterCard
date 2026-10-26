import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { PALETTE, SEMANTIC, LAYOUT, FONTS, RADII, SPACING, TYPE_SCALE } from '../../theme/tokensV2';

export interface AppBarAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}

export interface AppBarProps {
  title?: string;
  subtitle?: string;
  showBrand?: boolean;
  actions?: AppBarAction[];
  onLeadingPress?: () => void;
  leading?: React.ReactNode;
  /**
   * DIC-1427: when set, replaces the title column with a custom node that
   * fills the bar's center — the Pen `App / 02 搜尋結果` app bar (CXGih) puts
   * a full-width search field between the back arrow and the filter action.
   */
  center?: React.ReactNode;
  testID?: string;
}

/**
 * Pen `App Bar` frame (id `upe1D`, 390×56). Brand mark + title on the left;
 * up to three actions on the right. Shared across every top-level route so the
 * shell reads the same on Web/Android/iOS.
 */
export function AppBar({
  title = 'HoloHunter',
  subtitle,
  showBrand = true,
  actions = [],
  onLeadingPress,
  leading,
  center,
  testID = 'shell-app-bar',
}: AppBarProps) {
  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.brand} accessibilityRole="header">
        {leading ??
          (showBrand ? (
            <TouchableOpacity
              onPress={onLeadingPress}
              style={styles.mark}
              accessibilityRole="button"
              accessibilityLabel={`${title} home`}
              testID={`${testID}-mark`}
            >
              <View style={styles.markInner} />
            </TouchableOpacity>
          ) : null)}
        {center ? (
          <View style={styles.centerSlot} testID={`${testID}-center`}>
            {center}
          </View>
        ) : (
          <View style={styles.titleColumn}>
            <Text style={styles.title} numberOfLines={1} testID={`${testID}-title`}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1} testID={`${testID}-subtitle`}>
                {subtitle}
              </Text>
            ) : null}
          </View>
        )}
      </View>
      <View style={styles.actions} testID={`${testID}-actions`}>
        {actions.slice(0, 3).map((action) => (
          <TouchableOpacity
            key={action.key}
            onPress={action.onPress}
            disabled={action.disabled}
            style={[styles.actionButton, action.disabled && styles.actionButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            testID={action.testID ?? `${testID}-action-${action.key}`}
          >
            {action.icon ?? <Text style={styles.actionGlyph}>•</Text>}
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: LAYOUT.appBar.height,
    paddingHorizontal: LAYOUT.safeMobile,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.lg,
    flex: 1,
    minWidth: 0,
  },
  mark: {
    width: 24,
    height: 24,
    borderRadius: RADII.sm,
    backgroundColor: PALETTE.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PALETTE.accent,
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  markInner: {
    width: 12,
    height: 12,
    borderRadius: RADII.xs,
    backgroundColor: '#FFFFFF',
    opacity: 0.9,
  },
  titleColumn: {
    flexShrink: 1,
    minWidth: 0,
  },
  centerSlot: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.heading.size,
    lineHeight: TYPE_SCALE.heading.lineHeight,
    fontWeight: '700',
    color: SEMANTIC.onBg,
  },
  subtitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.small.size,
    lineHeight: TYPE_SCALE.small.lineHeight,
    color: SEMANTIC.onBgMuted,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.lg,
    minWidth: 60,
    justifyContent: 'flex-end',
  },
  actionButton: {
    width: 22,
    height: 22,
    borderRadius: RADII.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonDisabled: {
    opacity: 0.4,
  },
  actionGlyph: {
    fontSize: 18,
    color: SEMANTIC.onBg,
    lineHeight: 18,
  },
});

export default AppBar;
