import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Linking, ActivityIndicator, Image } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { COLORS, convertPrice } from '../constants';
import { useSettingsStore } from '../store/settingsStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { releaseCardFlags } from '../config/releaseFlags';
import { stripDisabledCardFields } from '../utils/cardReleaseFilter';
import { loadDatabaseJson, loadSeriesNamesJson } from '../utils/staticData';
import { useTranslation } from '../i18n';
import { uniformGridItemStyle } from '../utils/gridLayout';
import { normalizeCardIdentity, bloomLevelBadgeColor, categoryBadgeColor, PRINTING_RARITY_COLORS } from '../utils/cardNormalization';

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

function searchCards(database: DatabaseSchema, query: string, nameMap: Record<string, string>): CardResult[] {
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
    const rawColor = (c.color || '').toLowerCase();
    const colors = rawColor ? [rawColor] : [];
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
  const numColumns = isWide ? 3 : isDesktop ? 2 : 1;
  // DIC-1150: measure the row's available width so each card lands on an exact
  // pixel width (containerWidth - (n-1) * GRID_GAP) / n. Mixing the fixed 12px
  // `columnWrapper` gap with a guessed percentage gap was the root cause of the
  // horizontal scrollbar and the unaligned third column on desktop.
  const [rowWidth, setRowWidth] = useState(0);
  const onListLayout = useCallback((event: LayoutChangeEvent) => {
    // padding-left + padding-right of the FlatList's contentContainerStyle.
    const contentWidth = event.nativeEvent.layout.width - LIST_PADDING_X * 2;
    setRowWidth((prev) => (prev === contentWidth ? prev : Math.max(0, contentWidth)));
  }, []);
  const gridItemStyle = useMemo(
    () => uniformGridItemStyle({ columns: numColumns, containerWidth: rowWidth, gap: GRID_GAP }),
    [numColumns, rowWidth]
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

  if (loading) return (
    <View style={styles.centerContainer}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.loadingText}>{t('search_database_loading')}</Text>
    </View>
  );

  if (error) return (
    <View style={styles.centerContainer}>
      <Text style={styles.errorIcon}>⚠️</Text>
      <Text style={styles.errorText}>{error}</Text>
    </View>
  );

  if (!results || results.length === 0) return (
    <View style={styles.centerContainer}>
      <Text style={styles.emptyIcon}>🔍</Text>
      <Text style={styles.emptyText}>{t('search_empty_query', { query })}</Text>
      <Text style={styles.emptyHint}>{t('search_empty_hint')}</Text>
    </View>
  );

  const openUrl = (url: string) => Linking.openURL(url);

  return (
    <View style={styles.container}>
      <View style={[styles.centerWrap, isDesktop && styles.centerWrapDesktop]}>
        <View style={styles.header}>
          <Text style={{ ...styles.queryText, color: COLORS.text }}>{t('search_results_for', { query })}</Text>
          <Text style={{ ...styles.resultCount, color: COLORS.textSecondary }}>{t('search_found_count', { count: results.length })}</Text>
        </View>
        <FlatList
          key={`cols-${numColumns}`}
          data={results}
          keyExtractor={(item) => item.id}
          numColumns={numColumns}
          columnWrapperStyle={numColumns > 1 ? styles.columnWrapper : undefined}
          renderItem={({ item }) => (
            <View style={gridItemStyle}>
              <CardListItem card={item} onPress={() => navigation.navigate('CardDetail', { card: item })} />
            </View>
          )}
          contentContainerStyle={styles.list}
          onLayout={onListLayout}
        />
      </View>
    </View>
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

  const formatPrice = (price: number | null): string => {
    if (price == null) return '—';
    if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
    const { value, symbol } = convertPrice(price, preferredCurrency);
    return `${symbol}${value?.toLocaleString() || '—'}`;
  };

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

        <Text style={styles.cardName} numberOfLines={1}>
          {preferredLanguage === 'zh' && card.nameZh ? card.nameZh : card.name}
        </Text>
        {preferredLanguage === 'zh' && card.nameZh ? (
          <Text style={styles.cardNameZh} numberOfLines={1}>{card.name}</Text>
        ) : null}

        {effects && <Text style={styles.cardEffect} numberOfLines={2}>{effects}</Text>}

        <View style={styles.metaRow}>
          {card.seriesNames.map((s, i) => <Text key={i} style={styles.seriesTag}>{s}</Text>)}
          {card.colors.length > 0 && (
            <Text style={styles.colorText}>
              {card.colors.map((color) => t(`color_${color}` as Parameters<typeof t>[0])).join(' / ')}
            </Text>
          )}
        </View>

        {card.yuyuPrice != null && card.yuyuPrice > 0 ? (
          <View style={styles.priceRowList}>
            <Text style={styles.priceBadgeList}>{formatPrice(card.yuyuPrice)}</Text>
            {card.prices && card.prices.length > 1 && (
              <Text style={styles.variantBadge}>+{card.prices.length - 1}</Text>
            )}
          </View>
        ) : (
          <Text style={styles.noPriceBadgeList}>{t('scan_no_trade')}</Text>
        )}


      </View>
    </TouchableOpacity>
  );
}

// DIC-1150: single source of truth for the two numbers the row math depends on
// — the list's horizontal padding and the gap between columns. Both are read by
// the layout tests too so the contract stays honest across viewports.
const LIST_PADDING_X = 16;
const GRID_GAP = 12;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centerWrap: { flex: 1, width: '100%' },
  centerWrapDesktop: { maxWidth: 1100, alignSelf: 'center' },
  columnWrapper: { gap: GRID_GAP },
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background, padding: 20 },
  loadingText: { color: COLORS.text, fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' },
  loadingSubtext: { color: COLORS.textSecondary, fontSize: 13, marginTop: 6 },
  errorIcon: { fontSize: 48, marginBottom: 12 },
  errorText: { color: COLORS.error, fontSize: 16, textAlign: 'center' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { color: COLORS.text, fontSize: 18, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center' },
  header: { padding: 16, paddingBottom: 8 },
  queryText: { fontSize: 22, fontWeight: 'bold', marginBottom: 4 },
  resultCount: { fontSize: 13 },
  list: { padding: LIST_PADDING_X, paddingTop: 0 },
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
