import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, SafeAreaView, ActivityIndicator } from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';
import { loadDatabaseJson, loadSeriesNamesJson } from '../utils/staticData';
import { buildSeriesCatalog, SeriesCatalog } from '../utils/seriesCatalog';

let cachedSeries: SeriesCatalog | null = null;
let seriesFetchPromise: Promise<SeriesCatalog> | null = null;

async function fetchSeriesData(): Promise<SeriesCatalog> {
  if (cachedSeries) return cachedSeries;
  if (seriesFetchPromise) return seriesFetchPromise;

  seriesFetchPromise = (async () => {
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

const COLOR_BUTTONS = [
  { label: '白', query: '白色', color: '#ffffff' },
  { label: '青', query: '青色', color: '#3b82f6' },
  { label: '緑', query: '綠色', color: '#10b981' },
  { label: '赤', query: '紅色', color: '#ef4444' },
  { label: '紫', query: '紫色', color: '#8b5cf6' },
  { label: '黄', query: '黃色', color: '#f59e0b' },
];

export default function HomeScreen({ navigation }: any) {
  const { t } = useTranslation();
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
          <Text style={styles.heroTitle}>{t('home_hero_title')}</Text>
          <Text style={styles.heroSub}>{t('home_hero_sub')}</Text>
        </View>

        {/* Search Input */}
        <TouchableOpacity
          style={styles.searchBar}
          onPress={() => navigation.navigate('Search')}
          activeOpacity={0.7}
        >
          <Text style={styles.searchIcon}>🔍</Text>
          <Text style={styles.searchPlaceholder}>{t('home_search_placeholder')}</Text>
        </TouchableOpacity>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>{t('home_loading_series')}</Text>
          </View>
        ) : seriesData ? (
          <>
            {/* Booster Packs */}
            {seriesData.boosters.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('home_boosters')}</Text>
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
                <Text style={styles.sectionTitle}>{t('home_starters')}</Text>
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
                <Text style={styles.sectionTitle}>{t('home_special')}</Text>
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
            <Text style={styles.errorText}>{t('home_series_error')}</Text>
          </View>
        )}

        {/* Color Search */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('home_color_filter')}</Text>
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
    backgroundColor: '#141414',
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 24,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262626',
  },
  searchIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  searchPlaceholder: {
    color: '#666666',
    fontSize: 15,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    color: '#666666',
    fontSize: 14,
    marginTop: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 28,
  },
  sectionTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 14,
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  cardBtn: {
    width: '48%',
    backgroundColor: '#141414',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262626',
  },
  cardBtnDesktop: {
    width: '23%',
  },
  cardLabel: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardName: {
    color: '#cccccc',
    fontSize: 13,
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  colorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  colorBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
