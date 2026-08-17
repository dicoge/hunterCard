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
  type DeckZone,
  type MonthlyReport,
  type TournamentEvent,
} from '../types/tournament';

// ── Raw (pre-normalization) source records ──────────────────────────────────
// These mirror what a human-verified extraction of the official column yields.
// Any field the source did not publish is simply omitted here and becomes an
// explicit unknown after normalization.
export interface RawDeckRecord {
  decklogCode?: string | null;
  playerName?: string | null;
  rank?: number | null;
  rankLabel?: string | null;
  block?: string | null;
  deckName?: string | null;
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

const DECK_ZONES: readonly DeckZone[] = ['oshi', 'main', 'yell'];

export function isDeckZone(value: unknown): value is DeckZone {
  return typeof value === 'string' && (DECK_ZONES as readonly string[]).includes(value);
}

// A copy count is only readable as a positive integer. 0, negatives, fractions,
// NaN, numeric strings and missing values are all unreadable — and an unreadable
// count must never be repaired into 1, because a repaired count can make a
// broken list add up to a legal 1/50/20 deck (DIC-1029).
export function isReadableCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// A version is the rarity/printing token the source published alongside a slot.
// It is readable only as an explicit absence (null/undefined → honest unknown)
// or a non-blank string. An object, array, boolean or number is not a token any
// consumer can carry: such a value used to normalize as `verified` and then
// crash the deck importer on `.trim()` (DIC-1057). A blank/whitespace string is
// equally unreadable — it claims a token exists while naming none — and must not
// be repaired into null, for the same reason an unreadable count is never
// repaired into 1.
export function isReadableVersion(value: unknown): value is string | null | undefined {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && value.trim().length > 0;
}

/** Reject a raw card slot before any normalization touches it. Sanitizing first
 * — dropping unreadable entries or defaulting bad counts — destroys the very
 * evidence the strict gate needs, so every malformed slot throws here instead. */
function assertReadableSlot(card: DeckCardRef, index: number): asserts card is DeckCardRef {
  const at = `slot ${index}`;
  if (!card || typeof card !== 'object') {
    throw new Error(`${at} is not a card object (${JSON.stringify(card)})`);
  }
  if (typeof card.cardNumber !== 'string' || card.cardNumber.trim().length === 0) {
    throw new Error(`${at} has no readable card number (cardNumber=${JSON.stringify(card.cardNumber)})`);
  }
  if (!isDeckZone(card.zone)) {
    throw new Error(
      `card ${card.cardNumber} has no readable zone (zone=${JSON.stringify(card.zone)})`,
    );
  }
  if (!isReadableCount(card.count)) {
    throw new Error(
      `card ${card.cardNumber} has no readable copy count (count=${JSON.stringify(card.count)})`,
    );
  }
  if (!isReadableVersion(card.version)) {
    throw new Error(
      `card ${card.cardNumber} has no readable version (version=${JSON.stringify(card.version)})`,
    );
  }
}

export function normalizeCards(
  cards: DeckCardRef[] | undefined,
  catalogCardNumbers?: ReadonlySet<string> | null,
): {
  cards: DeckCardRef[];
  verified: boolean;
  failure: string | null;
} {
  // No card list at all is an honest unknown (the source published no cards).
  // A list that HAS entries must be readable in full: every slot is validated as
  // published, and a single unreadable one throws rather than being dropped or
  // repaired (DIC-1024: fail validation, never guess).
  if (!cards || cards.length === 0) return { cards: [], verified: false, failure: null };
  const clean = cards.map((c, i) => {
    assertReadableSlot(c, i);
    return {
      zone: c.zone,
      cardNumber: c.cardNumber,
      // version stays null when not supplied — never inferred from a
      // same-named/same-numbered printing.
      version: c.version ?? null,
      count: c.count,
    };
  });
  // A non-empty list is NOT evidence of a complete deck. Every card list —
  // freshly fetched or read back from a committed last-known-good source —
  // goes through the same strict gate, so a truncated, duplicate-slot or
  // catalog-invalid list can never be emitted as verified (DIC-1029).
  if (!catalogCardNumbers) {
    return {
      cards: clean,
      verified: false,
      failure: 'no card catalog supplied; cannot verify catalog membership',
    };
  }
  const { cardsVerified, failure } = verifyDeckCards(clean, catalogCardNumbers);
  return { cards: clean, verified: cardsVerified, failure };
}

export function normalizeDeck(
  raw: RawDeckRecord,
  eventId: string,
  sourceUrl: string,
  index: number,
  fetchedAt: string,
  catalogCardNumbers?: ReadonlySet<string> | null,
): DeckEntry {
  const { cards, verified } = normalizeCards(raw.cards, catalogCardNumbers);
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
    // block/deckName are only emitted when the source states them, so older
    // months (which never carried them) stay byte-identical instead of picking
    // up a null-key migration.
    ...(raw.block != null ? { block: raw.block } : {}),
    ...(raw.deckName != null ? { deckName: raw.deckName } : {}),
    archetypeId: raw.archetypeId ?? null,
    archetypeLabel: raw.archetypeLabel ?? null,
    oshi: raw.oshi ?? null,
    colors: Array.isArray(raw.colors) ? raw.colors : [],
    cards,
    cardsVerified: verified,
    coverage,
    fetchedAt,
  };
}

export function normalizeEvent(
  raw: RawEventRecord,
  fetchedAt: string,
  catalogCardNumbers?: ReadonlySet<string> | null,
): TournamentEvent {
  const eventId =
    raw.eventId ||
    raw.eventSlug ||
    `${slugify(raw.name)}${raw.date ? `_${raw.date}` : ''}`;

  const decks = dedupeDecks(
    (raw.decks ?? []).map((d, i) =>
      normalizeDeck(d, eventId, raw.sourceUrl, i, fetchedAt, catalogCardNumbers),
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
  // Official card numbers used to gate `cardsVerified` for raw events. Omitted
  // → raw card lists stay unverified (fail closed).
  catalogCardNumbers?: ReadonlySet<string> | null;
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
    isRaw(e) ? normalizeEvent(e, fetchedAt, opts.catalogCardNumbers) : e,
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

// ── Deck Log live import (DIC-1024) ─────────────────────────────────────────
// Deck Log (decklog.bushiroad.com) is the public Bushiroad deck-sharing site
// behind the /view/{code} SPA. Its public view API — POST
// /system/app/api/view/{code} with same-origin headers — returns the deck as
// JSON with three card lists: p_list (推しホロメン), list (主牌組) and
// sub_list (エールデッキ). Which list a card came from IS its zone, so zone is
// source-proven, never inferred. Only normalized fields (zone/cardNumber/
// version/count) survive the import — Deck Log's raw response fields (img,
// p_param, width, height, …) are never stored or republished.
//
// The functions below are pure so the collector and the fixture tests exercise
// exactly the same code path with no network.

export interface DecklogApiCard {
  card_number?: string;
  num?: number;
  type?: number;
  rare?: string | null;
}

export interface DecklogApiDeck {
  id?: number;
  deck_id?: string;
  title?: string | null;
  status?: number;
  game_title_id?: number;
  list?: DecklogApiCard[] | null;
  sub_list?: DecklogApiCard[] | null;
  p_list?: DecklogApiCard[] | null;
}

// Deck Log's numeric game id for hololive OFFICIAL CARD GAME (confirmed against
// a live public deck: /system/app/api/view/5USA7 returns game_title_id 9).
export const HOCG_DECKLOG_GAME_TITLE_ID = 9;

// Zone comes from which Deck Log list the card was published in — the same
// lists the deck editor renders as 推し / 主牌組 / エール. The numeric `type`
// field is checked as a cross-signal only and must agree.
const ZONE_BY_DECKLOG_LIST: Array<{ key: keyof DecklogApiDeck; zone: DeckZone; type: number }> = [
  { key: 'p_list', zone: 'oshi', type: 3 },
  { key: 'list', zone: 'main', type: 1 },
  { key: 'sub_list', zone: 'yell', type: 2 },
];

export function zoneFromDecklogList(
  listKey: keyof DecklogApiDeck | string,
): DeckZone | null {
  const match = ZONE_BY_DECKLOG_LIST.find((z) => z.key === listKey);
  return match ? match.zone : null;
}

/** Map a Deck Log view-API response into normalized, zoned deck cards. Throws on
 * the first unreadable slot (missing card number, unreadable copy count, or a
 * list/type mismatch) so a half-parsed deck can never silently become a
 * "verified" one. */
export function cardsFromDecklog(deck: DecklogApiDeck | null | undefined): DeckCardRef[] {
  if (!deck) throw new Error('empty Deck Log response');
  const out: DeckCardRef[] = [];
  for (const { key, zone, type } of ZONE_BY_DECKLOG_LIST) {
    for (const raw of (deck[key] as DecklogApiCard[] | null) ?? []) {
      const cardNumber = String(raw.card_number ?? '').trim();
      if (!cardNumber) {
        throw new Error(`Deck Log ${String(key)} slot has no card number`);
      }
      if (typeof raw.type === 'number' && raw.type !== type) {
        throw new Error(
          `Deck Log ${String(key)} slot ${cardNumber} has type ${raw.type}, expected ${type}`,
        );
      }
      // An unreadable copy count is an extraction failure like any other: it is
      // never defaulted to 1, or a partially readable response could be
      // persisted as a legal-looking deck.
      if (!isReadableCount(raw.num)) {
        throw new Error(
          `Deck Log ${String(key)} slot ${cardNumber} has no readable copy count (num=${JSON.stringify(raw.num)})`,
        );
      }
      out.push({
        zone,
        cardNumber,
        version: (raw.rare ?? '').trim() || null,
        count: raw.num,
      });
    }
  }
  return out;
}

// Official hOCG deck composition: exactly 1 推し / 50 main / 20 yell (DIC-943,
// enforced here only when the source published full card data).
export const REQUIRED_DECK_TOTALS: Readonly<Record<DeckZone, number>> = {
  oshi: 1,
  main: 50,
  yell: 20,
};

export interface ZoneTotals {
  oshi: number;
  main: number;
  yell: number;
}

export function totalsByZone(cards: DeckCardRef[]): ZoneTotals {
  const totals: ZoneTotals = { oshi: 0, main: 0, yell: 0 };
  for (const c of cards) totals[c.zone] += c.count;
  return totals;
}

/** Cards that repeat a cardNumber inside the SAME zone. Copies of the same
 * card number are legal across zones (e.g. the same card number can exist in
 * main and in a different printing) — what is not legal is one zone listing the
 * same number twice. */
export function duplicateSlotsWithinZone(cards: DeckCardRef[]): DeckCardRef[] {
  const seen = new Set<string>();
  const dups: DeckCardRef[] = [];
  for (const c of cards) {
    const key = `${c.zone}:${c.cardNumber}`;
    if (seen.has(key)) dups.push(c);
    seen.add(key);
  }
  return dups;
}

export function validateDeckTotals(cards: DeckCardRef[]): {
  ok: boolean;
  totals: ZoneTotals;
  failure: string | null;
} {
  const totals = totalsByZone(cards);
  const ok =
    totals.oshi === REQUIRED_DECK_TOTALS.oshi &&
    totals.main === REQUIRED_DECK_TOTALS.main &&
    totals.yell === REQUIRED_DECK_TOTALS.yell;
  return {
    ok,
    totals,
    failure: ok
      ? null
      : `deck totals must be 1 oshi / 50 main / 20 yell, got ${totals.oshi}/${totals.main}/${totals.yell}`,
  };
}

/** Fail-closed gate a deck's fetched cards must pass before it may claim
 * `cardsVerified`. Reports the FIRST single failing slot — never a guess. */
export function verifyDeckCards(
  cards: DeckCardRef[],
  catalogCardNumbers: ReadonlySet<string>,
): { cardsVerified: boolean; totals: ZoneTotals; failure: string | null } {
  const totals = totalsByZone(cards);
  const totalCheck = validateDeckTotals(cards);
  if (!totalCheck.ok) return { cardsVerified: false, totals, failure: totalCheck.failure };
  const dups = duplicateSlotsWithinZone(cards);
  if (dups.length > 0) {
    return {
      cardsVerified: false,
      totals,
      failure: `duplicate card slot within zone: ${dups[0].zone}:${dups[0].cardNumber}`,
    };
  }
  for (const c of cards) {
    if (!catalogCardNumbers.has(c.cardNumber)) {
      return {
        cardsVerified: false,
        totals,
        failure: `card not found in local official catalog: ${c.cardNumber}`,
      };
    }
  }
  return { cardsVerified: true, totals, failure: null };
}

/**
 * Source freshness discovery (issue requirement 6). The collector checks the
 * newest official publication date it can reach (WordPress news feed / X result
 * tweet) against the newest source record it already has. A strictly newer
 * discovery is an ALERT, never an auto-collect — a new source post still needs
 * human/agent verification before its decks are parsed. When discovery is
 * unavailable the last-known-good data is simply preserved.
 */
export type FreshnessVerdict = 'newer' | 'same' | 'older' | 'unknown';

export function classifyFreshness(
  discoveredDateISO: string | null | undefined,
  knownDateISO: string | null | undefined,
): FreshnessVerdict {
  if (!discoveredDateISO) return 'unknown';
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(discoveredDateISO.trim());
  const k = /^(\d{4}-\d{2}-\d{2})/.exec((knownDateISO ?? '').trim());
  if (!d) return 'unknown';
  if (!k) return 'newer';
  if (d[1] === k[1]) return 'same';
  return d[1] > k[1] ? 'newer' : 'older';
}
