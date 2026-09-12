import React, { useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ListRenderItemInfo } from 'react-native';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';
import { useFavoritesStore, type FavoriteEntry } from '../store/favoritesStore';
import { RouteShell } from '../components/shell';

/**
 * FavoritesScreen — DIC-1380 W6: real listing of the independent
 * favorites store, not a static "coming soon" card. Every bookmark the
 * user has round-tripped through the account sync is rendered here, with
 * a remove action that stamps the store's removal tombstone so the sync
 * 409 merge preserves the delete against a concurrent server add.
 */
export default function FavoritesScreen({ navigation }: any) {
  const { t } = useTranslation();
  const favorites = useFavoritesStore((s) => s.favorites);
  const removeFavorite = useFavoritesStore((s) => s.removeFavorite);

  const remove = useCallback((fav: FavoriteEntry) => {
    removeFavorite(fav.cardNumber, fav.printing);
  }, [removeFavorite]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<FavoriteEntry>) => {
    return (
      <View style={styles.row} testID={`favorite-row-${item.cardNumber}-${item.printing}`}>
        <View style={styles.rowCopy}>
          <Text style={styles.rowPrimary} numberOfLines={1}>{item.cardNumber}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {item.printing}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.removeButton}
          onPress={() => remove(item)}
          accessibilityRole="button"
          accessibilityLabel={t('favorites_remove_a11y', { name: item.cardNumber })}
          testID={`favorite-remove-${item.cardNumber}-${item.printing}`}
        >
          <Text style={styles.removeButtonText}>{t('favorites_remove_button')}</Text>
        </TouchableOpacity>
      </View>
    );
  }, [remove, t]);

  // DIC-1409 Phase 5 — Pen `App / 09 我的最愛` (frame sSDxQ) shared shell.
  const wrapInShell = (children: React.ReactNode) => (
    <RouteShell navigation={navigation} routeName="Favorites" title={t('favorites_title')} testID="favorites-shell">
      {children}
    </RouteShell>
  );

  if (favorites.length === 0) {
    return wrapInShell(
      <View style={styles.container} testID="favorites-empty">
        <Text style={styles.text}>❤️ {t('favorites_title')}</Text>
        <Text style={styles.subtitle}>{t('favorites_empty')}</Text>
      </View>
    );
  }

  return wrapInShell(
    <View style={styles.listContainer} testID="favorites-list">
      <View style={styles.header}>
        <Text style={styles.text}>❤️ {t('favorites_title')}</Text>
        <Text style={styles.count} testID="favorites-count">
          {t('favorites_count', { count: favorites.length })}
        </Text>
      </View>
      <FlatList
        data={favorites}
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
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  listContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 12,
    minHeight: 68,
  },
  rowCopy: {
    flex: 1,
  },
  rowPrimary: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
  },
  rowMeta: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  removeButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeButtonText: {
    color: COLORS.text,
    fontSize: 14,
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
