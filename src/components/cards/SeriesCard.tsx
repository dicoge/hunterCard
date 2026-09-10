import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import {
  PALETTE,
  SEMANTIC,
  LAYOUT,
  RADII,
  SPACING,
  TYPE_SCALE,
  FONTS,
  SHADOWS,
} from '../../theme/tokensV2';

export interface SeriesCardProps {
  code: string;
  title: string;
  thumbUrl?: string;
  onPress?: () => void;
  testID?: string;
  width?: number;
  /** Fill the parent cell instead of the fixed Pen 175px width (grid layouts). */
  fluid?: boolean;
}

/**
 * Pen `C / Series Card` (id `E1cDY`, 175×69). Thumb block on the left, code +
 * title on the right. Used as the booster / starter row in the Home surface
 * and as the compact row in the search results.
 */
export function SeriesCard({
  code,
  title,
  thumbUrl,
  onPress,
  testID = 'series-card',
  width = LAYOUT.seriesCard.width,
  fluid = false,
}: SeriesCardProps) {
  const Container = onPress ? TouchableOpacity : View;
  const containerProps = onPress
    ? {
        onPress,
        activeOpacity: 0.85,
        accessibilityRole: 'button' as const,
        accessibilityLabel: title,
      }
    : {};

  return React.createElement(
    Container,
    {
      ...containerProps,
      style: [
        styles.root,
        fluid ? { width: '100%' as const } : { width },
        { height: LAYOUT.seriesCard.height },
        SHADOWS.sm,
      ],
      testID,
    },
    <>
      <View style={styles.thumb} testID={`${testID}-thumb`}>
        {thumbUrl ? (
          <Image source={{ uri: thumbUrl }} style={styles.thumbImg} />
        ) : (
          <View style={styles.thumbPlaceholder} testID={`${testID}-thumb-placeholder`}>
            <Text style={styles.thumbPlaceholderText}>{code.slice(0, 2).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.code} numberOfLines={1} testID={`${testID}-code`}>
          {code}
        </Text>
        <Text style={styles.title} numberOfLines={2} testID={`${testID}-title`}>
          {title}
        </Text>
      </View>
    </>,
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.appSurface,
    borderRadius: RADII.md,
    padding: SPACING.md,
    gap: SPACING.md,
  },
  thumb: {
    width: 34,
    height: 47,
    borderRadius: RADII.sm,
    overflow: 'hidden',
    backgroundColor: PALETTE.appElev,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  thumbPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbPlaceholderText: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.small.size,
    color: SEMANTIC.onBgMuted,
    fontWeight: '700',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  code: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.micro.size,
    lineHeight: TYPE_SCALE.micro.lineHeight,
    color: PALETTE.accent2,
    letterSpacing: 0.6,
    fontWeight: '600',
  },
  title: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.caption.size,
    lineHeight: TYPE_SCALE.caption.lineHeight,
    color: SEMANTIC.onBg,
    fontWeight: '500',
  },
});

export default SeriesCard;
