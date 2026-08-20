/**
 * ScanSessionPanel — 掃描估值面板
 * 累計掃描的卡牌清單與總價值，支援展開/收起
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { useScanSessionStore, SessionCard, getEffectivePrice } from '../stores/scanSessionStore';
import { COLORS, convertPrice, CURRENCIES } from '../constants';
import { useSettingsStore } from '../store/settingsStore';
import { useTranslation } from '../i18n';

interface ScanSessionPanelProps {
  onContinueScanning?: () => void;
  onViewCard?: (card: SessionCard) => void;
  preferredCurrency?: string;
}

export default function ScanSessionPanel({
  onContinueScanning,
  onViewCard,
  preferredCurrency = 'TWD',
}: ScanSessionPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
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
      >
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>📋</Text>
          <Text style={styles.headerText}>
            {cardCount > 0
              ? t('scan_session_count', { count: cardCount })
              : t('scan_session_title')}
          </Text>
        </View>
        <View style={styles.headerRight}>
          {cardCount > 0 && (
            <>
              <Text style={styles.totalPrice}>
                {totalValue > 0 ? formatPrice(totalValue) : '——'}
              </Text>
              <Text style={styles.expandArrow}>{expanded ? '▼' : '▲'}</Text>
            </>
          )}
        </View>
      </TouchableOpacity>

      {/* Expanded List */}
      {expanded && (
        <View style={styles.expandedBody}>
          {/* Currency selector row */}
          <View style={styles.currencyRow}>
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
          {cardCount === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>{t('scan_session_empty')}</Text>
              <Text style={styles.emptyHint}>{t('scan_session_empty_hint')}</Text>
            </View>
          ) : (
            <>
              <ScrollView style={styles.cardList} nestedScrollEnabled>
                {cards.map((card, index) => {
                  const hasVersions = card.priceVersions && card.priceVersions.length > 1;
                  const selected = card.priceVersions?.[card.selectedVersion];
                  const pending = !card.versionConfident;
                  return (
                  <View key={card.instanceId} style={styles.cardRow}>
                    <View style={styles.cardInfo}>
                      <Text style={styles.cardIndex}>#{index + 1}</Text>
                      <View style={styles.cardDetails}>
                        <TouchableOpacity onPress={() => onViewCard?.(card)} activeOpacity={0.7}>
                          <Text style={styles.cardName} numberOfLines={1}>
                            {card.name}
                          </Text>
                          <Text style={styles.cardMeta}>
                            {card.id}{card.rarity ? ` · ${card.rarity}` : ''} ·{' '}
                            {pending ? t('scan_version_pending') : formatPrice(getEffectivePrice(card))}
                          </Text>
                        </TouchableOpacity>
                        {hasVersions ? (
                          <>
                            <Text style={styles.versionHint}>
                              {pending
                                ? t('scan_version_pending_hint')
                                : t('scan_version_select_hint')}
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
                                    {v.name} · {formatPrice(v.sellPrice)}
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

              {/* Total + Actions */}
              <View style={styles.footer}>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>{t('scan_total')}</Text>
                  <Text style={styles.totalValue}>
                    {formatPrice(totalValue)}
                  </Text>
                </View>
                {pendingCount > 0 && (
                  <Text style={styles.pendingNote}>
                    {t('scan_pending_count', { count: pendingCount })}
                  </Text>
                )}
                <View style={styles.actionRow}>
                  {cardCount > 0 && (
                    <>
                      {onContinueScanning && (
                        <TouchableOpacity
                          style={styles.actionBtn}
                          onPress={onContinueScanning}
                        >
                          <Text style={styles.actionBtnText}>{t('scan_continue')}</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.shareBtn]}
                        onPress={() => {
                          // Share/export — build text summary
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
                          // Trigger native share
                          if (Platform.OS === 'web') {
                            navigator.clipboard?.writeText(full);
                            alert(t('scan_copied'));
                          }
                        }}
                      >
                        <Text style={styles.shareBtnText}>{t('scan_copy_results')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.actionBtn, styles.clearBtn]}
                        onPress={clearSession}
                      >
                        <Text style={styles.clearBtnText}>{t('scan_clear')}</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
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
    backgroundColor: 'rgba(20, 20, 40, 0.95)',
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
  totalPrice: {
    color: '#00C853',
    fontSize: 18,
    fontWeight: 'bold',
  },
  expandArrow: {
    color: COLORS.textSecondary,
    fontSize: 10,
  },
  expandedBody: {
    maxHeight: 350,
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
  pendingNote: {
    color: 'rgba(255,255,255,0.55)',
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
    backgroundColor: 'rgba(0, 200, 83, 0.18)',
    borderColor: '#00C853',
  },
  versionChipText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    fontWeight: '600',
  },
  versionChipTextActive: {
    color: '#00C853',
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
  totalValue: {
    color: '#00C853',
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
