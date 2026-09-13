import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, ListRenderItemInfo } from 'react-native';
import { COLORS } from '../constants';
import { PALETTE, SEMANTIC } from '../theme/tokensV2';
import { useTranslation } from '../i18n';
import { useSettingsStore } from '../store/settingsStore';
import { useFavoritesStore, type FavoriteEntry } from '../store/favoritesStore';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import { ownershipKey, resolveExactPrice, type DeckCard } from '../utils/deckRules';
import { resolveCardDisplayName } from '../utils/cardDisplayName';
import { RouteShell } from '../components/shell';

/**
 * FavoritesScreen — DIC-1380 W6: real listing of the independent
 * favorites store, not a static "coming soon" card. Every bookmark the
 * user has round-tripped through the account sync is rendered here, with
 * a remove action that stamps the store's removal tombstone so the sync
 * 409 merge preserves the delete against a concurrent server add.
 *
 * DIC-1427 (Pen sSDxQ): rows now carry the real card identity — the
 * catalog art, localized name and the exact-printing reference price
 * (fail-closed: an unmatched printing shows no price) — and tap opens the
 * real CardDetail. The bare card-number rows were the QA re-audit's
 * remaining material mismatch on this frame.
 */
export default function FavoritesScreen({ navigation }: any) {
  const { t } = useTranslation();
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const favorites = useFavoritesStore((s) => s.favorites);
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);
  const [db, setDb] = useState<CardDatabase | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCardDatabase()
      .then((data) => { if (!cancelled) setDb(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const catalogByKey = useMemo(() => {
    const map = new Map<string, DeckCard>();
    for (const card of db?.cards ?? []) {
      map.set(ownershipKey(card.cardNumber, card.printing), card);
    }
    return map;
  }, [db]);

  const remove = useCallback((fav: FavoriteEntry) => {
    removeFavorite(fav.cardNumber, fav.printing);
  }, [removeFavorite]);

  // Pen sSDxQ head sort control (node MxLuq「價格 ↓」): real orderings only —
  // the store's own insertion order, or the exact-printing reference price
  // descending. An unpriced printing sorts last (fail-closed), never onto a
  // borrowed cross-version price.
  const [sortMode, setSortMode] = useState<'added' | 'price'>('added');
  const sortedFavorites = useMemo(() => {
    if (sortMode === 'added' || !db) return favorites;
    const priceOf = (fav: FavoriteEntry) => {
      const exact = resolveExactPrice(fav.cardNumber, fav.printing, db.priceRecords);
      return exact.status === 'ok' ? exact.price : -1;
    };
    return [...favorites].sort((a, b) => priceOf(b) - priceOf(a));
  }, [favorites, sortMode, db]);

  const openCard = useCallback((fav: FavoriteEntry, card: DeckCard | undefined) => {
    // Hand CardDetail the real catalog identity when the catalog resolves it;
    // a legacy bookmark the catalog no longer carries still opens with its
    // number so the route never dead-ends.
    navigation?.navigate?.('CardDetail', {
      card: card
        ? {
            id: card.id,
            cardNumber: card.cardNumber,
            name: card.name,
            nameZh: card.nameZh,
            printing: card.printing,
            printingLabel: card.printingLabel,
            series: card.series,
            type: card.type,
            imageUrl: card.exactImageUrl || card.imageUrl || '',
          }
        : { cardNumber: fav.cardNumber, name: fav.cardNumber, printing: fav.printing },
    });
  }, [navigation]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<FavoriteEntry>) => {
    const card = catalogByKey.get(ownershipKey(item.cardNumber, item.printing));
    const display = card
      ? resolveCardDisplayName({ name: card.name, nameZh: card.nameZh }, preferredLanguage)
      : null;
    const art = card?.exactImageUrl || card?.imageUrl;
    const price = db ? resolveExactPrice(item.cardNumber, item.printing, db.priceRecords) : null;
    return (
      <View style={styles.row} testID={`favorite-row-${item.cardNumber}-${item.printing}`}>
        <TouchableOpacity
          style={styles.rowMain}
          onPress={() => openCard(item, card)}
          accessibilityRole="button"
          accessibilityLabel={t('favorites_open_card')}
          testID={`favorite-open-${item.cardNumber}-${item.printing}`}
          activeOpacity={0.75}
        >
          {art ? (
            /* @ts-ignore */
            <Image source={{ uri: art }} style={styles.rowArt} resizeMode="cover" />
          ) : (
            <View style={[styles.rowArt, styles.rowArtFallback]}>
              <Text style={styles.rowArtFallbackText} numberOfLines={1}>{item.cardNumber.split('-')[0]}</Text>
            </View>
          )}
          <View style={styles.rowCopy}>
            <Text style={styles.rowPrimary} numberOfLines={1}>
              {display?.primary || item.cardNumber}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {item.cardNumber} · {card?.printingLabel?.trim() || item.printing}
            </Text>
          </View>
          <Text style={styles.rowPrice} numberOfLines={1}>
            {price && price.status === 'ok' ? `¥${price.price.toLocaleString()}` : '—'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.removeButton}
          onPress={() => remove(item)}
          accessibilityRole="button"
          accessibilityLabel={t('favorites_remove_a11y', { name: display?.primary || item.cardNumber })}
          testID={`favorite-remove-${item.cardNumber}-${item.printing}`}
        >
          <Text style={styles.removeButtonText}>{t('favorites_remove_button')}</Text>
        </TouchableOpacity>
      </View>
    );
  }, [remove, openCard, catalogByKey, db, preferredLanguage, t]);

  // DIC-1409 Phase 5 — Pen `App / 09 我的最愛` (frame sSDxQ) shared shell.
  const wrapInShell = (children: React.ReactNode) => (
    <RouteShell navigation={navigation} routeName="Favorites" title={t('favorites_title')} testID="favorites-shell">
      {children}
    </RouteShell>
  );

  if (favorites.length === 0) {
    return wrapInShell(
      <View style={styles.container} testID="favorites-empty">
        <Text style={styles.text}>{t('favorites_title')}</Text>
        <Text style={styles.subtitle}>{t('favorites_empty')}</Text>
      </View>
    );
  }

  return wrapInShell(
    <View style={styles.listContainer} testID="favorites-list">
      <View style={styles.header}>
        <Text style={styles.count} testID="favorites-count">
          {t('favorites_count', { count: favorites.length })}
        </Text>
        <TouchableOpacity
          style={styles.sortButton}
          onPress={() => setSortMode((mode) => (mode === 'added' ? 'price' : 'added'))}
          accessibilityRole="button"
          accessibilityLabel={t('favorites_sort_a11y')}
          testID="favorites-sort"
        >
          <Text style={styles.sortButtonText}>
            {sortMode === 'price' ? t('favorites_sort_price') : t('favorites_sort_added')}
          </Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={sortedFavorites}
        keyExtractor={(item) => `${item.cardNumber}|${item.printing}`}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.appBg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  listContainer: {
    flex: 1,
    backgroundColor: PALETTE.appBg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  // Pen sSDxQ head sort control
  sortButton: {
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: PALETTE.appSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortButtonText: {
    color: SEMANTIC.onBgDim,
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  // Pen sSDxQ list row: 44×60 art + name + code + price.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    gap: 10,
    minHeight: 72,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowArt: {
    width: 44,
    height: 60,
    borderRadius: 6,
    backgroundColor: PALETTE.appElev,
  },
  rowArtFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowArtFallbackText: {
    color: SEMANTIC.onBgDim,
    fontSize: 9,
    fontWeight: '700',
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  rowPrimary: {
    color: SEMANTIC.onBg,
    fontSize: 14,
    fontWeight: '700',
  },
  rowMeta: {
    color: SEMANTIC.onBgDim,
    fontSize: 11,
  },
  rowPrice: {
    color: PALETTE.accent2,
    fontSize: 13.5,
    fontWeight: '700',
  },
  removeButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: PALETTE.appSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  text: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  count: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
});
