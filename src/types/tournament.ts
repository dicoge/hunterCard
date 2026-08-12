// Normalized schema for the honest monthly tournament report (DIC-979).
//
// Design contract, grounded in the DIC-942 research findings:
//   • hOCG has NO public complete tournament-results database. The official
//     column ("イチ推し！デッキ紹介") publishes only a handful of *featured*
//     decks per event, never full standings or participant counts.
//   • Therefore every field that the source does not actually publish stays
//     `null` / empty and is surfaced as UNKNOWN. We never fabricate a rank,
//     a participant count, a full-coverage claim, an archetype, or a card
//     version. Unknown remains unknown.
//   • Card lists are only populated when an exact cardNumber (+ version when
//     supplied) is available. decklog deck pages are a JS-rendered SPA, so the
//     automated pipeline cannot read card lists yet — those decks carry
//     `cardsVerified: false` and an empty `cards` array, not a guess.

export const TOURNAMENT_SCHEMA_VERSION = 1;

// A single card reference inside a deck. version is only ever set when the
// source supplied it; a missing version is `null`, never inferred from a
// same-named or same-numbered printing.
export interface DeckCardRef {
  cardNumber: string;
  version: string | null;
  count: number;
}

// How much of a deck's data we actually observed from the source.
//   'ranked'   — a placement is published (rank is a real number)
//   'featured' — the deck was showcased but its placement is not published
//   'partial'  — some fields present, others explicitly unknown
export type DeckCoverage = 'ranked' | 'featured' | 'partial';

export interface DeckEntry {
  // Stable dedupe identity. Prefer the decklog code (globally unique per deck);
  // fall back to `${eventId}#${slotKey}` when no code is published.
  deckId: string;
  decklogCode: string | null;
  sourceUrl: string;
  playerName: string | null;
  rank: number | null;
  rankLabel: string | null;
  // null archetype means UNKNOWN — it is never force-classified into a named
  // bucket and is rendered as its own "unknown" slice.
  archetypeId: string | null;
  archetypeLabel: string | null;
  oshi: string | null;
  colors: string[];
  cards: DeckCardRef[];
  cardsVerified: boolean;
  coverage: DeckCoverage;
  fetchedAt: string;
}

export interface TournamentEvent {
  // Stable dedupe identity, e.g. `${sourceSlug}` or `${eventSlug}_${date}`.
  eventId: string;
  name: string;
  nameZh: string | null;
  date: string | null;
  region: string | null;
  format: string | null;
  // Participant count is NOT published by the source → null. Never invented.
  entrants: number | null;
  sourceUrl: string;
  sourceType: string;
  // Human-readable note on what this event's data does and does not cover.
  coverageNote: string;
  decks: DeckEntry[];
  fetchedAt: string;
}

export interface CoverageInfo {
  // Number of events we actually have data for this month.
  knownEvents: number;
  // The true universe of events held that month is not published anywhere, so
  // this is null (unknown), never a fabricated denominator.
  totalEvents: number | null;
  observedDecks: number;
  rankedDecks: number;
  note: string;
}

// One slice of the observed-sample archetype breakdown. A row with
// archetypeId === null is the explicit UNKNOWN slice.
export interface ArchetypeShareRow {
  archetypeId: string | null;
  label: string;
  count: number;
  // Fraction of the OBSERVED sample only (denominator = observedDecks),
  // including the unknown slice, so shares sum to 1. This is never presented
  // as full-meta share.
  share: number;
}

export interface MonthlyReport {
  schemaVersion: number;
  month: string; // 'YYYY-MM'
  generatedAt: string;
  source: {
    name: string;
    url: string;
    // Disclaimer shown verbatim in the UI so users never mistake a small
    // featured sample for complete metagame coverage.
    disclaimer: string;
  };
  coverage: CoverageInfo;
  events: TournamentEvent[];
  archetypeShare: ArchetypeShareRow[];
  observedSampleSize: number;
}

// Lightweight index of available months, consumed by the month selector.
export interface TournamentIndex {
  schemaVersion: number;
  generatedAt: string;
  months: Array<{
    month: string;
    events: number;
    observedDecks: number;
  }>;
}
