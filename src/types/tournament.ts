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
//     supplied) is available. A deck whose card list the source does not expose
//     carries `cardsVerified: false` and an empty `cards` array, not a guess.
//   • DIC-1000: Deck Log does expose complete lists over a JSON endpoint, but
//     its terms prohibit unauthorized reproduction, transmission, distribution
//     and publication of site content, and the endpoint ships no CORS grant and
//     `X-Robots-Tag: noindex, nofollow`. So this repo carries NO Deck Log card
//     content and the published artifacts republish none: a Deck Log-sourced
//     deck stays `cards: []` / `cardsVerified: false` until a licensed source
//     exists. Reachability is not permission (DIC-1001 finding #1).
//   • DIC-1001 finding #2: a card list counts as usable only when it is
//     COMPLETE. Malformed entries are never silently dropped into a
//     "verified" deck, and zones must hit the exact required counts.

export const TOURNAMENT_SCHEMA_VERSION = 3;

// Deck zones, mirroring the editor's DeckZone. Kept as its own type so the
// tournament schema does not depend on the editor module.
export type DeckCardZone = 'oshi' | 'main' | 'yell';

// A single card slot inside a deck, normalized for the deck editor (DIC-1000).
// version is only ever set when the source supplied it; a missing version is
// `null`, never inferred from a same-named or same-numbered printing.
export interface DeckCardRef {
  zone: DeckCardZone;
  cardNumber: string;
  version: string | null;
  count: number;
  /** source-supplied display name; null when the source published none */
  name: string | null;
  /** source-supplied card type (e.g. ホロメン / サポート・アイテム / エール) */
  cardKind: string | null;
  /** source-supplied printing path, e.g. `hBP08/hBP01-056_HR.png`; the exact
   *  printing identity used to match a local catalog entry. null when unknown. */
  imagePath: string | null;
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
  /** true only when the list is COMPLETE: every slot carried exactly the runtime
   *  types it claims and the zones hit the exact counts the game requires. A
   *  partial read is never presented as a deck the player actually built, so
   *  `cards` is empty whenever this is false. */
  cardsVerified: boolean;
  /** why the list cannot be imported — `'missing'` (source published none) or
   *  `'incomplete'` (a slot was malformed, or the zones fell short of 1/50/20).
   *  null when the list is complete. Drives the disabled-CTA reason in the UI. */
  cardsIssue: 'missing' | 'incomplete' | null;
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
