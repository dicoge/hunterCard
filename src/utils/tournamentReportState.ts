import type { MonthlyReport, TournamentIndex } from '../types/tournament';
import { ALL_SCOPE, type DonutScope } from './tournamentDonut';

// The screen holds every month the index lists, keyed by its own month, so the
// 'all' scope can aggregate them (DIC-1066). Storing per month rather than in a
// single `report` slot is what makes a stale render impossible: a response is
// only ever written under the month it was requested for, and the view reads
// only the months its current scope names.
export interface TournamentReportState {
  index: TournamentIndex | null;
  scope: DonutScope;
  reports: Record<string, MonthlyReport>;
  /** Months requested but not yet resolved. */
  pending: string[];
  /** Per-month load failure messages. */
  failed: Record<string, string>;
  /** True until the index itself resolves. */
  loading: boolean;
  error: string | null;
}

export type TournamentReportAction =
  | { type: 'index-loaded'; index: TournamentIndex }
  | { type: 'index-failed'; message: string }
  | { type: 'select-scope'; scope: DonutScope }
  | { type: 'report-loaded'; month: string; report: MonthlyReport }
  | { type: 'report-failed'; month: string; message: string };

/**
 * The most months the screen will ever request or keep resident. The index gains
 * one file every month and never drops one, so an unbounded 'all' scope would
 * issue an ever-growing burst of requests on mount and retain the whole archive
 * in memory. The window is a rolling one over the newest months, so a new month
 * still needs no code change — it simply enters the window and the oldest leaves.
 */
export const MAX_SCOPE_MONTHS = 12;

/** Report fetches allowed in flight at once, so a full window opens a bounded
 * number of sockets rather than one per month simultaneously. */
export const MAX_CONCURRENT_REPORT_LOADS = 4;

/** Every month this screen may touch: the newest MAX_SCOPE_MONTHS the index
 * lists. Sorted here rather than trusting index order, so the window is the same
 * set no matter how the file happens to be written. */
export function scopeWindow(index: TournamentIndex | null): string[] {
  return (index?.months ?? [])
    .map((m) => m.month)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, MAX_SCOPE_MONTHS);
}

/** Months the index lists but the window excludes. Non-empty means 'all' is not
 * literally all, and the screen has to say so. */
export function omittedMonths(state: TournamentReportState): string[] {
  const kept = new Set(scopeWindow(state.index));
  return (state.index?.months ?? [])
    .map((m) => m.month)
    .filter((m) => !kept.has(m))
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Runs `worker` over `items` with at most `limit` in flight. Rejections are the
 * worker's business — it is expected to dispatch its own failure action, so one
 * bad month cannot abort the rest of the window.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export const initialTournamentReportState: TournamentReportState = {
  index: null,
  scope: ALL_SCOPE,
  reports: {},
  pending: [],
  failed: {},
  loading: true,
  error: null,
};

export function tournamentReportReducer(
  state: TournamentReportState,
  action: TournamentReportAction,
): TournamentReportState {
  switch (action.type) {
    case 'index-loaded': {
      // Only the window is ever pending, and `report-loaded` refuses anything
      // not pending — so `reports` cannot grow past MAX_SCOPE_MONTHS entries.
      const months = scopeWindow(action.index);
      return {
        index: action.index,
        scope: ALL_SCOPE,
        reports: {},
        pending: months,
        failed: {},
        loading: false,
        error: months.length === 0 ? '目前沒有可用的賽事月報資料。' : null,
      };
    }
    case 'index-failed':
      return { ...state, loading: false, error: action.message };
    case 'select-scope':
      if (action.scope === state.scope) return state;
      return { ...state, scope: action.scope };
    case 'report-loaded': {
      // A month the index never listed is not part of this view.
      if (!state.pending.includes(action.month)) return state;
      return {
        ...state,
        reports: { ...state.reports, [action.month]: action.report },
        pending: state.pending.filter((m) => m !== action.month),
      };
    }
    case 'report-failed': {
      if (!state.pending.includes(action.month)) return state;
      return {
        ...state,
        failed: { ...state.failed, [action.month]: action.message },
        pending: state.pending.filter((m) => m !== action.month),
      };
    }
    default:
      return state;
  }
}

/** Months the current scope covers, newest first. Always a subset of the
 * window, so no scope can request or read a month outside it. */
export function monthsInScope(state: TournamentReportState): string[] {
  const all = scopeWindow(state.index);
  return state.scope === ALL_SCOPE ? all : all.filter((m) => m === state.scope);
}

/**
 * Months in scope that contribute no data — still loading, or failed. The screen
 * must name these: rendering the months that happened to load while the heading
 * still says "all months" would present a subset as the complete sample, which
 * is the one thing this chart may not do.
 */
export function incompleteMonths(state: TournamentReportState): {
  pending: string[];
  failed: string[];
} {
  const months = monthsInScope(state);
  return {
    pending: months.filter((m) => state.pending.includes(m)),
    failed: months.filter((m) => state.failed[m] != null),
  };
}

/** True when the rendered sample is missing months the scope claims to cover,
 * whether because they failed, are still loading, or fell outside the window. */
export function scopeIsPartial(state: TournamentReportState): boolean {
  const { pending, failed } = incompleteMonths(state);
  const windowGap = state.scope === ALL_SCOPE && omittedMonths(state).length > 0;
  return pending.length > 0 || failed.length > 0 || windowGap;
}

/** Loaded reports for the current scope. Months still pending or failed are
 * simply absent — never substituted with another month's data. */
export function reportsInScope(state: TournamentReportState): MonthlyReport[] {
  return monthsInScope(state)
    .map((m) => state.reports[m])
    .filter((r): r is MonthlyReport => r != null);
}

export function scopeLoading(state: TournamentReportState): boolean {
  if (state.loading) return true;
  return monthsInScope(state).some((m) => state.pending.includes(m));
}

/** The message to show instead of a chart: the index error, or the failure of
 * every month in scope. A partially loaded 'all' scope renders what it has. */
export function scopeError(state: TournamentReportState): string | null {
  if (state.error) return state.error;
  const months = monthsInScope(state);
  if (months.length === 0) return null;
  const resolved = months.filter((m) => !state.pending.includes(m));
  if (resolved.length === 0) return null;
  const failures = resolved.filter((m) => state.failed[m] != null);
  if (failures.length < resolved.length) return null;
  return failures.length === 1
    ? state.failed[failures[0]]
    : '無法載入賽事月報資料。';
}
