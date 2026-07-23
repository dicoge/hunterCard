/**
 * Trend Store (Zustand)
 *
 * 管理價格趨勢預測資料的載入與快取
 * 非持久化（趨勢資料每天更新，不需要離線保留）
 */

import { create } from 'zustand';

// ── 類型定義 ──

export type TrendDirection = 'up' | 'down' | 'stable';

export interface TrendPrediction {
  cardId: string;
  name: string;
  nameZh?: string;
  trend: TrendDirection;
  score: number;          // -1.0 ~ 1.0
  confidence: number;     // 0.0 ~ 1.0
  confidenceLevel?: 'low' | 'medium' | 'high';
  lowConfidence?: boolean; // 資料混版/不足，trendScore 不可信
  priceRange?: number;     // max/min 價格比，> 5 代表可能混版
  components: {
    priceTrend: number;
    ytTrend: number;
    newsSentiment: number;
  };
  lastUpdated: string;
  dataPoints: number;
}

export interface TrendSummary {
  up: number;
  down: number;
  stable: number;
}

export interface TopMover {
  cardId: string;
  name: string;
  nameZh?: string;
  score: number;
  trend: TrendDirection;
}

export interface TrendIndex {
  lastUpdated: string;
  totalCards: number;
  summary: TrendSummary;
  topGainers: TopMover[];
  topLosers: TopMover[];
}

// ── Store 介面 ──

interface TrendState {
  // Data
  trends: Record<string, TrendPrediction>;
  index: TrendIndex | null;

  // Loading state
  isLoadingTrends: boolean;
  isLoadingIndex: boolean;
  error: string | null;

  // Actions
  fetchTrendIndex: () => Promise<void>;
  fetchTrendForCard: (cardId: string) => Promise<TrendPrediction | null>;
  getTrendForCard: (cardId: string) => TrendPrediction | null;
  clearTrends: () => void;
}

// ── Store ──

export const useTrendStore = create<TrendState>((set, get) => ({
  // Initial state
  trends: {},
  index: null,
  isLoadingTrends: false,
  isLoadingIndex: false,
  error: null,

  // ── Actions ──

  fetchTrendIndex: async () => {
    set({ isLoadingIndex: true, error: null });
    try {
      const response = await fetch('/data/trends/index.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const index: TrendIndex = await response.json();
      set({ index, isLoadingIndex: false });
    } catch (err) {
      set({
        isLoadingIndex: false,
        error: err instanceof Error ? err.message : 'Failed to load trend index',
      });
    }
  },

  fetchTrendForCard: async (cardId: string) => {
    // Check cache first
    const cached = get().trends[cardId];
    if (cached) return cached;

    set({ isLoadingTrends: true, error: null });
    try {
      const safeId = cardId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const response = await fetch(`/data/trends/${safeId}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const trend: TrendPrediction = await response.json();
      set(state => ({
        trends: { ...state.trends, [cardId]: trend },
        isLoadingTrends: false,
      }));

      return trend;
    } catch (err) {
      set({ isLoadingTrends: false });
      return null;
    }
  },

  getTrendForCard: (cardId: string) => {
    return get().trends[cardId] || null;
  },

  clearTrends: () => {
    set({ trends: {}, index: null, error: null });
  },
}));
