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
import { useTranslation } from '../i18n';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { syncAlertRemove } from '../services/priceAlertSync';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import {
  buildPrintingIndex, resolvePrintingImage,
  type PendingAlert, type PrintingOption,
} from '../utils/alertMigration';
import {
  evaluateAlertStatus, formatAlertAmount, formatInterval,
  type AlertPrice, type PriceAlert, type AlertStatus,
} from '../utils/priceAlerts';

type DbState = 'loading' | 'ready' | 'unavailable';

type Row =
  | { kind: 'pending'; key: string; item: PendingAlert }
  | { kind: 'alert'; key: string; alert: PriceAlert };

export default function WatchlistScreen({ navigation }: any) {
  const { t } = useTranslation();
  const legacyTracked = useWatchlistStore((s) => s.items);
  const clearLegacyTracked = useWatchlistStore((s) => s.clearAll);
  const alerts = usePriceAlertStore((s) => s.alerts);
  const pending = usePriceAlertStore((s) => s.pending);
  const removeAlert = usePriceAlertStore((s) => s.removeAlert);
  const dismissPending = usePriceAlertStore((s) => s.dismissPending);
  const importLegacyTracking = usePriceAlertStore((s) => s.importLegacyTracking);
  const { isDesktop, isWide } = useBreakpoint();
  const numColumns = isWide ? 3 : isDesktop ? 2 : 1;

  const [db, setDb] = useState<CardDatabase | null>(null);
  const [dbState, setDbState] = useState<DbState>('loading');
  const [alertTarget, setAlertTarget] = useState<PriceAlertTarget | null>(null);
  const statusLabel = (status: AlertStatus) => t(`watchlist_status_${status.toLowerCase()}` as Parameters<typeof t>[0]);
  const pendingPrompt = (item: PendingAlert) => t('watchlist_pending_prompt', {
    needs: item.needs
      .map((need) => t(`watchlist_pending_need_${need.toLowerCase()}` as Parameters<typeof t>[0]))
      .join('、'),
  });

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
      t('watchlist_remove_alert'),
      t('watchlist_remove_alert_confirm', { name: alert.name, printing: alert.printingLabel || alert.printing }),
      [
        { text: t('common_cancel'), style: 'cancel' },
        {
          text: t('common_remove'),
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
      t('watchlist_remove_alert'),
      t('watchlist_remove_pending_confirm', { name: item.name }),
      [
        { text: t('common_cancel'), style: 'cancel' },
        { text: t('common_remove'), style: 'destructive', onPress: () => dismissPending(item.cardNumber) },
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
        style={[styles.row, numColumns > 1 && styles.rowGrid]}
        testID={`price-alert-row-${alert.cardNumber}|${alert.printing}`}
      >
        {thumb(image, alert.cardNumber)}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{alert.name}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {alert.cardNumber} · {alert.printingLabel || alert.printing}
          </Text>
          <Text style={styles.interval}>
            {t('watchlist_desired_interval', { interval: formatInterval(alert) })}
          </Text>
          <Text style={styles.status} testID={`price-alert-status-${alert.cardNumber}|${alert.printing}`}>
            {dbState === 'loading'
              ? t('watchlist_price_loading')
              : dbState === 'unavailable'
                ? t('watchlist_price_unavailable')
                : price
                  ? t('watchlist_current_price', {
                      price: formatAlertAmount(price.price, price.currency),
                      status: statusLabel(status),
                    })
                  : t('watchlist_current_unpriced', {
                      status: statusLabel(status),
                    })}
          </Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.action}
            onPress={() => editAlert(alert)}
            accessibilityRole="button"
            accessibilityLabel={t('watchlist_edit_a11y', { name: alert.name })}
            testID={`price-alert-edit-${alert.cardNumber}|${alert.printing}`}
          >
            <Text style={styles.link}>{t('common_edit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.action}
            onPress={() => confirmRemoveAlert(alert)}
            accessibilityRole="button"
            accessibilityLabel={t('watchlist_remove_a11y', { name: alert.name })}
            testID={`price-alert-delete-${alert.cardNumber}|${alert.printing}`}
          >
            <Text style={styles.destructive}>{t('common_remove')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderPending = (item: PendingAlert) => (
    <View
      style={[styles.row, styles.rowPending, numColumns > 1 && styles.rowGrid]}
      testID={`price-alert-pending-${item.cardNumber}`}
    >
      {thumb(undefined, item.cardNumber)}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{item.cardNumber}</Text>
        <Text style={styles.pendingPrompt}>{pendingPrompt(item)}</Text>
        {item.legacyTargetPrice !== null && (
          <Text style={styles.status}>
            {t('watchlist_previous_target', { price: item.legacyTargetPrice.toLocaleString('en-US') })}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.action}
          onPress={() => resolvePending(item)}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist_resolve_a11y', { name: item.name })}
          testID={`price-alert-resolve-${item.cardNumber}`}
        >
          <Text style={styles.link}>{t('watchlist_set')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          onPress={() => confirmRemovePending(item)}
          accessibilityRole="button"
          accessibilityLabel={t('watchlist_remove_a11y', { name: item.name })}
          testID={`price-alert-pending-delete-${item.cardNumber}`}
        >
          <Text style={styles.destructive}>{t('common_remove')}</Text>
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
        <Text style={styles.emptyTitle}>{t('watchlist_empty_title')}</Text>
        <Text style={styles.emptyHint}>{t('watchlist_empty_detail')}</Text>
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
            <Text style={styles.sectionTitle}>{t('watchlist_title')}</Text>
            <Text style={styles.sectionHint}>{t('watchlist_exact_price_hint')}</Text>
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
  rowGrid: { flex: 1 },
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
