import React, { useEffect, useReducer, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import type { DrawerNavigationProp } from '@react-navigation/drawer';
import { COLORS } from '../constants';
import { PALETTE, SEMANTIC, CATEGORY_COLORS } from '../theme/tokensV2';
import { openUrl } from '../utils/openUrl';
import { useTranslation } from '../i18n';
import { useBreakpoint } from '../hooks/useBreakpoint';
import type {
  MonthlyReport,
  TournamentIndex,
  TournamentEvent,
  DeckEntry,
} from '../types/tournament';
import type { MainDrawerParamList } from '../types';
import {
  tournamentReportReducer,
  initialTournamentReportState,
  reportsInScope,
  scopeLoading,
  scopeError,
  scopeWindow,
  omittedMonths,
  incompleteMonths,
  scopeIsPartial,
  runBounded,
  MAX_SCOPE_MONTHS,
  MAX_CONCURRENT_REPORT_LOADS,
} from '../utils/tournamentReportState';
import {
  ALL_SCOPE,
  buildDonutModel,
  filterEventsBySlice,
  SMALL_SAMPLE_MIN,
  type DonutDimension,
} from '../utils/tournamentDonut';
import {
  buildTournamentMonthlySummary,
  buildEventHighlights,
  filterEventsByColor,
  type EventHighlight,
} from '../utils/tournamentSummary';
import ObservedShareDonut from '../components/ObservedShareDonut';
import ObservedShareBar from '../components/ObservedShareBar';
import { useDeckStore } from '../store/deckStore';
import { RouteShell } from '../components/shell';
import { loadCardDatabase } from '../utils/deckCardData';
import type { DeckCard, PriceRecord } from '../utils/deckRules';
import {
  buildCatalogIndex,
  buildImportedDeck,
  evaluateImport,
} from '../utils/tournamentDeckImport';

const DIMENSIONS: Array<{ key: DonutDimension; labelKey: string }> = [
  { key: 'archetype', labelKey: 'search_filter_category' },
  { key: 'oshi', labelKey: 'deck_zone_oshi' },
];

// Pen XmHeK binds the 觀察分佈 bars to the $c-* color tokens.
const COLOR_BAR_TOKENS: Record<string, string> = {
  white: CATEGORY_COLORS.white,
  blue: CATEGORY_COLORS.blue,
  green: CATEGORY_COLORS.green,
  red: CATEGORY_COLORS.red,
  purple: CATEGORY_COLORS.purple,
  yellow: CATEGORY_COLORS.yellow,
};

type TranslateFn = ReturnType<typeof useTranslation>['t'];

/** Renders the rank badge line for an archetype/oshi chip. Prefers the
 * verified-only counts required by the CR (冠軍 N / 上位 M); "最佳 N" only
 * appears when NO ranked deck exists in the top-placement window, so the chip
 * always ends with concrete counts when they are available. */
function buildRankTags(
  item: { championCount: number; topPlacementCount: number; bestRank: number | null },
  t: TranslateFn,
): string {
  const parts: string[] = [];
  if (item.championCount > 0) parts.push(t('tournament_summary_champion_count', { count: item.championCount }));
  if (item.topPlacementCount > item.championCount) {
    parts.push(t('tournament_summary_top_placement_count', { count: item.topPlacementCount }));
  }
  if (parts.length === 0 && item.bestRank != null) {
    parts.push(t('tournament_summary_best_rank_short', { rank: item.bestRank }));
  }
  return parts.join(' · ');
}

/** Localized card name for a `cardNumber`. Falls back through the catalog
 * fields verbatim, never inferred — for a card the catalog cannot resolve, the
 * language-specific fallback label is used and the cardNumber shows underneath
 * as provenance (DIC-1142 CR: cards must not display raw "hBP…" as the label). */
function pickCardName(
  cardNumber: string,
  language: 'zh' | 'ja',
  catalog: Map<string, DeckCard[]> | null,
  t: TranslateFn,
): string {
  const variants = catalog?.get(cardNumber);
  const rep = variants && variants.length > 0 ? variants[0] : null;
  if (!rep) return t('tournament_representative_card_name_fallback');
  if (language === 'ja') return rep.nameJa || rep.name || t('tournament_representative_card_name_fallback');
  return rep.nameZh || rep.name || t('tournament_representative_card_name_fallback');
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to load ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function TournamentReportScreen() {
  const { t, language } = useTranslation();
  const { isDesktop } = useBreakpoint();
  const [state, dispatch] = useReducer(tournamentReportReducer, initialTournamentReportState);
  const { index, scope } = state;
  // DIC-1409 Phase 5 — same pattern as DeckEditorScreen (DIC-1380 W8 CR):
  // useNavigation() throws outside a NavigationContainer (render harness /
  // evidence renders); the context read returns undefined there, and every
  // consumer already guards through optional call sites.
  const navigation = React.useContext(NavigationContext as any) as DrawerNavigationProp<MainDrawerParamList>;
  const importDeck = useDeckStore((s) => s.importDeck);

  const [catalog, setCatalog] = useState<Map<string, DeckCard[]> | null>(null);
  const [priceRecords, setPriceRecords] = useState<PriceRecord[]>([]);
  const [imported, setImported] = useState<string | null>(null);
  const [dimension, setDimension] = useState<DonutDimension>('archetype');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [sourceExpanded, setSourceExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const idx = await fetchJson<TournamentIndex>('/data/tournaments/index.json');
        if (alive) dispatch({ type: 'index-loaded', index: idx });
      } catch {
        if (alive) dispatch({ type: 'index-failed', message: t('tournament_no_data') });
      }
    })();
    return () => {
      alive = false;
    };
  }, [language]);

  const windowMonths = useMemo(() => scopeWindow(index), [index]);
  const windowKey = windowMonths.join(',');
  useEffect(() => {
    if (!windowKey) return;
    let alive = true;
    void runBounded(windowKey.split(','), MAX_CONCURRENT_REPORT_LOADS, async (month) => {
      if (!alive) return;
      try {
        const r = await fetchJson<MonthlyReport>(`/data/tournaments/${month}.json`);
        if (alive) dispatch({ type: 'report-loaded', month, report: r });
      } catch {
        if (alive) {
          dispatch({
            type: 'report-failed',
            month,
            message: t('tournament_month_load_failed', { month }),
          });
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [windowKey, language]);

  useEffect(() => {
    let alive = true;
    loadCardDatabase()
      .then((db) => {
        if (!alive) return;
        setPriceRecords(db.priceRecords);
        setCatalog(buildCatalogIndex(db.cards));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onOpen = useCallback((url: string) => {
    void openUrl(url);
  }, []);

  const onImport = useCallback(
    (event: TournamentEvent, deck: DeckEntry) => {
      if (!catalog) return;
      const draft = buildImportedDeck(
        event,
        deck,
        catalog,
        priceRecords,
        useDeckStore.getState().decks.map((d) => d.name),
        new Date().toISOString(),
      );
      if (!draft) return;
      importDeck(draft);
      setImported(draft.name);
      navigation.navigate('DeckEditor');
    },
    [catalog, priceRecords, importDeck, navigation],
  );

  const reports = useMemo(() => reportsInScope(state), [state]);
  const model = useMemo(
    () => buildDonutModel(reports, scope, dimension),
    [reports, scope, dimension],
  );
  const summary = useMemo(
    () => buildTournamentMonthlySummary(reports, scope, language),
    [reports, scope, language],
  );

  const allEvents = useMemo(() => reports.flatMap((r) => r.events), [reports]);
  const highlightsByEvent = useMemo(
    () => buildEventHighlights(allEvents),
    [allEvents],
  );
  const events = useMemo(() => {
    if (selectedColor) return filterEventsByColor(allEvents, selectedColor);
    return filterEventsBySlice(allEvents, selectedKey, dimension);
  }, [allEvents, selectedKey, selectedColor, dimension]);

  const loading = scopeLoading(state);
  const error = scopeError(state);
  const selectedSlice = model.slices.find((s) => s.key === selectedKey) ?? null;
  const selectedColorLabel = selectedColor
    ? t(`color_${selectedColor}` as Parameters<typeof t>[0])
    : null;

  useEffect(() => {
    if (selectedKey != null && !model.slices.some((s) => s.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [model.slices, selectedKey]);

  useEffect(() => {
    if (selectedColor != null && !summary.topColors.some((item) => item.color === selectedColor)) {
      setSelectedColor(null);
    }
  }, [summary.topColors, selectedColor]);

  const coverage = useMemo(
    () =>
      reports.reduce(
        (acc, r) => ({
          knownEvents: acc.knownEvents + r.coverage.knownEvents,
          rankedDecks: acc.rankedDecks + r.coverage.rankedDecks,
        }),
        { knownEvents: 0, rankedDecks: 0 },
      ),
    [reports],
  );

  // DIC-1409 Phase 5 — Pen `App / 10 賽事月報` (frame wRgD8) shared shell.
  const wrapInShell = (children: React.ReactNode) => (
    <RouteShell navigation={navigation} routeName="TournamentReport" title={t('nav_tournament_report')} testID="tournament-shell">
      {children}
    </RouteShell>
  );

  if (state.loading && !index) {
    return wrapInShell(
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  if (!index) {
    return wrapInShell(
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t('tournament_title')}</Text>
        <Text style={styles.emptyText}>{state.error ?? t('tournament_no_data')}</Text>
      </View>
    );
  }

  const hasData = reports.length > 0;
  const partial = scopeIsPartial(state);
  const scopeLabel = scope !== ALL_SCOPE ? scope : partial ? t('tournament_partial_scope') : t('tournament_scope_all');
  const incomplete = incompleteMonths(state);
  const omitted = omittedMonths(state);
  const partialNotice = partial
    ? [
        reports.length > 0 ? t('tournament_included_months', { months: reports.map((r) => r.month).join('、') }) : null,
        incomplete.failed.length > 0 ? t('tournament_failed_months', { months: incomplete.failed.join('、') }) : null,
        incomplete.pending.length > 0 ? t('tournament_pending_months', { months: incomplete.pending.join('、') }) : null,
        omitted.length > 0 && scope === ALL_SCOPE
          ? t('tournament_omitted_months', { limit: MAX_SCOPE_MONTHS, count: omitted.length })
          : null,
      ]
        .filter((s): s is string => s != null)
        .join('；')
    : null;

  // `reports[0].source.name` is authored in Chinese today (includes 官方賽果 etc).
  // In ja mode we swap in the generic disclaimer as the footer summary so no
  // raw Chinese leaks into the Japanese UI. Kept verbatim in zh mode as the
  // real source string is the useful reference (DIC-1142 CR §3).
  const sourceName = language === 'zh'
    ? reports[0]?.source?.name ?? ''
    : t('tournament_source_disclaimer_generic');

  // Pen HJici month navigator: prev/next cycle through the REAL scope options
  // (全部 + every month the index actually carries) via the same reducer
  // dispatch the old chip row used.
  const scopeOptions = [ALL_SCOPE, ...windowMonths];
  const scopeIdx = Math.max(0, scopeOptions.indexOf(scope));
  const selectScopeAt = (idx: number) => {
    const clamped = Math.min(Math.max(idx, 0), scopeOptions.length - 1);
    dispatch({ type: 'select-scope', scope: scopeOptions[clamped] });
    setSelectedKey(null);
    setSelectedColor(null);
  };
  const scopeYear = scope !== ALL_SCOPE ? scope.slice(0, 4) : '';
  const scopeMonthLabel = scope !== ALL_SCOPE
    ? t('tournament_month_report', { month: String(parseInt(scope.slice(5), 10)) })
    : t('tournament_scope_all');

  // Pen RxPbs hero: the real top representative card of the scoped sample.
  const heroCard = summary.representativeCards[0] ?? null;
  // Pen SboNx podium: the real top-3 notable placements.
  const podium = summary.notablePlacements.slice(0, 3);
  const medalColors = ['#FBBF24', '#C0C7D1', '#C5865F'];

  return wrapInShell(
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {imported ? (
          <View style={styles.importedBanner}>
            <Text style={styles.importedText}>
              {t('tournament_imported', { name: imported })}
            </Text>
          </View>
        ) : null}

        {/* Month navigator (Pen HJici) */}
        <View style={styles.monthNav} testID="tournament-month-nav">
          <TouchableOpacity
            onPress={() => selectScopeAt(scopeIdx - 1)}
            disabled={scopeIdx <= 0}
            style={[styles.monthNavBtn, scopeIdx <= 0 && styles.monthNavBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('tournament_prev_scope_a11y')}
            testID="tournament-month-prev"
          >
            <Text style={styles.monthNavChevron}>‹</Text>
          </TouchableOpacity>
          <View style={styles.monthNavCenter} testID="tournament-month-label">
            {scopeYear ? <Text style={styles.monthNavYear}>{scopeYear}</Text> : null}
            <Text style={styles.monthNavTitle}>{scopeMonthLabel}</Text>
          </View>
          <TouchableOpacity
            onPress={() => selectScopeAt(scopeIdx + 1)}
            disabled={scopeIdx >= scopeOptions.length - 1}
            style={[styles.monthNavBtn, scopeIdx >= scopeOptions.length - 1 && styles.monthNavBtnDisabled]}
            accessibilityRole="button"
            accessibilityLabel={t('tournament_next_scope_a11y')}
            testID="tournament-month-next"
          >
            <Text style={styles.monthNavChevron}>›</Text>
          </TouchableOpacity>
        </View>

        {loading && <ActivityIndicator color={COLORS.primary} style={styles.inlineLoader} />}
        {error && !loading ? (
          <Text style={styles.errorText} testID="scope-error">
            {error}
          </Text>
        ) : null}

        {partialNotice && (hasData || !loading) ? (
          <Text style={styles.partialNotice} testID="scope-partial">
            {t('tournament_partial_notice', { details: partialNotice })}
          </Text>
        ) : null}

        {hasData && (
          <>
            {/* ── 熱門卡 hero (Pen RxPbs): real top representative card ── */}
            {heroCard ? (
              <View
                style={[
                  styles.heroCard,
                  Platform.OS === 'web'
                    ? ({ backgroundImage: `linear-gradient(120deg, rgba(139,92,246,0.45) 0%, rgba(255,77,157,0.25) 100%)`, backgroundColor: '#2A1840' } as object)
                    : { backgroundColor: '#2A1840' },
                ]}
                testID="tournament-hero"
              >
                <View style={styles.heroTopRow}>
                  <Text style={styles.heroEyebrow}>{t('tournament_hero_label')}</Text>
                  <Text style={styles.heroSample}>{t('tournament_hero_sample', { count: summary.verifiedDeckCount })}</Text>
                </View>
                <Text style={styles.heroName} numberOfLines={2}>
                  {pickCardName(heroCard.cardNumber, language, catalog, t)} / {heroCard.cardNumber}
                </Text>
                <View style={styles.heroMetricsRow}>
                  <View style={styles.heroMetricCell}>
                    <Text style={styles.heroMetricLabel}>{t('tournament_hero_adoption')}</Text>
                    <Text style={styles.heroMetricValue}>{Math.round(heroCard.adoptionRate * 100)}%</Text>
                  </View>
                  <View style={styles.heroMetricCell}>
                    <Text style={styles.heroMetricLabel}>{t('tournament_hero_decks')}</Text>
                    <Text style={styles.heroMetricValue}>{heroCard.deckCount}</Text>
                  </View>
                  <View style={styles.heroMetricCell}>
                    <Text style={styles.heroMetricLabel}>{t('tournament_hero_copies')}</Text>
                    <Text style={styles.heroMetricValue}>{heroCard.totalCopies}</Text>
                  </View>
                </View>
              </View>
            ) : null}

            {/* ── 觀察分佈 color bars (Pen XmHeK): real color counts ── */}
            {summary.topColors.length > 0 ? (
              <>
                <Text style={styles.h2}>{t('tournament_distribution', { scope: scopeLabel })}</Text>
                <View style={styles.colorBarsCard} testID="tournament-color-bars">
                  {summary.topColors.map((item) => {
                    const label = t(`color_${item.color}` as Parameters<typeof t>[0]);
                    const pct = summary.verifiedDeckCount > 0
                      ? Math.round((item.count / summary.verifiedDeckCount) * 100)
                      : 0;
                    const active = selectedColor === item.color;
                    const barColor = COLOR_BAR_TOKENS[item.color] ?? COLORS.primary;
                    return (
                      <TouchableOpacity
                        key={item.color}
                        style={styles.colorBarRow}
                        onPress={() => {
                          setSelectedKey(null);
                          setSelectedColor(active ? null : item.color);
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        testID={`summary-color-${item.color}`}
                      >
                        <Text style={[styles.colorBarLabel, active && styles.colorBarLabelActive]} numberOfLines={1}>
                          {label}
                        </Text>
                        <View style={styles.colorBarTrack}>
                          <View style={[styles.colorBarFill, { width: `${pct}%`, backgroundColor: barColor }]} />
                        </View>
                        <Text style={styles.colorBarValue}>{pct}%</Text>
                      </TouchableOpacity>
                    );
                  })}
                  <Text style={styles.colorBarsNote}>
                    {t('tournament_color_bars_note', { count: summary.verifiedDeckCount })}
                  </Text>
                </View>
              </>
            ) : null}

            {/* ── 優勝牌組 podium (Pen SboNx): real top-3 placements ── */}
            {podium.length > 0 ? (
              <>
                <Text style={styles.h2}>{t('tournament_podium_heading')}</Text>
                <View style={styles.podium} testID="tournament-podium">
                  {podium.map((p, i) => (
                    <View key={p.deckId} style={styles.podiumRow} testID={`tournament-podium-row-${i}`}>
                      <View style={[styles.podiumMedal, { backgroundColor: medalColors[i] + '22' }]}>
                        <Text style={[styles.podiumMedalText, { color: medalColors[i] }]}>
                          {p.rank ?? i + 1}
                        </Text>
                      </View>
                      <View style={styles.podiumMeta}>
                        <Text style={styles.podiumTitle} numberOfLines={1}>
                          {(p.archetypeLabel || p.oshi || t('tournament_featured_deck'))}
                          {p.playerName ? ` ・ ${p.playerName}` : ''}
                        </Text>
                        <Text style={styles.podiumSub} numberOfLines={1}>
                          {(p.rankLabel || t('tournament_rank', { rank: p.rank ?? '—' }))}
                          {' ・ '}
                          {language === 'zh' ? (p.eventNameZh || p.eventName) : p.eventName}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            {/* ── Monthly Summary Block ── */}
            <View style={styles.summaryCard} testID="tournament-monthly-summary">
              <Text style={styles.summaryTitle}>{t('tournament_summary_title')}</Text>
              <View style={styles.summaryMetaRow}>
                <View style={styles.summaryMetaItem}>
                  <Text style={styles.summaryMetaLabel}>{t('tournament_summary_scope')}</Text>
                  <Text style={styles.summaryMetaVal}>{summary.scopeLabel}</Text>
                </View>
                <View style={styles.summaryMetaItem}>
                  <Text style={styles.summaryMetaLabel}>{t('tournament_summary_events')}</Text>
                  <Text style={styles.summaryMetaVal}>{summary.eventCount}</Text>
                </View>
                <View style={styles.summaryMetaItem}>
                  <Text style={styles.summaryMetaLabel}>{t('tournament_summary_decks')}</Text>
                  <Text style={styles.summaryMetaVal}>{summary.verifiedDeckCount}</Text>
                </View>
                <View style={styles.summaryMetaItem}>
                  <Text style={styles.summaryMetaLabel}>{t('tournament_summary_observed')}</Text>
                  <Text style={styles.summaryMetaVal}>{summary.observedDeckCount}</Text>
                </View>
              </View>

              {summary.topArchetypes.length > 0 && (
                <View style={styles.summarySection}>
                  <Text style={styles.summarySectionTitle}>{t('tournament_summary_top_archetypes')}</Text>
                  <View style={styles.chipRow}>
                    {summary.topArchetypes.map((item) => {
                      const active = dimension === 'archetype' && selectedKey === item.id;
                      const tags = buildRankTags(item, t);
                      return (
                        <TouchableOpacity
                          key={item.id ?? 'unknown'}
                          style={[styles.summaryChip, active && styles.summaryChipActive]}
                          onPress={() => {
                            setDimension('archetype');
                            setSelectedColor(null);
                            setSelectedKey(active ? null : item.id);
                          }}
                          testID={`summary-archetype-${item.id ?? 'unknown'}`}
                        >
                          <Text style={[styles.summaryChipText, active && styles.summaryChipTextActive]}>
                            {item.label} ({item.count})
                            {tags ? ` · ${tags}` : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {summary.topOshi.length > 0 && (
                <View style={styles.summarySection}>
                  <Text style={styles.summarySectionTitle}>{t('tournament_summary_top_oshi')}</Text>
                  <View style={styles.chipRow}>
                    {summary.topOshi.map((item) => {
                      const active = dimension === 'oshi' && selectedKey === item.id;
                      const tags = buildRankTags(item, t);
                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={[styles.summaryChip, active && styles.summaryChipActive]}
                          onPress={() => {
                            setDimension('oshi');
                            setSelectedColor(null);
                            setSelectedKey(active ? null : item.id);
                          }}
                          testID={`summary-oshi-${item.id}`}
                        >
                          <Text style={[styles.summaryChipText, active && styles.summaryChipTextActive]}>
                            {item.label} ({item.count})
                            {tags ? ` · ${tags}` : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* 主要顏色 chips → Pen XmHeK color bars above; 重要名次 rows →
                  Pen SboNx podium above. Both keep their filter/testID
                  contracts on the new blocks. */}

              {/* Representative cards — deduped by cardNumber (DIC-1142) */}
              <View style={styles.summarySection}>
                <Text style={styles.summarySectionTitle}>{t('tournament_summary_representative_cards')}</Text>
                {summary.representativeCards.length === 0 ? (
                  <Text style={styles.representativeEmpty} testID="representative-empty">
                    {t('tournament_representative_empty')}
                  </Text>
                ) : (
                  <>
                    <View style={styles.representativeList}>
                      {summary.representativeCards.map((card) => {
                        const ratePct = Math.round(card.adoptionRate * 100);
                        const zoneKey = card.zone === 'oshi'
                          ? 'deck_zone_oshi'
                          : card.zone === 'yell'
                            ? 'deck_zone_yell'
                            : 'deck_zone_main';
                        const cardName = pickCardName(card.cardNumber, language, catalog, t);
                        return (
                          <View
                            key={card.cardNumber}
                            style={styles.representativeRow}
                            testID={`representative-${card.cardNumber}`}
                            accessibilityRole="text"
                            accessibilityLabel={t('tournament_representative_a11y', {
                              card: `${cardName}（${card.cardNumber}）`,
                              count: card.deckCount,
                              rate: ratePct,
                            })}
                          >
                            <View style={styles.representativeMain}>
                              <Text style={styles.representativeCardName} numberOfLines={1}>
                                {cardName}
                              </Text>
                              <Text style={styles.representativeCardNumber} numberOfLines={1}>
                                {card.cardNumber} · {t(zoneKey)}
                              </Text>
                            </View>
                            <View style={styles.representativeStats}>
                              <Text style={styles.representativeCount}>
                                {t('tournament_representative_deck_count', {
                                  count: card.deckCount,
                                  rate: ratePct,
                                })}
                              </Text>
                              <Text style={styles.representativeCopies}>
                                {t('tournament_representative_total_copies', { copies: card.totalCopies })}
                              </Text>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                    <Text style={styles.representativeNote}>{t('tournament_representative_dedupe_note')}</Text>
                  </>
                )}
              </View>

              {summary.smallSample && (
                <Text style={styles.summaryWarning} testID="summary-small-sample">
                  {t('tournament_summary_small_sample_warning', { count: summary.verifiedDeckCount })}
                </Text>
              )}

              <Text style={styles.summaryHint}>{t('tournament_summary_filter_hint')}</Text>
            </View>

            {/* Observed-share chart: bar on mobile, donut on desktop (DIC-1142) */}
            <Text style={styles.h2}>{t('tournament_dimension_share', { scope: scopeLabel })}</Text>
            <View style={styles.chartCard}>
              <View style={styles.dimensionRow}>
                {DIMENSIONS.map((d) => {
                  const active = d.key === dimension;
                  return (
                    <TouchableOpacity
                      key={d.key}
                      onPress={() => {
                        setDimension(d.key);
                        setSelectedKey(null);
                        setSelectedColor(null);
                      }}
                      style={[styles.dimChip, active && styles.dimChipActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      testID={`dimension-${d.key}`}
                    >
                      <Text style={[styles.dimChipText, active && styles.dimChipTextActive]}>
                        {d.key === 'archetype' ? t('tournament_dimension_archetype') : t('tournament_dimension_oshi')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <Text
                  style={styles.chartViewBadge}
                  testID={isDesktop ? 'chart-view-desktop' : 'chart-view-mobile'}
                >
                  {isDesktop ? t('tournament_chart_view_desktop') : t('tournament_chart_view_mobile')}
                </Text>
              </View>

              {model.sampleSize === 0 ? (
                <Text style={styles.emptyChart} testID="donut-empty">
                  {t('tournament_empty_chart')}
                  {model.observedSize > 0
                    ? t('tournament_empty_chart_observed', { count: model.observedSize })
                    : ''}
                </Text>
              ) : (
                <>
                  {model.smallSample ? (
                    <Text style={styles.smallSample} testID="donut-small-sample">
                      {t('tournament_small_sample', { count: model.sampleSize, minimum: SMALL_SAMPLE_MIN })}
                    </Text>
                  ) : null}
                  {isDesktop ? (
                    <ObservedShareDonut
                      model={model}
                      selectedKey={selectedKey}
                      onSelect={(key) => { setSelectedColor(null); setSelectedKey(key); }}
                    />
                  ) : (
                    <ObservedShareBar
                      model={model}
                      selectedKey={selectedKey}
                      onSelect={(key) => { setSelectedColor(null); setSelectedKey(key); }}
                    />
                  )}
                  {selectedSlice || selectedColorLabel ? (
                    <TouchableOpacity
                      onPress={() => { setSelectedKey(null); setSelectedColor(null); }}
                      style={styles.clearBtn}
                      accessibilityRole="button"
                      testID="donut-clear"
                    >
                      <Text style={styles.clearBtnText}>
                        {t('tournament_clear_filter', { label: selectedSlice?.label || selectedColorLabel || '' })}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.hint}>{t('tournament_chart_hint')}</Text>
                  )}
                  <Text style={styles.finePrint}>
                    {t('tournament_denominator_note', { sample: model.sampleSize, observed: model.observedSize })}
                  </Text>
                </>
              )}
            </View>

            {/* Events + featured decks with per-event highlights */}
            <Text style={styles.h2}>
              {t('tournament_events_decks', { filter: selectedSlice || selectedColorLabel ? `：${selectedSlice?.label || selectedColorLabel}` : '' })}
            </Text>
            {events.length === 0 ? (
              <Text style={styles.emptyText}>{t('tournament_no_filtered_decks')}</Text>
            ) : null}
            {events.map((e) => {
              const highlight = highlightsByEvent.get(e.eventId) ?? null;
              return (
                <View key={e.eventId} style={styles.eventCard}>
                  <Text style={styles.eventName}>{e.name}</Text>
                  {language === 'zh' && e.nameZh ? <Text style={styles.eventNameZh}>{e.nameZh}</Text> : null}
                  <View style={styles.metaRow}>
                    <Meta label={t('tournament_region')} value={e.region ?? t('common_unknown')} />
                    <Meta label={t('tournament_date')} value={e.date ?? t('common_unavailable')} />
                    <Meta label={t('tournament_entrants')} value={e.entrants == null ? t('common_unavailable') : `${e.entrants}`} />
                  </View>

                  {highlight ? (
                    <EventHighlightBlock
                      highlight={highlight}
                      event={e}
                      onOpen={onOpen}
                      language={language}
                    />
                  ) : null}

                  <Text style={styles.eventCoverage}>
                    {language === 'zh' ? e.coverageNote : t('tournament_event_coverage_generic')}
                  </Text>

                  {e.decks.map((d) => (
                    <View key={d.deckId} style={styles.deckRow} testID={`deck-${d.deckId}`}>
                      <View style={styles.deckHead}>
                        <Text style={styles.deckArchetype}>
                          {d.archetypeLabel ?? t('tournament_unknown_deck')}
                        </Text>
                        <Text style={styles.deckRank}>{d.rankLabel ?? t('tournament_rank_unavailable')}</Text>
                      </View>
                      <Text style={styles.deckPlayer}>
                        {t('tournament_player_label', { name: d.playerName ?? t('common_unavailable') })}
                      </Text>
                      <Text style={styles.deckCards}>
                        {d.cardsVerified === true
                          ? t('tournament_cards_count', { count: d.cards.length })
                          : t('tournament_cards_unavailable')}
                      </Text>
                      <ImportAction deck={d} catalog={catalog} onImport={() => onImport(e, d)} />
                      {d.decklogCode ? (
                        <TouchableOpacity onPress={() => onOpen(d.sourceUrl)}>
                          <Text style={styles.link}>{t('tournament_decklog_link', { code: d.decklogCode })}</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ))}
                </View>
              );
            })}

            {/* Source coverage — compact footer disclosure (DIC-1142) */}
            <View style={styles.disclaimer} testID="tournament-source-footer">
              <TouchableOpacity
                onPress={() => setSourceExpanded((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: sourceExpanded }}
                testID="tournament-source-toggle"
              >
                <Text style={styles.disclaimerTitle}>{t('tournament_source_coverage')}</Text>
                <Text style={styles.disclaimerCompact} numberOfLines={2}>
                  {t('tournament_source_footer_compact', { source: sourceName })}
                </Text>
                <Text style={styles.disclaimerToggle}>
                  {sourceExpanded ? t('tournament_source_footer_hide') : t('tournament_source_footer_show')}
                </Text>
              </TouchableOpacity>
              {sourceExpanded ? (
                <View style={styles.disclaimerBody} testID="tournament-source-body">
                  {language === 'zh' ? (
                    <Text style={styles.sourceName}>{reports[0].source.name}</Text>
                  ) : null}
                  <Text style={styles.disclaimerText}>
                    {language === 'zh' ? reports[0].source.disclaimer : t('tournament_source_disclaimer_generic')}
                  </Text>
                  {reports.map((r) => (
                    <Text key={r.month} style={styles.coverageNote}>
                      {r.month}：{language === 'zh' ? r.coverage.note : t('tournament_coverage_note_generic')}
                    </Text>
                  ))}
                  <View style={styles.statRow}>
                    <Stat label={t('tournament_summary_events')} value={`${coverage.knownEvents}`} />
                    <Stat label={t('tournament_summary_observed')} value={`${model.observedSize}`} />
                    <Stat label={t('tournament_summary_decks')} value={`${model.sampleSize}`} />
                    <Stat label={t('tournament_ranked')} value={`${coverage.rankedDecks}`} />
                  </View>
                </View>
              ) : null}
            </View>

            <Text style={styles.generatedAt}>
              {t('tournament_generated_at', { value: reports.map((r) => `${r.month} ${r.generatedAt}`).join('｜') })}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EventHighlightBlock({
  highlight,
  event,
  onOpen,
  language,
}: {
  highlight: EventHighlight;
  event: TournamentEvent;
  onOpen: (url: string) => void;
  language: 'zh' | 'ja';
}) {
  const { t } = useTranslation();
  const hasChampion = highlight.championDeckId != null;
  const championDeckLabel = highlight.championArchetypeLabel
    || highlight.championOshi
    || t('tournament_featured_deck');
  const eventDisplayName = language === 'zh' ? (event.nameZh || event.name) : event.name;
  const eventDate = event.date;
  const showcasedLine = `${t('tournament_event_showcased_count', { count: highlight.showcasedDecks })}${
    highlight.verifiedDecks > 0
      ? t('tournament_event_verified_count', { count: highlight.verifiedDecks })
      : ''
  }`;
  return (
    <View style={styles.highlightBlock} testID={`event-highlights-${event.eventId}`}>
      <Text style={styles.highlightTitle}>{t('tournament_event_highlights')}</Text>
      {hasChampion ? (
        <Text style={styles.highlightChampion} numberOfLines={2}>
          {t('tournament_event_champion', { deck: championDeckLabel })}
          {highlight.championPlayerName
            ? t('tournament_event_champion_by', { player: highlight.championPlayerName })
            : ''}
        </Text>
      ) : (
        <Text style={styles.highlightChampionMissing}>{t('tournament_event_champion_missing')}</Text>
      )}
      <Text style={styles.highlightMeta}>{showcasedLine}</Text>
      {highlight.commonCards.length > 0 ? (
        <View style={styles.highlightCommonRow}>
          <Text style={styles.highlightCommonLabel}>{t('tournament_event_common_cards_label')}</Text>
          <View style={styles.highlightCommonList}>
            {highlight.commonCards.map((c) => (
              <View
                key={c.cardNumber}
                style={styles.highlightCommonChip}
                testID={`event-common-${event.eventId}-${c.cardNumber}`}
              >
                <Text style={styles.highlightCommonText} numberOfLines={1}>
                  {c.cardNumber} · {t('common_decks_count', { count: c.deckCount })}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      <View style={styles.highlightNewsRow}>
        <Text style={styles.highlightNewsTitle}>{t('tournament_event_news_title')}</Text>
        {event.sourceUrl ? (
          <TouchableOpacity
            onPress={() => onOpen(event.sourceUrl)}
            accessibilityRole="link"
            testID={`event-news-${event.eventId}`}
          >
            <Text style={styles.highlightNewsLink} numberOfLines={2}>
              {t('tournament_event_official_result')}
            </Text>
            <Text style={styles.highlightNewsMeta} numberOfLines={1}>
              {eventDate ? `${eventDate} · ` : ''}{eventDisplayName}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.highlightNoNews}>{t('tournament_event_no_news')}</Text>
        )}
      </View>
    </View>
  );
}

function ImportAction({
  deck,
  catalog,
  onImport,
}: {
  deck: DeckEntry;
  catalog: Map<string, DeckCard[]> | null;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  const gate = useMemo(() => evaluateImport(deck, catalog), [deck, catalog]);

  if (!gate.importable) {
    return (
      <View style={styles.importBlock}>
        <View
          style={[styles.importBtn, styles.importBtnDisabled]}
          testID={`deck-import-disabled-${deck.deckId}`}
        >
          <Text style={styles.importBtnTextDisabled} numberOfLines={2}>
            {t('tournament_import_cta')}
          </Text>
        </View>
        <Text style={styles.importReason} testID={`deck-import-reason-${deck.deckId}`}>
          {gate.reason}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.importBlock}>
      <TouchableOpacity
        style={styles.importBtn}
        onPress={onImport}
        testID={`deck-import-${deck.deckId}`}
        accessibilityRole="button"
        accessibilityLabel={t('tournament_import_cta')}
      >
        <Text style={styles.importBtnText} numberOfLines={2}>{t('tournament_import_cta')}</Text>
      </TouchableOpacity>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <Text style={styles.meta}>
      <Text style={styles.metaLabel}>{label}：</Text>
      {value}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scroll: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  h1: { color: COLORS.text, fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  h2: { color: COLORS.text, fontSize: 17, fontWeight: 'bold', marginTop: 20, marginBottom: 10 },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
  emptyText: { color: COLORS.textSecondary, fontSize: 14, textAlign: 'center' },
  errorText: { color: COLORS.error, fontSize: 14, marginTop: 16 },
  partialNotice: { color: COLORS.accent, fontSize: 12, lineHeight: 18, marginTop: 12 },
  inlineLoader: { marginVertical: 24 },

  // Month navigator (Pen HJici: $app-surface r12, chevrons + centered label)
  monthNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: PALETTE.appSurface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10, minHeight: 58,
  },
  monthNavBtn: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  monthNavBtnDisabled: { opacity: 0.3 },
  monthNavChevron: { color: SEMANTIC.onBgMuted, fontSize: 22, lineHeight: 24, fontWeight: '600' },
  monthNavCenter: { alignItems: 'center', gap: 2, flexShrink: 1 },
  monthNavYear: { color: SEMANTIC.onBgDim, fontSize: 11, fontWeight: '500' },
  monthNavTitle: { color: SEMANTIC.onBg, fontSize: 15, fontWeight: '700' },

  // 熱門卡 hero (Pen RxPbs: purple gradient r16, 3 metric cells)
  heroCard: { borderRadius: 16, paddingHorizontal: 18, paddingVertical: 16, marginTop: 14, gap: 10 },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroEyebrow: { color: '#FFB4D9', fontSize: 12, fontWeight: '600' },
  heroSample: { color: PALETTE.textSecondary, fontSize: 11 },
  heroName: { color: SEMANTIC.onBg, fontSize: 18, fontWeight: '700' },
  heroMetricsRow: { flexDirection: 'row', gap: 10 },
  heroMetricCell: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  heroMetricLabel: { color: '#FFB4D9', fontSize: 10 },
  heroMetricValue: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  // 觀察分佈 color bars (Pen XmHeK: $app-surface r14, token-tinted fills)
  colorBarsCard: { backgroundColor: PALETTE.appSurface, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  colorBarRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 24 },
  colorBarLabel: { width: 34, color: SEMANTIC.onBgMuted, fontSize: 12, fontWeight: '600' },
  colorBarLabelActive: { color: SEMANTIC.onBg },
  colorBarTrack: { flex: 1, height: 10, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.3)', overflow: 'hidden' },
  colorBarFill: { height: 10, borderRadius: 8 },
  colorBarValue: { width: 40, textAlign: 'right', color: SEMANTIC.onBg, fontSize: 11, fontWeight: '700' },
  colorBarsNote: { color: SEMANTIC.onBgDim, fontSize: 10.5, marginTop: 4 },

  // 優勝牌組 podium (Pen SboNx: medal rows on $app-surface r12)
  podium: { gap: 8 },
  podiumRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: PALETTE.appSurface, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, minHeight: 57,
  },
  podiumMedal: { width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  podiumMedalText: { fontSize: 12, fontWeight: '700' },
  podiumMeta: { flex: 1, minWidth: 0, gap: 2 },
  podiumTitle: { color: SEMANTIC.onBg, fontSize: 13, fontWeight: '700' },
  podiumSub: { color: SEMANTIC.onBgDim, fontSize: 11 },

  // Summary Card Styles
  summaryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 16,
    marginTop: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
  },
  summaryTitle: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  summaryMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 14,
  },
  summaryMetaItem: {
    flex: 1,
    minWidth: 70,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  summaryMetaLabel: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginBottom: 2,
  },
  summaryMetaVal: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: 'bold',
  },
  summarySection: {
    marginTop: 10,
  },
  summarySectionTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  summaryChip: {
    backgroundColor: COLORS.surfaceLight,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  summaryChipActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '20',
  },
  summaryChipText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  summaryChipTextActive: {
    color: COLORS.primary,
    fontWeight: 'bold',
  },
  notableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    padding: 8,
    borderRadius: 6,
    marginBottom: 4,
  },
  notableRank: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: 'bold',
    marginRight: 8,
  },
  notableDetails: {
    color: COLORS.text,
    fontSize: 12,
    flex: 1,
  },

  representativeList: {
    gap: 6,
  },
  representativeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    padding: 8,
    borderRadius: 6,
    gap: 8,
  },
  representativeMain: { flex: 1, minWidth: 90 },
  representativeCardName: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  representativeCardNumber: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  representativeStats: { alignItems: 'flex-end' },
  representativeCount: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  representativeCopies: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  representativeEmpty: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  representativeNote: {
    color: COLORS.textSecondary + 'aa',
    fontSize: 11,
    marginTop: 6,
    lineHeight: 16,
  },

  summaryWarning: {
    color: COLORS.accent,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  summaryHint: {
    color: COLORS.textSecondary + 'aa',
    fontSize: 11,
    marginTop: 8,
    textAlign: 'center',
  },

  disclaimer: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 12,
    marginTop: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  disclaimerTitle: { color: COLORS.accent, fontSize: 13, fontWeight: 'bold', marginBottom: 4 },
  disclaimerCompact: { color: COLORS.textSecondary, fontSize: 11, lineHeight: 16 },
  disclaimerToggle: { color: COLORS.primary, fontSize: 12, marginTop: 6, fontWeight: '600' },
  disclaimerBody: { marginTop: 10 },
  sourceName: { color: COLORS.text, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  disclaimerText: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18 },
  coverageNote: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 8 },
  statRow: { flexDirection: 'row', marginTop: 12, gap: 8, flexWrap: 'wrap' },
  stat: {
    flex: 1,
    minWidth: 70,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  statValue: { color: COLORS.text, fontSize: 16, fontWeight: 'bold' },
  statLabel: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2, textAlign: 'center' },
  chartCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dimensionRow: { flexDirection: 'row', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' },
  dimChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  dimChipActive: { borderColor: COLORS.primary, backgroundColor: COLORS.background },
  dimChipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  dimChipTextActive: { color: COLORS.primary },
  chartViewBadge: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginLeft: 'auto',
  },
  emptyChart: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  smallSample: {
    color: COLORS.accent,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 12,
  },
  hint: { color: COLORS.textSecondary, fontSize: 12, marginTop: 12, textAlign: 'center' },
  clearBtn: {
    marginTop: 12,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  clearBtnText: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },
  finePrint: { color: COLORS.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 12 },
  eventCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  eventName: { color: COLORS.text, fontSize: 15, fontWeight: 'bold' },
  eventNameZh: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
  meta: { color: COLORS.text, fontSize: 12 },
  metaLabel: { color: COLORS.textSecondary },
  eventCoverage: { color: COLORS.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 8 },

  highlightBlock: {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    borderWidth: 1,
    borderColor: COLORS.primary + '33',
  },
  highlightTitle: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  highlightChampion: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  highlightChampionMissing: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  highlightMeta: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 4,
    lineHeight: 16,
  },
  highlightCommonRow: {
    marginTop: 8,
    flexDirection: 'column',
    gap: 4,
  },
  highlightCommonLabel: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  highlightCommonList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  highlightCommonChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    maxWidth: '100%',
  },
  highlightCommonText: {
    color: COLORS.text,
    fontSize: 11,
  },
  highlightNewsRow: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 8,
  },
  highlightNewsTitle: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  highlightNewsLink: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  highlightNewsMeta: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  highlightNoNews: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontStyle: 'italic',
  },

  deckRow: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  deckHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deckArchetype: { color: COLORS.text, fontSize: 14, fontWeight: '600', flex: 1 },
  deckRank: { color: COLORS.accent, fontSize: 12, fontWeight: '600' },
  deckPlayer: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4 },
  deckCards: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  link: { color: COLORS.primary, fontSize: 12, fontWeight: '600', marginTop: 8 },
  importBlock: { marginTop: 10, width: '100%' },
  importBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  importBtnDisabled: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  importBtnText: { color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' },
  importBtnTextDisabled: {
    color: COLORS.textSecondary, fontSize: 14, fontWeight: 'bold', textAlign: 'center',
  },
  importReason: { color: COLORS.textSecondary, fontSize: 12, marginTop: 6, lineHeight: 17 },
  importedBanner: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: 10,
    marginBottom: 12,
  },
  importedText: { color: COLORS.text, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  generatedAt: { color: COLORS.textSecondary, fontSize: 11, marginTop: 16, textAlign: 'center' },
});
