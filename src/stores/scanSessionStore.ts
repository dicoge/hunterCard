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

export interface SessionCard extends CardInfo {
  scannedAt: string; // ISO timestamp
}

interface ScanSessionState {
  cards: SessionCard[];
  totalValue: number;
  cardCount: number;
  isSessionActive: boolean;

  // Actions
  addCard: (card: CardInfo) => void;
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

      addCard: (card: CardInfo) => {
        const { cards } = get();
        const now = Date.now();
        const lastDuplicate = [...cards].reverse().find(c => c.cardNumber === card.cardNumber);
        if (lastDuplicate && now - Date.parse(lastDuplicate.scannedAt) < 5000) {
          return;
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
        });
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
        });
      },

      startNewSession: () => {
        set({
          cards: [],
          totalValue: 0,
          cardCount: 0,
          isSessionActive: true,
        });
      },
    }),
    {
      name: 'hunterCard-scan-session',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);