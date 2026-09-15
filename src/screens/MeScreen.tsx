import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Platform } from 'react-native';
import { AppShell, buildShellTabs } from '../components/shell';
import { PALETTE, SEMANTIC, FONTS, RADII, SPACING } from '../theme/tokensV2';
import { SearchGlyph } from '../components/shell/icons';
import { useTranslation } from '../i18n';
import { useDeckStore } from '../store/deckStore';
import { useAuthStore } from '../stores/authStore';
import { useWatchlistStore } from '../stores/watchlistStore';
import { useSettingsStore } from '../store/settingsStore';
import { FEATURES } from '../config/releaseFlags';
import { loadCardDatabase } from '../utils/deckCardData';
import { ownershipKey, type DeckCard, type PriceRecord } from '../utils/deckRules';
import { convertPrice } from '../constants';

/** ownershipKey = `cardNumber|version` (deckRules DIC-978). When the catalog
 * row is loaded we pass its exact fields; for legacy keys split the key. */
function stepOwned(
  adjustOwned: (cardNumber: string, version: string, delta: number) => void,
  key: string,
  card: DeckCard | undefined,
  delta: number,
): void {
  if (card) {
    adjustOwned(card.cardNumber, card.printing, delta);
    return;
  }
  const sep = key.indexOf('|');
  adjustOwned(sep >= 0 ? key.slice(0, sep) : key, sep >= 0 ? key.slice(sep + 1) : '', delta);
}

/**
 * DIC-1427 CR/QA repair — Pen `App / 07 我的` (frame siVsa): the Me tab is the
 * COLLECTION HUB, not a settings page. Structure per Pen: app bar (我的 +
 * settings gear xQIU2/amD3P), account card (ZYJRw), three stat cells (vGwTI:
 * 收藏張數 / 收藏市值 / 到價提醒), segment row (oaxgt: 收藏 / 到價提醒 /
 * 趨勢追蹤 → the real Collection / Watchlist / Favorites routes), search
 * field (WUovy → Collection), owned rows with real qty steppers (x8bEnt…).
 * All data comes from the live deckStore collection, watchlist and auth
 * stores; steppers call the real adjustOwned action.
 */
export default function MeScreen({ navigation }: any) {
  const { t } = useTranslation();
  const collection = useDeckStore((s) => s.collection);
  const adjustOwned = useDeckStore((s) => s.adjustOwned);
  const watchlistCount = useWatchlistStore((s) => s.items.length);
  const session = useAuthStore((s) => s.session);
  const { preferredCurrency } = useSettingsStore();
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [priceRecords, setPriceRecords] = useState<PriceRecord[]>([]);

  useEffect(() => {
    let alive = true;
    loadCardDatabase()
      .then((db) => {
        if (!alive) return;
        setCards(db.cards);
        setPriceRecords(db.priceRecords);
      })
      .catch(() => { if (alive) { setCards([]); setPriceRecords([]); } });
    return () => { alive = false; };
  }, []);

  const byKey = useMemo(() => {
    const map = new Map<string, DeckCard>();
    for (const card of cards) map.set(ownershipKey(card.cardNumber, card.printing), card);
    return map;
  }, [cards]);

  // Version-precise pricing only (DIC-945 #6): an owned printing counts into
  // the collection value only when its exact printing has a real price record.
  const priceByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const rec of priceRecords) {
      if (typeof rec.price === 'number') map.set(ownershipKey(rec.cardNumber, rec.version), rec.price);
    }
    return map;
  }, [priceRecords]);

  const ownedEntries = useMemo(() => (
    Object.entries(collection)
      .filter(([, qty]) => qty > 0)
      .map(([key, qty]) => ({ key, qty, card: byKey.get(key) }))
      .sort((a, b) => b.qty - a.qty || a.key.localeCompare(b.key))
  ), [collection, byKey]);

  const totalOwned = useMemo(
    () => ownedEntries.reduce((sum, e) => sum + e.qty, 0),
    [ownedEntries],
  );
  const totalValue = useMemo(() => (
    ownedEntries.reduce((sum, e) => sum + (priceByKey.get(e.key) ?? 0) * e.qty, 0)
  ), [ownedEntries, priceByKey]);

  const formatValue = (jpy: number): string => {
    if (preferredCurrency === 'JPY') return `¥${jpy.toLocaleString()}`;
    const { value, symbol } = convertPrice(jpy, preferredCurrency as Parameters<typeof convertPrice>[1]);
    return `${symbol}${value?.toLocaleString() || '0'}`;
  };

  const shellTabs = useMemo(() => buildShellTabs({ navigation }), [navigation]);
  const accountName = session?.user?.name || session?.user?.email || t('me_guest_name' as any);
  const accountHint = session ? t('me_account_manage' as any) : t('me_guest_hint' as any);

  const segments: Array<{ key: string; label: string; route: string; enabled: boolean }> = [
    { key: 'collection', label: t('nav_collection' as any), route: 'Collection', enabled: true },
    { key: 'watchlist', label: t('nav_watchlist' as any), route: 'Watchlist', enabled: FEATURES.watchlist },
    { key: 'trends', label: t('me_seg_trends' as any), route: 'Favorites', enabled: FEATURES.favorites },
  ];

  return (
    <AppShell
      appBar={{
        showBrand: false,
        title: t('nav_me' as any),
        actions: [
          {
            key: 'settings',
            label: t('nav_settings' as any),
            icon: <Text style={styles.gearGlyph}>⚙</Text>,
            onPress: () => navigation.navigate('Settings'),
            testID: 'me-settings-action',
          },
        ],
      }}
      bottomTabBar={{ items: shellTabs, activeKey: 'me' }}
      contentPadding={false}
      testID="me-shell"
    >
      <View style={styles.body}>
        {/* Pen ZYJRw — account card */}
        <TouchableOpacity
          style={styles.accountCard}
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          testID="me-account-card"
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarGlyph}>{String(accountName).slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={styles.accountText}>
            <Text style={styles.accountName} numberOfLines={1} testID="me-account-name">{accountName}</Text>
            <Text style={styles.accountHint} numberOfLines={1}>{accountHint}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>

        {/* Pen vGwTI — stat cells over live stores */}
        <View style={styles.statsRow} testID="me-stats">
          <View style={styles.statCell} testID="me-stat-owned">
            <Text style={styles.statValue}>{totalOwned}</Text>
            <Text style={styles.statLabel}>{t('me_stat_owned' as any)}</Text>
          </View>
          <View style={styles.statCell} testID="me-stat-value">
            <Text style={styles.statValue} numberOfLines={1}>{formatValue(totalValue)}</Text>
            <Text style={styles.statLabel}>{t('me_stat_value' as any)}</Text>
          </View>
          <View style={styles.statCell} testID="me-stat-alerts">
            <Text style={styles.statValue}>{watchlistCount}</Text>
            <Text style={styles.statLabel}>{t('nav_watchlist' as any)}</Text>
          </View>
        </View>

        {/* Pen oaxgt — segment row routing to the real hub destinations */}
        <View style={styles.segmentRow} testID="me-segments">
          {segments.filter((s) => s.enabled).map((seg) => (
            <TouchableOpacity
              key={seg.key}
              style={styles.segment}
              onPress={() => navigation.navigate(seg.route)}
              accessibilityRole="button"
              testID={`me-segment-${seg.key}`}
            >
              <Text style={styles.segmentLabel}>{seg.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Pen WUovy — search into the collection browser */}
        <TouchableOpacity
          style={styles.searchField}
          onPress={() => navigation.navigate('Collection')}
          accessibilityRole="button"
          testID="me-search-field"
        >
          <SearchGlyph color={PALETTE.textMuted} size={16} />
          <Text style={styles.searchPlaceholder}>{t('collection_search_placeholder' as any)}</Text>
        </TouchableOpacity>

        {/* Pen x8bEnt… — owned rows with REAL qty steppers */}
        {ownedEntries.length === 0 ? (
          <View style={styles.emptyBox} testID="me-owned-empty">
            <Text style={styles.emptyTitle}>{t('me_empty_title' as any)}</Text>
            <Text style={styles.emptyHint}>{t('me_empty_hint' as any)}</Text>
            <TouchableOpacity
              style={styles.emptyCta}
              onPress={() => navigation.navigate('Scan')}
              accessibilityRole="button"
              testID="me-empty-scan"
            >
              <Text style={styles.emptyCtaLabel}>{t('nav_scan' as any)}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {ownedEntries.slice(0, 6).map(({ key, qty, card }) => (
              <View key={key} style={styles.ownedRow} testID="me-owned-row">
                <View style={styles.thumb}>
                  {card?.imageUrl ? (
                    <Image source={{ uri: card.imageUrl }} style={styles.thumbImg} />
                  ) : (
                    <Text style={styles.thumbFallback}>{(card?.name || key).slice(0, 1)}</Text>
                  )}
                </View>
                <View style={styles.ownedText}>
                  <Text style={styles.ownedName} numberOfLines={1}>{card?.name || key}</Text>
                  <Text style={styles.ownedMeta} numberOfLines={1}>
                    {(card?.cardNumber || key)}{priceByKey.has(key) ? ` · ${formatValue(priceByKey.get(key)!)}` : ''}
                  </Text>
                </View>
                <View style={styles.stepper}>
                  <TouchableOpacity
                    style={styles.stepBtn}
                    onPress={() => stepOwned(adjustOwned, key, card, -1)}
                    accessibilityRole="button"
                    testID={`me-owned-minus-${key}`}
                  >
                    <Text style={styles.stepGlyph}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.stepQty} testID={`me-owned-qty-${key}`}>{qty}</Text>
                  <TouchableOpacity
                    style={styles.stepBtn}
                    onPress={() => stepOwned(adjustOwned, key, card, 1)}
                    accessibilityRole="button"
                    testID={`me-owned-plus-${key}`}
                  >
                    <Text style={styles.stepGlyph}>＋</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            <TouchableOpacity
              style={styles.viewAll}
              onPress={() => navigation.navigate('Collection')}
              accessibilityRole="button"
              testID="me-view-all"
            >
              <Text style={styles.viewAllLabel}>{t('me_view_all' as any)}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, gap: 14 },
  gearGlyph: { fontSize: 18, lineHeight: 20, color: SEMANTIC.onBgMuted },
  // Pen ZYJRw account card: $app-surface, avatar 44 gradient tile.
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: RADII.md,
    padding: 14,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: RADII.md,
    backgroundColor: PALETTE.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? ({ backgroundImage: `linear-gradient(150deg, ${PALETTE.accent} 0%, ${PALETTE.accent3} 100%)` } as object)
      : null),
  },
  avatarGlyph: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  accountText: { flex: 1, minWidth: 0, gap: 3 },
  accountName: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 15, fontWeight: '700', color: SEMANTIC.onBg,
  },
  accountHint: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12, color: PALETTE.textSecondary,
  },
  chevron: { fontSize: 22, color: PALETTE.textMuted, lineHeight: 24 },
  // Pen vGwTI stat cells 113×64.
  statsRow: { flexDirection: 'row', gap: 9 },
  statCell: {
    flex: 1,
    height: 64,
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: RADII.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  statValue: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 16, fontWeight: '800', color: SEMANTIC.onBg,
  },
  statLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 11, color: PALETTE.textSecondary,
  },
  // Pen oaxgt segment row.
  segmentRow: {
    flexDirection: 'row',
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: RADII.md,
    padding: 3,
    gap: 2,
  },
  segment: {
    flex: 1,
    height: 36,
    borderRadius: RADII.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12.5, fontWeight: '600', color: PALETTE.textSecondary,
  },
  // Pen WUovy search field.
  searchField: {
    height: 40,
    borderRadius: RADII.md,
    backgroundColor: PALETTE.appElev,
    borderWidth: 1,
    borderColor: PALETTE.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
  },
  searchPlaceholder: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12.5, color: PALETTE.textMuted,
  },
  // Pen owned rows: thumb 34×47 + text + stepper 84×30.
  ownedRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
  thumb: {
    width: 34, height: 47, borderRadius: 4,
    backgroundColor: PALETTE.appElev,
    borderWidth: 1, borderColor: PALETTE.border,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%', resizeMode: 'cover' },
  thumbFallback: { color: PALETTE.textMuted, fontSize: 13, fontWeight: '700' },
  ownedText: { flex: 1, minWidth: 0, gap: 2 },
  ownedName: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 13.5, fontWeight: '600', color: SEMANTIC.onBg,
  },
  ownedMeta: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 11.5, color: PALETTE.textSecondary,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PALETTE.appElev,
    borderRadius: RADII.pill,
    borderWidth: 1,
    borderColor: PALETTE.border,
    height: 30,
    paddingHorizontal: 4,
    gap: 2,
  },
  stepBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { color: SEMANTIC.onBg, fontSize: 15, fontWeight: '700', lineHeight: 17 },
  stepQty: {
    minWidth: 18, textAlign: 'center',
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 13, fontWeight: '700', color: SEMANTIC.onBg,
  },
  emptyBox: {
    alignItems: 'center', gap: 8, paddingVertical: 28,
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1, borderColor: PALETTE.border, borderRadius: RADII.md,
  },
  emptyTitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 14, fontWeight: '700', color: SEMANTIC.onBg,
  },
  emptyHint: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12, color: PALETTE.textSecondary, textAlign: 'center', paddingHorizontal: 16,
  },
  emptyCta: {
    marginTop: 6, paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: RADII.pill, backgroundColor: PALETTE.accent,
  },
  emptyCtaLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  viewAll: { alignItems: 'center', paddingVertical: 8 },
  viewAllLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12.5, fontWeight: '600', color: PALETTE.accent2,
  },
});
