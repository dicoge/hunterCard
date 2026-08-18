import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { showAlert } from '../utils/platformAlert';
import { useWatchlistStore, WatchlistItem } from '../stores/watchlistStore';
import { usePriceAlertStore, sortedAlerts } from '../stores/priceAlertStore';
import { useSettingsStore } from '../store/settingsStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { syncAlertRemove } from '../services/priceAlertSync';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import { resolveExactPrice } from '../utils/deckRules';
import {
  evaluateAlertStatus, formatAlertAmount, formatInterval, ALERT_STATUS_LABELS,
  type AlertPrice, type PriceAlert,
} from '../utils/priceAlerts';

const rarityColors: Record<string, string> = {
  N: '#6b7280', C: '#6b7280', U: '#10b981', R: '#3b82f6', SR: '#8b5cf6',
};

type DbState = 'loading' | 'ready' | 'unavailable';

export default function WatchlistScreen({ navigation }: any) {
  const { t } = useTranslation();
  const { items, removeCard } = useWatchlistStore();
  const alerts = usePriceAlertStore((s) => s.alerts);
  const removeAlert = usePriceAlertStore((s) => s.removeAlert);
  const { preferredLanguage } = useSettingsStore();
  const { isDesktop, isWide } = useBreakpoint();
  const numColumns = isWide ? 3 : isDesktop ? 2 : 1;

  const [db, setDb] = useState<CardDatabase | null>(null);
  const [dbState, setDbState] = useState<DbState>('loading');
  const [alertTarget, setAlertTarget] = useState<PriceAlertTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCardDatabase()
      .then((data) => { if (!cancelled) { setDb(data); setDbState('ready'); } })
      .catch(() => { if (!cancelled) setDbState('unavailable'); });
    return () => { cancelled = true; };
  }, []);

  const alertList = useMemo(() => sortedAlerts(alerts), [alerts]);

  function priceOf(alert: PriceAlert): AlertPrice | null {
    if (!db) return null;
    const resolved = resolveExactPrice(alert.cardNumber, alert.printing, db.priceRecords);
    return resolved.status === 'ok' ? { price: resolved.price, currency: resolved.currency } : null;
  }

  const confirmRemove = (item: WatchlistItem) => {
    const label = (preferredLanguage === 'zh' && item.nameZh) ? item.nameZh : item.name;
    showAlert(
      '移除趨勢追蹤',
      `確定要從趨勢追蹤移除「${label}」嗎？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: () => removeCard(item.cardNumber) },
      ]
    );
  };

  const confirmRemoveAlert = (alert: PriceAlert) => {
    showAlert(
      '移除到價提醒',
      `確定要移除「${alert.name}（${alert.printingLabel || alert.printing}）」的期望入手價格提醒嗎？`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '移除',
          style: 'destructive',
          onPress: () => {
            removeAlert(alert.cardNumber, alert.printing);
            void syncAlertRemove(alert.cardNumber, alert.printing);
          },
        },
      ]
    );
  };

  const openDetail = (item: WatchlistItem) => {
    navigation.navigate('CardDetail', {
      card: {
        cardNumber: item.cardNumber,
        name: item.name,
        nameZh: item.nameZh,
        rarity: item.rarity,
        imageUrl: item.imageUrl,
      },
    });
  };

  const alertSection = (
    <View style={styles.section} testID="price-alert-section">
      <Text style={styles.sectionTitle}>{t('watchlist_title')}</Text>
      {alertList.length === 0 ? (
        <Text style={styles.sectionHint}>
          {t('watchlist_empty')}
        </Text>
      ) : (
        <>
          <Text style={styles.sectionHint}>
            比對該精確版本的玩家「參考售價」；不採用店家收購價或跨版本價格。
          </Text>
          {alertList.map((alert) => {
            const price = priceOf(alert);
            const status = evaluateAlertStatus(alert, price);
            return (
              <View
                key={`${alert.cardNumber}|${alert.printing}`}
                style={styles.alertRow}
                testID={`price-alert-row-${alert.cardNumber}|${alert.printing}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.alertName} numberOfLines={1}>{alert.name}</Text>
                  <Text style={styles.alertMeta}>
                    {alert.cardNumber} · {alert.printingLabel || alert.printing}
                  </Text>
                  <Text style={styles.alertInterval}>
                    期望入手 {formatInterval(alert)}
                  </Text>
                  <Text style={styles.alertStatus}>
                    {dbState === 'loading'
                      ? '目前價格：載入中…'
                      : dbState === 'unavailable'
                        ? '目前價格：價格資料無法載入'
                        : `目前 ${price ? formatAlertAmount(price.price, price.currency) : '—'} · ${ALERT_STATUS_LABELS[status]}`}
                  </Text>
                </View>
                <View style={styles.alertActions}>
                  <TouchableOpacity
                    onPress={() => setAlertTarget({
                      cardNumber: alert.cardNumber,
                      printing: alert.printing,
                      printingLabel: alert.printingLabel,
                      name: alert.name,
                      currency: alert.currency,
                      currentPrice: price && price.currency === alert.currency ? price.price : null,
                    })}
                    accessibilityRole="button"
                    accessibilityLabel={`編輯 ${alert.name} 的期望入手價格區間`}
                    testID={`price-alert-edit-${alert.cardNumber}|${alert.printing}`}
                  >
                    <Text style={styles.link}>編輯</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => confirmRemoveAlert(alert)}
                    accessibilityRole="button"
                    accessibilityLabel={`移除 ${alert.name} 的到價提醒`}
                    testID={`price-alert-delete-${alert.cardNumber}|${alert.printing}`}
                  >
                    <Text style={styles.destructive}>移除</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </>
      )}
    </View>
  );

  const renderItem = ({ item }: { item: WatchlistItem }) => {
    const label = (preferredLanguage === 'zh' && item.nameZh) ? item.nameZh : item.name;
    const subLabel = (preferredLanguage === 'zh' && item.nameZh) ? item.name : item.nameZh;
    const rarityColor = rarityColors[item.rarity] || '#6b7280';
    return (
      <TouchableOpacity style={[styles.row, numColumns > 1 && styles.rowGrid]} activeOpacity={0.8} onPress={() => openDetail(item)}>
        {item.imageUrl ? (
          <Image source={{ uri: item.imageUrl }} style={styles.thumb} resizeMode="contain" />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Text style={styles.thumbFallbackText}>{item.cardNumber}</Text>
          </View>
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{label}</Text>
          {subLabel ? <Text style={styles.subName} numberOfLines={1}>{subLabel}</Text> : null}
          <View style={styles.metaRow}>
            <View style={[styles.rarityBadge, { backgroundColor: rarityColor }]}>
              <Text style={styles.rarityText}>{item.rarity || '?'}</Text>
            </View>
            <Text style={styles.cardNumber}>{item.cardNumber}</Text>
          </View>
          {item.targetPrice != null ? (
            <Text style={styles.targetPrice}>🎯 舊版目標價（未指定版本）¥{item.targetPrice.toLocaleString()}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={styles.removeBtn} onPress={() => confirmRemove(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeBtnText}>✕</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  if (items.length === 0 && alertList.length === 0) {
    return (
      <SafeAreaView style={styles.emptyContainer} edges={['bottom']}>
        <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
        <Text style={styles.emptyIcon}>🔔</Text>
        <Text style={styles.emptyTitle}>{t('watchlist_title')}</Text>
        <Text style={styles.emptyHint}>{t('watchlist_empty')}</Text>
        <View style={styles.emptyActions}>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('Search')}>
            <Text style={styles.emptyBtnText}>🔍 {t('nav_search')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.emptyBtn, styles.emptyBtnAlt]} onPress={() => navigation.navigate('Scan')}>
            <Text style={styles.emptyBtnText}>📷 {t('nav_scan')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      <FlatList
        key={`cols-${numColumns}`}
        data={items}
        keyExtractor={(item) => item.cardNumber}
        renderItem={renderItem}
        numColumns={numColumns}
        columnWrapperStyle={numColumns > 1 ? styles.columnWrapper : undefined}
        contentContainerStyle={[styles.list, isDesktop && styles.listDesktop]}
        ListHeaderComponent={
          <View>
            {alertSection}
            <Text style={styles.sectionTitle}>趨勢追蹤（依卡號）</Text>
            <Text style={styles.header}>共 {items.length} 張追蹤中的卡牌</Text>
          </View>
        }
        ListEmptyComponent={
          <Text style={styles.sectionHint}>尚無趨勢追蹤的卡牌。</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  list: { padding: 16 },
  listDesktop: { maxWidth: 1100, width: '100%', alignSelf: 'center' },
  columnWrapper: { gap: 10 },
  header: { color: COLORS.textSecondary, fontSize: 13, marginBottom: 12 },

  section: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: COLORS.border + '55',
  },
  sectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  sectionHint: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18 },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    marginTop: 8,
  },
  alertName: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  alertMeta: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  alertInterval: { color: COLORS.success, fontSize: 12, marginTop: 3, fontWeight: '600' },
  alertStatus: { color: COLORS.primaryLight, fontSize: 12, marginTop: 2 },
  alertActions: { alignItems: 'flex-end', gap: 8 },
  link: { color: COLORS.primary, fontSize: 13 },
  destructive: { color: COLORS.error, fontSize: 13 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border + '55',
  },
  rowGrid: { flex: 1 },
  thumb: { width: 52, height: 73, borderRadius: 6, backgroundColor: COLORS.surfaceLight },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  thumbFallbackText: { color: COLORS.textSecondary, fontSize: 10, textAlign: 'center' },

  info: { flex: 1, marginLeft: 12 },
  name: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  subName: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  rarityBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5, marginRight: 8 },
  rarityText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  cardNumber: { color: COLORS.textSecondary, fontSize: 12 },
  targetPrice: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4 },

  removeBtn: {
    marginLeft: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '700' },

  emptyContainer: { flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  emptyHint: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
  emptyActions: { flexDirection: 'row', gap: 12 },
  emptyBtn: { backgroundColor: COLORS.primary, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10 },
  emptyBtnAlt: { backgroundColor: COLORS.secondary },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
