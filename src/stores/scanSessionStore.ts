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
import type { CardInfo } from '../services/cardRecognition';
import { dedupKey, isDuplicateScan, SCAN_DEDUP_WINDOW_MS } from '../utils/scanDedup';
import { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
import type { PriceVersion } from '../utils/versionAlignment';
import {
  MAX_SCAN_PRICE_VERSIONS,
  MAX_SCAN_SESSION_ENTRIES,
  MAX_SCAN_TEXT,
  MAX_SCAN_URL,
  type SyncScanEntry,
  type SyncScanSession,
} from '../utils/scanSessionSync';

// Re-export shared version-alignment helpers so existing import sites keep working.
export { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
export type { PriceVersion, VersionResolution } from '../utils/versionAlignment';

export interface SessionCard extends CardInfo {
  instanceId: string;
  scannedAt: string;
  priceVersions: PriceVersion[];
  selectedVersion: number;
  /** false while the source cannot prove WHICH listing this card is — the same
   * fail-closed state the card page and the deck estimator already honour. */
  versionConfident: boolean;
  /** When the player last picked the version by hand (ISO); sync merge provenance. */
  selectedAt?: string;
}

/**
 * This card's scan value, or null when the source proves no single listing.
 *
 * The dataset really does ship two `白銀ノエル(パラレル)` listings at ¥3,480 and
 * ¥500. Reading `priceVersions[selectedVersion]` regardless would price the scan
 * off whichever listing the scrape happened to emit first, so the same physical
 * card would be worth ¥3,480 or ¥500 depending on source order. Until the player
 * picks a listing the card carries no price and stays out of the total.
 */
export function getEffectivePrice(card: SessionCard): number | null {
  if (!card.versionConfident) return null;
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

  /** Account sync (v41): instanceIds removed here since the last server ack. */
  removals: Record<string, string>;
  /** Account sync (v41): when this list was last cleared (entries scanned at or before are gone). */
  clearedAt: string | null;

  addCard: (card: CardInfo, options?: { force?: boolean }) => boolean;
  removeCard: (instanceId: string) => void;
  setCardVersion: (instanceId: string, versionIndex: number) => void;
  clearSession: () => void;
  startNewSession: () => void;
  /** Replace the list with the account's synced list (hydrate / merge). Not a user change. */
  replaceFromSync: (session: SyncScanSession, opts?: { keepRemovals?: boolean }) => void;
  clearSyncTombstones: () => void;
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
      removals: {},
      clearedAt: null,

      addCard: (card: CardInfo, options?: { force?: boolean }) => {
        const { cards, lastScanKey, lastScanAt } = get();
        const key = dedupKey(card);
        const now = Date.now();

        if (!options?.force && isDuplicateScan(lastScanKey, lastScanAt, key, now, SCAN_DEDUP_WINDOW_MS)) {
          set({ lastScanAt: now });
          return false;
        }

        // 掃描清單的預設版本走與卡片頁、組牌器同一個來源版本解析，三邊不會對同一張卡
        // 給出不同的版本。
        const priceVersions = buildPriceVersions(card);
        const resolution = resolveVersionForCard(priceVersions);
        const sessionCard: SessionCard = {
          ...card,
          instanceId: makeInstanceId(),
          scannedAt: new Date(now).toISOString(),
          priceVersions,
          selectedVersion: Math.max(resolution.index, 0),
          versionConfident: resolution.confident,
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
          removals: { ...get().removals, [instanceId]: new Date().toISOString() },
          cards: newCards,
          totalValue: computeTotal(newCards),
          cardCount: newCards.length,
          isSessionActive: newCards.length > 0,
        });
      },

      // An explicit pick is the player telling us which listing they hold — the
      // one thing that can resolve an ambiguity the source cannot.
      setCardVersion: (instanceId: string, versionIndex: number) => {
        const { cards } = get();
        const newCards = cards.map(c =>
          c.instanceId === instanceId &&
          versionIndex >= 0 &&
          versionIndex < c.priceVersions.length
            ? { ...c, selectedVersion: versionIndex, versionConfident: true, selectedAt: new Date().toISOString() }
            : c
        );
        set({ cards: newCards, totalValue: computeTotal(newCards) });
      },

      clearSession: () => {
        set({
          clearedAt: new Date().toISOString(),
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
          clearedAt: new Date().toISOString(),
          cards: [],
          totalValue: 0,
          cardCount: 0,
          isSessionActive: true,
          lastScanKey: null,
          lastScanAt: null,
        });
      },

      replaceFromSync: (session: SyncScanSession, opts?: { keepRemovals?: boolean }) => {
        const newCards = session.entries.map(fromSyncEntry);
        set({
          cards: newCards,
          totalValue: computeTotal(newCards),
          cardCount: newCards.length,
          isSessionActive: newCards.length > 0,
          clearedAt: session.clearedAt,
          ...(opts?.keepRemovals ? {} : { removals: {} }),
        });
      },

      clearSyncTombstones: () => set({ removals: {} }),
    }),
    {
      name: 'hunterCard-scan-session',
      // v2 adds versionConfident. A v1 card carries no proof of which listing it
      // is, and a scan session is transient working state, so the existing
      // reset-on-migrate contract applies rather than back-filling a guess.
      version: 2,
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
        removals: state.removals,
        clearedAt: state.clearedAt,
      }),
    }
  )
);

const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, max) : undefined;
const price = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The compact, account-sync form of one scanned card (src/utils/scanSessionSync):
 * identity / display fields and the listing prices captured at scan time. Buy-back
 * prices travel only when that surface is enabled (`includeBuyPrice`).
 */
export function toSyncEntry(c: SessionCard, includeBuyPrice: boolean): SyncScanEntry {
  const versions = (c.priceVersions ?? []).slice(0, MAX_SCAN_PRICE_VERSIONS).map((v) => ({
    name: clip(v.name, MAX_SCAN_TEXT) ?? '',
    printing: clip(v.printing, MAX_SCAN_TEXT) ?? '',
    sellPrice: price(v.sellPrice),
    buyPrice: includeBuyPrice ? price(v.buyPrice) : null,
  }));
  const selected = Number.isInteger(c.selectedVersion) && c.selectedVersion >= 0 ? c.selectedVersion : 0;
  const inRange = selected < Math.max(versions.length, 1);
  const image = clip(c.imageUrl, MAX_SCAN_URL);
  return {
    instanceId: c.instanceId,
    scannedAt: c.scannedAt,
    card: {
      id: clip(c.id, MAX_SCAN_TEXT) ?? c.cardNumber,
      cardNumber: clip(c.cardNumber, MAX_SCAN_TEXT) ?? '',
      name: clip(c.name, MAX_SCAN_TEXT) ?? clip(c.cardNumber, MAX_SCAN_TEXT) ?? '',
      ...(clip(c.nameZh, MAX_SCAN_TEXT) ? { nameZh: clip(c.nameZh, MAX_SCAN_TEXT) } : {}),
      ...(clip(c.rarity, MAX_SCAN_TEXT) ? { rarity: clip(c.rarity, MAX_SCAN_TEXT) } : {}),
      ...(clip(c.series, MAX_SCAN_TEXT) ? { series: clip(c.series, MAX_SCAN_TEXT) } : {}),
      ...(image && image.startsWith('https://') ? { imageUrl: image } : {}),
      sellPrice: price(c.sellPrice),
    },
    priceVersions: versions,
    selectedVersion: inRange ? selected : 0,
    versionConfident: inRange ? c.versionConfident === true : false,
    ...(inRange && c.selectedAt && Number.isFinite(Date.parse(c.selectedAt)) ? { selectedAt: c.selectedAt } : {}),
  };
}

/** A synced entry back into a list card (prices are the ones captured at scan time). */
export function fromSyncEntry(e: SyncScanEntry): SessionCard {
  return {
    id: e.card.id,
    name: e.card.name,
    ...(e.card.nameZh ? { nameZh: e.card.nameZh } : {}),
    cardNumber: e.card.cardNumber,
    type: '',
    rarity: e.card.rarity ?? '',
    series: e.card.series ?? '',
    sellPrice: e.card.sellPrice,
    yuyuName: '',
    color: '',
    imageUrl: e.card.imageUrl ?? '',
    instanceId: e.instanceId,
    scannedAt: e.scannedAt,
    priceVersions: e.priceVersions.map((v) => ({ ...v })),
    selectedVersion: e.selectedVersion,
    versionConfident: e.versionConfident,
    ...(e.selectedAt ? { selectedAt: e.selectedAt } : {}),
  };
}

/** The list in account-sync form, newest entries kept when over the cap. */
export function scanSessionForSync(includeBuyPrice: boolean): SyncScanSession {
  const { cards, clearedAt } = useScanSessionStore.getState();
  return {
    entries: cards.slice(-MAX_SCAN_SESSION_ENTRIES).map((c) => toSyncEntry(c, includeBuyPrice)),
    clearedAt: clearedAt ?? null,
  };
}
