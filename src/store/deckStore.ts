/**
 * Deck Store (Zustand + persistent, local-only)
 *
 * Holds the player's locally-built decks and their card collection quantities
 * for the deck editor (DIC-945). This is a local-only prototype: everything
 * lives on-device via platformStorage. Cloud sync / sharing is deliberately out
 * of scope and must not block the prototype — see the issue's item 7.
 *
 * Collection is keyed by ownershipKey = `cardNumber|version`, storing an owned
 * quantity (not a boolean) so the gap analysis can compute owned/needed/missing.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import type { Deck, DeckCard, DeckZone, DeckSlot } from '../utils/deckRules';
import { ownershipKey } from '../utils/deckRules';
import { isLegacySlotCard, migrateSlotsToPrintings, normalizeSlotsToLowCost } from '../utils/deckVariants';
import { migrateUnresolvedSlots, type ImportedDeckDraft } from '../utils/tournamentDeckImport';

function newId(): string {
  return `deck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyDeck(name: string): Deck {
  return { id: newId(), name, oshi: [], main: [], yell: [], updatedAt: new Date().toISOString() };
}

function upsertSlot(slots: DeckSlot[], card: DeckCard, delta: number): DeckSlot[] {
  const idx = slots.findIndex((s) => s.card.id === card.id);
  if (idx === -1) {
    if (delta <= 0) return slots;
    return [...slots, { card, qty: delta }];
  }
  const nextQty = slots[idx].qty + delta;
  if (nextQty <= 0) return slots.filter((_, i) => i !== idx);
  const copy = slots.slice();
  copy[idx] = { ...copy[idx], qty: nextQty };
  return copy;
}

interface DeckState {
  decks: Deck[];
  activeDeckId: string | null;
  /** ownershipKey -> owned quantity */
  collection: Record<string, number>;
  /** deck.id -> deletedAt ISO. Tombstone for the 409 merge so a genuine
   *  local delete cannot be resurrected by a concurrent server add
   *  (DIC-1380 W6). Cleared on hydrate + after a successful push. */
  deletedDeckIds: Record<string, string>;
  /** ownershipKey -> updatedAt ISO. Records that this key was written
   *  locally after the last hydrate. The 409 merge uses it to prefer the
   *  LOCAL value (which may be smaller, including 0) over MAX when the
   *  local write is newer than the server snapshot's own updatedAt —
   *  ownership can legitimately decrease (DIC-1380 W6). */
  collectionChangedKeys: Record<string, string>;

  createDeck: (name: string) => string;
  /** Add a NEW independent deck from a tournament import draft (DIC-1033) and
   * make it active. Never overwrites, merges into, or renames an existing deck:
   * repeat imports of the same source deck produce separate copies. */
  importDeck: (draft: ImportedDeckDraft) => string;
  renameDeck: (deckId: string, name: string) => void;
  deleteDeck: (deckId: string) => void;
  setActiveDeck: (deckId: string | null) => void;
  getActiveDeck: () => Deck | null;

  /** add `delta` copies of a card to a zone (negative removes; removes slot at 0) */
  changeCard: (deckId: string, zone: DeckZone, card: DeckCard, delta: number) => void;
  removeCard: (deckId: string, zone: DeckZone, cardId: string) => void;
  /** rewrite every slot onto its low-cost default printing (DIC-1004 §A5).
   * Zones and quantities are preserved; the global collection is never touched. */
  applyLowCostVariants: (deckId: string, index: Map<string, DeckCard>) => void;
  /** move drafts persisted under the pre-DIC-1013 rarity model onto real source
   * printings. Idempotent, runs across every deck once the database is loaded. */
  migrateLegacyPrintings: (index: Map<string, DeckCard>) => void;
  /** move TOURNAMENT decks persisted with DIC-1033's unresolved printings onto
   * their lowest ordinary printing (DIC-1060). Idempotent, tournament-only, and
   * never touches a printing the player picked themselves. */
  migrateTournamentDefaults: (index: Map<string, DeckCard>) => void;

  setOwned: (cardNumber: string, version: string, qty: number) => void;
  /** apply a signed delta to the owned count; clamps at 0 (never negative) */
  adjustOwned: (cardNumber: string, version: string, delta: number) => void;
  getOwned: (cardNumber: string, version: string) => number;

  /** Consumed after a successful push — the server now knows about our
   *  local deletions / decreases (DIC-1380 W6), so tombstones + local-
   *  change stamps can be dropped. Also invoked on hydrate because the
   *  server snapshot becomes the new baseline. */
  clearSyncTombstones: () => void;
}

// Sanitize a raw owned quantity into a non-negative integer. Guards the global
// inventory against zero / negative / fractional / NaN input from +/- controls
// or a rehydrated payload (DIC-978 #8): anything that is not a positive integer
// collapses to 0, which the setters treat as "remove the entry".
function sanitizeQty(qty: number): number {
  const n = Math.floor(Number(qty));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Re-key a persisted collection through the normalized ownershipKey, summing
 * any buckets that collapse together and dropping non-positive/garbage counts.
 * Used by the persist migration (DIC-978 #2). */
function normalizeCollection(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw || {})) {
    const sep = key.indexOf('|');
    const cardNumber = sep === -1 ? key : key.slice(0, sep);
    const version = sep === -1 ? '' : key.slice(sep + 1);
    const qty = sanitizeQty(val as number);
    if (qty <= 0) continue;
    const nk = ownershipKey(cardNumber, version);
    out[nk] = (out[nk] || 0) + qty;
  }
  return out;
}

const ZONES: DeckZone[] = ['oshi', 'main', 'yell'];

export const useDeckStore = create<DeckState>()(
  persist(
    (set, get) => ({
      decks: [],
      activeDeckId: null,
      collection: {},
      deletedDeckIds: {},
      collectionChangedKeys: {},

      createDeck: (name) => {
        const deck = emptyDeck(name.trim() || '新牌組');
        set((s) => {
          const deletedDeckIds = { ...s.deletedDeckIds };
          delete deletedDeckIds[deck.id];
          return { decks: [...s.decks, deck], activeDeckId: deck.id, deletedDeckIds };
        });
        return deck.id;
      },
      importDeck: (draft) => {
        const deck: Deck = {
          id: newId(),
          name: draft.name.trim() || '賽事牌組',
          oshi: draft.oshi,
          main: draft.main,
          yell: draft.yell,
          origin: draft.origin,
          updatedAt: new Date().toISOString(),
        };
        set((s) => {
          const deletedDeckIds = { ...s.deletedDeckIds };
          delete deletedDeckIds[deck.id];
          return { decks: [...s.decks, deck], activeDeckId: deck.id, deletedDeckIds };
        });
        return deck.id;
      },
      renameDeck: (deckId, name) => set((s) => ({
        decks: s.decks.map((d) => d.id === deckId
          ? { ...d, name: name.trim() || d.name, updatedAt: new Date().toISOString() }
          : d),
      })),
      deleteDeck: (deckId) => set((s) => {
        if (!s.decks.some((d) => d.id === deckId)) return {};
        return {
          decks: s.decks.filter((d) => d.id !== deckId),
          activeDeckId: s.activeDeckId === deckId ? null : s.activeDeckId,
          deletedDeckIds: { ...s.deletedDeckIds, [deckId]: new Date().toISOString() },
        };
      }),
      setActiveDeck: (deckId) => set({ activeDeckId: deckId }),
      getActiveDeck: () => {
        const { decks, activeDeckId } = get();
        return decks.find((d) => d.id === activeDeckId) || null;
      },

      changeCard: (deckId, zone, card, delta) => set((s) => ({
        decks: s.decks.map((d) => d.id === deckId
          ? { ...d, [zone]: upsertSlot(d[zone], card, delta), updatedAt: new Date().toISOString() }
          : d),
      })),
      removeCard: (deckId, zone, cardId) => set((s) => ({
        decks: s.decks.map((d) => d.id === deckId
          ? { ...d, [zone]: d[zone].filter((sl) => sl.card.id !== cardId), updatedAt: new Date().toISOString() }
          : d),
      })),
      applyLowCostVariants: (deckId, index) => set((s) => ({
        decks: s.decks.map((d) => d.id === deckId
          ? {
              ...d,
              oshi: normalizeSlotsToLowCost(d.oshi, 'oshi', index),
              main: normalizeSlotsToLowCost(d.main, 'main', index),
              yell: normalizeSlotsToLowCost(d.yell, 'yell', index),
              updatedAt: new Date().toISOString(),
            }
          : d),
      })),

      migrateLegacyPrintings: (index) => set((s) => {
        const pending = s.decks.filter(
          (d) => ZONES.some((z) => d[z].some((slot) => isLegacySlotCard(slot.card))),
        );
        if (pending.length === 0) return {};
        const migrated = new Set(pending.map((d) => d.id));
        return {
          decks: s.decks.map((d) => (migrated.has(d.id)
            ? {
                ...d,
                oshi: migrateSlotsToPrintings(d.oshi, 'oshi', index),
                main: migrateSlotsToPrintings(d.main, 'main', index),
                yell: migrateSlotsToPrintings(d.yell, 'yell', index),
              }
            : d)),
        };
      }),

      // Only decks the tournament import created are eligible: an unresolved
      // printing in a hand-built deck was not put there by this pipeline, so it
      // is left alone. Each zone comes back as the SAME array when nothing in it
      // changed, so an already-migrated store returns no update at all and the
      // editor's load effect cannot re-render itself in a loop.
      migrateTournamentDefaults: (index) => set((s) => {
        let changed = false;
        const decks = s.decks.map((d) => {
          if (d.origin?.kind !== 'tournament') return d;
          const oshi = migrateUnresolvedSlots(d.oshi, 'oshi', index);
          const main = migrateUnresolvedSlots(d.main, 'main', index);
          const yell = migrateUnresolvedSlots(d.yell, 'yell', index);
          if (oshi === d.oshi && main === d.main && yell === d.yell) return d;
          changed = true;
          return { ...d, oshi, main, yell };
        });
        return changed ? { decks } : {};
      }),

      setOwned: (cardNumber, version, qty) => set((s) => {
        const key = ownershipKey(cardNumber, version);
        const next = { ...s.collection };
        const clean = sanitizeQty(qty);
        if (clean <= 0) delete next[key];
        else next[key] = clean;
        return {
          collection: next,
          collectionChangedKeys: { ...s.collectionChangedKeys, [key]: new Date().toISOString() },
        };
      }),
      adjustOwned: (cardNumber, version, delta) => set((s) => {
        const key = ownershipKey(cardNumber, version);
        const next = { ...s.collection };
        const clean = sanitizeQty((next[key] || 0) + delta);
        if (clean <= 0) delete next[key];
        else next[key] = clean;
        return {
          collection: next,
          collectionChangedKeys: { ...s.collectionChangedKeys, [key]: new Date().toISOString() },
        };
      }),
      getOwned: (cardNumber, version) => get().collection[ownershipKey(cardNumber, version)] || 0,

      clearSyncTombstones: () => set({ deletedDeckIds: {}, collectionChangedKeys: {} }),
    }),
    {
      name: 'hunterCard-decks',
      // v1 (DIC-978): the global collection is now keyed by the NORMALIZED
      // ownershipKey. A v0 payload (raw cardNumber|rarity keys) is re-keyed and
      // collision-summed on load so existing on-device inventories carry over.
      //
      // DIC-1013 deliberately does NOT bump this again: deck slots move onto
      // source printings lazily via migrateLegacyPrintings (it needs the card
      // database, which loads async), and collection entries are left untouched
      // — owning `hBP04-005|SEC` does not prove ownership of the plain printing,
      // so re-keying inventory here would fabricate ownership the player never
      // recorded. Legacy entries stay visible and editable in the inventory.
      //
      // v2 (DIC-1139): ownershipKey now folds errata-history tokens out of the
      // printing (`PARALLEL/SIGN/ERRATA-PRE` → `PARALLEL/SIGN`) so the corrected
      // reprint and the pre-errata row share ONE canonical bucket. Re-key any
      // legacy inventory through the new normalizer, summing quantities that
      // collapse together — the player owned the tier, not the shop's audit
      // history, so folded entries add up rather than being dropped.
      // v3 (DIC-1380 W6): persist per-key deletion / change tombstones so
      // the account-sync 409 merge can honor local deletions and inventory
      // decreases across a reload — the tracker is worthless if it evaporates
      // on the very restart that separates the local write from the sync.
      version: 3,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({
        decks: s.decks,
        activeDeckId: s.activeDeckId,
        collection: s.collection,
        deletedDeckIds: s.deletedDeckIds,
        collectionChangedKeys: s.collectionChangedKeys,
      }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<DeckState>;
        if (version < 2) {
          state.collection = normalizeCollection(
            (state.collection as Record<string, unknown>) || {},
          );
        }
        if (version < 3) {
          state.deletedDeckIds = {};
          state.collectionChangedKeys = {};
        }
        if (!state.deletedDeckIds || typeof state.deletedDeckIds !== 'object') {
          state.deletedDeckIds = {};
        }
        if (!state.collectionChangedKeys || typeof state.collectionChangedKeys !== 'object') {
          state.collectionChangedKeys = {};
        }
        return state as DeckState;
      },
    }
  )
);

// re-export ZONES for consumers that iterate zones
export { ZONES };
