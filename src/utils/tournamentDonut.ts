// Pure model + geometry for the observed-sample donut chart (DIC-1066).
//
// Kept free of React, I/O and wall-clock reads so the fixture tests exercise
// exactly what the screen renders.
//
// Honesty invariants (same contract as src/utils/tournamentReport.ts):
//   • The denominator is the PUBLISHED VERIFIED sample only — decks whose card
//     list was actually read and validated (`cardsVerified`). A deck the source
//     only name-dropped is not a sample; it is never counted, and the chart is
//     never labeled as overall tournament share.
//   • Unknown stays unknown: a deck with no archetype/oshi becomes its own
//     explicit slice, never folded into a named one.
//   • Nothing about unobserved entrants is inferred. Sample sizes come from the
//     data files, never from a constant.

import { dedupeDecks, UNKNOWN_ARCHETYPE_LABEL } from './tournamentReport';
import type {
  ArchetypeShareRow,
  DeckEntry,
  MonthlyReport,
  TournamentEvent,
} from '../types/tournament';

/** Scope covering every verified month at once — the default view. */
export const ALL_SCOPE = 'all';
/** `'all'` or a 'YYYY-MM' key. Any month present in the index works, so a new
 * month needs no code change. */
export type DonutScope = string;

/** What the donut groups by. Both dimensions are published per deck, so neither
 * requires inference; anything that would (e.g. splitting a multi-color deck
 * across color slices) is deliberately absent. */
export type DonutDimension = 'archetype' | 'oshi';

/** Below this a sample is too thin to read as a trend and must say so. */
export const SMALL_SAMPLE_MIN = 3;

/** Slice identity for "the source published no archetype/oshi here". */
export const UNKNOWN_SLICE_KEY = '__unknown__';

// Deterministic palette. The unknown slice always takes the muted gray so it
// reads as a gap rather than a real deck theme.
export const SLICE_COLORS = [
  '#ff6b9d',
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
  '#eab308',
] as const;
export const UNKNOWN_COLOR = '#4b5563';

export function sliceKeyOf(id: string | null): string {
  return id ?? UNKNOWN_SLICE_KEY;
}

/** Which slice a deck belongs to under the given dimension. */
export function deckSliceKey(deck: DeckEntry, dimension: DonutDimension): string {
  return sliceKeyOf(dimension === 'oshi' ? deck.oshi : deck.archetypeId);
}

/** The published verified sample: decks whose card list passed the fail-closed
 * gate. De-duped by deckId so an 'all' scope can never double-count a deck that
 * appears in two month files.
 *
 * The `=== true` is load-bearing, not style. These reports are fetched JSON that
 * is only type-cast, never runtime-validated, so `cardsVerified` can arrive as
 * the string "false", a number, or an object. Under truthiness every one of
 * those would enter the published sample and inflate the denominator — the exact
 * claim this chart is not allowed to get wrong. Anything that is not the boolean
 * true is treated as unverified. */
export function verifiedDecks(events: readonly TournamentEvent[]): DeckEntry[] {
  return dedupeDecks(events.flatMap((e) => e.decks).filter((d) => d.cardsVerified === true));
}

export function reportsForScope(
  reports: readonly MonthlyReport[],
  scope: DonutScope,
): MonthlyReport[] {
  if (scope === ALL_SCOPE) return [...reports];
  return reports.filter((r) => r.month === scope);
}

/**
 * Share rows for one dimension over an explicit deck sample. Same shape, order
 * and unknown handling as computeArchetypeShare (which stays the single
 * implementation for the archetype dimension over a whole report) — the
 * regression test asserts the two agree on identical input.
 */
export function computeShareRows(
  decks: readonly DeckEntry[],
  dimension: DonutDimension,
): ArchetypeShareRow[] {
  const total = decks.length;
  if (total === 0) return [];

  const counts = new Map<string, { label: string; count: number }>();
  let unknown = 0;
  for (const d of decks) {
    const id = dimension === 'oshi' ? d.oshi : d.archetypeId;
    if (id == null) {
      unknown += 1;
      continue;
    }
    const cur = counts.get(id);
    if (cur) cur.count += 1;
    else counts.set(id, { label: dimension === 'oshi' ? id : d.archetypeLabel ?? id, count: 1 });
  }

  const rows: ArchetypeShareRow[] = [...counts.entries()]
    .map(([archetypeId, v]) => ({
      archetypeId,
      label: v.label,
      count: v.count,
      share: v.count / total,
    }))
    .sort((a, b) => b.count - a.count || a.archetypeId!.localeCompare(b.archetypeId!));

  if (unknown > 0) {
    rows.push({
      archetypeId: null,
      label: UNKNOWN_ARCHETYPE_LABEL,
      count: unknown,
      share: unknown / total,
    });
  }
  return rows;
}

/**
 * Integer percentages that sum to exactly 100, by largest remainder. Plain
 * per-row rounding drifts (three thirds render as 33/33/33 = 99%), and a legend
 * whose parts do not add up reads as a data error.
 */
export function integerPercents(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c * 100) / total);
  const out = exact.map((v) => Math.floor(v));
  const remainder = 100 - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    // Ties break on index so the same input always produces the same legend.
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remainder; k += 1) out[order[k].i] += 1;
  return out;
}

export interface DonutSlice {
  key: string;
  id: string | null;
  label: string;
  count: number;
  share: number;
  /** Integer percent; all slices sum to exactly 100. */
  percent: number;
  color: string;
}

export interface DonutModel {
  scope: DonutScope;
  dimension: DonutDimension;
  /** Verified decks in scope — the chart's only denominator. */
  sampleSize: number;
  /** Decks the source showcased in scope, verified or not. Always >= sampleSize;
   * shown alongside so a gap between the two is visible rather than implied. */
  observedSize: number;
  slices: DonutSlice[];
  /** A real but too-thin sample. Distinct from sampleSize === 0. */
  smallSample: boolean;
}

export function buildDonutModel(
  reports: readonly MonthlyReport[],
  scope: DonutScope,
  dimension: DonutDimension,
): DonutModel {
  const inScope = reportsForScope(reports, scope);
  const events = inScope.flatMap((r) => r.events);
  const observed = dedupeDecks(events.flatMap((e) => e.decks));
  const sample = verifiedDecks(events);
  const rows = computeShareRows(sample, dimension);
  const percents = integerPercents(rows.map((r) => r.count));

  return {
    scope,
    dimension,
    sampleSize: sample.length,
    observedSize: observed.length,
    slices: rows.map((r, i) => ({
      key: sliceKeyOf(r.archetypeId),
      id: r.archetypeId,
      label: r.label,
      count: r.count,
      share: r.share,
      percent: percents[i],
      color: r.archetypeId == null ? UNKNOWN_COLOR : SLICE_COLORS[i % SLICE_COLORS.length],
    })),
    smallSample: sample.length > 0 && sample.length < SMALL_SAMPLE_MIN,
  };
}

/**
 * One drawable wedge. Angles are degrees clockwise from 12 o'clock. A sweep
 * wider than a half turn is split in two, because the renderer draws a wedge by
 * intersecting a half-disc with a half-plane and so cannot express one.
 */
export interface DonutArc {
  key: string;
  sliceKey: string;
  color: string;
  startAngle: number;
  sweep: number;
}

export const MAX_ARC_SWEEP = 180;

export function donutArcs(slices: readonly DonutSlice[]): DonutArc[] {
  const total = slices.reduce((n, s) => n + s.count, 0);
  if (total <= 0) return [];
  const arcs: DonutArc[] = [];
  let acc = 0;
  for (const s of slices) {
    // Angles come from the running count, not from summed floats, so the last
    // wedge lands exactly on 360 and no seam appears.
    const start = (acc * 360) / total;
    acc += s.count;
    const sweep = (acc * 360) / total - start;
    if (sweep <= 0) continue;
    if (sweep > MAX_ARC_SWEEP) {
      const half = sweep / 2;
      arcs.push({ key: `${s.key}#0`, sliceKey: s.key, color: s.color, startAngle: start, sweep: half });
      arcs.push({
        key: `${s.key}#1`,
        sliceKey: s.key,
        color: s.color,
        startAngle: start + half,
        sweep: half,
      });
    } else {
      arcs.push({ key: `${s.key}#0`, sliceKey: s.key, color: s.color, startAngle: start, sweep });
    }
  }
  return arcs;
}

/**
 * Events narrowed to the decks of one slice, for the list under the chart.
 * A null selection is "no filter". Events left with no matching deck drop out
 * rather than rendering as empty cards.
 */
export function filterEventsBySlice(
  events: readonly TournamentEvent[],
  sliceKey: string | null,
  dimension: DonutDimension,
): TournamentEvent[] {
  if (sliceKey == null) return [...events];
  return events
    .map((e) => ({ ...e, decks: e.decks.filter((d) => deckSliceKey(d, dimension) === sliceKey) }))
    .filter((e) => e.decks.length > 0);
}
