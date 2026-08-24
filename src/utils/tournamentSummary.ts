import type { MonthlyReport, TournamentEvent, DeckEntry } from '../types/tournament';
import { verifiedDecks, ALL_SCOPE, SMALL_SAMPLE_MIN } from './tournamentDonut';
import type { LanguageCode } from '../store/settingsStore';
import { t } from '../i18n/index';

export interface SummaryArchetypeItem {
  id: string | null;
  label: string;
  count: number;
  /** Best (lowest) numeric rank observed in scope, when the source published one. */
  bestRank: number | null;
  /** Source-published rank string (e.g. "champion", "1位") for the deck holding bestRank. */
  bestRankLabel: string | null;
}

export interface SummaryOshiItem {
  id: string;
  label: string;
  count: number;
  bestRank: number | null;
  bestRankLabel: string | null;
}

export interface SummaryColorItem {
  color: string;
  count: number;
}

/** One high-frequency card in the verified sample. Dedupe identity is
 * `cardNumber` — printings/versions of the same card are never double-counted
 * (DIC-1142). Within a single deck, the same cardNumber across zones or
 * versions counts as one deck; across decks, `deckCount` is the number of
 * verified decks that contain the card. */
export interface RepresentativeCard {
  cardNumber: string;
  /** Preferred zone label from the first observation, so the UI can show it
   * as an oshi/main/yell hint without inventing a zone. */
  zone: 'oshi' | 'main' | 'yell';
  /** Sum of `count` across verified decks (co-occurrence weight), for the
   * secondary "共 X 張" line. Never used as adoption denominator. */
  totalCopies: number;
  /** How many verified decks contain the card at all. Adoption denominator. */
  deckCount: number;
  /** deckCount / verifiedDeckCount, as a 0–1 fraction. */
  adoptionRate: number;
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
  /** Cards seen in ≥1 verified deck, deduped by cardNumber, sorted by
   * deckCount desc then totalCopies desc. Empty when the verified sample is
   * empty. Capped at REPRESENTATIVE_CARDS_LIMIT to keep the mobile card short.
   */
  representativeCards: RepresentativeCard[];
  smallSample: boolean;
  coverageNote: string;
}

/** How many representative cards the summary exposes. Mobile can render every
 * row without scrolling nested. */
export const REPRESENTATIVE_CARDS_LIMIT = 8;
/** Minimum decks a card must appear in to qualify as "representative" when the
 * verified sample is large enough that a single-deck card would be noise. Small
 * samples (< REPRESENTATIVE_MIN_SAMPLE_FOR_MULTI verified) fall back to
 * appearances >= 1 so the section is not empty when every deck is unique. */
export const REPRESENTATIVE_MIN_DECK_COUNT = 2;
export const REPRESENTATIVE_MIN_SAMPLE_FOR_MULTI = 4;

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

  // Top Archetypes. Best rank is the lowest source-published `rank` observed
  // for a deck of this archetype in scope — never fabricated from `rankLabel`.
  const archetypeCounts = new Map<string, {
    label: string;
    count: number;
    bestRank: number | null;
    bestRankLabel: string | null;
  }>();
  for (const d of verified) {
    const key = d.archetypeId || d.archetypeLabel;
    if (!key) continue;
    const label = d.archetypeLabel || key;
    const existing = archetypeCounts.get(key)
      || { label, count: 0, bestRank: null as number | null, bestRankLabel: null as string | null };
    existing.count += 1;
    if (typeof d.rank === 'number' && (existing.bestRank == null || d.rank < existing.bestRank)) {
      existing.bestRank = d.rank;
      existing.bestRankLabel = d.rankLabel ?? null;
    }
    archetypeCounts.set(key, existing);
  }
  const topArchetypes: SummaryArchetypeItem[] = Array.from(archetypeCounts.entries())
    .map(([id, item]) => ({
      id,
      label: item.label,
      count: item.count,
      bestRank: item.bestRank,
      bestRankLabel: item.bestRankLabel,
    }))
    .sort((a, b) => b.count - a.count || (a.bestRank ?? 99) - (b.bestRank ?? 99))
    .slice(0, 4);

  // Top Oshi
  const oshiCounts = new Map<string, {
    label: string;
    count: number;
    bestRank: number | null;
    bestRankLabel: string | null;
  }>();
  for (const d of verified) {
    if (d.oshi) {
      const existing = oshiCounts.get(d.oshi)
        || { label: d.oshi, count: 0, bestRank: null as number | null, bestRankLabel: null as string | null };
      existing.count += 1;
      if (typeof d.rank === 'number' && (existing.bestRank == null || d.rank < existing.bestRank)) {
        existing.bestRank = d.rank;
        existing.bestRankLabel = d.rankLabel ?? null;
      }
      oshiCounts.set(d.oshi, existing);
    }
  }
  const topOshi: SummaryOshiItem[] = Array.from(oshiCounts.entries())
    .map(([id, item]) => ({
      id,
      label: item.label,
      count: item.count,
      bestRank: item.bestRank,
      bestRankLabel: item.bestRankLabel,
    }))
    .sort((a, b) => b.count - a.count || (a.bestRank ?? 99) - (b.bestRank ?? 99))
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
  const representativeCards = buildRepresentativeCards(verified);

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
    representativeCards,
    smallSample,
    coverageNote,
  };
}

/** Aggregates high-frequency cards across a verified deck sample. Dedupe key
 * is `cardNumber` — printing/rarity `version` collapse into one card, so the
 * champion-only SEC print and the R print of hBP08-005 are ONE card, not two
 * (DIC-1142 §4). Zones are preserved from the first observation; a card
 * legitimately seen in both `main` and `yell` (rare but possible with
 * cross-zone dupes in incoming data) keeps its first zone rather than being
 * split — the goal is a stable identity, not zone attribution. */
export function buildRepresentativeCards(verified: readonly DeckEntry[]): RepresentativeCard[] {
  const total = verified.length;
  if (total === 0) return [];
  const cardMap = new Map<string, {
    zone: 'oshi' | 'main' | 'yell';
    totalCopies: number;
    deckCount: number;
  }>();
  for (const deck of verified) {
    // Collapse duplicates within a single deck up-front (different `version`
    // values of the same cardNumber must not inflate deckCount past 1).
    const perDeck = new Map<string, { zone: 'oshi' | 'main' | 'yell'; copies: number }>();
    for (const card of deck.cards || []) {
      if (!card?.cardNumber) continue;
      const existing = perDeck.get(card.cardNumber);
      if (existing) {
        existing.copies += card.count || 0;
      } else {
        perDeck.set(card.cardNumber, { zone: card.zone, copies: card.count || 0 });
      }
    }
    for (const [cardNumber, info] of perDeck.entries()) {
      const cur = cardMap.get(cardNumber);
      if (cur) {
        cur.totalCopies += info.copies;
        cur.deckCount += 1;
      } else {
        cardMap.set(cardNumber, { zone: info.zone, totalCopies: info.copies, deckCount: 1 });
      }
    }
  }
  const minDeckCount = total >= REPRESENTATIVE_MIN_SAMPLE_FOR_MULTI
    ? REPRESENTATIVE_MIN_DECK_COUNT
    : 1;
  const rows: RepresentativeCard[] = [];
  for (const [cardNumber, info] of cardMap.entries()) {
    if (info.deckCount < minDeckCount) continue;
    rows.push({
      cardNumber,
      zone: info.zone,
      totalCopies: info.totalCopies,
      deckCount: info.deckCount,
      adoptionRate: info.deckCount / total,
    });
  }
  rows.sort((a, b) => (
    b.deckCount - a.deckCount
    || b.totalCopies - a.totalCopies
    || a.cardNumber.localeCompare(b.cardNumber)
  ));
  return rows.slice(0, REPRESENTATIVE_CARDS_LIMIT);
}

// ── Per-event highlights ────────────────────────────────────────────────────
// The source publishes decks + a coverageNote per event; there is no separate
// "news" feed. Rather than fabricate a headline (banned by DIC-1142), we
// derive an honest highlight from the deck data itself: champion (rank 1),
// number of showcased decks, common cards across decks in this event. The
// event's own sourceUrl is the only news reference.

export interface EventHighlightCard {
  cardNumber: string;
  zone: 'oshi' | 'main' | 'yell';
  deckCount: number;
}

export interface EventHighlight {
  eventId: string;
  /** Deck with rank 1, when the source published one. */
  championDeckId: string | null;
  championArchetypeLabel: string | null;
  championOshi: string | null;
  championPlayerName: string | null;
  /** Total decks the source showcased for this event (verified or not). */
  showcasedDecks: number;
  /** How many of those had a full verified card list. */
  verifiedDecks: number;
  /** Cards that appear in >= 2 decks IN THIS EVENT, deduped by cardNumber.
   * When there are fewer than 2 verified decks the array is empty (nothing
   * meaningful to intersect). Capped at EVENT_COMMON_CARDS_LIMIT. */
  commonCards: EventHighlightCard[];
  /** True when the source published the event but only 0-1 decks made it in.
   * The UI uses this to switch to "已公開 n=X" copy without long disclaimers.
   */
  smallSample: boolean;
  /** true when there is at least one champion/top-4 numeric rank in scope. */
  hasNotableRank: boolean;
}

export const EVENT_COMMON_CARDS_LIMIT = 5;
export const EVENT_COMMON_MIN_DECK_COUNT = 2;

export function buildEventHighlights(events: readonly TournamentEvent[]): Map<string, EventHighlight> {
  const out = new Map<string, EventHighlight>();
  for (const event of events) {
    const decks = event.decks || [];
    const verified = decks.filter((d) => d.cardsVerified === true);
    const champion = decks.find((d) => d.rank === 1) || null;
    const hasNotableRank = decks.some((d) => typeof d.rank === 'number' && d.rank <= 4);

    let commonCards: EventHighlightCard[] = [];
    if (verified.length >= EVENT_COMMON_MIN_DECK_COUNT) {
      const cardCounts = new Map<string, { zone: 'oshi' | 'main' | 'yell'; deckCount: number }>();
      for (const deck of verified) {
        const seenInDeck = new Set<string>();
        for (const card of deck.cards || []) {
          if (!card?.cardNumber || seenInDeck.has(card.cardNumber)) continue;
          seenInDeck.add(card.cardNumber);
          const cur = cardCounts.get(card.cardNumber);
          if (cur) cur.deckCount += 1;
          else cardCounts.set(card.cardNumber, { zone: card.zone, deckCount: 1 });
        }
      }
      commonCards = Array.from(cardCounts.entries())
        .filter(([, info]) => info.deckCount >= EVENT_COMMON_MIN_DECK_COUNT)
        .map(([cardNumber, info]) => ({
          cardNumber,
          zone: info.zone,
          deckCount: info.deckCount,
        }))
        .sort((a, b) => b.deckCount - a.deckCount || a.cardNumber.localeCompare(b.cardNumber))
        .slice(0, EVENT_COMMON_CARDS_LIMIT);
    }

    out.set(event.eventId, {
      eventId: event.eventId,
      championDeckId: champion?.deckId ?? null,
      championArchetypeLabel: champion?.archetypeLabel ?? null,
      championOshi: champion?.oshi ?? null,
      championPlayerName: champion?.playerName ?? null,
      showcasedDecks: decks.length,
      verifiedDecks: verified.length,
      commonCards,
      smallSample: decks.length <= 1,
      hasNotableRank,
    });
  }
  return out;
}
