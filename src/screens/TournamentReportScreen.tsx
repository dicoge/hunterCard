import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { COLORS } from '../constants';
import { openUrl } from '../utils/openUrl';
import type {
  MonthlyReport,
  TournamentIndex,
  ArchetypeShareRow,
} from '../types/tournament';

// Deterministic palette for archetype slices; the unknown slice is always the
// muted gray below (never a "real" archetype color) so it reads as a gap.
const SLICE_COLORS = [
  '#ff6b9d',
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#eab308',
];
const UNKNOWN_COLOR = '#4b5563';

function sliceColor(row: ArchetypeShareRow, index: number): string {
  return row.archetypeId == null ? UNKNOWN_COLOR : SLICE_COLORS[index % SLICE_COLORS.length];
}

function pct(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
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
  const [index, setIndex] = useState<TournamentIndex | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const idx = await fetchJson<TournamentIndex>('/data/tournaments/index.json');
        if (!alive) return;
        setIndex(idx);
        setMonth(idx.months[0]?.month ?? null);
      } catch {
        if (alive) setError('目前沒有可用的賽事月報資料。');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!month) return;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await fetchJson<MonthlyReport>(`/data/tournaments/${month}.json`);
        if (alive) setReport(r);
      } catch {
        if (alive) setError(`無法載入 ${month} 的賽事月報。`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [month]);

  const onOpen = useCallback((url: string) => {
    void openUrl(url);
  }, []);

  if (loading && !report) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  if (error && !report) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>🏆 賽事月報</Text>
        <Text style={styles.emptyText}>{error}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>🏆 每月賽事月報</Text>

        {/* Month selector */}
        <View style={styles.monthRow}>
          {(index?.months ?? []).map((m) => {
            const active = m.month === month;
            return (
              <TouchableOpacity
                key={m.month}
                onPress={() => setMonth(m.month)}
                style={[styles.monthChip, active && styles.monthChipActive]}
              >
                <Text style={[styles.monthChipText, active && styles.monthChipTextActive]}>
                  {m.month}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {report && (
          <>
            {/* Source + honesty disclaimer */}
            <View style={styles.disclaimer}>
              <Text style={styles.disclaimerTitle}>資料來源與涵蓋率</Text>
              <Text style={styles.sourceName}>{report.source.name}</Text>
              <Text style={styles.disclaimerText}>{report.source.disclaimer}</Text>
              <Text style={styles.coverageNote}>{report.coverage.note}</Text>
              <View style={styles.statRow}>
                <Stat label="收錄賽事" value={`${report.coverage.knownEvents}`} />
                <Stat label="觀測牌組" value={`${report.coverage.observedDecks}`} />
                <Stat label="有名次" value={`${report.coverage.rankedDecks}`} />
                <Stat label="賽事總數" value="未公開" />
              </View>
            </View>

            {/* Archetype share over the observed sample only */}
            <Text style={styles.h2}>牌組占比（僅限已觀測樣本，共 {report.observedSampleSize} 副）</Text>
            {report.archetypeShare.length === 0 ? (
              <Text style={styles.emptyText}>本月無可觀測牌組。</Text>
            ) : (
              <>
                <View style={styles.bar}>
                  {report.archetypeShare.map((row, i) => (
                    <View
                      key={row.archetypeId ?? 'unknown'}
                      style={{
                        flex: row.count,
                        backgroundColor: sliceColor(row, i),
                        height: 22,
                      }}
                    />
                  ))}
                </View>
                {report.archetypeShare.map((row, i) => (
                  <View key={row.archetypeId ?? 'unknown'} style={styles.legendRow}>
                    <View style={[styles.swatch, { backgroundColor: sliceColor(row, i) }]} />
                    <Text
                      style={[
                        styles.legendLabel,
                        row.archetypeId == null && styles.legendUnknown,
                      ]}
                    >
                      {row.label}
                    </Text>
                    <Text style={styles.legendPct}>
                      {pct(row.share)}（{row.count}）
                    </Text>
                  </View>
                ))}
                <Text style={styles.finePrint}>
                  * 占比分母為已觀測樣本，非整體 meta。「未知」為未歸類牌組，不併入任何具名牌組。
                </Text>
              </>
            )}

            {/* Events + featured decks */}
            <Text style={styles.h2}>賽事與精選牌組</Text>
            {report.events.map((e) => (
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
                  <View key={d.deckId} style={styles.deckRow}>
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
                      {d.cardsVerified
                        ? `卡表：${d.cards.length} 種卡`
                        : '卡表：未收錄（decklog 需 JS 渲染，尚未讀取）'}
                    </Text>
                    {d.decklogCode ? (
                      <TouchableOpacity onPress={() => onOpen(d.sourceUrl)}>
                        <Text style={styles.link}>在 decklog 查看牌組 ({d.decklogCode}) ↗</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ))}

                <TouchableOpacity onPress={() => onOpen(e.sourceUrl)}>
                  <Text style={styles.link}>官方來源 ↗</Text>
                </TouchableOpacity>
              </View>
            ))}

            <Text style={styles.generatedAt}>
              產生時間：{report.generatedAt}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
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
  monthRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
  disclaimer: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    marginTop: 16,
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
  statLabel: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2 },
  bar: {
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 12,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  swatch: { width: 14, height: 14, borderRadius: 3, marginRight: 8 },
  legendLabel: { color: COLORS.text, fontSize: 13, flex: 1 },
  legendUnknown: { color: COLORS.textSecondary, fontStyle: 'italic' },
  legendPct: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  finePrint: { color: COLORS.textSecondary, fontSize: 11, lineHeight: 16, marginTop: 8 },
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
  generatedAt: { color: COLORS.textSecondary, fontSize: 11, marginTop: 16, textAlign: 'center' },
});
