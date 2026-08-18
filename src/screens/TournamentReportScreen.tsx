import React, { useEffect, useReducer, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { DrawerNavigationProp } from '@react-navigation/drawer';
import { COLORS } from '../constants';
import { openUrl } from '../utils/openUrl';
import { useTranslation } from '../i18n';
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
  type TournamentMonthlySummaryModel,
} from '../utils/tournamentSummary';
import ObservedShareDonut from '../components/ObservedShareDonut';
import { useDeckStore } from '../store/deckStore';
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
  const [state, dispatch] = useReducer(tournamentReportReducer, initialTournamentReportState);
  const { index, scope } = state;
  const navigation = useNavigation<DrawerNavigationProp<MainDrawerParamList>>();
  const importDeck = useDeckStore((s) => s.importDeck);

  const [catalog, setCatalog] = useState<Map<string, DeckCard[]> | null>(null);
  const [priceRecords, setPriceRecords] = useState<PriceRecord[]>([]);
  const [imported, setImported] = useState<string | null>(null);
  const [dimension, setDimension] = useState<DonutDimension>('archetype');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const idx = await fetchJson<TournamentIndex>('/data/tournaments/index.json');
        if (alive) dispatch({ type: 'index-loaded', index: idx });
      } catch {
        if (alive) dispatch({ type: 'index-failed', message: '目前沒有可用的賽事月報資料。' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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
            message: `無法載入 ${month} 的賽事月報。`,
          });
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [windowKey]);

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
  const events = useMemo(
    () => filterEventsBySlice(allEvents, selectedKey, dimension),
    [allEvents, selectedKey, dimension],
  );

  const loading = scopeLoading(state);
  const error = scopeError(state);
  const selectedSlice = model.slices.find((s) => s.key === selectedKey) ?? null;

  useEffect(() => {
    if (selectedKey != null && !model.slices.some((s) => s.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [model.slices, selectedKey]);

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

  if (state.loading && !index) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  if (!index) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t('tournament_title')}</Text>
        <Text style={styles.emptyText}>{state.error ?? '目前沒有可用的賽事月報資料。'}</Text>
      </View>
    );
  }

  const hasData = reports.length > 0;
  const partial = scopeIsPartial(state);
  const scopeLabel = scope !== ALL_SCOPE ? scope : partial ? '部分月份' : t('tournament_scope_all');
  const incomplete = incompleteMonths(state);
  const omitted = omittedMonths(state);
  const partialNotice = partial
    ? [
        reports.length > 0 ? `已納入 ${reports.map((r) => r.month).join('、')}` : null,
        incomplete.failed.length > 0 ? `${incomplete.failed.join('、')} 載入失敗` : null,
        incomplete.pending.length > 0 ? `${incomplete.pending.join('、')} 仍在載入` : null,
        omitted.length > 0 && scope === ALL_SCOPE
          ? `僅取最近 ${MAX_SCOPE_MONTHS} 個月，另有 ${omitted.length} 個較早月份未納入`
          : null,
      ]
        .filter((s): s is string => s != null)
        .join('；')
    : null;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>{t('tournament_title')}</Text>

        {imported ? (
          <View style={styles.importedBanner}>
            <Text style={styles.importedText}>
              ✓ 已匯入「{imported}」，並已在牌組編輯器中開啟。
            </Text>
          </View>
        ) : null}

        {/* Scope selector */}
        <View style={styles.monthRow}>
          {[
            { month: ALL_SCOPE, label: t('tournament_scope_all') },
            ...windowMonths.map((m) => ({ month: m, label: m })),
          ].map((opt) => {
            const active = opt.month === scope;
            return (
              <TouchableOpacity
                key={opt.month}
                onPress={() => dispatch({ type: 'select-scope', scope: opt.month })}
                style={[styles.monthChip, active && styles.monthChipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                testID={`scope-${opt.month}`}
              >
                <Text style={[styles.monthChipText, active && styles.monthChipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading && <ActivityIndicator color={COLORS.primary} style={styles.inlineLoader} />}
        {error && !loading ? (
          <Text style={styles.errorText} testID="scope-error">
            {error}
          </Text>
        ) : null}

        {partialNotice && (hasData || !loading) ? (
          <Text style={styles.partialNotice} testID="scope-partial">
            ⚠ 這不是全部月份的資料：{partialNotice}。占比僅以上列已納入月份為母體。
          </Text>
        ) : null}

        {hasData && (
          <>
            {/* ── Monthly Summary Block (DIC-1085) ── */}
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
                      return (
                        <TouchableOpacity
                          key={item.id ?? 'unknown'}
                          style={[styles.summaryChip, active && styles.summaryChipActive]}
                          onPress={() => {
                            setDimension('archetype');
                            setSelectedKey(active ? null : item.id);
                          }}
                          testID={`summary-archetype-${item.id ?? 'unknown'}`}
                        >
                          <Text style={[styles.summaryChipText, active && styles.summaryChipTextActive]}>
                            {item.label} ({item.count})
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
                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={[styles.summaryChip, active && styles.summaryChipActive]}
                          onPress={() => {
                            setDimension('oshi');
                            setSelectedKey(active ? null : item.id);
                          }}
                          testID={`summary-oshi-${item.id}`}
                        >
                          <Text style={[styles.summaryChipText, active && styles.summaryChipTextActive]}>
                            {item.label} ({item.count})
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}

              {summary.notablePlacements.length > 0 && (
                <View style={styles.summarySection}>
                  <Text style={styles.summarySectionTitle}>{t('tournament_summary_notable_placements')}</Text>
                  {summary.notablePlacements.map((p) => (
                    <View key={p.deckId} style={styles.notableRow}>
                      <Text style={styles.notableRank}>{p.rankLabel || `第 ${p.rank} 位`}</Text>
                      <Text style={styles.notableDetails} numberOfLines={1}>
                        {p.archetypeLabel || p.oshi || '精選牌組'} · {p.eventNameZh || p.eventName} ({p.playerName || '玩家'})
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {summary.smallSample && (
                <Text style={styles.summaryWarning} testID="summary-small-sample">
                  {t('tournament_summary_small_sample_warning', { count: summary.verifiedDeckCount })}
                </Text>
              )}

              <Text style={styles.summaryHint}>{t('tournament_summary_filter_hint')}</Text>
            </View>

            {/* Source + honesty disclaimer */}
            <View style={styles.disclaimer}>
              <Text style={styles.disclaimerTitle}>資料來源與涵蓋率</Text>
              <Text style={styles.sourceName}>{reports[0].source.name}</Text>
              <Text style={styles.disclaimerText}>{reports[0].source.disclaimer}</Text>
              {reports.map((r) => (
                <Text key={r.month} style={styles.coverageNote}>
                  {r.month}：{r.coverage.note}
                </Text>
              ))}
              <View style={styles.statRow}>
                <Stat label={t('tournament_summary_events')} value={`${coverage.knownEvents}`} />
                <Stat label={t('tournament_summary_observed')} value={`${model.observedSize}`} />
                <Stat label={t('tournament_summary_decks')} value={`${model.sampleSize}`} />
                <Stat label="有名次" value={`${coverage.rankedDecks}`} />
              </View>
            </View>

            {/* Observed-share donut over the verified sample only */}
            <Text style={styles.h2}>已公開樣本分布（{scopeLabel}）</Text>
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
                      }}
                      style={[styles.dimChip, active && styles.dimChipActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      testID={`dimension-${d.key}`}
                    >
                      <Text style={[styles.dimChipText, active && styles.dimChipTextActive]}>
                        {d.key === 'archetype' ? '牌型' : '推し'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {model.sampleSize === 0 ? (
                <Text style={styles.emptyChart} testID="donut-empty">
                  此範圍尚無已取得完整卡表的樣本，因此不繪製圖表。
                  {model.observedSize > 0
                    ? `（已觀測 ${model.observedSize} 副精選牌組，卡表尚未公開。）`
                    : ''}
                </Text>
              ) : (
                <>
                  {model.smallSample ? (
                    <Text style={styles.smallSample} testID="donut-small-sample">
                      ⚠ 樣本數偏少（n={model.sampleSize}，少於 {SMALL_SAMPLE_MIN}
                      ），僅供參考，不足以代表趨勢。
                    </Text>
                  ) : null}
                  <ObservedShareDonut
                    model={model}
                    selectedKey={selectedKey}
                    onSelect={setSelectedKey}
                  />
                  {selectedSlice ? (
                    <TouchableOpacity
                      onPress={() => setSelectedKey(null)}
                      style={styles.clearBtn}
                      accessibilityRole="button"
                      testID="donut-clear"
                    >
                      <Text style={styles.clearBtnText}>
                        ✕ 清除篩選：{selectedSlice.label}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.hint}>點選色塊或圖例可篩選下方牌組。</Text>
                  )}
                  <Text style={styles.finePrint}>
                    * 分母僅為已公開完整卡表的 {model.sampleSize} 副樣本，非整體 meta，也未涵蓋未公開卡表的參賽者。
                    此範圍共觀測 {model.observedSize} 副精選牌組。
                  </Text>
                </>
              )}
            </View>

            {/* Events + featured decks */}
            <Text style={styles.h2}>
              賽事與精選牌組{selectedSlice ? `：${selectedSlice.label}` : ''}
            </Text>
            {events.length === 0 ? (
              <Text style={styles.emptyText}>此篩選條件下沒有牌組。</Text>
            ) : null}
            {events.map((e) => (
              <View key={e.eventId} style={styles.eventCard}>
                <Text style={styles.eventName}>{e.name}</Text>
                {e.nameZh ? <Text style={styles.eventNameZh}>{e.nameZh}</Text> : null}
                <View style={styles.metaRow}>
                  <Meta label="地區" value={e.region ?? '未知'} />
                  <Meta label="日期" value={e.date ?? '未公開'} />
                  <Meta label="參賽數" value={e.entrants == null ? '未公開' : `${e.entrants}`} />
                </View>
                <Text style={styles.eventCoverage}>{e.coverageNote}</Text>

                {e.decks.map((d) => (
                  <View key={d.deckId} style={styles.deckRow} testID={`deck-${d.deckId}`}>
                    <View style={styles.deckHead}>
                      <Text style={styles.deckArchetype}>
                        {d.archetypeLabel ?? '未知牌組'}
                      </Text>
                      <Text style={styles.deckRank}>{d.rankLabel ?? '名次未公開'}</Text>
                    </View>
                    <Text style={styles.deckPlayer}>
                      玩家：{d.playerName ?? '未公開'}
                    </Text>
                    <Text style={styles.deckCards}>
                      {d.cardsVerified === true
                        ? `卡表：${d.cards.length} 種卡`
                        : '卡表：未收錄（decklog 需 JS 渲染，尚未讀取）'}
                    </Text>
                    <ImportAction deck={d} catalog={catalog} onImport={() => onImport(e, d)} />
                    {d.decklogCode ? (
                      <TouchableOpacity onPress={() => onOpen(d.sourceUrl)}>
                        <Text style={styles.link}>{t('tournament_decklog_link', { code: d.decklogCode })}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ))}

                <TouchableOpacity onPress={() => onOpen(e.sourceUrl)}>
                  <Text style={styles.link}>{t('tournament_official_source')}</Text>
                </TouchableOpacity>
              </View>
            ))}

            <Text style={styles.generatedAt}>
              產生時間：{reports.map((r) => `${r.month} ${r.generatedAt}`).join('｜')}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
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
  monthRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inlineLoader: { marginVertical: 24 },
  monthChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  monthChipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  monthChipText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
  monthChipTextActive: { color: '#fff' },

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
    padding: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  disclaimerTitle: { color: COLORS.accent, fontSize: 14, fontWeight: 'bold', marginBottom: 6 },
  sourceName: { color: COLORS.text, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  disclaimerText: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18 },
  coverageNote: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 8 },
  statRow: { flexDirection: 'row', marginTop: 12, gap: 8 },
  stat: {
    flex: 1,
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
  dimensionRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
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
