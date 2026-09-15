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

  // Pen `C / Card Tile` (mJyjf) anatomy: the rarity chip floats at the TOP of
  // the art (Art Foot cWMDV at y=6), while name (LsL66) and price (h0nqOz)
  // stack BELOW the art — price in $accent-2. DIC-1427 realigned this from the
  // earlier bottom-foot approximation to the exact Pen structure.
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
        {rarity ? (
          <View style={styles.artFoot} testID={`${testID}-foot`}>
            <Text style={styles.rarity} testID={`${testID}-rarity`}>
              {rarity}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.name} numberOfLines={1} testID={`${testID}-name`}>
        {name}
      </Text>
      {price ? (
        <Text style={styles.price} testID={`${testID}-price`} numberOfLines={1}>
          {price}
        </Text>
      ) : null}
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
    // Pen tiles have no surface plate behind name/price — the art card sits
    // directly on $app-bg with the text stack below (frame Z6jlE grid rows).
    backgroundColor: 'transparent',
  },
  disabled: {
    opacity: 0.5,
  },
  art: {
    // Pen Art (djwnQ): cornerRadius 9, $app-elev base, 1px $border hairline.
    borderRadius: 9,
    borderWidth: 1,
    borderColor: PALETTE.border,
    backgroundColor: PALETTE.appElev,
    overflow: 'hidden',
    justifyContent: 'flex-start',
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
  // Pen Art Foot (cWMDV): 16px band floating 6px inside the art's top edge,
  // #00000059 scrim, radius 4, rarity text centered (bSCmG, 9/700 white).
  artFoot: {
    position: 'absolute',
    top: 6,
    left: 6,
    right: 6,
    height: 16,
    borderRadius: 4,
    backgroundColor: '#00000059',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rarity: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 9,
    lineHeight: 11,
    color: '#FFFFFF',
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  // Pen Name (LsL66): 11.5/600 $text-primary, 7px below the art.
  name: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 11.5,
    lineHeight: 15,
    color: SEMANTIC.onBg,
    fontWeight: '600',
    marginTop: 7,
  },
  // Pen Price (h0nqOz): 11/600 $accent-2, 7px below the name.
  price: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.micro.size,
    lineHeight: TYPE_SCALE.micro.lineHeight + 3,
    color: PALETTE.accent2,
    fontWeight: '600',
    marginTop: 7,
  },
});

export default CardTile;
