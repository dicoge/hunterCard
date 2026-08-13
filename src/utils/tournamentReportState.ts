import type { MonthlyReport, TournamentIndex } from '../types/tournament';

export interface TournamentReportState {
  index: TournamentIndex | null;
  month: string | null;
  report: MonthlyReport | null;
  loading: boolean;
  error: string | null;
}

export type TournamentReportAction =
  | { type: 'index-loaded'; index: TournamentIndex }
  | { type: 'index-failed'; message: string }
  | { type: 'select-month'; month: string }
  | { type: 'report-loaded'; month: string; report: MonthlyReport }
  | { type: 'report-failed'; month: string; message: string };

export const initialTournamentReportState: TournamentReportState = {
  index: null,
  month: null,
  report: null,
  loading: true,
  error: null,
};

// Invariant enforced here: `report` is either null or belongs to `month`. A
// failed or late response for any other month can never reach the render tree.
export function tournamentReportReducer(
  state: TournamentReportState,
  action: TournamentReportAction,
): TournamentReportState {
  switch (action.type) {
    case 'index-loaded': {
      const month = action.index.months[0]?.month ?? null;
      return {
        index: action.index,
        month,
        report: null,
        loading: month != null,
        error: month == null ? '目前沒有可用的賽事月報資料。' : null,
      };
    }
    case 'index-failed':
      return { ...state, loading: false, error: action.message };
    case 'select-month':
      if (action.month === state.month) return state;
      return { ...state, month: action.month, report: null, loading: true, error: null };
    case 'report-loaded':
      if (action.month !== state.month) return state;
      return { ...state, report: action.report, loading: false, error: null };
    case 'report-failed':
      if (action.month !== state.month) return state;
      return { ...state, report: null, loading: false, error: action.message };
    default:
      return state;
  }
}
