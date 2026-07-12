import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Linking, ActivityIndicator, Image } from 'react-native';
import { COLORS, convertPrice } from '../constants';
import { useSettingsStore } from '../store/settingsStore';

// ── Server-side search constants ──

// Module-level cache for series names (fetched from JSON)
let cachedSeriesNames: Record<string, string> | null = null;
let seriesNamesFetchPromise: Promise<Record<string, string>> | null = null;

async function fetchSeriesNames(): Promise<Record<string, string>> {
  if (cachedSeriesNames) return cachedSeriesNames;
  if (seriesNamesFetchPromise) return seriesNamesFetchPromise;

  seriesNamesFetchPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('/data/series-names.json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const names: Record<string, string> = await res.json();
      cachedSeriesNames = names;
      return names;
    } finally {
      clearTimeout(timeoutId);
    }
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

const rarityColors: Record<string, string> = {
  N: '#8B4513', C: '#6b7280', U: '#10b981', R: '#3b82f6', SR: '#f59e0b',
};
const gradeLabels: Record<string, string> = {
  debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot',
};

// ── Types ──

interface CardRecord {
  id: string; name: string; series: string; type: string; rarity: string;
  color: string; localImage?: string; officialImage?: string;
  sellPrice?: number | null; buyPrice?: number | null; yuyuName?: string; yuyuImage?: string;
  prices?: { name: string; sellPrice: number | null; rarity: string }[];
  priceHistory?: Record<string, number>;
  ytStats?: any;
  effects?: string[]; hp?: string; life?: string; arts?: string;
  nameZh?: string;
}

interface CardResult {
  id: string; name: string; type: string; grade: string; rarity: string;
  colors: string[]; colorNames: string[]; series: string[]; seriesNames: string[];
  tags: string[]; cardNumber: string; imageUrl: string;
  yuyuUrl: string; carousellUrl: string; officialUrl: string;
  yuyuPrice?: number | null;
  sellPrice?: number | null; buyPrice?: number | null; ytStats?: any;
  prices?: { name: string; sellPrice: number | null; rarity: string }[];
  priceHistory?: Record<string, number>;
  searchKeywords?: string[];
  nameZh?: string;
  skillsJp?: any;
  skillsZh?: any;
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/data/database.json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const db: DatabaseSchema = await res.json();
      cachedDatabase = db;
      return db;
    } finally {
      clearTimeout(timeoutId);
    }
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

  return deduped.map((c: CardRecord) => {
    const id = c.id || '';
    const name = c.name || '';
    const rawColor = (c.color || '').toLowerCase();
    const colors = rawColor ? [rawColor] : [];
    const colorNames = colors.map((x: string) => COLOR_MAP[x] || x);
    const series = c.series ? [c.series] : [];
    const seriesNames = series.map((s: string) => nameMap[s] || s);
    const cardNumber = (c as any).cardNumber || id;

    // Grade/rarity mapping (same as original api/search.ts logic)
    const rarityCode = (c.rarity || '').toUpperCase();
    let grade = '';
    let rarity = 'C';
    if (rarityCode.includes('OSR') || rarityCode.includes('OUR')) { grade = 'buzz'; rarity = 'SR'; }
    else if (rarityCode === 'UR') { grade = '2nd'; rarity = 'R'; }
    else if (rarityCode === 'SR') { grade = '1st'; rarity = 'U'; }
    else if (rarityCode === 'RR') { grade = 'debut'; rarity = 'C'; }
    else if (rarityCode === 'R') { grade = 'debut'; rarity = 'C'; }
    else if (rarityCode === 'U') { grade = 'debut'; rarity = 'C'; }
    else if (rarityCode === 'C') { grade = 'debut'; rarity = 'C'; }
    else if (rarityCode === 'N') { grade = 'spot'; rarity = 'N'; }

    // Use official image (400×559) first for sharp display, local image (100×140) as fallback
    const imageUrl = c.officialImage || c.localImage || '';

    return {
      id,
      name,
      cardNumber,
      type: c.type || '',
      grade,
      rarity,
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
    };
  });
}

// Extract effect text from searchKeywords (index 3+)
function getEffectPreview(kw: string[] = []): string {
  const gameTerms = ['給予', '抽', '傷害', '牌組', '手札', '成員', '中央', '藝能', 'HP', '生命', '階段', '回合', '特殊', '公開'];
  return kw.slice(3).filter((t: string) => t.trim().length > 8 && gameTerms.some(g => t.includes(g))).join('\n');
}

// ── Screen component ──

export default function SearchResultsScreen({ route, navigation }: any) {
  const query = route?.params?.query || '';
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<CardResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setError('無搜尋關鍵字');
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
          setError('查詢逾時，請稍後再試');
        } else {
          setError(err instanceof Error ? err.message : '資料庫載入失敗');
        }
      } finally {
        setLoading(false);
      }
    };
    run();
  }, [query]);

  if (loading) return (
    <View style={styles.centerContainer}>
      <ActivityIndicator size="large" color={COLORS.primary} />
      <Text style={styles.loadingText}>正在載入卡牌資料庫...</Text>
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
      <Text style={styles.emptyText}>找不到「{query}」的結果</Text>
      <Text style={styles.emptyHint}>試試看日文名稱、卡號、或系列代碼</Text>
    </View>
  );

  const openUrl = (url: string) => Linking.openURL(url);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={{ ...styles.queryText, color: COLORS.text }}>搜尋結果：{query}</Text>
        <Text style={{ ...styles.resultCount, color: COLORS.textSecondary }}>找到 {results.length} 張卡牌</Text>
      </View>
      <FlatList
        data={results}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <CardListItem card={item} onPress={() => navigation.navigate('CardDetail', { card: item })} />
        )}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

// ──────────────────────────────────────────────
function CardListItem({ card, onPress }: { card: CardResult; onPress: () => void }) {
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
        <View style={styles.cardHeader}>
          <Text style={styles.cardNumber}>{id}</Text>
          <View style={[styles.rarityBadge, { backgroundColor: rarityColors[card.rarity] || '#6b7280' }]}>
            <Text style={styles.rarityText}>{gradeLabels[card.grade] || card.grade}</Text>
          </View>
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
          {card.colorNames.length > 0 && <Text style={styles.colorText}>{card.colorNames.join(' / ')}</Text>}
        </View>

        {card.yuyuPrice != null && card.yuyuPrice > 0 ? (
          <View style={styles.priceRowList}>
            <Text style={styles.priceBadgeList}>{formatPrice(card.yuyuPrice)}</Text>
            {card.prices && card.prices.length > 1 && (
              <Text style={styles.variantBadge}>+{card.prices.length - 1}</Text>
            )}
          </View>
        ) : (
          <Text style={styles.noPriceBadgeList}>尚無交易</Text>
        )}


      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
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
  list: { padding: 16, paddingTop: 0 },
  card: { flexDirection: 'row', backgroundColor: COLORS.surface, borderRadius: 12, marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.border, minHeight: 140 },
  cardImageContainer: { padding: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderRadius: 4, marginRight: 4 },
  rarityStrip: { width: 5, minWidth: 5 },
  cardContent: { flex: 1, padding: 14, paddingRight: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardNumber: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '700' },
  rarityBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, minWidth: 45, alignItems: 'center' },
  rarityText: { color: COLORS.text, fontSize: 11, fontWeight: '800' },
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