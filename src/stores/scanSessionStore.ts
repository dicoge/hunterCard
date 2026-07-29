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
import {
  PriceVersion,
  buildPriceVersions,
  resolveVersionForCard,
} from '../utils/versionAlignment';

// Re-export shared version-alignment helpers so existing import sites keep working.
export { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
export type { PriceVersion, VersionResolution } from '../utils/versionAlignment';

export interface SessionCard extends CardInfo {
  instanceId: string;
  scannedAt: string;
  priceVersions: PriceVersion[];
  selectedVersion: number;
}

/**
 * 預估清單用的預設版本 index。
 * 能唯一對齊 rarity → 用對齊結果；無法唯一對齊時，預估流程採保守預設（等於 sellPrice 的那筆，
 * 避免高估連續掃描總價），使用者仍可在面板逐張改選正確版本。
 */
export function pickDefaultVersion(card: CardInfo, versions: PriceVersion[]): number {
  const resolution = resolveVersionForCard(card, versions);
  if (resolution.confident) return resolution.index;
  const spIdx = versions.findIndex(v => v.sellPrice === card.sellPrice);
  if (spIdx >= 0) return spIdx;
  return 0;
}

export function getEffectivePrice(card: SessionCard): number | null {
  const v = card.priceVersions?.[card.selectedVersion];
  if (v) return v.sellPrice;
  return card.sellPrice ?? null;
}

function computeTotal(cards: SessionCard[]): number {
  return cards.reduce((sum, c) => sum + (getEffectivePrice(c) || 0), 0);
}

function makeInstanceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ScanSessionState {
  cards: SessionCard[];
  totalValue: number;
  cardCount: number;
  isSessionActive: boolean;

  lastScanKey: string | null;
  lastScanAt: number | null;

  addCard: (card: CardInfo, options?: { force?: boolean }) => boolean;
  removeCard: (instanceId: string) => void;
  setCardVersion: (instanceId: string, versionIndex: number) => void;
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

        if (!options?.force && isDuplicateScan(lastScanKey, lastScanAt, key, now, SCAN_DEDUP_WINDOW_MS)) {
          set({ lastScanAt: now });
          return false;
        }

        const priceVersions = buildPriceVersions(card);
        const selectedVersion = pickDefaultVersion(card, priceVersions);
        const sessionCard: SessionCard = {
          ...card,
          instanceId: makeInstanceId(),
          scannedAt: new Date(now).toISOString(),
          priceVersions,
          selectedVersion,
        };
        const newCards = [...cards, sessionCard];
        set({
          cards: newCards,
          totalValue: computeTotal(newCards),
          cardCount: newCards.length,
          isSessionActive: true,
          lastScanKey: key,
          lastScanAt: now,
        });
        return true;
      },

      removeCard: (instanceId: string) => {
        const { cards } = get();
        const newCards = cards.filter(c => c.instanceId !== instanceId);
        set({
          cards: newCards,
          totalValue: computeTotal(newCards),
          cardCount: newCards.length,
          isSessionActive: newCards.length > 0,
        });
      },

      setCardVersion: (instanceId: string, versionIndex: number) => {
        const { cards } = get();
        const newCards = cards.map(c =>
          c.instanceId === instanceId &&
          versionIndex >= 0 &&
          versionIndex < c.priceVersions.length
            ? { ...c, selectedVersion: versionIndex }
            : c
        );
        set({ cards: newCards, totalValue: computeTotal(newCards) });
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
      version: 1,
      storage: createJSONStorage(() => platformStorage),
      migrate: () => ({
        cards: [],
        totalValue: 0,
        cardCount: 0,
        isSessionActive: false,
      }),
      partialize: (state) => ({
        cards: state.cards,
        totalValue: state.totalValue,
        cardCount: state.cardCount,
        isSessionActive: state.isSessionActive,
      }),
    }
  )
);
