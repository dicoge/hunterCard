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

export interface CardTileProps {
  name: string;
  price?: string;
  rarity?: string;
  imageUrl?: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  width?: number;
}

/**
 * Pen `C / Card Tile` (id `mJyjf`, 112×199). Art foot renders the rarity chip
 * and price row. Rendered at Pen bounds by default but honors an override
 * `width` so tablet/desktop grids can scale the tile without breaking the
 * intrinsic art aspect ratio (112:156).
 */
export function CardTile({
  name,
  price,
  rarity,
  imageUrl,
  onPress,
  disabled = false,
  testID = 'card-tile',
  width = LAYOUT.cardTile.width,
}: CardTileProps) {
  const artHeight = Math.round((LAYOUT.cardTile.artHeight / LAYOUT.cardTile.width) * width);
  const containerStyle = [
    styles.root,
    { width },
    disabled && styles.disabled,
    SHADOWS.sm,
  ];

  const body = (
    <>
      <View style={[styles.art, { width, height: artHeight }]} testID={`${testID}-art`}>
        {imageUrl ? (
          <Image
            source={{ uri: imageUrl }}
            style={styles.artImg}
            accessibilityLabel={name}
          />
        ) : (
          <View style={styles.artPlaceholder} testID={`${testID}-art-placeholder`}>
            <Text style={styles.artPlaceholderText} numberOfLines={1}>
              {name.slice(0, 2)}
            </Text>
          </View>
        )}
        <View style={styles.artFoot} testID={`${testID}-foot`}>
          {rarity ? (
            <Text style={styles.rarity} testID={`${testID}-rarity`}>
              {rarity}
            </Text>
          ) : (
            <View />
          )}
          {price ? (
            <Text style={styles.price} testID={`${testID}-price`} numberOfLines={1}>
              {price}
            </Text>
          ) : null}
        </View>
      </View>
      <Text style={styles.name} numberOfLines={1} testID={`${testID}-name`}>
        {name}
      </Text>
    </>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={name}
        style={containerStyle}
        testID={testID}
      >
        {body}
      </TouchableOpacity>
    );
  }
  return (
    <View style={containerStyle} testID={testID}>
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderRadius: RADII.md,
    backgroundColor: PALETTE.appSurface,
    overflow: 'hidden',
  },
  disabled: {
    opacity: 0.5,
  },
  art: {
    borderRadius: RADII.md,
    backgroundColor: PALETTE.appElev,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  artImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  artPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.appElev,
  },
  artPlaceholderText: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.title.size,
    color: SEMANTIC.onBgMuted,
    fontWeight: '600',
  },
  artFoot: {
    height: 16,
    backgroundColor: '#00000059',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
  },
  rarity: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.micro.size,
    lineHeight: TYPE_SCALE.micro.lineHeight,
    color: SEMANTIC.onBg,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  price: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.micro.size,
    lineHeight: TYPE_SCALE.micro.lineHeight,
    color: PALETTE.accent2,
    fontWeight: '600',
  },
  name: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.caption.size,
    lineHeight: TYPE_SCALE.caption.lineHeight,
    color: SEMANTIC.onBg,
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.xs,
  },
});

export default CardTile;
