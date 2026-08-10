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

  createDeck: (name: string) => string;
  renameDeck: (deckId: string, name: string) => void;
  deleteDeck: (deckId: string) => void;
  setActiveDeck: (deckId: string | null) => void;
  getActiveDeck: () => Deck | null;

  /** add `delta` copies of a card to a zone (negative removes; removes slot at 0) */
  changeCard: (deckId: string, zone: DeckZone, card: DeckCard, delta: number) => void;
  removeCard: (deckId: string, zone: DeckZone, cardId: string) => void;

  setOwned: (cardNumber: string, version: string, qty: number) => void;
  getOwned: (cardNumber: string, version: string) => number;
}

const ZONES: DeckZone[] = ['oshi', 'main', 'yell'];

export const useDeckStore = create<DeckState>()(
  persist(
    (set, get) => ({
      decks: [],
      activeDeckId: null,
      collection: {},

      createDeck: (name) => {
        const deck = emptyDeck(name.trim() || '新牌組');
        set((s) => ({ decks: [...s.decks, deck], activeDeckId: deck.id }));
        return deck.id;
      },
      renameDeck: (deckId, name) => set((s) => ({
        decks: s.decks.map((d) => d.id === deckId
          ? { ...d, name: name.trim() || d.name, updatedAt: new Date().toISOString() }
          : d),
      })),
      deleteDeck: (deckId) => set((s) => ({
        decks: s.decks.filter((d) => d.id !== deckId),
        activeDeckId: s.activeDeckId === deckId ? null : s.activeDeckId,
      })),
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

      setOwned: (cardNumber, version, qty) => set((s) => {
        const key = ownershipKey(cardNumber, version);
        const next = { ...s.collection };
        if (qty <= 0) delete next[key];
        else next[key] = qty;
        return { collection: next };
      }),
      getOwned: (cardNumber, version) => get().collection[ownershipKey(cardNumber, version)] || 0,
    }),
    {
      name: 'hunterCard-decks',
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ decks: s.decks, activeDeckId: s.activeDeckId, collection: s.collection }),
    }
  )
);

// re-export ZONES for consumers that iterate zones
export { ZONES };
