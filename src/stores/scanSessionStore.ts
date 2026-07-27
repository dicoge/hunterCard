/**
 * Scan Session Store (Zustand)
 * 管理連續掃描的卡牌清單與總價值
 *
 * Uses platform-specific storage module:
 * - web: localStorage (avoids broken async-storage npm package)
 * - native: AsyncStorage
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';
import { CardInfo } from '../services/cardRecognition';
import { dedupKey, isDuplicateScan, SCAN_DEDUP_WINDOW_MS } from '../utils/scanDedup';

export interface SessionCard extends CardInfo {
  scannedAt: string; // ISO timestamp
}

interface ScanSessionState {
  cards: SessionCard[];
  totalValue: number;
  cardCount: number;
  isSessionActive: boolean;

  // Runtime-only dedup tracking (not persisted)
  lastScanKey: string | null;
  lastScanAt: number | null;

  // Actions
  /**
   * Add a scanned card. Returns true if it was added, false if it was skipped
   * as a short-window duplicate of the previous scan. Pass { force: true } for
   * an explicit user "add one more" of the same card.
   */
  addCard: (card: CardInfo, options?: { force?: boolean }) => boolean;
  removeCard: (cardId: string) => void;
  clearSession: () => void;
  startNewSession: () => void;
}

export const useScanSessionStore = create<ScanSessionState>()(
  persist(
    (set, get) => ({
      cards: [],
      totalValue: 0,
      cardCount: 0,
      isSessionActive: false,
      lastScanKey: null,
      lastScanAt: null,

      addCard: (card: CardInfo, options?: { force?: boolean }) => {
        const { cards, lastScanKey, lastScanAt } = get();
        const key = dedupKey(card);
        const now = Date.now();

        // Skip rapid repeat of the same card unless the user explicitly forces it.
        // Refresh lastScanAt on a blocked attempt so a card held continuously in
        // frame keeps being deduped until it has been absent for the window.
        if (!options?.force && isDuplicateScan(lastScanKey, lastScanAt, key, now, SCAN_DEDUP_WINDOW_MS)) {
          set({ lastScanAt: now });
          return false;
        }

        const sessionCard: SessionCard = {
          ...card,
          scannedAt: new Date(now).toISOString(),
        };
        const newCards = [...cards, sessionCard];
        const total = newCards.reduce((sum, c) => sum + (c.sellPrice || 0), 0);
        set({
          cards: newCards,
          totalValue: total,
          cardCount: newCards.length,
          isSessionActive: true,
          lastScanKey: key,
          lastScanAt: now,
        });
        return true;
      },

      removeCard: (cardId: string) => {
        const { cards } = get();
        const newCards = cards.filter(c => c.id !== cardId);
        const total = newCards.reduce((sum, c) => sum + (c.sellPrice || 0), 0);
        set({
          cards: newCards,
          totalValue: total,
          cardCount: newCards.length,
          isSessionActive: newCards.length > 0,
        });
      },

      clearSession: () => {
        set({
          cards: [],
          totalValue: 0,
          cardCount: 0,
          isSessionActive: false,
          lastScanKey: null,
          lastScanAt: null,
        });
      },

      startNewSession: () => {
        set({
          cards: [],
          totalValue: 0,
          cardCount: 0,
          isSessionActive: true,
          lastScanKey: null,
          lastScanAt: null,
        });
      },
    }),
    {
      name: 'hunterCard-scan-session',
      storage: createJSONStorage(() => platformStorage),
      // Runtime dedup fields (lastScanKey/lastScanAt) are intentionally not persisted.
      partialize: (state) => ({
        cards: state.cards,
        totalValue: state.totalValue,
        cardCount: state.cardCount,
        isSessionActive: state.isSessionActive,
      }),
    }
  )
);