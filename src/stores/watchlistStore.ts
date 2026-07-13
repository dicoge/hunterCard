/**
 * Watchlist Store (Zustand + persistent)
 *
 * 入手提醒的本機 watchlist：用戶追蹤想入手的卡牌清單。
 * Persisted via platform-specific storage (localStorage / AsyncStorage).
 *
 * Usage:
 *   const { items, addCard, removeCard, isInWatchlist } = useWatchlistStore();
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';

export interface WatchlistItem {
  cardNumber: string;   // e.g. "hBP01-075"
  name: string;
  nameZh?: string;
  rarity: string;
  imageUrl?: string;
  addedAt: string;      // ISO date
  targetPrice?: number; // 可選：用戶設定的目標入手價
}

interface WatchlistStore {
  items: WatchlistItem[];
  addCard: (card: WatchlistItem) => void;
  removeCard: (cardNumber: string) => void;
  isInWatchlist: (cardNumber: string) => boolean;
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set, get) => ({
      items: [],

      addCard: (card) => {
        const { items } = get();
        if (items.some((item) => item.cardNumber === card.cardNumber)) return;
        set({ items: [...items, { ...card, addedAt: card.addedAt || new Date().toISOString() }] });
      },

      removeCard: (cardNumber) => {
        set((state) => ({
          items: state.items.filter((item) => item.cardNumber !== cardNumber),
        }));
      },

      isInWatchlist: (cardNumber) => {
        return get().items.some((item) => item.cardNumber === cardNumber);
      },
    }),
    {
      name: 'watchlist-storage',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);
