/**
 * ScanResultCard.tsx
 *
 * Floating price card overlay on camera view.
 * Shows card name, card ID, all rarity/series prices inline,
 * and confidence indicator. Auto-dismisses after 5 seconds or on tap.
 *
 * Style inspired by Rare Candy Scanner 3.0.
 */

import React, { useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
} from 'react-native';
import { COLORS, convertPrice, CURRENCIES } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { CardInfo } from '../services/cardRecognition';
import { useTranslation } from '../i18n';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export interface ScanResultCardProps {
  /** The recognized card info */
  card: CardInfo;
  /** Whether the card is visible */
  visible: boolean;
  /** Confidence level 0-1 (from OCR) */
  confidence?: number;
  /** Callback when card is dismissed */
  onDismiss: () => void;
  /** Auto-dismiss duration in ms (default: 5000) */
  autoDismissMs?: number;
  /** Preferred currency for price display (default: 'TWD') */
  preferredCurrency?: string;
  /** Preferred language (default: 'zh') */
  preferredLanguage?: string;
}

export default function ScanResultCard({
  card,
  visible,
  confidence = 1,
  onDismiss,
  autoDismissMs = 5000,
  preferredCurrency = 'TWD',
  preferredLanguage = 'zh',
}: ScanResultCardProps) {
  const { t } = useTranslation();
  const slideAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 1,
          useNativeDriver: true,
          friction: 8,
          tension: 60,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();

      dismissTimer.current = setTimeout(() => {
        handleDismiss();
      }, autoDismissMs);
    } else {
      slideAnim.setValue(0);
      opacityAnim.setValue(0);
    }

    return () => {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
    };
  }, [visible]);

  const handleDismiss = () => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onDismiss();
    });
  };

  // Deduplicate price entries by (name + sellPrice) — must be before early return (React hooks rule)
  const uniquePrices = useMemo(() => {
    const p = card?.prices;
    if (!p || p.length === 0) return null;
    const seen = new Set<string>();
    return p.filter(entry => {
      const key = `${entry.name}|${entry.sellPrice}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [card?.prices]);

  if (!visible) return null;

  const getRarityColor = (rarity: string): string => {
    const colors: Record<string, string> = {
      C: '#6b7280',
      U: '#10b981',
      R: '#3b82f6',
      SR: '#8b5cf6',
      UC: '#f59e0b',
      CP: '#ef4444',
    };
    return colors[rarity] || COLORS.textSecondary;
  };

  const formatPrice = (price: number | null): string => {
    if (price == null) return t('scan_no_trade');
    if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
    const { value, symbol } = convertPrice(price, preferredCurrency);
    if (value == null) return t('scan_no_trade');
    return `${symbol}${value.toLocaleString()} (¥${price.toLocaleString()})`;
  };

  const confidencePercent = Math.round(confidence * 100);
  const confidenceColor = confidencePercent >= 80
    ? '#10b981'
    : confidencePercent >= 50
      ? '#f59e0b'
      : '#ef4444';

  const variants = card.variants && card.variants.length > 0 ? card.variants : null;
  const sellPriceNull = card.sellPrice == null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{
            translateY: slideAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [-100, 0],
            }),
          }],
          opacity: opacityAnim,
        },
      ]}
    >
      <TouchableOpacity
        style={styles.card}
        onPress={handleDismiss}
        activeOpacity={0.9}
      >
        {/* Header: rarity badge + confidence + close */}
        <View style={styles.headerRow}>
          <View style={[styles.rarityBadge, { backgroundColor: getRarityColor(card.rarity) }]}>
            <Text style={styles.rarityText}>{card.rarity}</Text>
          </View>
          <View style={[styles.confidenceBadge, { borderColor: confidenceColor }]}>
            <Text style={[styles.confidenceText, { color: confidenceColor }]}>
              {confidencePercent}%
            </Text>
          </View>
          <TouchableOpacity onPress={handleDismiss} style={styles.closeBtn}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Card name + number */}
        <View style={styles.infoContainer}>
          {preferredLanguage === 'zh' && card.nameZh ? (
            <>
              <Text style={styles.cardName} numberOfLines={2}>{card.nameZh}</Text>
              <Text style={styles.cardNameZh}>{card.name}</Text>
            </>
          ) : (
            <>
              <Text style={styles.cardName} numberOfLines={2}>{card.name}</Text>
              {card.nameZh && preferredLanguage !== 'ja' ? (
                <Text style={styles.cardNameZh}>{card.nameZh}</Text>
              ) : null}
            </>
          )}
          <Text style={styles.cardId}>
            #{card.cardNumber || card.id}
          </Text>
        </View>

        {/* 掃到的這張卡自己的售價 — Store MVP 也顯示 (DIC-1319)。掃描→看價是
            產品主路徑。這裡列的是這筆 catalog entry 自己的 card.prices，不會去
            抓別筆 entry 的價格；但要注意 prices[] 是 yuyu-tei 對同一張卡號的
            掛牌列表，實務上可能同時含普卡／パラレル／箔押し，甚至跨收錄系列，
            價差可以到三個數量級。也就是說這一段沒有「跨版本借價」，卻也還沒告訴
            使用者哪一列才是手上那一版——版本確認仍由候選選擇器與 session 的版本
            chip 負責 (見 DIC-1319 交付說明的待決事項)。 */}
        {FEATURES.sellPrice && (
          <View style={styles.pricesSection} testID="scan-result-prices">
            {uniquePrices ? (
              uniquePrices.map((p, i) => (
                <View key={`p-${p.name}-${p.sellPrice}-${i}`} style={styles.priceRow}>
                  <Text style={styles.priceLabel} numberOfLines={1}>{p.name}</Text>
                  <Text style={[
                    styles.priceValue,
                    p.sellPrice != null ? styles.priceValuePositive : styles.priceValueNull,
                  ]}>
                    {formatPrice(p.sellPrice)}
                  </Text>
                </View>
              ))
            ) : (
              <View style={styles.priceRow}>
                <Text style={styles.priceLabel}>{card.series || t('scan_estimate')}</Text>
                <Text style={[
                  styles.priceValue,
                  sellPriceNull ? styles.priceValueNull : styles.priceValuePositive,
                ]}>
                  {formatPrice(card.sellPrice)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Series reprint variants — stays on FEATURES.marketData: this section
            compares OTHER printings' prices against the one in hand, which is
            the cross-printing surface DIC-1319 must keep out of the store
            build. The price above is this printing's own. */}
        {FEATURES.marketData && variants && (
          <View style={styles.variantsSection} testID="scan-result-variants">
            <Text style={styles.variantsHeader}>{t('scan_other_versions')}</Text>
            {variants.map((v, i) => {
              const vPrices = v.prices && v.prices.length > 0 ? v.prices : null;
              return (
                <View key={`v-${i}`}>
                  {vPrices ? (
                    vPrices.map((vp, j) => (
                      <View key={`vp-${i}-${j}`} style={styles.variantRow}>
                        <Text style={styles.variantLabel} numberOfLines={1}>
                          {vp.name}
                        </Text>
                        <Text style={[
                          styles.variantPrice,
                          vp.sellPrice != null ? styles.variantPricePositive : styles.variantPriceNull,
                        ]}>
                          {formatPrice(vp.sellPrice)}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <View style={styles.variantRow}>
                      <Text style={styles.variantLabel} numberOfLines={1}>
                        {v.seriesName || v.series}
                      </Text>
                      <Text style={[
                        styles.variantPrice,
                        v.sellPrice != null ? styles.variantPricePositive : styles.variantPriceNull,
                      ]}>
                        {formatPrice(v.sellPrice)}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        <Text style={styles.dismissHint}>{t('scan_dismiss_hint')}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 40,
  },
  card: {
    backgroundColor: 'rgba(15, 15, 35, 0.92)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 157, 0.3)',
    padding: 16,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  rarityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  rarityText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  confidenceBadge: {
    marginLeft: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  confidenceText: {
    fontSize: 11,
    fontWeight: '700',
  },
  closeBtn: {
    marginLeft: 'auto',
    padding: 4,
  },
  closeText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },
  infoContainer: {
    marginBottom: 8,
  },
  cardName: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: 'bold',
    lineHeight: 22,
  },
  cardId: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  cardNameZh: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginTop: 1,
  },
  pricesSection: {
    marginBottom: 4,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.04)',
  },
  priceLabel: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  priceValuePositive: {
    color: '#00C853',
  },
  priceValueNull: {
    color: 'rgba(255, 255, 255, 0.35)',
  },
  dismissHint: {
    color: 'rgba(255, 255, 255, 0.3)',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 8,
  },
  variantsSection: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    paddingTop: 6,
  },
  variantsHeader: {
    color: 'rgba(255, 255, 255, 0.4)',
    fontSize: 11,
    marginBottom: 4,
  },
  variantRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  variantLabel: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
    flex: 1,
    marginRight: 8,
  },
  variantPrice: {
    fontSize: 13,
    fontWeight: '700',
  },
  variantPricePositive: {
    color: '#00C853',
  },
  variantPriceNull: {
    color: 'rgba(255, 255, 255, 0.3)',
  },
});
