/**
 * 到價提醒 — the one alert list (DIC-1087).
 *
 * There used to be two lists here: exact-version 到價提醒 and a card-number
 * 趨勢追蹤 list. They were the same idea told twice, so the card-number list is
 * gone. Rows migrated from it that the catalog could not resolve to a single
 * printing stay in THIS list as unresolved rows and ask for the version instead
 * of being guessed onto one.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Image, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { showAlert } from '../utils/platformAlert';
import { useWatchlistStore } from '../stores/watchlistStore';
import { usePriceAlertStore, sortedAlerts, sortedPending } from '../stores/priceAlertStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { syncAlertRemove } from '../services/priceAlertSync';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import {
  buildPrintingIndex, pendingPrompt, resolvePrintingImage,
  type PendingAlert, type PrintingOption,
} from '../utils/alertMigration';
import {
  evaluateAlertStatus, formatAlertAmount, formatInterval, ALERT_STATUS_LABELS,
  type AlertPrice, type PriceAlert,
} from '../utils/priceAlerts';
import { uniformGridItemStyle } from '../utils/gridLayout';

type DbState = 'loading' | 'ready' | 'unavailable';

type Row =
  | { kind: 'pending'; key: string; item: PendingAlert }
  | { kind: 'alert'; key: string; alert: PriceAlert };

export default function WatchlistScreen({ navigation }: any) {
  const legacyTracked = useWatchlistStore((s) => s.items);
  const clearLegacyTracked = useWatchlistStore((s) => s.clearAll);
  const alerts = usePriceAlertStore((s) => s.alerts);
  const pending = usePriceAlertStore((s) => s.pending);
  const removeAlert = usePriceAlertStore((s) => s.removeAlert);
  const dismissPending = usePriceAlertStore((s) => s.dismissPending);
  const importLegacyTracking = usePriceAlertStore((s) => s.importLegacyTracking);
  const { isDesktop, isWide } = useBreakpoint();
  const numColumns = isWide ? 3 : isDesktop ? 2 : 1;
  const gridItemStyle = useMemo(() => uniformGridItemStyle(numColumns), [numColumns]);

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

  const printingIndex = useMemo(
    () => (db ? buildPrintingIndex(db.cards, db.priceRecords) : new Map<string, PrintingOption[]>()),
    [db],
  );

  // Fold the old card-number list in as soon as the catalog can say how many
  // printings each card number has. Nothing is lost when it cannot: an
  // unresolvable row becomes a pending row carrying its name, art and old target
  // price, so clearing the legacy store is safe.
  useEffect(() => {
    if (dbState !== 'ready' || legacyTracked.length === 0) return;
    importLegacyTracking(legacyTracked, printingIndex);
    clearLegacyTracked();
  }, [dbState, legacyTracked, printingIndex, importLegacyTracking, clearLegacyTracked]);

  const rows: Row[] = useMemo(() => [
    ...sortedPending(pending).map((item) => ({ kind: 'pending' as const, key: `pending:${item.cardNumber}`, item })),
    ...sortedAlerts(alerts).map((alert) => ({
      kind: 'alert' as const, key: `alert:${alert.cardNumber}|${alert.printing}`, alert,
    })),
  ], [alerts, pending]);

  /** Exact (cardNumber, printing) reference SELL price. Never a cross-version or
   *  same-name fallback — an unmatched printing simply has no price. */
  function priceOf(alert: PriceAlert): AlertPrice | null {
    const option = printingIndex.get(alert.cardNumber)?.find((o) => o.printing === alert.printing);
    if (!option || option.sellPrice === null) return null;
    return { price: option.sellPrice, currency: option.currency };
  }

  const editAlert = (alert: PriceAlert) => {
    const price = priceOf(alert);
    setAlertTarget({
      cardNumber: alert.cardNumber,
      printing: alert.printing,
      printingLabel: alert.printingLabel,
      name: alert.name,
      currency: alert.currency,
      currentPrice: price && price.currency === alert.currency ? price.price : null,
      imageUrl: resolvePrintingImage(alert.cardNumber, alert.printing, printingIndex),
    });
  };

  const resolvePending = (item: PendingAlert) => {
    setAlertTarget({
      cardNumber: item.cardNumber,
      printing: null,
      printingLabel: '',
      name: item.name,
      currency: '',
      currentPrice: null,
      imageUrl: undefined,
      choices: printingIndex.get(item.cardNumber) ?? [],
      suggestedUpper: item.legacyTargetPrice,
    });
  };

  const confirmRemoveAlert = (alert: PriceAlert) => {
    showAlert(
      '移除到價提醒',
      `確定要移除「${alert.name}（${alert.printingLabel || alert.printing}）」的到價提醒嗎？`,
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

  const confirmRemovePending = (item: PendingAlert) => {
    showAlert(
      '移除到價提醒',
      `「${item.name}」尚未選定版本，確定要移除嗎？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: () => dismissPending(item.cardNumber) },
      ]
    );
  };

  const thumb = (uri: string | undefined, fallback: string) => (
    uri ? (
      <Image
        source={{ uri }}
        style={styles.thumb}
        resizeMode="contain"
        testID={`price-alert-thumb-image-${fallback}`}
      />
    ) : (
      <View
        style={[styles.thumb, styles.thumbFallback]}
        testID={`price-alert-thumb-placeholder-${fallback}`}
      >
        <Text style={styles.thumbFallbackText}>{fallback}</Text>
      </View>
    )
  );

  const renderAlert = (alert: PriceAlert) => {
    const price = priceOf(alert);
    const status = evaluateAlertStatus(alert, price);
    const image = resolvePrintingImage(alert.cardNumber, alert.printing, printingIndex);
    return (
      <View
        style={[styles.row, gridItemStyle]}
        testID={`price-alert-row-${alert.cardNumber}|${alert.printing}`}
      >
        {thumb(image, alert.cardNumber)}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{alert.name}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {alert.cardNumber} · {alert.printingLabel || alert.printing}
          </Text>
          <Text style={styles.interval}>期望入手 {formatInterval(alert)}</Text>
          <Text style={styles.status} testID={`price-alert-status-${alert.cardNumber}|${alert.printing}`}>
            {dbState === 'loading'
              ? '目前參考售價：載入中'
              : dbState === 'unavailable'
                ? '目前參考售價：價格資料無法載入'
                : price
                  ? `目前參考售價 ${formatAlertAmount(price.price, price.currency)}・${ALERT_STATUS_LABELS[status]}`
                  : `目前參考售價：暫無資料・${ALERT_STATUS_LABELS[status]}`}
          </Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.action}
            onPress={() => editAlert(alert)}
            accessibilityRole="button"
            accessibilityLabel={`編輯 ${alert.name} 的到價提醒`}
            testID={`price-alert-edit-${alert.cardNumber}|${alert.printing}`}
          >
            <Text style={styles.link}>編輯</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.action}
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
  };

  const renderPending = (item: PendingAlert) => (
    <View
      style={[styles.row, styles.rowPending, gridItemStyle]}
      testID={`price-alert-pending-${item.cardNumber}`}
    >
      {thumb(undefined, item.cardNumber)}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{item.cardNumber}</Text>
        <Text style={styles.pendingPrompt}>{pendingPrompt(item)}</Text>
        {item.legacyTargetPrice !== null && (
          <Text style={styles.status}>先前的目標價 {item.legacyTargetPrice.toLocaleString('en-US')}，選定版本後即可套用</Text>
        )}
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.action}
          onPress={() => resolvePending(item)}
          accessibilityRole="button"
          accessibilityLabel={`設定 ${item.name} 的到價提醒版本與價格區間`}
          testID={`price-alert-resolve-${item.cardNumber}`}
        >
          <Text style={styles.link}>設定</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          onPress={() => confirmRemovePending(item)}
          accessibilityRole="button"
          accessibilityLabel={`移除 ${item.name}`}
          testID={`price-alert-pending-delete-${item.cardNumber}`}
        >
          <Text style={styles.destructive}>移除</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const editor = <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />;

  if (rows.length === 0) {
    return (
      <SafeAreaView style={styles.emptyContainer} edges={['bottom']} testID="price-alert-empty">
        {editor}
        <Text style={styles.emptyIcon}>🔔</Text>
        <Text style={styles.emptyTitle}>還沒有到價提醒</Text>
        <Text style={styles.emptyHint}>
          選定卡片的精確版本並設定期望入手價格區間，{'\n'}
          價格進入區間時就會通知你。
        </Text>
        <View style={styles.emptyActions}>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('Search')}>
            <Text style={styles.emptyBtnText}>🔍 前往搜尋</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.emptyBtn, styles.emptyBtnAlt]} onPress={() => navigation.navigate('Scan')}>
            <Text style={styles.emptyBtnText}>📷 掃描卡牌</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      {editor}
      <FlatList
        key={`cols-${numColumns}`}
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => (item.kind === 'pending' ? renderPending(item.item) : renderAlert(item.alert))}
        numColumns={numColumns}
        columnWrapperStyle={numColumns > 1 ? styles.columnWrapper : undefined}
        contentContainerStyle={[styles.list, isDesktop && styles.listDesktop]}
        ListHeaderComponent={
          <View testID="price-alert-section">
            <Text style={styles.sectionTitle}>到價提醒</Text>
            <Text style={styles.sectionHint}>
              比對你選定版本的玩家「參考售價」；不採用店家收購價或跨版本價格。價格進入區間時通知一次。
            </Text>
          </View>
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

  sectionTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700', marginBottom: 6 },
  sectionHint: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 14 },

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
  rowPending: { borderColor: COLORS.primary + '99' },
  thumb: { width: 52, height: 73, borderRadius: 6, backgroundColor: COLORS.surfaceLight },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  thumbFallbackText: { color: COLORS.textSecondary, fontSize: 10, textAlign: 'center' },

  info: { flex: 1, marginLeft: 12 },
  name: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  meta: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  interval: { color: COLORS.success, fontSize: 12, marginTop: 4, fontWeight: '600' },
  status: { color: COLORS.primaryLight, fontSize: 12, marginTop: 2 },
  pendingPrompt: { color: COLORS.primary, fontSize: 12, marginTop: 4, fontWeight: '600' },

  actions: { alignItems: 'flex-end', marginLeft: 8 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  link: { color: COLORS.primary, fontSize: 13 },
  destructive: { color: COLORS.error, fontSize: 13 },

  emptyContainer: { flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  emptyHint: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
  emptyActions: { flexDirection: 'row', gap: 12 },
  emptyBtn: { backgroundColor: COLORS.primary, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, minHeight: 44, justifyContent: 'center' },
  emptyBtnAlt: { backgroundColor: COLORS.secondary },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
