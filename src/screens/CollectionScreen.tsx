import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation, type TranslationKey } from '../i18n';
import { useDeckStore } from '../store/deckStore';
import { loadCardDatabase } from '../utils/deckCardData';
import { eligibleZone, ownershipKey, resolveExactPrice, type DeckCard, type DeckZone, type PriceRecord } from '../utils/deckRules';
import { PALETTE, SEMANTIC } from '../theme/tokensV2';
import { RouteShell } from '../components/shell';

type CollectionFilter = 'all' | 'owned' | DeckZone;

const FILTERS: Array<{ key: CollectionFilter; label: TranslationKey }> = [
  { key: 'all', label: 'collection_filter_all' },
  { key: 'owned', label: 'collection_filter_owned' },
  { key: 'oshi', label: 'collection_filter_oshi' },
  { key: 'main', label: 'collection_filter_main' },
  { key: 'yell', label: 'collection_filter_yell' },
];

function labelOf(card: DeckCard): string {
  return card.printingLabel?.trim() || card.printing;
}

function legacyCard(key: string): DeckCard {
  const separator = key.indexOf('|');
  const cardNumber = separator < 0 ? key : key.slice(0, separator);
  const printing = separator < 0 ? '' : key.slice(separator + 1);
  return {
    id: `legacy#${key}`,
    cardNumber,
    name: cardNumber,
    printing,
    printingLabel: printing,
    series: '',
  };
}

export default function CollectionScreen({ navigation }: any) {
  const { width } = useBreakpoint();
  const { t } = useTranslation();
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [priceRecords, setPriceRecords] = useState<PriceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CollectionFilter>('all');
  const collection = useDeckStore((state) => state.collection);
  const decks = useDeckStore((state) => state.decks);
  const adjustOwned = useDeckStore((state) => state.adjustOwned);
  const setOwned = useDeckStore((state) => state.setOwned);

  useEffect(() => {
    loadCardDatabase()
      .then((database) => { setCards(database.cards); setPriceRecords(database.priceRecords); })
      .catch(() => setCards([]))
      .finally(() => setLoading(false));
  }, []);

  const catalog = useMemo(() => {
    const byKey = new Map<string, DeckCard>();
    for (const card of cards) {
      byKey.set(ownershipKey(card.cardNumber, card.printing), card);
    }
    for (const key of Object.keys(collection)) {
      if (!byKey.has(key)) byKey.set(key, legacyCard(key));
    }
    return [...byKey.values()].sort((left, right) => (
      left.cardNumber.localeCompare(right.cardNumber)
      || labelOf(left).localeCompare(labelOf(right))
    ));
  }, [cards, collection]);

  const visibleCards = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return catalog.filter((card) => {
      const owned = collection[ownershipKey(card.cardNumber, card.printing)] || 0;
      if (filter === 'owned' && owned <= 0) return false;
      if (filter !== 'all' && filter !== 'owned' && eligibleZone(card) !== filter) return false;
      if (!needle) return true;
      return `${card.name} ${card.cardNumber} ${labelOf(card)}`.toLocaleLowerCase().includes(needle);
    });
  }, [catalog, collection, filter, query]);

  const ownedTotal = useMemo(
    () => Object.values(collection).reduce((total, quantity) => total + quantity, 0),
    [collection],
  );

  // Pen ej9RF stats hero — REAL numbers only: total value sums qty × the
  // exact-printing reference price (fail-closed: an unpriced printing adds
  // nothing and is counted separately). The Pen 交易紀錄 cell has no real
  // transaction log behind it, so the third cell is the honest 有報價版本
  // count instead of a fabricated number.
  const heroStats = useMemo(() => {
    let value = 0;
    let pricedKeys = 0;
    for (const [key, qty] of Object.entries(collection)) {
      if (qty <= 0) continue;
      const separator = key.indexOf('|');
      const cardNumber = separator < 0 ? key : key.slice(0, separator);
      const printing = separator < 0 ? '' : key.slice(separator + 1);
      const price = resolveExactPrice(cardNumber, printing, priceRecords);
      if (price.status === 'ok') {
        value += price.price * qty;
        pricedKeys += 1;
      }
    }
    return { value, pricedKeys };
  }, [collection, priceRecords]);

  // DIC-1409 Phase 5 — Pen `App / 08 收藏` (frame ej9RF) shared shell.
  const wrapInShell = (children: React.ReactNode) => (
    <RouteShell navigation={navigation} routeName="Collection" title={t('collection_title')} testID="collection-shell">
      {children}
    </RouteShell>
  );

  if (loading) {
    return wrapInShell(
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.muted}>{t('collection_loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return wrapInShell(
    <SafeAreaView style={styles.container}>
      {/* Pen ej9RF stats hero (node group at the top of the frame): real
          collection value + metric cells from the live ownership store. */}
      <View style={styles.statsHero} testID="collection-stats-hero">
        <Text style={styles.statsHeroLabel}>{t('collection_hero_value_label')}</Text>
        <Text style={styles.statsHeroValue}>
          {heroStats.value > 0 ? `¥${heroStats.value.toLocaleString()}` : '—'}
        </Text>
        <View style={styles.statsHeroCells}>
          <View style={styles.statsHeroCell}>
            <Text style={styles.statsHeroCellLabel}>{t('collection_hero_cards')}</Text>
            <Text style={styles.statsHeroCellValue}>{ownedTotal}</Text>
          </View>
          <View style={styles.statsHeroCell}>
            <Text style={styles.statsHeroCellLabel}>{t('collection_hero_decks')}</Text>
            <Text style={styles.statsHeroCellValue}>{decks.length}</Text>
          </View>
          <View style={styles.statsHeroCell}>
            <Text style={styles.statsHeroCellLabel}>{t('collection_hero_priced')}</Text>
            <Text style={styles.statsHeroCellValue}>{heroStats.pricedKeys}</Text>
          </View>
        </View>
      </View>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t('collection_title')}</Text>
          <Text style={styles.total} testID="collection-owned-total">{t('collection_total', { count: ownedTotal })}</Text>
        </View>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={t('collection_search_placeholder')}
          placeholderTextColor={COLORS.textSecondary}
          accessibilityLabel={t('collection_search_a11y')}
          testID="collection-search"
        />
        <View style={styles.filters} testID="collection-filters">
          {FILTERS.map((item) => {
            const active = filter === item.key;
            return (
              <TouchableOpacity
                key={item.key}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setFilter(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                testID={`collection-filter-${item.key}`}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>{t(item.label)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <FlatList
        data={visibleCards}
        keyExtractor={(card) => ownershipKey(card.cardNumber, card.printing)}
        contentContainerStyle={styles.list}
        initialNumToRender={18}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={styles.empty}>{t('collection_empty')}</Text>}
        renderItem={({ item }) => {
          const key = ownershipKey(item.cardNumber, item.printing);
          const quantity = collection[key] || 0;
          return (
            <View style={styles.cardRow} testID={`collection-card-${key}`}>
              <TouchableOpacity
                style={styles.cardInfo}
                onPress={() => navigation.navigate('CardDetail', { card: item })}
                accessibilityRole="button"
                accessibilityLabel={t('collection_view_a11y', { name: item.name, version: labelOf(item) })}
              >
                {item.imageUrl ? (
                  <Image
                    source={{ uri: item.imageUrl }}
                    style={[styles.image, width <= 390 && styles.imageSmall]}
                    resizeMode="contain"
                    accessibilityLabel={t('collection_image_a11y', { name: item.name, version: labelOf(item) })}
                  />
                ) : (
                  <View style={[styles.image, styles.imageFallback, width <= 390 && styles.imageSmall]}>
                    <Text style={styles.imageFallbackText}>{item.cardNumber}</Text>
                  </View>
                )}
                <View style={styles.cardCopy}>
                  <Text style={styles.cardName} numberOfLines={2}>{item.name}</Text>
                  <Text style={styles.cardNumber}>{item.cardNumber}</Text>
                  <Text style={styles.printing} numberOfLines={2}>{labelOf(item)}</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.controls}>
                <View style={styles.quantityRow}>
                  <TouchableOpacity
                    style={styles.quantityButton}
                    onPress={() => adjustOwned(item.cardNumber, item.printing, -1)}
                    disabled={quantity <= 0}
                    accessibilityRole="button"
                    accessibilityLabel={t('deck_collection_decrease_a11y', { name: item.name })}
                    testID={`collection-dec-${key}`}
                  >
                    <Text style={[styles.quantityButtonText, quantity <= 0 && styles.disabled]}>－</Text>
                  </TouchableOpacity>
                  <Text style={styles.quantity} testID={`collection-qty-${key}`}>{quantity}</Text>
                  <TouchableOpacity
                    style={styles.quantityButton}
                    onPress={() => adjustOwned(item.cardNumber, item.printing, 1)}
                    accessibilityRole="button"
                    accessibilityLabel={t('deck_collection_increase_a11y', { name: item.name })}
                    testID={`collection-inc-${key}`}
                  >
                    <Text style={styles.quantityButtonText}>＋</Text>
                  </TouchableOpacity>
                </View>
                {quantity > 0 && (
                  <TouchableOpacity
                    onPress={() => setOwned(item.cardNumber, item.printing, 0)}
                    accessibilityRole="button"
                    accessibilityLabel={t('deck_collection_remove_a11y', { name: item.name })}
                    testID={`collection-remove-${key}`}
                  >
                    <Text style={styles.remove}>{t('common_remove')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Pen ej9RF stats hero
  statsHero: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: PALETTE.appSurface,
    gap: 6,
  },
  statsHeroLabel: { color: SEMANTIC.onBgDim, fontSize: 12 },
  statsHeroValue: { color: SEMANTIC.onBg, fontSize: 30, fontWeight: '700' },
  statsHeroCells: { flexDirection: 'row', gap: 10, marginTop: 6 },
  statsHeroCell: { flex: 1, backgroundColor: PALETTE.appElev, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  statsHeroCellLabel: { color: SEMANTIC.onBgDim, fontSize: 10 },
  statsHeroCellValue: { color: SEMANTIC.onBg, fontSize: 15, fontWeight: '700' },
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 14, paddingBottom: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: COLORS.text, fontSize: 22, fontWeight: '800' },
  total: { color: COLORS.primaryLight, fontSize: 13, fontWeight: '700' },
  search: { minHeight: 44, backgroundColor: COLORS.surfaceLight, color: COLORS.text, borderRadius: 9, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 12 },
  filters: { flexDirection: 'row', gap: 6, marginTop: 10 },
  filterChip: { flex: 1, minWidth: 0, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  filterChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  filterText: { color: COLORS.textSecondary, fontSize: 11, fontWeight: '700' },
  filterTextActive: { color: '#fff' },
  list: { padding: 12, paddingBottom: 28 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginBottom: 10, borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface },
  cardInfo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  image: { width: 72, height: 100, borderRadius: 7, backgroundColor: COLORS.surfaceLight },
  imageSmall: { width: 58, height: 82 },
  imageFallback: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  imageFallbackText: { color: COLORS.textSecondary, fontSize: 10, textAlign: 'center' },
  cardCopy: { flex: 1, minWidth: 0 },
  cardName: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  cardNumber: { color: COLORS.primaryLight, fontSize: 12, fontWeight: '700', marginTop: 4 },
  printing: { color: COLORS.textSecondary, fontSize: 11, marginTop: 3 },
  controls: { width: 112, alignItems: 'center', gap: 7 },
  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  quantityButton: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  quantityButtonText: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  quantity: { minWidth: 24, color: COLORS.text, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  remove: { color: COLORS.error, fontSize: 12, fontWeight: '700' },
  disabled: { color: COLORS.border },
  muted: { color: COLORS.textSecondary, fontSize: 13, marginTop: 8 },
  empty: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center', paddingVertical: 40 },
});
