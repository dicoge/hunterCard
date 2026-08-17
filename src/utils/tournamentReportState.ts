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
      const months = action.index.months.map((m) => m.month);
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

/** Months the current scope covers, newest first (index order). */
export function monthsInScope(state: TournamentReportState): string[] {
  const all = (state.index?.months ?? []).map((m) => m.month);
  return state.scope === ALL_SCOPE ? all : all.filter((m) => m === state.scope);
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
