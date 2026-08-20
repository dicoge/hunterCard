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
import { eligibleZone, ownershipKey, type DeckCard, type DeckZone } from '../utils/deckRules';

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
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CollectionFilter>('all');
  const collection = useDeckStore((state) => state.collection);
  const adjustOwned = useDeckStore((state) => state.adjustOwned);
  const setOwned = useDeckStore((state) => state.setOwned);

  useEffect(() => {
    loadCardDatabase()
      .then((database) => setCards(database.cards))
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

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.muted}>{t('collection_loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
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
