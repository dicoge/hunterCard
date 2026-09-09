/**
 * ScanCandidateSelector.tsx
 *
 * Bottom-sheet picker shown for mid/low-confidence scans. Lists the top 3-5
 * candidate cards; the card is only added to the session AFTER the user taps a
 * candidate to confirm — this is the point where a scan quota should be charged.
 *
 * - tier 'mid': "看起來像這幾張，請選擇正確的" — confirm before adding.
 * - tier 'low': shows shooting-quality guidance and steers toward re-shoot / manual search.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { COLORS, convertPrice } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { CardInfo, RecognizedCandidate } from '../services/cardRecognition';
import { useTranslation } from '../i18n';

export interface ScanCandidateSelectorProps {
  visible: boolean;
  tier: 'mid' | 'low';
  candidates: RecognizedCandidate[];
  onSelect: (card: CardInfo) => void;
  onRescan: () => void;
  onManualSearch: () => void;
  onDismiss: () => void;
  preferredCurrency?: string;
  preferredLanguage?: string;
}

export default function ScanCandidateSelector({
  visible,
  tier,
  candidates,
  onSelect,
  onRescan,
  onManualSearch,
  onDismiss,
  preferredCurrency = 'TWD',
  preferredLanguage = 'zh',
}: ScanCandidateSelectorProps) {
  const { t } = useTranslation();
  if (!visible || candidates.length === 0) return null;

  const formatPrice = (price: number | null): string => {
    if (price == null) return t('scan_no_trade');
    if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
    const { value, symbol } = convertPrice(price, preferredCurrency);
    if (value == null) return t('scan_no_trade');
    return `${symbol}${value.toLocaleString()}`;
  };

  const confidenceColor = (c: number): string =>
    c >= 0.8 ? '#10b981' : c >= 0.55 ? '#f59e0b' : '#ef4444';

  const title = tier === 'low' ? t('scan_candidate_low_title') : t('scan_candidate_mid_title');
  const subtitle =
    tier === 'low'
      ? t('scan_candidate_low_body')
      : t('scan_candidate_mid_body');
  const guidanceTips = [t('scan_tip_number'), t('scan_tip_glare'), t('scan_tip_flat')];

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
          <TouchableOpacity onPress={onDismiss} style={styles.closeBtn}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.guidanceRow}>
          {guidanceTips.map(tip => (
            <View key={tip} style={styles.guidanceChip}>
              <Text style={styles.guidanceText}>{tip}</Text>
            </View>
          ))}
        </View>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {candidates.map((cand, i) => {
            const card = cand.card;
            const pct = Math.round(cand.confidence * 100);
            const isBest = i === 0;
            const displayName =
              preferredLanguage === 'zh' && card.nameZh ? card.nameZh : card.name;
            return (
              <TouchableOpacity
                key={`${card.cardNumber || card.id}-${i}`}
                style={[styles.item, isBest && styles.itemBest]}
                onPress={() => onSelect(card)}
                activeOpacity={0.8}
              >
                <View style={styles.rankBadge}>
                  <Text style={styles.rankText}>{i + 1}</Text>
                </View>
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {displayName}
                    {isBest ? <Text style={styles.bestTag}>  {t('scan_best_match')}</Text> : null}
                  </Text>
                  <Text style={styles.itemMeta} numberOfLines={1} testID="scan-candidate-meta">
                    #{card.cardNumber || card.id}
                    {card.rarity ? ` · ${card.rarity}` : ''}
                    {/* Store MVP 隱藏候選卡的價格 (DIC-1256)；仍保留卡號 + 稀有度
                        以便使用者辨認正確的卡片。 */}
                    {FEATURES.marketData ? `  ${formatPrice(card.sellPrice)}` : ''}
                  </Text>
                  <View style={styles.confidenceTrack}>
                    <View
                      style={[
                        styles.confidenceFill,
                        { width: `${pct}%`, backgroundColor: confidenceColor(cand.confidence) },
                      ]}
                    />
                  </View>
                </View>
                <Text style={[styles.itemPct, { color: confidenceColor(cand.confidence) }]}>
                  {pct}%
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.actionBtn} onPress={onRescan} activeOpacity={0.8}>
            <Text style={styles.actionText}>{t('scan_rescan')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.actionBtnAlt]}
            onPress={onManualSearch}
            activeOpacity={0.8}
          >
            <Text style={[styles.actionText, styles.actionTextAlt]}>{t('scan_manual_search')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 50,
  },
  sheet: {
    backgroundColor: 'rgba(15, 15, 35, 0.98)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 157, 0.3)',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  headerText: {
    flex: 1,
    marginRight: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: 'bold',
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  closeBtn: {
    padding: 4,
  },
  closeText: {
    color: COLORS.textSecondary,
    fontSize: 18,
  },
  guidanceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  guidanceChip: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  guidanceText: {
    color: 'rgba(255, 255, 255, 0.75)',
    fontSize: 12,
  },
  list: {
    marginBottom: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  itemBest: {
    borderColor: 'rgba(16, 185, 129, 0.5)',
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
  },
  rankBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  rankText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '700',
  },
  itemInfo: {
    flex: 1,
  },
  itemName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
  },
  bestTag: {
    color: '#10b981',
    fontSize: 11,
    fontWeight: '700',
  },
  itemMeta: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  confidenceTrack: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  confidenceFill: {
    height: '100%',
    borderRadius: 2,
  },
  itemPct: {
    fontSize: 13,
    fontWeight: '700',
    marginLeft: 10,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 24,
    alignItems: 'center',
  },
  actionBtnAlt: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  actionTextAlt: {
    color: COLORS.text,
  },
});
