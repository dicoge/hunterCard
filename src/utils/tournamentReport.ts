// Pure, deterministic core for the honest monthly tournament report (DIC-979).
//
// Kept free of any I/O, network, or React so it can be exercised directly by
// fixture tests and reused by both the collector script and the UI. Every
// function is a pure transform: same input → same output, no wall-clock reads.
//
// Honesty invariants enforced here (see src/types/tournament.ts for the why):
//   • Unknown stays unknown. A missing rank/archetype/card/version is preserved
//     as null/empty, never back-filled or force-classified.
//   • Archetype share is computed over the OBSERVED sample only. The unknown
//     segment is a first-class slice, so shares always sum to 1 and the total
//     is never dressed up as full-meta coverage.
//   • Participant counts and the true event universe are unknown → null.

import {
  TOURNAMENT_SCHEMA_VERSION,
  type ArchetypeShareRow,
  type CoverageInfo,
  type DeckCardRef,
  type DeckEntry,
  type MonthlyReport,
  type TournamentEvent,
} from '../types/tournament';
import { RULES } from './deckRules';

// ── Raw (pre-normalization) source records ──────────────────────────────────
// These mirror what a human-verified extraction of the official column yields.
// Any field the source did not publish is simply omitted here and becomes an
// explicit unknown after normalization.
export interface RawDeckRecord {
  decklogCode?: string | null;
  playerName?: string | null;
  rank?: number | null;
  rankLabel?: string | null;
  archetypeId?: string | null;
  archetypeLabel?: string | null;
  oshi?: string | null;
  colors?: string[];
  cards?: DeckCardRef[];
}

export interface RawEventRecord {
  eventId?: string;
  eventSlug?: string;
  name: string;
  nameZh?: string | null;
  date?: string | null;
  region?: string | null;
  format?: string | null;
  entrants?: number | null;
  sourceUrl: string;
  sourceType?: string;
  coverageNote?: string;
  decks?: RawDeckRecord[];
}

export const UNKNOWN_ARCHETYPE_LABEL = '未知 / Unknown';

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 'YYYY-MM' bucket for an ISO date, using UTC so a 2026-07-31 vs 2026-08-01
// boundary never drifts by local timezone. Returns null when no date is known.
export function monthOf(dateISO: string | null | undefined): string | null {
  if (!dateISO) return null;
  const m = /^(\d{4})-(\d{2})/.exec(dateISO.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

// These run against whatever a source file or a future fetcher actually hands
// us at runtime, where the DeckCardRef type is only a claim. Coercion is
// deliberately refused: Number('50') would turn a string into a plausible
// quantity, and `${{}}` would turn an object into a plausible version, both of
// which invent data the source never published.
function isExactString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value == null || isExactString(value);
}

// A card list is only usable if it is COMPLETE and every slot is exactly the
// shape it claims to be. A partially-read source must never present itself as a
// deck the user can import: a 46-card "main deck" looks like a deck the player
// chose to build illegally, which is a lie about the tournament. So ONE bad slot
// rejects the whole list — it is not trimmed into a plausible-looking deck
// (DIC-1001 finding #2).
function normalizeCards(cards: DeckCardRef[] | undefined): {
  cards: DeckCardRef[];
  verified: boolean;
  issue: DeckEntry['cardsIssue'];
} {
  if (!Array.isArray(cards) || cards.length === 0) {
    return { cards: [], verified: false, issue: 'missing' };
  }

  const clean: DeckCardRef[] = [];
  for (const c of cards) {
    const zoneOk = c?.zone === 'oshi' || c?.zone === 'main' || c?.zone === 'yell';
    const numberOk = isExactString(c?.cardNumber);
    const countOk = typeof c?.count === 'number' && Number.isInteger(c.count) && c.count > 0;
    // version stays null when not supplied — never inferred from a same-named or
    // same-numbered printing. A supplied-but-blank or non-string value is a
    // failed read, not a published value.
    const optionalsOk =
      isOptionalString(c?.version) &&
      isOptionalString(c?.name) &&
      isOptionalString(c?.cardKind) &&
      isOptionalString(c?.imagePath);
    if (!zoneOk || !numberOk || !countOk || !optionalsOk) {
      return { cards: [], verified: false, issue: 'incomplete' };
    }
    clean.push({
      zone: c.zone,
      cardNumber: c.cardNumber.trim(),
      version: c.version ?? null,
      count: c.count,
      name: c.name ?? null,
      cardKind: c.cardKind ?? null,
      imagePath: c.imagePath ?? null,
    });
  }

  const totals = { oshi: 0, main: 0, yell: 0 };
  for (const c of clean) totals[c.zone] += c.count;
  const complete =
    totals.oshi === RULES.zones.oshi.exactCount &&
    totals.main === RULES.zones.main.exactCount &&
    totals.yell === RULES.zones.yell.exactCount;

  if (!complete) return { cards: [], verified: false, issue: 'incomplete' };
  return { cards: clean, verified: true, issue: null };
}

export function normalizeDeck(
  raw: RawDeckRecord,
  eventId: string,
  sourceUrl: string,
  index: number,
  fetchedAt: string,
): DeckEntry {
  const { cards, verified, issue } = normalizeCards(raw.cards);
  const rank = typeof raw.rank === 'number' ? raw.rank : null;
  const decklogCode = raw.decklogCode ?? null;
  const deckId = decklogCode
    ? `decklog:${decklogCode}`
    : `${eventId}#${raw.rankLabel ? slugify(raw.rankLabel) : `slot-${index}`}`;

  const coverage: DeckEntry['coverage'] =
    rank == null ? 'featured' : verified ? 'ranked' : 'partial';

  return {
    deckId,
    decklogCode,
    sourceUrl: raw.decklogCode
      ? `https://decklog.bushiroad.com/view/${raw.decklogCode}`
      : sourceUrl,
    playerName: raw.playerName ?? null,
    rank,
    rankLabel: raw.rankLabel ?? null,
    archetypeId: raw.archetypeId ?? null,
    archetypeLabel: raw.archetypeLabel ?? null,
    oshi: raw.oshi ?? null,
    colors: Array.isArray(raw.colors) ? raw.colors : [],
    cards,
    cardsVerified: verified,
    cardsIssue: issue,
    coverage,
    fetchedAt,
  };
}

export function normalizeEvent(
  raw: RawEventRecord,
  fetchedAt: string,
): TournamentEvent {
  const eventId =
    raw.eventId ||
    raw.eventSlug ||
    `${slugify(raw.name)}${raw.date ? `_${raw.date}` : ''}`;

  const decks = dedupeDecks(
    (raw.decks ?? []).map((d, i) =>
      normalizeDeck(d, eventId, raw.sourceUrl, i, fetchedAt),
    ),
  );

  return {
    eventId,
    name: raw.name,
    nameZh: raw.nameZh ?? null,
    date: raw.date ?? null,
    region: raw.region ?? null,
    format: raw.format ?? null,
    // Never fabricated: the source does not publish participant counts.
    entrants: typeof raw.entrants === 'number' ? raw.entrants : null,
    sourceUrl: raw.sourceUrl,
    sourceType: raw.sourceType ?? 'official-column',
    coverageNote:
      raw.coverageNote ??
      '僅收錄官方專欄公開的精選牌組，非完整賽果；參賽數與完整名次未公開。',
    decks,
    fetchedAt,
  };
}

// Dedupe by stable deckId. First occurrence wins so re-running the collector is
// idempotent and never double-counts a deck across months.
export function dedupeDecks(decks: DeckEntry[]): DeckEntry[] {
  const seen = new Map<string, DeckEntry>();
  for (const d of decks) if (!seen.has(d.deckId)) seen.set(d.deckId, d);
  return [...seen.values()];
}

// Dedupe by eventId. When the same event appears twice its decks are merged and
// de-duped, so an event straddling two source posts is not duplicated.
export function dedupeEvents(events: TournamentEvent[]): TournamentEvent[] {
  const seen = new Map<string, TournamentEvent>();
  for (const e of events) {
    const existing = seen.get(e.eventId);
    if (!existing) {
      seen.set(e.eventId, { ...e, decks: dedupeDecks(e.decks) });
    } else {
      existing.decks = dedupeDecks([...existing.decks, ...e.decks]);
    }
  }
  return [...seen.values()];
}

// Date-based month filter. Used for the date-driven monthly-boundary path and
// tests. Note the *report* itself buckets by the source column's declared
// month (see buildMonthlyReport) because exact per-event competition dates are
// not published — only the column's publish date is verifiable.
export function eventsForMonth(
  events: TournamentEvent[],
  month: string,
): TournamentEvent[] {
  return events.filter((e) => monthOf(e.date) === month);
}

export function groupEventsByMonth(
  events: TournamentEvent[],
): Map<string, TournamentEvent[]> {
  const out = new Map<string, TournamentEvent[]>();
  for (const e of events) {
    const m = monthOf(e.date);
    if (!m) continue; // no verifiable date → cannot be date-bucketed
    const bucket = out.get(m) ?? [];
    bucket.push(e);
    out.set(m, bucket);
  }
  return out;
}

export function computeCoverage(events: TournamentEvent[]): CoverageInfo {
  const observedDecks = events.reduce((n, e) => n + e.decks.length, 0);
  const rankedDecks = events.reduce(
    (n, e) => n + e.decks.filter((d) => d.rank != null).length,
    0,
  );
  return {
    knownEvents: events.length,
    // The real number of events held is not published anywhere → unknown.
    totalEvents: null,
    observedDecks,
    rankedDecks,
    note: `本月僅收錄 ${events.length} 場的公開精選牌組（共 ${observedDecks} 副，其中 ${rankedDecks} 副有公開名次）。賽事總場數未公開，涵蓋率無法計算完整母體。`,
  };
}

// Archetype share over the OBSERVED sample. The unknown segment (archetypeId
// null) is included as its own slice, so `share` values sum to 1 and are never
// presented as complete metagame share. Denominator = total observed decks.
export function computeArchetypeShare(
  events: TournamentEvent[],
): ArchetypeShareRow[] {
  const decks = events.flatMap((e) => e.decks);
  const total = decks.length;
  if (total === 0) return [];

  const counts = new Map<string, { label: string; count: number }>();
  let unknown = 0;
  for (const d of decks) {
    if (d.archetypeId == null) {
      unknown += 1;
      continue;
    }
    const cur = counts.get(d.archetypeId);
    if (cur) cur.count += 1;
    else
      counts.set(d.archetypeId, {
        label: d.archetypeLabel ?? d.archetypeId,
        count: 1,
      });
  }

  const rows: ArchetypeShareRow[] = [...counts.entries()]
    .map(([archetypeId, v]) => ({
      archetypeId,
      label: v.label,
      count: v.count,
      share: v.count / total,
    }))
    // Deterministic order: count desc, then id asc for stable ties.
    .sort((a, b) => b.count - a.count || a.archetypeId!.localeCompare(b.archetypeId!));

  if (unknown > 0) {
    // Unknown always renders last as an explicit, visible slice.
    rows.push({
      archetypeId: null,
      label: UNKNOWN_ARCHETYPE_LABEL,
      count: unknown,
      share: unknown / total,
    });
  }
  return rows;
}

export interface BuildReportOptions {
  month: string;
  // Events already selected for this report's month. They are bucketed by the
  // source column's declared month (its verifiable publish date), because exact
  // per-event competition dates are not published. Pass `filterByEventDate` to
  // additionally require each event's own date to fall in `month`.
  events: RawEventRecord[] | TournamentEvent[];
  generatedAt: string;
  fetchedAt?: string;
  source?: MonthlyReport['source'];
  filterByEventDate?: boolean;
}

const DEFAULT_SOURCE: MonthlyReport['source'] = {
  name: 'hololive OFFICIAL CARD GAME — 公式コラム「イチ推し！デッキ紹介」',
  url: 'https://hololive-official-cardgame.com/',
  disclaimer:
    '資料僅來自官方專欄公開的精選牌組，非完整賽事結果。官方不公開參賽人數、完整名次或全部牌組；本頁占比僅反映「已觀測樣本」，不代表整體 meta 佔比。台灣／亞洲賽事目前無可驗證的公開來源，維持未知。',
};

function isRaw(e: RawEventRecord | TournamentEvent): e is RawEventRecord {
  return !('eventId' in e) || !('fetchedAt' in e);
}

export function buildMonthlyReport(opts: BuildReportOptions): MonthlyReport {
  const fetchedAt = opts.fetchedAt ?? opts.generatedAt;
  const normalized: TournamentEvent[] = opts.events.map((e) =>
    isRaw(e) ? normalizeEvent(e, fetchedAt) : e,
  );
  const selected = opts.filterByEventDate
    ? eventsForMonth(normalized, opts.month)
    : normalized;
  const events = dedupeEvents(selected);

  return {
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    month: opts.month,
    generatedAt: opts.generatedAt,
    source: opts.source ?? DEFAULT_SOURCE,
    coverage: computeCoverage(events),
    events,
    archetypeShare: computeArchetypeShare(events),
    observedSampleSize: events.reduce((n, e) => n + e.decks.length, 0),
  };
}

// Incremental merge for monthly day-1 runs: union prior last-known-good events
// with freshly collected ones (incoming wins on eventId conflict), then rebuild.
// The collector calls this so a partial re-run never drops previously stored
// events, and a total source failure can simply skip the merge to preserve
// last-known-good untouched.
export function mergeMonthlyReport(
  prev: MonthlyReport | null,
  incoming: TournamentEvent[],
  opts: { month: string; generatedAt: string; source?: MonthlyReport['source'] },
): MonthlyReport {
  const prevEvents = prev?.events ?? [];
  const byId = new Map<string, TournamentEvent>();
  for (const e of prevEvents) byId.set(e.eventId, e);
  for (const e of incoming) byId.set(e.eventId, e); // incoming wins
  return buildMonthlyReport({
    month: opts.month,
    events: dedupeEvents([...byId.values()]),
    generatedAt: opts.generatedAt,
    source: opts.source ?? prev?.source,
  });
}

// Stable content fingerprint that excludes volatile timestamps, so change
// detection only fires on real data changes (not every scheduled run).
export function reportContentKey(report: MonthlyReport): string {
  const stable = {
    schemaVersion: report.schemaVersion,
    month: report.month,
    source: report.source,
    events: report.events.map((e) => ({
      ...e,
      fetchedAt: undefined,
      decks: e.decks.map((d) => ({ ...d, fetchedAt: undefined })),
    })),
  };
  return JSON.stringify(stable);
}
