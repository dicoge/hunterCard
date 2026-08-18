import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import { COLORS } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { HoloCard } from '../types/hololive';
import PriceTrendBadge from './PriceTrendBadge';
import type { TrendPrediction } from '../store/trendStore';
import { useTranslation } from '../i18n';

interface CardItemProps {
  card: HoloCard;
  onPress?: () => void;
  showPrices?: boolean;
  trend?: TrendPrediction | null;
}

export default function CardItem({ card, onPress, showPrices = true, trend }: CardItemProps) {
  const { t } = useTranslation();
  const minPrice = card.prices && card.prices.length > 0 
    ? Math.min(...card.prices.map(p => p.price))
    : null;

  const rarityColors: Record<string, string> = {
    'C': COLORS.rarityC,
    'U': COLORS.rarityU,
    'R': COLORS.rarityR,
    'SR': COLORS.raritySR,
    'UC': COLORS.rarityUC,
    'CP': COLORS.rarityCP,
  };

  const rarityNames: Record<string, string> = {
    'C': 'Common',
    'U': 'Uncommon',
    'R': 'Rare',
    'SR': 'Super Rare',
    'UC': 'Ultra Rare',
    'CP': 'Campaign Promo',
  };

  return (
    <TouchableOpacity 
      style={styles.card} 
      onPress={onPress}
      activeOpacity={0.7}
    >
      {/* 卡牌圖片區域 - 顯示稀有度顏色 */}
      <View style={[styles.imageContainer, { backgroundColor: rarityColors[card.rarity] || COLORS.surfaceLight }]}>
        <Text style={styles.rarityLarge}>{card.rarity}</Text>
        <Text style={styles.rarityFull}>{rarityNames[card.rarity]}</Text>
      </View>

      {/* 卡牌資訊 */}
      <View style={styles.infoContainer}>
        <View style={styles.header}>
          <Text style={styles.cardNumber}>{card.cardNumber}</Text>
          <View style={[styles.rarityBadge, { backgroundColor: rarityColors[card.rarity] || COLORS.surfaceLight }]}>
            <Text style={styles.rarityText}>{card.rarity}</Text>
          </View>
        </View>

        <Text style={styles.memberName} numberOfLines={1}>
          {card.member}
        </Text>
        
        <Text style={styles.memberNameJp} numberOfLines={1}>
          {card.memberJp}
        </Text>

        <Text style={styles.series} numberOfLines={1}>
          {card.series}
        </Text>

        {card.description && (
          <Text style={styles.description} numberOfLines={2}>
            {card.description}
          </Text>
        )}

        {/* 價格資訊 */}
        {showPrices && minPrice !== null && card.prices && card.prices.length > 0 && (
          <View style={styles.priceSection}>
            <View style={styles.priceHeader}>
              <Text style={styles.priceLabel}>{t('card_item_lowest_price')}</Text>
              <Text style={styles.priceValue}>NT$ {minPrice.toLocaleString()}</Text>
            </View>
            
            {/* 價格來源列表 */}
            <View style={styles.priceSources}>
              {card.prices.slice(0, 3).map((price, index) => (
                <TouchableOpacity 
                  key={index}
                  style={styles.priceSource}
                  onPress={() => price.url && Linking.openURL(price.url)}
                >
                  <Text style={styles.priceSourceName}>{price.source}</Text>
                  <Text style={styles.priceSourcePrice}>NT$ {price.price.toLocaleString()}</Text>
                  <Text style={styles.priceSourceStock}>
                    {price.inStock ? '✓' : '✗'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {showPrices && (!card.prices || card.prices.length === 0) && (
          <View style={styles.priceSection}>
            <Text style={styles.noPriceLabel}>{t('card_item_no_sales')}</Text>
          </View>
        )}
        
        {/* 趨勢預測 — Store MVP 隱藏（DIC-908） */}
        {FEATURES.trendPrediction && showPrices && trend && (
          <View style={styles.trendSection}>
            <PriceTrendBadge
              trend={trend.trend}
              score={trend.score}
              confidence={trend.confidence}
              compact
            />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
    minHeight: 180,
  },
  imageContainer: {
    width: 120,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 10,
  },
  rarityLarge: {
    color: COLORS.text,
    fontSize: 36,
    fontWeight: 'bold',
    textShadowColor: 'rgba(0, 0, 0, 0.3)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  rarityFull: {
    color: COLORS.text,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 4,
    opacity: 0.9,
  },
  infoContainer: {
    flex: 1,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardNumber: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  rarityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 45,
    alignItems: 'center',
  },
  rarityText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: 'bold',
  },
  memberName: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  memberNameJp: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 4,
  },
  series: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 12,
  },
  priceSection: {
    marginTop: 'auto',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  priceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  priceLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  priceValue: {
    color: COLORS.success,
    fontSize: 18,
    fontWeight: 'bold',
  },
  priceSources: {
    gap: 6,
  },
  priceSource: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  priceSourceName: {
    color: COLORS.textSecondary,
    fontSize: 12,
    flex: 1,
  },
  priceSourcePrice: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    marginRight: 12,
  },
  priceSourceStock: {
    color: COLORS.success,
    fontSize: 14,
    width: 30,
    textAlign: 'right',
  },
  noPriceLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 4,
  },
  trendSection: {
    marginTop: 8,
  },
});
