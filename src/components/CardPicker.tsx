// Visual card picker for the deck editor (DIC-1067).
//
// A player builds a deck by looking at card art, names and filters — typing a
// card number is never required. Card Number stays available as an ADVANCED
// search mode for the player who already knows what they want.

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Image, ScrollView,
} from 'react-native';
import { COLORS } from '../constants';
import type { DeckCard } from '../utils/deckRules';
import type { VariantGroup } from '../utils/deckVariants';
import {
  hasActiveFilters,
  type CardCategory, type FilterOptions, type ParallelMode,
  type PickerCriteria, type SearchMode,
} from '../utils/cardCatalog';
import { useTranslation, type TranslationKey } from '../i18n';

const SEARCH_MODE_KEYS: Record<SearchMode, TranslationKey> = {
  name: 'picker_mode_name', text: 'picker_mode_text', number: 'picker_mode_number',
};
const CATEGORY_KEYS: Record<CardCategory, TranslationKey> = {
  oshi: 'picker_category_oshi', holomen: 'picker_category_holomen',
  support: 'picker_category_support', yell: 'picker_category_yell',
};
const COLOR_KEYS: Record<string, TranslationKey> = {
  白: 'color_white', 緑: 'color_green', 赤: 'color_red', 青: 'color_blue',
  紫: 'color_purple', 黄: 'color_yellow', '◇': 'color_colorless',
};
const PARALLEL_KEYS: Record<ParallelMode, TranslationKey> = {
  all: 'picker_parallel_all', hasBase: 'picker_parallel_has_base',
  hasParallel: 'picker_parallel_has_parallel', noParallel: 'picker_parallel_no_parallel',
};

const PARALLEL_MODES: ParallelMode[] = ['all', 'hasBase', 'hasParallel', 'noParallel'];

// ── Filter panel ──────────────────────────────────────────────────────────

interface FilterPanelProps {
  criteria: PickerCriteria;
  onChange: (next: PickerCriteria) => void;
  options: FilterOptions;
  /** categories the open zone tab allows; a single-category zone hides the chips */
  categoryChoices: CardCategory[];
  resultCount: number;
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Chip({
  label, active, onPress, testID,
}: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function CardFilterPanel({
  criteria, onChange, options, categoryChoices, resultCount,
}: FilterPanelProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<PickerCriteria>) => onChange({ ...criteria, ...patch });
  const modeLabel = t(SEARCH_MODE_KEYS[criteria.mode]);

  return (
    <View testID="card-filter-panel">
      <View style={styles.modeRow}>
        {(['name', 'text', 'number'] as SearchMode[]).map((mode) => (
          <Chip
            key={mode}
            label={t(SEARCH_MODE_KEYS[mode])}
            active={criteria.mode === mode}
            onPress={() => set({ mode })}
            testID={`search-mode-${mode}`}
          />
        ))}
      </View>
      <TextInput
        style={styles.input}
        placeholder={criteria.mode === 'number' ? t('picker_number_placeholder') : t('picker_search_placeholder', { mode: modeLabel })}
        placeholderTextColor={COLORS.textSecondary}
        value={criteria.query}
        onChangeText={(query) => set({ query })}
        testID="card-search-input"
        accessibilityLabel={t('picker_search_a11y', { mode: modeLabel })}
      />

      {categoryChoices.length > 1 && (
        <FilterGroup title={t('picker_category_title')}>
          {categoryChoices.map((c) => (
            <Chip
              key={c}
              label={t(CATEGORY_KEYS[c])}
              active={criteria.categories.includes(c)}
              onPress={() => set({ categories: toggle(criteria.categories, c) })}
              testID={`filter-category-${c}`}
            />
          ))}
        </FilterGroup>
      )}

      {options.colors.length > 0 && (
        <FilterGroup title={t('picker_color_title')}>
          {options.colors.map((c) => (
            <Chip
              key={c}
              label={COLOR_KEYS[c] ? t(COLOR_KEYS[c]) : c}
              active={criteria.colors.includes(c)}
              onPress={() => set({ colors: toggle(criteria.colors, c) })}
              testID={`filter-color-${c}`}
            />
          ))}
        </FilterGroup>
      )}

      {options.rarities.length > 0 && (
        <FilterGroup title={t('picker_rarity_title')}>
          {options.rarities.map((r) => (
            <Chip
              key={r}
              label={r}
              active={criteria.rarities.includes(r)}
              onPress={() => set({ rarities: toggle(criteria.rarities, r) })}
              testID={`filter-rarity-${r}`}
            />
          ))}
        </FilterGroup>
      )}

      {options.sets.length > 0 && (
        <FilterGroup title={t('picker_set_title')}>
          {options.sets.map((s) => (
            <Chip
              key={s}
              label={s}
              active={criteria.sets.includes(s)}
              onPress={() => set({ sets: toggle(criteria.sets, s) })}
              testID={`filter-set-${s}`}
            />
          ))}
        </FilterGroup>
      )}

      <FilterGroup title={t('picker_version_title')}>
        {PARALLEL_MODES.map((m) => (
          <Chip
            key={m}
            label={t(PARALLEL_KEYS[m])}
            active={criteria.parallel === m}
            onPress={() => set({ parallel: m })}
            testID={`filter-parallel-${m}`}
          />
        ))}
      </FilterGroup>

      <View style={styles.resultRow}>
        <Text style={styles.resultCount} testID="card-result-count">
          {t('deck_cards_count', { count: resultCount })}
        </Text>
        {hasActiveFilters(criteria) && (
          <TouchableOpacity
            onPress={() => set({ query: '', categories: [], sets: [], colors: [], rarities: [], parallel: 'all' })}
            accessibilityRole="button"
            accessibilityLabel={t('picker_clear_a11y')}
            testID="filter-reset"
            style={styles.resetBtn}
          >
            <Text style={styles.link}>{t('picker_clear_all')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.filterGroup}>
      <Text style={styles.filterTitle}>{title}</Text>
      <View style={styles.chipWrap}>{children}</View>
    </View>
  );
}

// ── Card grid ─────────────────────────────────────────────────────────────

function CardThumb({ card }: { card: DeckCard }) {
  const [failed, setFailed] = useState(false);
  if (!card.imageUrl || failed) {
    return (
      <View style={[styles.thumb, styles.thumbFallback]}>
        <Text style={styles.thumbFallbackText} numberOfLines={3}>{card.name}</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: card.imageUrl }}
      style={styles.thumb}
      resizeMode="contain"
      onError={() => setFailed(true)}
      accessibilityLabel={card.name}
    />
  );
}

interface GridProps {
  groups: VariantGroup[];
  numColumns: number;
  height: number;
  /** copies of this card number already in the deck, for the quantity badge */
  qtyOf: (cardNumber: string) => number;
  onAdd: (card: DeckCard) => void;
  emptyLabel: string;
}

const PAGE_SIZE = 60;

export function CardPickerGrid({
  groups, numColumns, height, qtyOf, onAdd, emptyLabel,
}: GridProps) {
  const { t } = useTranslation();
  // The catalog holds ~2,100 card numbers; rendering them all would stall the
  // first paint, so the grid pages in as the player scrolls (DIC-1067 §11).
  const [visible, setVisible] = useState(PAGE_SIZE);
  const page = useMemo(() => groups.slice(0, visible), [groups, visible]);

  // A new filter/search result must start from the top of the page window.
  const resetKey = groups.length;
  const [lastKey, setLastKey] = useState(resetKey);
  if (lastKey !== resetKey) {
    setLastKey(resetKey);
    setVisible(PAGE_SIZE);
  }

  return (
    <FlatList
      // FlatList cannot change numColumns on an existing list instance.
      key={`grid-${numColumns}`}
      testID="card-picker-grid"
      data={page}
      numColumns={numColumns}
      keyExtractor={(g) => g.cardNumber}
      style={[styles.grid, { height }]}
      columnWrapperStyle={numColumns > 1 ? styles.gridRow : undefined}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={numColumns * 4}
      windowSize={5}
      removeClippedSubviews={false}
      onEndReachedThreshold={0.4}
      onEndReached={() => setVisible((n) => (n < groups.length ? n + PAGE_SIZE : n))}
      renderItem={({ item }) => {
        const qty = qtyOf(item.cardNumber);
        return (
          <View style={[styles.cell, qty > 0 && styles.cellSelected]}>
            <TouchableOpacity
              style={styles.cellTap}
              onPress={() => onAdd(item.card)}
              accessibilityRole="button"
              accessibilityLabel={t('picker_add_deck_a11y', {
                name: item.card.name,
                number: item.cardNumber,
                selected: qty > 0 ? t('picker_selected_count', { count: qty }) : '',
              })}
              testID={`card-cell-${item.cardNumber}`}
            >
              <CardThumb card={item.card} />
              <Text style={styles.cellName} numberOfLines={2}>{item.card.name}</Text>
            </TouchableOpacity>
            {qty > 0 && (
              <View style={styles.qtyBadge} testID={`card-qty-${item.cardNumber}`}>
                <Text style={styles.qtyBadgeText}>{qty}</Text>
              </View>
            )}
            <Text style={styles.cellMeta} numberOfLines={1}>{item.cardNumber}</Text>
          </View>
        );
      }}
      ListEmptyComponent={<Text style={styles.muted}>{emptyLabel}</Text>}
      ListFooterComponent={
        page.length < groups.length
          ? <Text style={styles.muted}>{t('picker_load_more', { visible: page.length, total: groups.length })}</Text>
          : null
      }
    />
  );
}

// A grid cell must stay comfortably above the 44px minimum touch target at the
// 390px viewport, where the grid renders two columns.
const CELL_MIN_HEIGHT = 168;

const styles = StyleSheet.create({
  input: {
    backgroundColor: COLORS.surfaceLight, color: COLORS.text, borderRadius: 8,
    paddingHorizontal: 12, minHeight: 44, borderWidth: 1, borderColor: COLORS.border,
  },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  filterGroup: { marginTop: 10 },
  filterTitle: { color: COLORS.textSecondary, fontSize: 12, marginBottom: 4 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 12,
    borderRadius: 999, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight,
  },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.text, fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: 'bold' },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 8 },
  resultCount: { color: COLORS.text, fontSize: 13, fontWeight: 'bold' },
  resetBtn: { minHeight: 44, justifyContent: 'center' },
  link: { color: COLORS.primary, fontSize: 14 },
  muted: { color: COLORS.textSecondary, fontSize: 13, marginTop: 8 },
  grid: { marginTop: 10 },
  gridRow: { gap: 8 },
  cell: {
    flex: 1, minHeight: CELL_MIN_HEIGHT, marginBottom: 8, padding: 6,
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight,
  },
  cellSelected: { borderColor: COLORS.primary },
  cellTap: { flex: 1 },
  thumb: { width: '100%', aspectRatio: 5 / 7, borderRadius: 6, backgroundColor: COLORS.surface },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', padding: 6 },
  thumbFallbackText: { color: COLORS.textSecondary, fontSize: 11, textAlign: 'center' },
  cellName: { color: COLORS.text, fontSize: 13, marginTop: 6 },
  cellMeta: { color: COLORS.textSecondary, fontSize: 11, flexShrink: 1 },
  qtyBadge: {
    position: 'absolute', top: 10, right: 10, minWidth: 26, height: 26, borderRadius: 13,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 6,
  },
  qtyBadgeText: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
});
