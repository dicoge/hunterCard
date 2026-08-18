import type { MonthlyReport, TournamentEvent, DeckEntry } from '../types/tournament';
import { verifiedDecks, ALL_SCOPE, SMALL_SAMPLE_MIN } from './tournamentDonut';
import type { LanguageCode } from '../store/settingsStore';
import { t } from '../i18n/index';

export interface SummaryArchetypeItem {
  id: string | null;
  label: string;
  count: number;
}

export interface SummaryOshiItem {
  id: string;
  label: string;
  count: number;
}

export interface SummaryColorItem {
  color: string;
  count: number;
}

export interface NotablePlacement {
  eventId: string;
  eventName: string;
  eventNameZh?: string | null;
  deckId: string;
  decklogCode?: string | null;
  playerName?: string | null;
  rankLabel?: string | null;
  rank?: number | null;
  archetypeId?: string | null;
  archetypeLabel?: string | null;
  oshi?: string | null;
}

export interface TournamentMonthlySummaryModel {
  scope: string;
  scopeLabel: string;
  eventCount: number;
  observedDeckCount: number;
  verifiedDeckCount: number;
  topArchetypes: SummaryArchetypeItem[];
  topOshi: SummaryOshiItem[];
  topColors: SummaryColorItem[];
  notablePlacements: NotablePlacement[];
  smallSample: boolean;
  coverageNote: string;
}

const COLOR_ID: Record<string, string> = {
  白: 'white', white: 'white',
  青: 'blue', 藍: 'blue', blue: 'blue',
  緑: 'green', 綠: 'green', green: 'green',
  赤: 'red', 紅: 'red', red: 'red',
  紫: 'purple', purple: 'purple',
  黄: 'yellow', 黃: 'yellow', yellow: 'yellow',
  '◇': 'colorless', 無色: 'colorless', colorless: 'colorless',
};

export function normalizeTournamentColor(color: string): string {
  return COLOR_ID[color] || color.toLowerCase();
}

/** Filters the visible event list by a published deck color. Multi-color decks
 * stay in one event row and are never split into invented fractional shares. */
export function filterEventsByColor(
  events: readonly TournamentEvent[],
  color: string | null,
): TournamentEvent[] {
  if (color == null) return [...events];
  return events
    .map((event) => ({
      ...event,
      decks: event.decks.filter((deck) =>
        (deck.colors || []).some((deckColor) => normalizeTournamentColor(deckColor) === color)),
    }))
    .filter((event) => event.decks.length > 0);
}

export function buildTournamentMonthlySummary(
  reports: MonthlyReport[],
  scope: string,
  language: LanguageCode = 'zh',
): TournamentMonthlySummaryModel {
  const events: TournamentEvent[] = reports.flatMap((r) => r.events || []);
  const verified: DeckEntry[] = verifiedDecks(events);

  // Scope label formatting
  let scopeLabel = scope;
  if (scope === ALL_SCOPE) {
    const months = reports.map((r) => r.month).filter(Boolean).sort();
    if (months.length > 0) {
      const start = months[0];
      const end = months[months.length - 1];
      scopeLabel = t('tournament_summary_all_scope_label', language, { start, end });
    } else {
      scopeLabel = t('tournament_scope_all', language);
    }
  }

  // Event & Deck Counts
  const eventCount = events.length;
  const observedDeckCount = events.reduce((acc, e) => acc + (e.decks?.length || 0), 0);
  const verifiedDeckCount = verified.length;

  // Top Archetypes
  const archetypeCounts = new Map<string, { label: string; count: number }>();
  for (const d of verified) {
    const key = d.archetypeId || d.archetypeLabel;
    if (!key) continue;
    const label = d.archetypeLabel || key;
    const existing = archetypeCounts.get(key) || { label, count: 0 };
    existing.count += 1;
    archetypeCounts.set(key, existing);
  }
  const topArchetypes: SummaryArchetypeItem[] = Array.from(archetypeCounts.entries())
    .map(([id, item]) => ({ id, label: item.label, count: item.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  // Top Oshi
  const oshiCounts = new Map<string, { label: string; count: number }>();
  for (const d of verified) {
    if (d.oshi) {
      const existing = oshiCounts.get(d.oshi) || { label: d.oshi, count: 0 };
      existing.count += 1;
      oshiCounts.set(d.oshi, existing);
    }
  }
  const topOshi: SummaryOshiItem[] = Array.from(oshiCounts.entries())
    .map(([id, item]) => ({ id, label: item.label, count: item.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  // Top Colors
  const colorCounts = new Map<string, number>();
  for (const d of verified) {
    for (const rawColor of d.colors || []) {
      const c = normalizeTournamentColor(rawColor);
      if (c) {
        colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
      }
    }
  }
  const topColors: SummaryColorItem[] = Array.from(colorCounts.entries())
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  // Notable Placements (Champions or top ranks)
  const notablePlacements: NotablePlacement[] = [];
  for (const e of events) {
    for (const d of e.decks || []) {
      // Pick champions (rank === 1 or rankLabel contains champion/1位) or top placements
      const isChampion = d.rank === 1 || (d.rankLabel && (d.rankLabel.includes('champion') || d.rankLabel.includes('1位') || d.rankLabel.includes('優勝')));
      if (isChampion || (d.rank != null && d.rank <= 4)) {
        notablePlacements.push({
          eventId: e.eventId,
          eventName: e.name,
          eventNameZh: e.nameZh,
          deckId: d.deckId,
          decklogCode: d.decklogCode,
          playerName: d.playerName,
          rankLabel: d.rankLabel,
          rank: d.rank,
          archetypeId: d.archetypeId,
          archetypeLabel: d.archetypeLabel,
          oshi: d.oshi,
        });
      }
    }
  }
  // Sort by rank ascending (champions first)
  notablePlacements.sort((a, b) => (a.rank || 99) - (b.rank || 99));

  const smallSample = verifiedDeckCount < SMALL_SAMPLE_MIN;
  const coverageNote = reports.map((r) => r.coverage?.note).filter(Boolean).join(' ');

  return {
    scope,
    scopeLabel,
    eventCount,
    observedDeckCount,
    verifiedDeckCount,
    topArchetypes,
    topOshi,
    topColors,
    notablePlacements: notablePlacements.slice(0, 5),
    smallSample,
    coverageNote,
  };
}
