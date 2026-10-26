/**
 * ScanSessionPanel — 掃描估值面板
 * 累計掃描的卡牌清單與總價值，支援展開/收起
 */
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Platform,
} from 'react-native';
import { useScanSessionStore, SessionCard, getEffectivePrice } from '../stores/scanSessionStore';
import { COLORS, convertPrice, CURRENCIES } from '../constants';
import { PALETTE } from '../theme/tokensV2';
import { FEATURES } from '../config/releaseFlags';
import { useSettingsStore } from '../store/settingsStore';
import { useTranslation } from '../i18n';

interface ScanSessionPanelProps {
  onContinueScanning?: () => void;
  onViewCard?: (card: SessionCard) => void;
  preferredCurrency?: string;
  /** DIC-1427 Pen AQf9b: bump to ask the panel to expand (估值清單 box). */
  expandRequest?: number;
  /** Test/evidence harness convenience: start expanded. */
  initialExpanded?: boolean;
}

export default function ScanSessionPanel({
  onContinueScanning,
  onViewCard,
  preferredCurrency = 'TWD',
  expandRequest = 0,
  initialExpanded = false,
}: ScanSessionPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(initialExpanded);
  useEffect(() => {
    if (expandRequest > 0) setExpanded(true);
  }, [expandRequest]);
  const { cards, totalValue, cardCount, removeCard, setCardVersion, clearSession } = useScanSessionStore();
  const { setCurrency } = useSettingsStore();

  if (cardCount === 0 && !expanded) return null;

  const pendingCount = cards.filter((c) => !c.versionConfident).length;

  const formatPrice = (price: number | null) => {
    if (price == null || price === 0) return '—';
    if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
    const { value, symbol } = convertPrice(price, preferredCurrency);
    if (value == null) return '—';
    return `${symbol}${value.toLocaleString()}`;
  };

  return (
    <View style={styles.container}>
      {/* Collapsed Header */}
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded(!expanded)}
        activeOpacity={0.7}
        testID="scan-session-header"
      >
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>📋</Text>
          <Text style={styles.headerText}>
            {cardCount > 0
              ? t('scan_session_count', { count: cardCount })
              /* Store MVP 隱藏「估值」字樣 (DIC-1256)。 */
              : t(FEATURES.marketData ? 'scan_session_title' : 'scan_session_title_store')}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {cardCount > 0 && (
            <>
              {/* Store MVP 隱藏 session 累計價值 (DIC-1256)。 */}
              {FEATURES.marketData && (
                <Text style={styles.totalPrice} testID="scan-session-total-price">
                  {totalValue > 0 ? formatPrice(totalValue) : '——'}
                </Text>
              )}
              <Text style={styles.expandArrow}>{expanded ? '▼' : '▲'}</Text>
            </>
          )}
        </View>
      </TouchableOpacity>
      {/* Pen wC1cO app-bar 清除 (node S7Pq3U): visible while expanded. */}
      {expanded && cardCount > 0 ? (
        <TouchableOpacity
          style={styles.clearLink}
          onPress={clearSession}
          accessibilityRole="button"
          accessibilityLabel={t('scan_clear')}
          testID="scan-session-clear"
        >
          <Text style={styles.clearLinkText}>{t('scan_clear')}</Text>
        </TouchableOpacity>
      ) : null}

      {/* Expanded List */}
      {expanded && (
        <View style={styles.expandedBody}>
          {/* Currency selector — Store MVP 隱藏 (DIC-1256)：session 沒有價格
              可以換算幣別，這排就沒意義了。 */}
          {FEATURES.marketData && (
            <View style={styles.currencyRow} testID="scan-session-currency-row">
              {CURRENCIES.map((c) => (
                <TouchableOpacity
                  key={c.code}
                  style={[
                    styles.currencyBtn,
                    preferredCurrency === c.code && styles.currencyBtnActive,
                  ]}
                  onPress={() => { setCurrency(c.code as 'TWD' | 'JPY' | 'USD'); }}
                >
                  <Text
                    style={[
                      styles.currencyBtnText,
                      preferredCurrency === c.code && styles.currencyBtnTextActive,
                    ]}
                  >
                    {c.symbol} {c.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {cardCount === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>{t('scan_session_empty')}</Text>
              <Text style={styles.emptyHint}>{t('scan_session_empty_hint')}</Text>
            </View>
          ) : (
            <>
              {/* Pen wC1cO summary card (node Ahd5w): 本次掃描總計 · N 張 +
                  big total + 複製結果 + 版本待確認 warning. Store MVP hides
                  the valuation pieces (DIC-1256), the count line stays. */}
              <View style={styles.summaryCard} testID="scan-session-summary">
                <View style={styles.summaryTopRow}>
                  <View style={styles.summaryLeft}>
                    <Text style={styles.summaryLabel}>{t('scan_session_summary', { count: cardCount })}</Text>
                    {FEATURES.marketData && (
                      <View testID="scan-session-total-row">
                        <Text style={styles.summaryValue}>{formatPrice(totalValue)}</Text>
                      </View>
                    )}
                  </View>
                  {FEATURES.marketData && (
                    <TouchableOpacity
                      style={styles.copyBtn}
                      testID="scan-session-copy-results"
                      accessibilityRole="button"
                      onPress={() => {
                        const summary = cards.map((c, i) => {
                          if (!c.versionConfident) return `${i + 1}. ${c.name} (${c.id}) — ${t('scan_export_pending')}`;
                          const v = c.priceVersions?.[c.selectedVersion];
                          const versionLabel = c.priceVersions && c.priceVersions.length > 1 && v?.name
                            ? ` [${v.name}]`
                            : '';
                          return `${i + 1}. ${c.name} (${c.id})${versionLabel} — ${formatPrice(getEffectivePrice(c))}`;
                        }).join('\n');
                        const pendingNote = pendingCount > 0 ? `\n（${t('scan_pending_count', { count: pendingCount })}）` : '';
                        const full = `${t('scan_export_title')}\n━━━━━━━━━━━━\n${summary}\n━━━━━━━━━━━━\n${t('scan_export_total', { total: formatPrice(totalValue) })}${pendingNote}`;
                        if (Platform.OS === 'web') {
                          navigator.clipboard?.writeText(full);
                          alert(t('scan_copied'));
                        }
                      }}
                    >
                      <Text style={styles.copyBtnText}>{t('scan_copy_results')}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {FEATURES.marketData && pendingCount > 0 && (
                  <Text style={styles.pendingNote} testID="scan-session-pending-note">
                    ⚠ {t('scan_pending_count', { count: pendingCount })}
                  </Text>
                )}
              </View>
              <ScrollView style={styles.cardList} nestedScrollEnabled>
                {cards.map((card, index) => {
                  const hasVersions = card.priceVersions && card.priceVersions.length > 1;
                  const selected = card.priceVersions?.[card.selectedVersion];
                  const pending = !card.versionConfident;
                  return (
                  <View key={card.instanceId} style={styles.cardRow} testID={`scan-session-item-${index}`}>
                    <View style={styles.cardInfo}>
                      {card.imageUrl ? (
                        /* @ts-ignore */
                        <Image source={{ uri: card.imageUrl }} style={styles.cardThumb} resizeMode="cover" />
                      ) : (
                        <Text style={styles.cardIndex}>#{index + 1}</Text>
                      )}
                      <View style={styles.cardDetails}>
                        <TouchableOpacity onPress={() => onViewCard?.(card)} activeOpacity={0.7}>
                          <Text style={styles.cardName} numberOfLines={1}>
                            {card.name}
                          </Text>
                          <Text style={styles.cardMeta}>
                            {/* Store MVP 隱藏每張卡的估價字段 (DIC-1256)。
                                版本待確認狀態仍顯示，因為它與辨識識別／版本
                                選擇有關，不是市場資訊。 */}
                            {card.id}{card.rarity ? ` · ${card.rarity}` : ''}
                            {pending
                              ? ` · ${t('scan_version_pending')}`
                              : FEATURES.marketData
                                ? ` · ${formatPrice(getEffectivePrice(card))}`
                                : ''}
                          </Text>
                        </TouchableOpacity>
                        {hasVersions ? (
                          <>
                            <Text style={styles.versionHint}>
                              {/* Store MVP 使用去掉「估價／總計」字樣的變體
                                  hint (DIC-1256)。版本選擇本身仍保留，只是
                                  文案不再提市場資訊。 */}
                              {pending
                                ? t(FEATURES.marketData ? 'scan_version_pending_hint' : 'scan_version_pending_hint_store')
                                : t(FEATURES.marketData ? 'scan_version_select_hint' : 'scan_version_select_hint_store')}
                            </Text>
                            <View style={styles.versionRow}>
                              {card.priceVersions.map((v, vi) => {
                                const active = !pending && vi === card.selectedVersion;
                                return (
                                <TouchableOpacity
                                  key={`${card.instanceId}-v${vi}`}
                                  style={[styles.versionChip, active && styles.versionChipActive]}
                                  onPress={() => setCardVersion(card.instanceId, vi)}
                                >
                                  <Text
                                    style={[styles.versionChipText, active && styles.versionChipTextActive]}
                                    numberOfLines={1}
                                  >
                                    {/* Store MVP 隱藏 chip 上的價格 (DIC-1256)；
                                        chip 仍可點選來確定卡片版本。 */}
                                    {FEATURES.marketData ? `${v.name} · ${formatPrice(v.sellPrice)}` : v.name}
                                  </Text>
                                </TouchableOpacity>
                                );
                              })}
                            </View>
                          </>
                        ) : selected && selected.name && selected.name !== card.series ? (
                          <Text style={styles.versionSingle} numberOfLines={1}>{selected.name}</Text>
                        ) : null}
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.removeBtn}
                      onPress={() => removeCard(card.instanceId)}
                    >
                      <Text style={styles.removeBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  );
                })}
              </ScrollView>

              {/* Pen wC1cO action bar (node Y1xPi/G3y9k): full-width 繼續掃描. */}
              <View style={styles.footer}>
                {onContinueScanning && cardCount > 0 && (
                  <TouchableOpacity
                    style={[
                      styles.continueBar,
                      Platform.OS === 'web'
                        ? ({ backgroundImage: `linear-gradient(135deg, ${PALETTE.accent} 0%, ${PALETTE.accent3} 100%)` } as object)
                        : null,
                    ]}
                    onPress={onContinueScanning}
                    accessibilityRole="button"
                    testID="scan-session-continue"
                  >
                    <Text style={styles.continueBarText}>{t('scan_continue')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    // Pen App/05 掃描估值清單 (frame wC1cO): $app-surface at F2 opacity.
    backgroundColor: '#12121DF2',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIcon: {
    fontSize: 18,
  },
  headerText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  // Pen summary value (node ekhnv): display face on $accent-2 for prices.
  totalPrice: {
    color: PALETTE.accent2,
    fontSize: 18,
    fontWeight: 'bold',
  },
  expandArrow: {
    color: COLORS.textSecondary,
    fontSize: 10,
  },
  expandedBody: {
    maxHeight: 420,
  },
  // Pen wC1cO 清除 (node S7Pq3U)
  clearLink: {
    position: 'absolute',
    top: 12,
    right: 48,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  clearLinkText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  // Pen wC1cO summary card (node Ahd5w): gradient-tinted surface r16
  summaryCard: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(139,92,246,0.10)',
    gap: 10,
  },
  summaryTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryLeft: {
    flexShrink: 1,
    gap: 5,
  },
  summaryLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  summaryValue: {
    color: PALETTE.textPrimary,
    fontSize: 30,
    fontWeight: '700',
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  copyBtnText: {
    color: PALETTE.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  cardThumb: {
    width: 36,
    height: 50,
    borderRadius: 6,
    backgroundColor: PALETTE.appElev,
  },
  continueBar: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: PALETTE.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueBarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  emptyState: {
    padding: 30,
    alignItems: 'center',
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: 16,
    marginBottom: 8,
  },
  emptyHint: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
  },
  cardList: {
    maxHeight: 200,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  cardInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardIndex: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    width: 24,
  },
  cardDetails: {
    flex: 1,
  },
  cardName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '500',
  },
  cardMeta: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  versionHint: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 10,
    marginTop: 6,
  },
  // Pen Warning line (node yo1XN): #D6B25A on amber.
  pendingNote: {
    color: '#D6B25A',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'right',
  },
  versionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  versionChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'transparent',
    maxWidth: '100%',
  },
  versionChipActive: {
    backgroundColor: PALETTE.accent + '24',
    borderColor: PALETTE.accent,
  },
  versionChipText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    fontWeight: '600',
  },
  versionChipTextActive: {
    color: PALETTE.accent,
  },
  versionSingle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    marginTop: 4,
  },
  removeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 82, 82, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeBtnText: {
    color: '#FF5252',
    fontSize: 12,
    fontWeight: 'bold',
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  totalLabel: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  // Pen 本次掃描總計 value (node ekhnv): 30/700 $text-primary.
  totalValue: {
    color: PALETTE.textPrimary,
    fontSize: 24,
    fontWeight: 'bold',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  actionBtnText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  shareBtn: {
    backgroundColor: COLORS.primary,
  },
  shareBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  clearBtn: {
    backgroundColor: 'rgba(255, 82, 82, 0.2)',
  },
  clearBtnText: {
    color: '#FF5252',
    fontSize: 13,
    fontWeight: '600',
  },
  currencyRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  currencyBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  currencyBtnActive: {
    backgroundColor: COLORS.primary,
  },
  currencyBtnText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
  },
  currencyBtnTextActive: {
    color: '#fff',
  },
});
