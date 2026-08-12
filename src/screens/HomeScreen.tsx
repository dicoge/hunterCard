import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView, ActivityIndicator } from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { loadDatabaseJson, loadSeriesNamesJson } from '../utils/staticData';
import { buildSeriesCatalog, SeriesCatalog } from '../utils/seriesCatalog';

// ── Module-level cache for series data ──

let cachedSeries: SeriesCatalog | null = null;
let seriesFetchPromise: Promise<SeriesCatalog> | null = null;

async function fetchSeriesData(): Promise<SeriesCatalog> {
  if (cachedSeries) return cachedSeries;
  if (seriesFetchPromise) return seriesFetchPromise;

  seriesFetchPromise = (async () => {
    // Load both files in parallel. On native these resolve from the bundled,
    // pre-sanitized asset; on web from the same-origin /data/* URL (staticData).
    const [db, seriesNames] = await Promise.all([
      loadDatabaseJson(),
      loadSeriesNamesJson(),
    ]);

    const result = buildSeriesCatalog(db, seriesNames);
    cachedSeries = result;
    return result;
  })();

  return seriesFetchPromise;
}

// Color quick access buttons (static, unchanged)
const COLOR_BUTTONS = [
  { label: '白', query: '白色', color: '#ffffff' },
  { label: '青', query: '青色', color: '#3b82f6' },
  { label: '緑', query: '綠色', color: '#10b981' },
  { label: '赤', query: '紅色', color: '#ef4444' },
  { label: '紫', query: '紫色', color: '#8b5cf6' },
  { label: '黄', query: '黃色', color: '#f59e0b' },
];

export default function HomeScreen({ navigation }: any) {
  const [seriesData, setSeriesData] = useState<SeriesCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const { isDesktop } = useBreakpoint();
  const cardBtnStyle = isDesktop ? [styles.cardBtn, styles.cardBtnDesktop] : styles.cardBtn;

  useEffect(() => {
    fetchSeriesData()
      .then(data => setSeriesData(data))
      .catch(() => setSeriesData(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView style={styles.container} contentContainerStyle={isDesktop ? styles.scrollContentDesktop : undefined}>
       <View style={isDesktop ? styles.innerDesktop : styles.inner}>
        {/* Hero Section */}
        <View style={styles.hero}>
          <Text style={styles.heroTitle}>hololive Card Game</Text>
          <Text style={styles.heroSub}>卡牌查詢 · 非官方工具</Text>
        </View>

        {/* Search Input */}
        <TouchableOpacity
          style={styles.searchBar}
          onPress={() => navigation.navigate('Search')}
          activeOpacity={0.7}
        >
          <Text style={styles.searchIcon}>🔍</Text>
          <Text style={styles.searchPlaceholder}>卡號或成員名稱...</Text>
        </TouchableOpacity>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>載入系列資料...</Text>
          </View>
        ) : seriesData ? (
          <>
            {/* Booster Packs */}
            {seriesData.boosters.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>ブースターパック</Text>
                <View style={styles.cardGrid}>
                  {seriesData.boosters.map((item) => (
                    <TouchableOpacity
                      key={item.query}
                      style={cardBtnStyle}
                      onPress={() => navigation.navigate('SearchResults', { query: item.query })}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.cardLabel}>{item.label}</Text>
                      <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Starter Decks */}
            {seriesData.starters.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>スタートデッキ</Text>
                <View style={styles.cardGrid}>
                  {seriesData.starters.map((item) => (
                    <TouchableOpacity
                      key={item.query}
                      style={cardBtnStyle}
                      onPress={() => navigation.navigate('SearchResults', { query: item.query })}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.cardLabel}>{item.label}</Text>
                      <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* Special & Promo */}
            {seriesData.special.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>特殊・PR</Text>
                <View style={styles.cardGrid}>
                  {seriesData.special.map((item) => (
                    <TouchableOpacity
                      key={item.query}
                      style={cardBtnStyle}
                      onPress={() => navigation.navigate('SearchResults', { query: item.query })}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.cardLabel}>{item.label}</Text>
                      <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </>
        ) : (
          <View style={styles.loadingContainer}>
            <Text style={styles.errorText}>⚠️ 無法載入系列資料</Text>
          </View>
        )}

        {/* Color Search */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>カラー</Text>
          <View style={styles.colorGrid}>
            {COLOR_BUTTONS.map((btn) => (
              <TouchableOpacity
                key={btn.query}
                style={[styles.colorBtn, { backgroundColor: btn.color + '15', borderColor: btn.color }]}
                onPress={() => navigation.navigate('SearchResults', { query: btn.query })}
                activeOpacity={0.7}
              >
                <View style={[styles.colorDot, { backgroundColor: btn.color }]} />
                <Text style={[styles.colorBtnText, { color: btn.color }]}>{btn.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
       </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  scrollContentDesktop: { alignItems: 'center' },
  inner: { width: '100%' },
  innerDesktop: { width: '100%', maxWidth: 1100 },
  hero: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  heroTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 3,
    textAlign: 'center',
    marginBottom: 8,
  },
  heroSub: {
    color: '#666666',
    fontSize: 24,
    fontWeight: '300',
    letterSpacing: 2,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 4,
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: '#333333',
  },
  searchIcon: { fontSize: 16, marginRight: 12 },
  searchPlaceholder: { color: '#666666', fontSize: 14 },
  loadingContainer: { padding: 40, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#666666', fontSize: 14, marginTop: 12 },
  errorText: { color: '#ef4444', fontSize: 14 },
  section: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  sectionTitle: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 2,
    marginBottom: 16,
    textTransform: 'uppercase',
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  cardBtn: {
    backgroundColor: '#1a1a1a',
    borderRadius: 2,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#333333',
    width: '31%',
  },
  cardBtnDesktop: {
    width: 200,
    flexGrow: 0,
  },
  cardLabel: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  cardName: {
    color: '#666666',
    fontSize: 10,
    fontWeight: '400',
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  colorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 2,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    gap: 8,
  },
  colorDot: { width: 8, height: 8, borderRadius: 4 },
  colorBtnText: { fontSize: 13, fontWeight: '500', letterSpacing: 1 },
});
