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

export const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  name: '卡片名稱',
  text: '技能／效果',
  number: '卡號（進階）',
};

export const CATEGORY_LABELS: Record<CardCategory, string> = {
  oshi: '推しホロメン',
  holomen: 'ホロメン',
  support: 'サポート',
  yell: 'エール',
};

export const COLOR_LABELS: Record<string, string> = {
  白: '白', 緑: '綠', 赤: '紅', 青: '藍', 紫: '紫', 黄: '黃', '◇': '無色',
};

const PARALLEL_LABELS: Record<ParallelMode, string> = {
  all: '全部版本',
  hasBase: '有原印版',
  hasParallel: '有平行版',
  noParallel: '無平行版',
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
  const set = (patch: Partial<PickerCriteria>) => onChange({ ...criteria, ...patch });

  return (
    <View testID="card-filter-panel">
      <View style={styles.modeRow}>
        {(['name', 'text', 'number'] as SearchMode[]).map((mode) => (
          <Chip
            key={mode}
            label={SEARCH_MODE_LABELS[mode]}
            active={criteria.mode === mode}
            onPress={() => set({ mode })}
            testID={`search-mode-${mode}`}
          />
        ))}
      </View>
      <TextInput
        style={styles.input}
        placeholder={criteria.mode === 'number' ? '輸入卡號，例如 hBP04-005' : `搜尋${SEARCH_MODE_LABELS[criteria.mode]}`}
        placeholderTextColor={COLORS.textSecondary}
        value={criteria.query}
        onChangeText={(query) => set({ query })}
        testID="card-search-input"
        accessibilityLabel={`搜尋卡片（${SEARCH_MODE_LABELS[criteria.mode]}）`}
      />

      {categoryChoices.length > 1 && (
        <FilterGroup title="卡片種類">
          {categoryChoices.map((c) => (
            <Chip
              key={c}
              label={CATEGORY_LABELS[c]}
              active={criteria.categories.includes(c)}
              onPress={() => set({ categories: toggle(criteria.categories, c) })}
              testID={`filter-category-${c}`}
            />
          ))}
        </FilterGroup>
      )}

      {options.colors.length > 0 && (
        <FilterGroup title="顏色">
          {options.colors.map((c) => (
            <Chip
              key={c}
              label={COLOR_LABELS[c] ?? c}
              active={criteria.colors.includes(c)}
              onPress={() => set({ colors: toggle(criteria.colors, c) })}
              testID={`filter-color-${c}`}
            />
          ))}
        </FilterGroup>
      )}

      {options.rarities.length > 0 && (
        <FilterGroup title="稀有度">
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
        <FilterGroup title="商品／系列">
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

      <FilterGroup title="版本">
        {PARALLEL_MODES.map((m) => (
          <Chip
            key={m}
            label={PARALLEL_LABELS[m]}
            active={criteria.parallel === m}
            onPress={() => set({ parallel: m })}
            testID={`filter-parallel-${m}`}
          />
        ))}
      </FilterGroup>

      <View style={styles.resultRow}>
        <Text style={styles.resultCount} testID="card-result-count">
          {resultCount} 張卡片
        </Text>
        {hasActiveFilters(criteria) && (
          <TouchableOpacity
            onPress={() => set({ query: '', categories: [], sets: [], colors: [], rarities: [], parallel: 'all' })}
            accessibilityRole="button"
            accessibilityLabel="清除所有篩選"
            testID="filter-reset"
            style={styles.resetBtn}
          >
            <Text style={styles.link}>清除全部</Text>
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
  /** record one more owned copy of the card's default printing */
  onAddOwned: (card: DeckCard) => void;
  emptyLabel: string;
}

const PAGE_SIZE = 60;

export function CardPickerGrid({
  groups, numColumns, height, qtyOf, onAdd, onAddOwned, emptyLabel,
}: GridProps) {
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
          // The ＋擁有 control is a SIBLING of the add-to-deck target, never
          // nested inside it: a tap meant for the collection must not also drop
          // a copy into the deck.
          <View style={[styles.cell, qty > 0 && styles.cellSelected]}>
            <TouchableOpacity
              style={styles.cellTap}
              onPress={() => onAdd(item.card)}
              accessibilityRole="button"
              accessibilityLabel={`加入牌組 ${item.card.name} ${item.cardNumber}${qty > 0 ? `，已選 ${qty} 張` : ''}`}
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
            <View style={styles.cellFooter}>
              <Text style={styles.cellMeta} numberOfLines={1}>{item.cardNumber}</Text>
              <TouchableOpacity
                style={styles.ownBtn}
                onPress={() => onAddOwned(item.card)}
                accessibilityRole="button"
                accessibilityLabel={`收藏 +1 ${item.card.name}`}
                testID={`collection-add-${item.card.id}`}
              >
                <Text style={styles.ownBtnText}>＋擁有</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      }}
      ListEmptyComponent={<Text style={styles.muted}>{emptyLabel}</Text>}
      ListFooterComponent={
        page.length < groups.length
          ? <Text style={styles.muted}>向下捲動載入更多（{page.length}/{groups.length}）</Text>
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
  cellFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, gap: 4 },
  cellMeta: { color: COLORS.textSecondary, fontSize: 11, flexShrink: 1 },
  ownBtn: {
    minHeight: 30, paddingHorizontal: 8, justifyContent: 'center', borderRadius: 6,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface,
  },
  ownBtnText: { color: COLORS.text, fontSize: 11, fontWeight: 'bold' },
  qtyBadge: {
    position: 'absolute', top: 10, right: 10, minWidth: 26, height: 26, borderRadius: 13,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 6,
  },
  qtyBadgeText: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
});
