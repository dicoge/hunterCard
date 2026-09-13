import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { COLORS, convertPrice } from '../constants';
import { useSettingsStore } from '../store/settingsStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { FEATURES, releaseCardFlags } from '../config/releaseFlags';
import { stripDisabledCardFields } from '../utils/cardReleaseFilter';
import { resolveCardDisplayName } from '../utils/cardDisplayName';
import { loadDatabaseJson, loadSeriesNamesJson } from '../utils/staticData';
import { useTranslation } from '../i18n';
import { uniformGridItemStyle } from '../utils/gridLayout';
import { AppShell, buildShellTabs } from '../components/shell';
import {
  ArrowLeftGlyph,
  SearchGlyph,
  SlidersGlyph,
  ChevronDownGlyph,
  XGlyph,
} from '../components/shell/icons';
import { CardTile } from '../components/cards';
import { PALETTE, SEMANTIC, FONTS, TYPE_SCALE, RADII, SPACING } from '../theme/tokensV2';
import { Platform } from 'react-native';
import {
  normalizeCardIdentity,
  bloomLevelBadgeColor,
  categoryBadgeColor,
  PRINTING_RARITY_COLORS,
  KNOWN_COLOR_KEYS,
  resolveCardColorsWithNestedFallback,
} from '../utils/cardNormalization';

// ── Server-side search constants ──

// Module-level cache for series names (fetched from JSON)
let cachedSeriesNames: Record<string, string> | null = null;
let seriesNamesFetchPromise: Promise<Record<string, string>> | null = null;

async function fetchSeriesNames(): Promise<Record<string, string>> {
  if (cachedSeriesNames) return cachedSeriesNames;
  if (seriesNamesFetchPromise) return seriesNamesFetchPromise;

  seriesNamesFetchPromise = (async () => {
    // Native reads the bundled asset; web fetches same-origin /data/* (staticData).
    const names = await loadSeriesNamesJson();
    cachedSeriesNames = names;
    return names;
  })();

  return seriesNamesFetchPromise;
}
const COLOR_MAP: Record<string, string> = {
  white: '白色', blue: '藍色', green: '綠色', red: '紅色',
  purple: '紫色', yellow: '黃色', colorless: '無色',
};
const GRADE_RARITY: Record<string, string> = { debut: 'C', '1st': 'U', '2nd': 'R', buzz: 'SR', spot: 'N' };

const COLOR_TO_CN: Record<string, string[]> = {
  'white': ['白色'],
  'blue': ['藍色', '青色'],
  'green': ['綠色'],
  'red': ['紅色'],
  'purple': ['紫色'],
  'yellow': ['黃色'],
  'colorless': ['無色'],
};

// Printing rarity palette — single source is PRINTING_RARITY_COLORS in
// cardNormalization.ts. Local const kept as an alias so the rest of the file
// (and any surviving `rarityColors[...]` lookup) still resolves without a
// second definition drifting from the palette-collision test (DIC-1141 CR).
const rarityColors = PRINTING_RARITY_COLORS;
const gradeLabels: Record<string, string> = {
  debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot',
};

// ── Types ──

interface CardRecord {
  id: string; name: string; series: string; type: string; rarity: string;
  color: string; localImage?: string; officialImage?: string;
  sellPrice?: number | null; buyPrice?: number | null; yuyuName?: string; yuyuImage?: string;
  prices?: { name: string; sellPrice: number | null; rarity: string; buyPrice?: number | null }[];
  priceHistory?: Record<string, number>;
  ytStats?: any;
  effects?: string[]; hp?: string; life?: string; arts?: string;
  nameZh?: string;
  skillsJp?: any; skillsZh?: any;
}

interface CardResult {
  id: string; name: string; type: string; grade: string; rarity: string; sourceRarity: string;
  colors: string[]; colorNames: string[]; series: string[]; seriesNames: string[];
  tags: string[]; cardNumber: string; imageUrl: string;
  yuyuUrl: string; carousellUrl: string; officialUrl: string;
  yuyuPrice?: number | null;
  sellPrice?: number | null; buyPrice?: number | null; ytStats?: any;
  prices?: { name: string; sellPrice: number | null; rarity: string; buyPrice?: number | null }[];
  priceHistory?: Record<string, number>;
  searchKeywords?: string[];
  nameZh?: string;
  skillsJp?: any;
  skillsZh?: any;
  normalized?: any;
}

interface DatabaseSchema {
  cards: Record<string, CardRecord>;
  totalCards: number;
  lastUpdated: string;
}

// ── Module-level database cache (persists across re-renders and navigation) ──

let cachedDatabase: DatabaseSchema | null = null;
let databaseFetchPromise: Promise<DatabaseSchema> | null = null;

async function fetchDatabase(): Promise<DatabaseSchema> {
  if (cachedDatabase) return cachedDatabase;
  if (databaseFetchPromise) return databaseFetchPromise;

  databaseFetchPromise = (async () => {
    // Native reads the bundled sanitized asset; web fetches same-origin /data/*.
    const db: DatabaseSchema = await loadDatabaseJson();
    cachedDatabase = db;
    return db;
  })();

  return databaseFetchPromise;
}

// ── Search & mapping logic (ported from api/search.ts) ──

// Exported for the DIC-1409 Phase 3 render-evidence scripts: CardDetail
// previews are produced from the exact card objects this production mapper
// emits over the real bundled database — never from hand-written fixtures.
export function searchCards(database: DatabaseSchema, query: string, nameMap: Record<string, string>): CardResult[] {
  const searchQ = query.toLowerCase().trim();
  const cards = database.cards || {};

  // Use cardNumber (base, no series suffix) and series for matching,
  // not the compound id (cardNumber_series) to avoid false positives.
  const matched = Object.values(cards).filter((c: CardRecord) => {
    const cardNum = ((c as any).cardNumber || c.id || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const series = (c.series || '').toLowerCase();
    const type = (c.type || '').toLowerCase();
    const rarity = (c.rarity || '').toLowerCase();
    const color = (c.color || '').toLowerCase();
    const colorCnList = COLOR_TO_CN[color] || [];
    const colorSearch = (color + ' ' + colorCnList.join(' ')).toLowerCase();

    return cardNum.includes(searchQ) ||
           name.includes(searchQ) ||
           type.includes(searchQ) ||
           rarity.includes(searchQ) ||
           colorSearch.includes(searchQ) ||
           series.includes(searchQ);
  });

  // Deduplicate by cardNumber: keep the version whose series matches the search query,
  // or the first occurrence if none matches more specifically.
  const dedupMap = new Map<string, CardRecord>();
  for (const c of matched) {
    const key = ((c as any).cardNumber || c.id || '').toLowerCase();
    if (!key) continue;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, c);
    } else if (searchQ.length > 0) {
      const existingSeries = (existing.series || '').toLowerCase();
      const candidateSeries = (c.series || '').toLowerCase();
      const existingMatch = existingSeries.includes(searchQ);
      const candidateMatch = candidateSeries.includes(searchQ);
      if (!existingMatch && candidateMatch) {
        // Candidate's series matches the query, prefer it over the existing entry
        dedupMap.set(key, c);
      } else if (existingMatch && candidateMatch) {
        // Both match — keep whichever appears first (already set)
      }
      // If neither matches, keep whichever was first (existing)
    }
  }
  const deduped = Array.from(dedupMap.values());

  // Sort: cards whose cardNumber starts with the search query first (in numeric order),
  // then other cards (reprints/cross-series) sorted by cardNumber.
  const searchPrefix = searchQ.replace(/[^a-z0-9]/g, '');
  deduped.sort((a, b) => {
    const aRaw = ((a as any).cardNumber || a.id || '').toLowerCase();
    const bRaw = ((b as any).cardNumber || b.id || '').toLowerCase();
    const aPrefix = aRaw.split('-')[0];
    const bPrefix = bRaw.split('-')[0];
    // Cards matching the series prefix come first
    const aMatchSeries = aRaw.startsWith(searchPrefix) ? 0 : 1;
    const bMatchSeries = bRaw.startsWith(searchPrefix) ? 0 : 1;
    if (aMatchSeries !== bMatchSeries) return aMatchSeries - bMatchSeries;
    // Group by prefix (hBP08 / hBP01 / hSD11 / etc.)
    if (aPrefix !== bPrefix) return aPrefix.localeCompare(bPrefix);
    // Finally sort by numeric suffix
    const aSuffix = parseInt(aRaw.split('-')[1], 10) || 0;
    const bSuffix = parseInt(bRaw.split('-')[1], 10) || 0;
    return aSuffix - bSuffix;
  });

  const cardFlags = releaseCardFlags();
  return deduped.map((c: CardRecord) => {
    const id = c.id || '';
    const name = c.name || '';
    // DIC-1159 + DIC-1192 + CR #1: strict canonicalCardColors first (so raw
    // `◇` / `blue_red` cannot reach `t(\`color_${color}\`)`), fall through to
    // the permissive normaliser so DIC-1192's shipped `◇ → 無色` render still
    // lands at 1440×900. When the top-level source produces no colors (the
    // 2026-08-28 catalog sync now writes `"null"` at top level for the real
    // hBP04-087/088/hBP06-084 winners), fall back to the authoritative
    // ◇ token in `skillsJp.color` / `skillsZh.color` so those diamond
    // winners still render as colorless instead of dropping the label.
    const colors = resolveCardColorsWithNestedFallback(c);
    const colorNames = colors.map((x: string) => COLOR_MAP[x] || x);
    const series = c.series ? [c.series] : [];
    const seriesNames = series.map((s: string) => nameMap[s] || s);
    const cardNumber = (c as any).cardNumber || id;

    const normalized = normalizeCardIdentity(c);
    const rarity = (c.rarity || '').toUpperCase();

    // Use official image (400×559) first for sharp display, local image (100×140) as fallback
    const imageUrl = c.officialImage || c.localImage || '';

    return stripDisabledCardFields({
      id,
      name,
      cardNumber,
      type: normalized.category || '',
      grade: normalized.stage || '',
      normalized,
      rarity,
      sourceRarity: c.rarity || '',
      colors,
      colorNames,
      series,
      seriesNames,
      imageUrl,
      yuyuPrice: c.sellPrice || null,
      sellPrice: c.sellPrice ?? null,
      buyPrice: c.buyPrice ?? null,
      ytStats: c.ytStats ?? null,
      yuyuPriceName: c.yuyuName || '',
      prices: c.prices || [],
      priceHistory: c.priceHistory || {},
      yuyuImage: c.yuyuImage || '',
      officialImage: c.officialImage || '',
      localImage: c.localImage || '',
      effects: c.effects || [],
      hp: c.hp || '',
      life: c.life || '',
      arts: c.arts || '',
      skillsJp: (c as any).skillsJp,
      skillsZh: (c as any).skillsZh,
      searchKeywords: [c.name || '', '', ''],
      tags: [],
      nameZh: c.nameZh || '',
      yuyuUrl: `https://yuyu-tei.jp/sell/hocg/s/search?search_word=${encodeURIComponent(cardNumber)}`,
      carousellUrl: '',
      officialUrl: `https://hololive-official-cardgame.com/cardlist/?keyword=${encodeURIComponent(cardNumber)}&view=image`,
    }, cardFlags);
  });
}

// ── DIC-1427: Pen App/02 sort + filter model ──

export type SearchSortMode = 'relevance' | 'price-desc' | 'price-asc';

const SORT_CYCLE: SearchSortMode[] = ['relevance', 'price-desc', 'price-asc'];
const SORT_LABEL_KEY: Record<SearchSortMode, string> = {
  relevance: 'search_sort_relevance',
  'price-desc': 'search_sort_price_desc',
  'price-asc': 'search_sort_price_asc',
};

// "SR 以上" (Pen chip CT3mi): printings at or above SR in the hOCG rarity
// ladder. Base ladder is C < U < R < RR < SR; everything above SR is a
// premium/parallel tier (OSR / UR / OUR / SEC / SY / SP / P).
const SR_PLUS_RARITIES = new Set(['SR', 'OSR', 'UR', 'OUR', 'SEC', 'SY', 'SP', 'P']);

function cardPriceValue(card: CardResult): number | null {
  const price = card.sellPrice ?? card.yuyuPrice ?? null;
  return typeof price === 'number' && price > 0 ? price : null;
}

export function applySearchRefinements(
  results: CardResult[],
  opts: { colors: ReadonlySet<string>; series: ReadonlySet<string>; srPlus: boolean; sort: SearchSortMode },
): CardResult[] {
  let list = results;
  if (opts.colors.size > 0) {
    list = list.filter((c) => (c.colors || []).some((color) => opts.colors.has(color)));
  }
  if (opts.series.size > 0) {
    list = list.filter((c) => (c.series || []).some((s) => opts.series.has(s)));
  }
  if (opts.srPlus) {
    list = list.filter((c) => SR_PLUS_RARITIES.has((c.rarity || '').toUpperCase()));
  }
  if (opts.sort !== 'relevance') {
    list = [...list].sort((a, b) => {
      const pa = cardPriceValue(a);
      const pb = cardPriceValue(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;
      if (pb == null) return -1;
      return opts.sort === 'price-desc' ? pb - pa : pa - pb;
    });
  }
  return list;
}

// Shared display-price formatter (same contract CardListItem always used).
function formatCardPrice(price: number | null | undefined, preferredCurrency: string): string {
  if (price == null) return '—';
  if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
  const { value, symbol } = convertPrice(price, preferredCurrency as Parameters<typeof convertPrice>[1]);
  return `${symbol}${value?.toLocaleString() || '—'}`;
}

// Extract effect text from searchKeywords (index 3+)
function getEffectPreview(kw: string[] = []): string {
  const gameTerms = ['給予', '抽', '傷害', '牌組', '手札', '成員', '中央', '藝能', 'HP', '生命', '階段', '回合', '特殊', '公開'];
  return kw.slice(3).filter((t: string) => t.trim().length > 8 && gameTerms.some(g => t.includes(g))).join('\n');
}

// ── Screen component ──

export default function SearchResultsScreen({ route, navigation }: any) {
  const { t, language } = useTranslation();
  const query = route?.params?.query || '';
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<CardResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isDesktop, isWide } = useBreakpoint();
  // DIC-1427 QA P1: the Pen `App / 02 搜尋結果` Card Tile grid (frame Z6jlE)
  // is the authoritative design system at EVERY width — 768/1440 previously
  // fell back to the legacy horizontal list-cards. Columns scale with the
  // content box while the tile keeps its Pen anatomy: 3 at mobile (exact
  // 113px Pen tiles), 6 at tablet, 8 at desktop widths.
  const numColumns = isWide ? WIDE_TILE_COLUMNS : isDesktop ? TABLET_TILE_COLUMNS : MOBILE_GRID_COLUMNS;
  const useTileGrid = true;
  const gridGap = MOBILE_GRID_GAP;
  // DIC-1150: measure the row's available width so each card lands on an exact
  // pixel width (containerWidth - (n-1) * gap) / n. Mixing the fixed 12px
  // `columnWrapper` gap with a guessed percentage gap was the root cause of the
  // horizontal scrollbar and the unaligned third column on desktop.
  const [rowWidth, setRowWidth] = useState(0);
  const onListLayout = useCallback((event: LayoutChangeEvent) => {
    // padding-left + padding-right of the FlatList's contentContainerStyle.
    const contentWidth = event.nativeEvent.layout.width - LIST_PADDING_X * 2;
    setRowWidth((prev) => (prev === contentWidth ? prev : Math.max(0, contentWidth)));
  }, []);
  const gridItemStyle = useMemo(
    () => uniformGridItemStyle({ columns: numColumns, containerWidth: rowWidth, gap: gridGap }),
    [numColumns, rowWidth, gridGap]
  );
  const tileWidth = typeof gridItemStyle.width === 'number' ? gridItemStyle.width : undefined;

  // DIC-1427: live search field draft (Pen node hKr9H/j5Et8) — submitting
  // re-runs the real SearchResults route with the edited query.
  const [queryDraft, setQueryDraft] = useState<string>(query);
  useEffect(() => { setQueryDraft(query); }, [query]);
  const submitDraft = useCallback(() => {
    const next = queryDraft.trim();
    if (!next) return;
    navigation.navigate('SearchResults', { query: next });
  }, [queryDraft, navigation]);

  // DIC-1427: refinement state — real filters/sort over the real result set.
  const [sortMode, setSortMode] = useState<SearchSortMode>('relevance');
  const [colorFilters, setColorFilters] = useState<ReadonlySet<string>>(new Set());
  const [seriesFilters, setSeriesFilters] = useState<ReadonlySet<string>>(new Set());
  const [srPlus, setSrPlus] = useState(false);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  useEffect(() => {
    // A new query means a new result universe — stale refinements would
    // silently hide fresh results.
    setColorFilters(new Set());
    setSeriesFilters(new Set());
    setSrPlus(false);
    setFilterPanelOpen(false);
  }, [query]);

  const toggleSetMember = (set: ReadonlySet<string>, value: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  // DIC-1409 Phase 3 + DIC-1427: every branch renders inside the shared Pen v2
  // shell. App bar = back arrow (A2SWo) + real search field (hKr9H) + sliders
  // filter affordance (w5jzG9); no mock status bar — the OS/browser already
  // draws status chrome, and doubling it was the production regression the
  // user captured. Bottom tab bar keeps 搜尋 active.
  const shellTabs = useMemo(() => buildShellTabs({ navigation }), [navigation]);
  // DIC-1427 QA: the Pen status row is back on this route — AppStatusBar now
  // renders web-only (real clock + drawn glyphs), and returns null on native
  // where the OS bar exists, so the original duplicate-status P0 cannot recur.
  const wrapInShell = (children: React.ReactNode) => (
    <AppShell
      appBar={{
        showBrand: false,
        leading: (
          <TouchableOpacity
            onPress={() => (navigation.goBack ? navigation.goBack() : navigation.navigate('Home'))}
            accessibilityRole="button"
            accessibilityLabel={t('common_back' as Parameters<typeof t>[0])}
            style={shellStyles.backButton}
            testID="search-results-back"
          >
            <ArrowLeftGlyph color={SEMANTIC.onBgMuted} size={22} />
          </TouchableOpacity>
        ),
        center: (
          <View style={shellStyles.searchField} testID="search-results-search-field">
            <SearchGlyph color={PALETTE.textMuted} size={16} />
            <TextInput
              value={queryDraft}
              onChangeText={setQueryDraft}
              onSubmitEditing={submitDraft}
              placeholder={t('search_landing_placeholder' as Parameters<typeof t>[0])}
              placeholderTextColor={PALETTE.textMuted}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              style={shellStyles.searchInput}
              accessibilityLabel={t('search_title' as Parameters<typeof t>[0])}
              testID="search-results-input"
            />
          </View>
        ),
        actions: [
          {
            key: 'filter',
            label: t('search_filter_open' as Parameters<typeof t>[0]),
            icon: <SlidersGlyph color={SEMANTIC.onBgMuted} size={21} />,
            onPress: () => setFilterPanelOpen((open) => !open),
            testID: 'search-results-filter-button',
          },
        ],
      }}
      bottomTabBar={{ items: shellTabs, activeKey: 'search' }}
      scrollable={false}
      contentPadding={false}
      testID="search-results-shell"
    >
      {children}
    </AppShell>
  );

  useEffect(() => {
    if (!query.trim()) {
      setError(t('search_missing_query'));
      setLoading(false);
      return;
    }

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const [db, names] = await Promise.all([fetchDatabase(), fetchSeriesNames()]);
        const matched = searchCards(db, query, names);
        setResults(matched);
      } catch (err) {
        if ((err as any)?.name === 'AbortError') {
          setError(t('search_timeout'));
        } else {
          setError(language === 'ja' ? t('search_database_failed') : (err instanceof Error ? err.message : t('search_database_failed')));
        }
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [query, language]);

  if (loading) return wrapInShell(
    <View style={styles.centerContainer}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.loadingText}>{t('search_database_loading')}</Text>
    </View>
  );

  if (error) return wrapInShell(
    <View style={styles.centerContainer}>
      <Text style={styles.errorIcon}>⚠️</Text>
      <Text style={styles.errorText}>{error}</Text>
    </View>
  );

  if (!results || results.length === 0) return wrapInShell(
    <View style={styles.centerContainer}>
      <Text style={styles.emptyIcon}>🔍</Text>
      <Text style={styles.emptyText}>{t('search_empty_query', { query })}</Text>
      <Text style={styles.emptyHint}>{t('search_empty_hint')}</Text>
    </View>
  );

  const visible = applySearchRefinements(results, {
    colors: colorFilters,
    series: seriesFilters,
    srPlus,
    sort: sortMode,
  });

  // Real filter options derived from the actual result universe.
  const colorOptions = Array.from(new Set(results.flatMap((c) => c.colors || []))).filter((c) =>
    KNOWN_COLOR_KEYS.has(c)
  );
  const seriesOptions = Array.from(new Set(results.flatMap((c) => c.series || [])));

  const cycleSort = () => {
    setSortMode((mode) => SORT_CYCLE[(SORT_CYCLE.indexOf(mode) + 1) % SORT_CYCLE.length]);
  };

  const hasActiveFilters = colorFilters.size > 0 || seriesFilters.size > 0 || srPlus;

  // Pen `Active Filters` row (tTrL3): dismissible accent chips per active
  // color/series filter, neutral chip for the SR 以上 threshold (CT3mi).
  const chipRow = hasActiveFilters ? (
    <View style={styles.chipRow} testID="search-results-chips">
      {Array.from(colorFilters).map((color) => (
        <TouchableOpacity
          key={`color-${color}`}
          style={styles.chipAccent}
          onPress={() => setColorFilters((set) => toggleSetMember(set, color))}
          accessibilityRole="button"
          testID={`search-results-chip-color-${color}`}
        >
          <Text style={styles.chipAccentLabel}>
            {KNOWN_COLOR_KEYS.has(color) ? t(`color_${color}` as Parameters<typeof t>[0]) : color}
          </Text>
          <View testID={`search-results-chip-color-${color}-remove`}>
            <XGlyph color={CHIP_ACCENT_FG} size={11} />
          </View>
        </TouchableOpacity>
      ))}
      {Array.from(seriesFilters).map((code) => (
        <TouchableOpacity
          key={`series-${code}`}
          style={styles.chipAccent}
          onPress={() => setSeriesFilters((set) => toggleSetMember(set, code))}
          accessibilityRole="button"
          testID={`search-results-chip-series-${code}`}
        >
          <Text style={styles.chipAccentLabel}>{code}</Text>
          <View testID={`search-results-chip-series-${code}-remove`}>
            <XGlyph color={CHIP_ACCENT_FG} size={11} />
          </View>
        </TouchableOpacity>
      ))}
      {srPlus ? (
        <TouchableOpacity
          style={styles.chipNeutral}
          onPress={() => setSrPlus(false)}
          accessibilityRole="button"
          testID="search-results-chip-srplus"
        >
          <Text style={styles.chipNeutralLabel}>{t('search_filter_sr_plus' as Parameters<typeof t>[0])}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  ) : null;

  // Pen `Result Count` row (xKkbE): count left, sort control (zkTTM) right.
  const listHeader = (
    <View>
      {chipRow}
      <View style={styles.countRow}>
        <Text style={styles.countText} testID="search-results-count">
          {t('search_found_count', { count: visible.length })}
        </Text>
        <TouchableOpacity
          style={styles.sortControl}
          onPress={cycleSort}
          accessibilityRole="button"
          accessibilityLabel={t(SORT_LABEL_KEY[sortMode] as Parameters<typeof t>[0])}
          testID="search-results-sort"
        >
          <Text style={styles.sortLabel} testID="search-results-sort-label">
            {t(SORT_LABEL_KEY[sortMode] as Parameters<typeof t>[0])}
          </Text>
          <ChevronDownGlyph color={PALETTE.textMuted} size={14} />
        </TouchableOpacity>
      </View>
    </View>
  );

  // Functional filter sheet behind the sliders affordance (w5jzG9). Options
  // come from the real dataset; toggles feed the chips row above.
  const filterPanel = filterPanelOpen ? (
    <View style={styles.filterPanel} testID="search-results-filter-panel">
      <Text style={styles.filterSectionTitle}>{t('search_filter_color' as Parameters<typeof t>[0])}</Text>
      <View style={styles.filterOptionRow}>
        {colorOptions.map((color) => {
          const active = colorFilters.has(color);
          return (
            <TouchableOpacity
              key={color}
              style={[styles.filterOption, active && styles.filterOptionActive]}
              onPress={() => setColorFilters((set) => toggleSetMember(set, color))}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              testID={`search-results-filter-color-${color}`}
            >
              <Text style={[styles.filterOptionLabel, active && styles.filterOptionLabelActive]}>
                {t(`color_${color}` as Parameters<typeof t>[0])}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.filterSectionTitle}>{t('search_filter_rarity' as Parameters<typeof t>[0])}</Text>
      <View style={styles.filterOptionRow}>
        <TouchableOpacity
          style={[styles.filterOption, srPlus && styles.filterOptionActive]}
          onPress={() => setSrPlus((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ selected: srPlus }}
          testID="search-results-filter-srplus"
        >
          <Text style={[styles.filterOptionLabel, srPlus && styles.filterOptionLabelActive]}>
            {t('search_filter_sr_plus' as Parameters<typeof t>[0])}
          </Text>
        </TouchableOpacity>
      </View>
      {seriesOptions.length > 1 ? (
        <>
          <Text style={styles.filterSectionTitle}>{t('search_filter_set' as Parameters<typeof t>[0])}</Text>
          <View style={styles.filterOptionRow}>
            {seriesOptions.map((code) => {
              const active = seriesFilters.has(code);
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.filterOption, active && styles.filterOptionActive]}
                  onPress={() => setSeriesFilters((set) => toggleSetMember(set, code))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  testID={`search-results-filter-series-${code}`}
                >
                  <Text style={[styles.filterOptionLabel, active && styles.filterOptionLabelActive]}>{code}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : null}
      <View style={styles.filterPanelFooter}>
        <TouchableOpacity
          onPress={() => {
            setColorFilters(new Set());
            setSeriesFilters(new Set());
            setSrPlus(false);
          }}
          accessibilityRole="button"
          testID="search-results-filter-reset"
        >
          <Text style={styles.filterReset}>{t('search_reset' as Parameters<typeof t>[0])}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setFilterPanelOpen(false)}
          style={styles.filterDoneButton}
          accessibilityRole="button"
          testID="search-results-filter-done"
        >
          <Text style={styles.filterDone}>{t('search_filter_done' as Parameters<typeof t>[0])}</Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  return wrapInShell(
    <View style={styles.container}>
      <View style={[styles.centerWrap, isDesktop && styles.centerWrapDesktop]}>
        {filterPanel}
        <FlatList
          key={`cols-${numColumns}`}
          data={visible}
          keyExtractor={(item) => item.id}
          numColumns={numColumns}
          // Pen Z6jlE row pitch: 14px between tile rows (spacer nodes
          // SpR0/OFt50). CardListItem carries its own 12px marginBottom, so
          // the extra row margin only applies to the mobile tile grid.
          columnWrapperStyle={
            numColumns > 1
              ? { gap: gridGap, marginBottom: useTileGrid ? MOBILE_ROW_GAP : 0 }
              : undefined
          }
          ListHeaderComponent={listHeader}
          renderItem={({ item }) => (
            <View style={gridItemStyle} testID="search-result-grid-item">
              {useTileGrid ? (
                <SearchResultTile
                  card={item}
                  width={tileWidth}
                  onPress={() => navigation.navigate('CardDetail', { card: item })}
                />
              ) : (
                <CardListItem card={item} onPress={() => navigation.navigate('CardDetail', { card: item })} />
              )}
            </View>
          )}
          contentContainerStyle={styles.list}
          onLayout={onListLayout}
        />
      </View>
    </View>
  );
}

/**
 * Pen `C / Card Tile` instance as used by frame Z6jlE's grid rows: real card
 * art, rarity chip in the art foot, real display name and real listed price
 * (gated by the same Store-MVP flag the list layout used, DIC-1319).
 */
export function SearchResultTile({
  card,
  width,
  onPress,
}: {
  card: CardResult;
  width?: number;
  onPress: () => void;
}) {
  const { preferredCurrency, preferredLanguage } = useSettingsStore();
  const { primary } = resolveCardDisplayName(card, preferredLanguage);
  const price = cardPriceValue(card);
  const showPrice = FEATURES.sellPrice && price != null;
  return (
    <CardTile
      name={primary || card.cardNumber || card.id}
      rarity={card.rarity || undefined}
      price={showPrice ? formatCardPrice(price, preferredCurrency) : undefined}
      imageUrl={card.imageUrl || undefined}
      onPress={onPress}
      width={width}
      testID="search-card-tile"
    />
  );
}

// ──────────────────────────────────────────────
// Two-badge header: Bloom Level (primary) + card category (secondary) for
// Holomen, category-only for Oshi/Support/Yell/Mascot. Colors are picked from
// the Bloom Level / category palette in cardNormalization, never from printing
// rarity — mixing rarity color with a Bloom Level label was the DIC-1141 bug.
function CardIdentityBadges({
  normalized,
  t,
}: {
  normalized: any;
  rarity?: string;
  t: (k: any, p?: any) => string;
}) {
  if (!normalized) return null;
  const isHolomen = normalized.category === 'holomen';
  const stageLabel = normalized.stageLabel;
  const categoryLabel = normalized.categoryLabel;
  const bloomColor = bloomLevelBadgeColor(normalized.stage);
  const catColor = categoryBadgeColor(normalized.category);

  if (isHolomen) {
    // Bloom Level goes first as the primary badge; category chip trails as
    // secondary. When Bloom Level is missing, show "Bloom 等級未取得" — never
    // let the category label ("Holomen") impersonate a Bloom Level.
    return (
      <View style={styles.badgeRow}>
        {stageLabel ? (
          <View style={[styles.bloomBadge, { backgroundColor: bloomColor || '#6b7280' }]}>
            <Text style={styles.bloomBadgeText}>{stageLabel}</Text>
          </View>
        ) : (
          <View style={styles.bloomBadgePending} testID="bloom-badge-pending">
            <Text style={styles.bloomBadgePendingText}>{t('search_bloom_level_pending')}</Text>
          </View>
        )}
        <View style={[styles.categoryChip, { borderColor: catColor || '#6b7280' }]}>
          <Text style={[styles.categoryChipText, { color: catColor || '#6b7280' }]}>{categoryLabel}</Text>
        </View>
      </View>
    );
  }
  if (!categoryLabel) return null;
  return (
    <View style={styles.badgeRow}>
      <View style={[styles.bloomBadge, { backgroundColor: catColor || '#6b7280' }]}>
        <Text style={styles.bloomBadgeText}>{categoryLabel}</Text>
      </View>
    </View>
  );
}

export function CardListItem({ card, onPress }: { card: CardResult; onPress: () => void }) {
  const { t } = useTranslation();
  const [imgErr, setImgErr] = React.useState(false);
  const id = card.cardNumber || card.id;
  const effects = getEffectPreview(card.searchKeywords);
  const { preferredCurrency, preferredLanguage } = useSettingsStore();

  const formatPrice = (price: number | null): string => formatCardPrice(price, preferredCurrency);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.rarityStrip, { backgroundColor: rarityColors[card.rarity] || '#6b7280' }]} />
      {/* Card Image */}
      {card.imageUrl && !imgErr && (
        <View style={styles.cardImageContainer}>
          <Image
            source={{ uri: card.imageUrl }}
            style={{ width: 80, height: 112, borderRadius: 4 }}
            resizeMode="contain"
            onError={() => setImgErr(true)}
          />
        </View>
      )}
      <View style={styles.cardContent}>
        <View style={styles.cardHeader} testID="search-card-header">
          <Text style={styles.cardNumber} numberOfLines={1} testID="search-card-number">{id}</Text>
        </View>

        <View style={styles.identityBadgeLine} accessible={false} testID="search-card-identity-badges">
          <CardIdentityBadges normalized={card.normalized} rarity={card.rarity} t={t} />
        </View>

        {(() => {
          const { primary, secondary } = resolveCardDisplayName(card, preferredLanguage);
          return (
            <>
              <Text style={styles.cardName} numberOfLines={1}>{primary}</Text>
              {secondary ? (
                <Text style={styles.cardNameZh} numberOfLines={1}>{secondary}</Text>
              ) : null}
            </>
          );
        })()}

        {effects && <Text style={styles.cardEffect} numberOfLines={2}>{effects}</Text>}

        <View style={styles.metaRow}>
          {card.seriesNames.map((s, i) => <Text key={i} style={styles.seriesTag}>{s}</Text>)}
          {card.colors.length > 0 && (
            <Text style={styles.colorText}>
              {card.colors.map((color) => (
                // DIC-1192 defence-in-depth: card.colors is normalised in
                // searchCards, but if any future consumer of CardListItem
                // bypasses that path we must NOT hand a non-whitelisted key
                // to t() — it throws on missing keys (i18n/index.ts line 24)
                // and would fail-close the entire SearchResultsScreen the
                // way `color_◇` did at 1440×900 / hBP04. Fall back to the
                // raw token so at worst a single card shows an odd label
                // instead of crashing the whole screen.
                KNOWN_COLOR_KEYS.has(color)
                  ? t(`color_${color}` as Parameters<typeof t>[0])
                  : color
              )).join(' / ')}
            </Text>
          )}
        </View>

        {/* 搜尋結果列上的單卡售價／無交易 badge — Store MVP 也顯示 (DIC-1319)。
            這是該卡自己掛牌價的單一數字，不是行情比較，也不含買賣差價。 */}
        {FEATURES.sellPrice && (
          card.yuyuPrice != null && card.yuyuPrice > 0 ? (
            <View style={styles.priceRowList} testID="search-result-price-row">
              <Text style={styles.priceBadgeList}>{formatPrice(card.yuyuPrice)}</Text>
              {card.prices && card.prices.length > 1 && (
                <Text style={styles.variantBadge}>+{card.prices.length - 1}</Text>
              )}
            </View>
          ) : (
            <Text style={styles.noPriceBadgeList} testID="search-result-no-trade">{t('scan_no_trade')}</Text>
          )
        )}


      </View>
    </TouchableOpacity>
  );
}

// DIC-1150: single source of truth for the numbers the row math depends on
// — the list's horizontal padding and the gap between columns. Both are read by
// the layout tests too so the contract stays honest across viewports.
// DIC-1427: mobile (<768) renders the Pen Z6jlE 3-column Card Tile grid —
// tiles land on the exact Pen width: floor((390-32 − 2·9)/3) = 113.
const LIST_PADDING_X = 16;
const GRID_GAP = 12;
const MOBILE_GRID_COLUMNS = 3;
const MOBILE_GRID_GAP = 9;
const MOBILE_ROW_GAP = 14;
// DIC-1427 QA P1: tile columns for the wider breakpoints (tile design system
// everywhere; Pen defines the 390 frame, wider widths scale the same tile).
const TABLET_TILE_COLUMNS = 6;
const WIDE_TILE_COLUMNS = 8;
// Pen chip label tint (nodes AFVm9/Fx6XO/lAz8y — #FF9AC8 on #FF4D9D24).
const CHIP_ACCENT_FG = '#FF9AC8';
const CHIP_ACCENT_BG = PALETTE.accent + '24';
const CHIP_ACCENT_BORDER = PALETTE.accent + '59';

export const SEARCH_RESULTS_LAYOUT = {
  listPaddingX: LIST_PADDING_X,
  gridGap: GRID_GAP,
  mobileColumns: MOBILE_GRID_COLUMNS,
  mobileGridGap: MOBILE_GRID_GAP,
  mobileRowGap: MOBILE_ROW_GAP,
  tabletTileColumns: TABLET_TILE_COLUMNS,
  wideTileColumns: WIDE_TILE_COLUMNS,
  desktopMaxWidth: 1100,
} as const;

// DIC-1150 CR: layout tests need to render the real FlatList wrapper against a
// dataset of exactly N cards so the mutation `<View style={[gridItemStyle,
// { flexGrow: 1 }]}>` can fail on the last card of a partial row. The production
// module memoizes the DB / series-names load in the two `let` bindings above;
// this helper is the ONLY way to overwrite them from a test without shipping a
// runtime seam. Callers pass `null, null` in `afterEach` to clear the cache so
// the next render re-fetches the real database.
export function __seedSearchResultsCacheForTest(
  db: DatabaseSchema | null,
  names: Record<string, string> | null,
): void {
  cachedDatabase = db;
  databaseFetchPromise = null;
  cachedSeriesNames = names;
  seriesNamesFetchPromise = null;
}

// Pen `App / 02 搜尋結果` shell chrome — back arrow (A2SWo) + search field
// (hKr9H: $app-elev fill, r12, 1px $border, h38, 12px padding, 8px gap).
const shellStyles = StyleSheet.create({
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -6,
  },
  searchField: {
    // No `flex: 1` here: inside the app bar's column-direction center slot,
    // flex-basis 0% would override the fixed height and collapse the field
    // to its 18px content (the regression the DIC-1427 geometry suite
    // caught on the real route). Width comes from the slot's cross-axis
    // stretch; height stays the Pen 38.
    alignSelf: 'stretch',
    height: 38,
    borderRadius: RADII.md,
    backgroundColor: PALETTE.appElev,
    borderWidth: 1,
    borderColor: PALETTE.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 13.5,
    color: PALETTE.textPrimary,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PALETTE.appBg },
  centerWrap: { flex: 1, width: '100%' },
  centerWrapDesktop: { maxWidth: SEARCH_RESULTS_LAYOUT.desktopMaxWidth, alignSelf: 'center' },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background, padding: 20 },
  loadingText: { color: COLORS.text, fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  loadingSubtext: { color: COLORS.textSecondary, fontSize: 13, marginTop: 6 },
  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorText: { color: COLORS.error, fontSize: 16, textAlign: 'center' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { color: COLORS.text, fontSize: 18, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center' },
  list: { padding: LIST_PADDING_X, paddingTop: 0 },
  // Pen `Active Filters` row (tTrL3): pill chips, 6px below the app bar.
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingTop: 6 },
  chipAccent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: CHIP_ACCENT_BG,
    borderWidth: 1,
    borderColor: CHIP_ACCENT_BORDER,
  },
  chipAccentLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    fontWeight: '700',
    color: CHIP_ACCENT_FG,
  },
  chipNeutral: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  chipNeutralLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    fontWeight: '500',
    color: PALETTE.textSecondary,
  },
  // Pen `Result Count` row (xKkbE): 13/600 count left, sort control right.
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 14,
    paddingBottom: 14,
  },
  countText: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.textSecondary,
  },
  sortControl: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sortLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    color: PALETTE.textMuted,
  },
  // Filter sheet behind the sliders affordance (w5jzG9).
  filterPanel: {
    marginHorizontal: LIST_PADDING_X,
    marginTop: SPACING.md,
    padding: SPACING.lg,
    borderRadius: RADII.md,
    backgroundColor: PALETTE.appSurface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: SPACING.md,
  },
  filterSectionTitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    fontWeight: '600',
    color: PALETTE.textSecondary,
    marginTop: SPACING.xs,
  },
  filterOptionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filterOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: PALETTE.appElev,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  filterOptionActive: {
    backgroundColor: CHIP_ACCENT_BG,
    borderColor: CHIP_ACCENT_BORDER,
  },
  filterOptionLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    fontWeight: '500',
    color: PALETTE.textSecondary,
  },
  filterOptionLabelActive: { color: CHIP_ACCENT_FG, fontWeight: '700' },
  filterPanelFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  filterReset: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    color: PALETTE.textMuted,
  },
  filterDoneButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: RADII.pill,
    backgroundColor: PALETTE.accent,
  },
  filterDone: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  card: { flexDirection: 'row', backgroundColor: COLORS.surface, borderRadius: 12, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.border, minHeight: 140 },
  cardImageContainer: { padding: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderRadius: 4, marginRight: 4 },
  rarityStrip: { width: 5, minWidth: 5 },
  cardContent: { flex: 1, padding: 14, paddingRight: 8 },
  // DIC-1150 CR: the identity chips live on their own row. Keeping them inside
  // this header left only 43-53px for a 69px identifier at real product widths.
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  cardNumber: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700', flexShrink: 0, minWidth: 72 },
  identityBadgeLine: { minHeight: 22, alignItems: 'flex-start', marginBottom: 6 },
  rarityBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, minWidth: 45, alignItems: 'center' },
  rarityText: { color: COLORS.text, fontSize: 11, fontWeight: '800' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  bloomBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, minWidth: 48, alignItems: 'center' },
  bloomBadgeText: { color: '#ffffff', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  bloomBadgePending: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.border, backgroundColor: 'transparent' },
  bloomBadgePendingText: { color: COLORS.textSecondary, fontSize: 10, fontWeight: '700' },
  categoryChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1, backgroundColor: 'transparent' },
  categoryChipText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  cardName: { color: COLORS.text, fontSize: 17, fontWeight: '700', marginBottom: 3 },
  cardNameZh: { color: COLORS.primary, fontSize: 13, marginBottom: 3 },
  cardEffect: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginBottom: 4 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8, alignItems: 'center' },
  seriesTag: { color: COLORS.textSecondary, fontSize: 11, backgroundColor: COLORS.surfaceLight, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  colorText: { color: COLORS.textSecondary, fontSize: 11 },
  quickLinks: { flexDirection: 'row', gap: 8, marginTop: 'auto' },
  quickLink: { backgroundColor: COLORS.surfaceLight, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  quickLinkText: { color: COLORS.primary, fontSize: 12, fontWeight: '600' },
  priceRowList: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 'auto', alignSelf: 'flex-end' },
  priceBadgeList: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: '700',
    marginTop: 'auto',
    alignSelf: 'flex-end',
  },
  variantBadge: {
    color: COLORS.primary,
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: COLORS.primary + '1a',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 'auto',
  },
  noPriceBadgeList: {
    color: COLORS.textSecondary + '99',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 'auto',
    alignSelf: 'flex-end',
  },
});
