import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { FEATURES } from '../config/releaseFlags';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';
import { loadDatabaseJson, loadSeriesNamesJson } from '../utils/staticData';
import { buildSeriesCatalog, SeriesCatalog } from '../utils/seriesCatalog';
import { AppShell, buildShellTabs } from '../components/shell';
import { SeriesCard } from '../components/cards';
import {
  PALETTE,
  SEMANTIC,
  CATEGORY_COLORS,
  FONTS,
  RADII,
  SPACING,
  TYPE_SCALE,
} from '../theme/tokensV2';

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

// Test seam (same pattern as SearchResultsScreen's __seedSearchResultsCacheForTest):
// the module-level cache above is the only way a JSDOM regression can render the
// real screen against a deterministic catalog. Pass `null` to clear.
export function __seedHomeSeriesCacheForTest(catalog: SeriesCatalog | null): void {
  cachedSeries = catalog;
  seriesFetchPromise = null;
}

// Pen `App / 01 首頁` (frame tmKqY) — Color Chips row (node gfXsp): six chips,
// $app-surface fill, r10, 9px dot in the Pen category color. Queries stay on
// the shipped search vocabulary (COLOR_TO_CN in SearchResultsScreen resolves
// both 藍色 and 青色 onto `blue`), so behavior is unchanged.
export const HOME_COLOR_CHIPS = [
  { label: '白', query: '白色', color: CATEGORY_COLORS.white },
  { label: '藍', query: '藍色', color: CATEGORY_COLORS.blue },
  { label: '綠', query: '綠色', color: CATEGORY_COLORS.green },
  { label: '赤', query: '紅色', color: CATEGORY_COLORS.red },
  { label: '紫', query: '紫色', color: CATEGORY_COLORS.purple },
  { label: '黃', query: '黃色', color: CATEGORY_COLORS.yellow },
] as const;

// Pen Quick Actions (node OJimN): four $app-surface tiles with an accent glyph.
// Every destination is an already-registered route — 到價提醒 is gated on the
// same FEATURES.watchlist flag that registers/unregisters its drawer route.
const QUICK_ACTIONS: {
  key: string;
  labelKey: 'nav_scan' | 'nav_tournament_report' | 'nav_tutorial' | 'nav_watchlist';
  glyph: string;
  tint: string;
  route: string;
  gate?: 'watchlist';
}[] = [
  { key: 'scan', labelKey: 'nav_scan', glyph: '⌖', tint: PALETTE.accent, route: 'Scan' },
  { key: 'tournament', labelKey: 'nav_tournament_report', glyph: '◍', tint: PALETTE.accent2, route: 'TournamentReport' },
  { key: 'tutorial', labelKey: 'nav_tutorial', glyph: '✦', tint: PALETTE.accent3, route: 'Tutorial' },
  { key: 'watchlist', labelKey: 'nav_watchlist', glyph: '◔', tint: PALETTE.cYellow, route: 'Watchlist', gate: 'watchlist' },
];

export default function HomeScreen({ navigation }: any) {
  const { t } = useTranslation();
  const [seriesData, setSeriesData] = useState<SeriesCatalog | null>(cachedSeries);
  const [loading, setLoading] = useState(cachedSeries == null);
  const { isDesktop } = useBreakpoint();

  useEffect(() => {
    fetchSeriesData()
      .then(data => setSeriesData(data))
      .catch(() => setSeriesData(null))
      .finally(() => setLoading(false));
  }, []);

  const tabs = useMemo(() => buildShellTabs({ navigation }), [navigation]);
  const quickActions = QUICK_ACTIONS.filter((a) => (a.gate === 'watchlist' ? FEATURES.watchlist : true));

  const appBarActions = [
    ...(FEATURES.watchlist
      ? [{
          key: 'bell',
          label: t('nav_watchlist'),
          icon: <Text style={styles.appBarGlyph}>◔</Text>,
          onPress: () => navigation.navigate('Watchlist'),
        }]
      : []),
    {
      key: 'settings',
      label: t('nav_settings'),
      icon: <Text style={styles.appBarGlyph}>⚙</Text>,
      onPress: () => navigation.navigate('Settings'),
    },
  ];

  const seriesColumns = isDesktop ? 4 : 2;

  const renderSeriesGrid = (items: SeriesCatalog['boosters'], testIDPrefix: string) => {
    const rows: SeriesCatalog['boosters'][] = [];
    for (let i = 0; i < items.length; i += seriesColumns) {
      rows.push(items.slice(i, i + seriesColumns));
    }
    return rows.map((row, rowIdx) => (
      <View key={rowIdx} style={styles.seriesRow}>
        {row.map((item) => (
          <View key={item.query} style={styles.seriesCell}>
            <SeriesCard
              code={item.label}
              title={item.name}
              thumbUrl={item.thumbUrl}
              fluid
              onPress={() => navigation.navigate('SearchResults', { query: item.query })}
              testID={`${testIDPrefix}-${item.label}`}
            />
          </View>
        ))}
        {row.length < seriesColumns
          ? Array.from({ length: seriesColumns - row.length }).map((_, i) => (
              <View key={`pad-${i}`} style={styles.seriesCell} />
            ))
          : null}
      </View>
    ));
  };

  const sectionHead = (title: string, count?: number) => (
    <View style={styles.sectionHead}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {count != null ? <Text style={styles.sectionMore}>全部 {count}</Text> : null}
    </View>
  );

  return (
    <AppShell
      appBar={{
        title: 'HoloHunter',
        showBrand: true,
        onLeadingPress: () => navigation.openDrawer?.(),
        actions: appBarActions,
      }}
      bottomTabBar={{ items: tabs, activeKey: 'home' }}
      testID="home-shell"
    >
      {/* Search Field — Pen node BxPhh: $app-elev, r14, 46h, muted glyph + placeholder */}
      <TouchableOpacity
        style={styles.searchField}
        onPress={() => navigation.navigate('Search')}
        activeOpacity={0.8}
        accessibilityRole="button"
        testID="home-search-field"
      >
        <Text style={styles.searchGlyph}>⌕</Text>
        <Text style={styles.searchPlaceholder}>{t('home_search_placeholder')}</Text>
      </TouchableOpacity>

      {/* Quick Actions — Pen node OJimN */}
      <View style={styles.quickRow} testID="home-quick-actions">
        {quickActions.map((action) => (
          <TouchableOpacity
            key={action.key}
            style={styles.quickTile}
            onPress={() => navigation.navigate(action.route)}
            activeOpacity={0.8}
            accessibilityRole="button"
            testID={`home-quick-${action.key}`}
          >
            <Text style={[styles.quickGlyph, { color: action.tint }]}>{action.glyph}</Text>
            <Text style={styles.quickLabel} numberOfLines={1}>{t(action.labelKey)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 依顏色快速篩選 — Pen nodes FXEpL + gfXsp */}
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{t('home_color_filter')}</Text>
      </View>
      <View style={styles.colorRow} testID="home-color-chips">
        {HOME_COLOR_CHIPS.map((chip) => (
          <TouchableOpacity
            key={chip.query}
            style={styles.colorChip}
            onPress={() => navigation.navigate('SearchResults', { query: chip.query })}
            activeOpacity={0.8}
            accessibilityRole="button"
            testID={`home-color-${chip.label}`}
          >
            <View style={[styles.colorDot, { backgroundColor: chip.color }]} />
            <Text style={styles.colorLabel}>{chip.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={PALETTE.accent} />
          <Text style={styles.loadingText}>{t('home_loading_series')}</Text>
        </View>
      ) : seriesData ? (
        <>
          {seriesData.boosters.length > 0 && (
            <View style={styles.section} testID="home-boosters">
              {sectionHead(t('home_boosters'), seriesData.boosters.length)}
              {renderSeriesGrid(seriesData.boosters, 'home-booster')}
            </View>
          )}
          {seriesData.starters.length > 0 && (
            <View style={styles.section} testID="home-starters">
              {sectionHead(t('home_starters'), seriesData.starters.length)}
              {renderSeriesGrid(seriesData.starters, 'home-starter')}
            </View>
          )}
          {seriesData.special.length > 0 && (
            <View style={styles.section} testID="home-special">
              {sectionHead(t('home_special'), seriesData.special.length)}
              {renderSeriesGrid(seriesData.special, 'home-series')}
            </View>
          )}
        </>
      ) : (
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>{t('home_series_error')}</Text>
        </View>
      )}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  appBarGlyph: {
    fontSize: 18,
    lineHeight: 22,
    color: SEMANTIC.onBgMuted,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 46,
    backgroundColor: PALETTE.appElev,
    borderRadius: 14,
    paddingHorizontal: 14,
    gap: 10,
    marginTop: SPACING.sm,
  },
  searchGlyph: {
    fontSize: 18,
    color: SEMANTIC.onBgDim,
  },
  searchPlaceholder: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 13.5,
    color: SEMANTIC.onBgDim,
  },
  quickRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  quickTile: {
    flex: 1,
    backgroundColor: PALETTE.appSurface,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: 71,
  },
  quickGlyph: {
    fontSize: 21,
    lineHeight: 22,
  },
  quickLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.micro.size,
    fontWeight: '600',
    color: '#B9B9CE',
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 10,
  },
  sectionTitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.body.size,
    fontWeight: '700',
    color: SEMANTIC.onBg,
  },
  sectionMore: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: TYPE_SCALE.small.size,
    color: SEMANTIC.onBgDim,
  },
  // Pen Color Chips row (node gfXsp): six 53×34 chips fill the 358 content
  // width on one row — flex:1 keeps that ratio at every breakpoint.
  colorRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  colorChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.appSurface,
    borderRadius: 10,
    height: 34,
    gap: 6,
  },
  colorDot: {
    width: 9,
    height: 9,
    borderRadius: RADII.pill,
  },
  colorLabel: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    fontSize: 12.5,
    fontWeight: '600',
    color: '#B9B9CE',
  },
  section: {
    width: '100%',
  },
  seriesRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  seriesCell: {
    flex: 1,
    minWidth: 0,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: SPACING['5xl'],
  },
  loadingText: {
    color: SEMANTIC.onBgDim,
    fontSize: TYPE_SCALE.label.size,
    marginTop: SPACING.lg,
  },
  errorText: {
    color: SEMANTIC.error,
    fontSize: TYPE_SCALE.label.size,
  },
});
