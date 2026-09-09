/**
 * Favorites store (DIC-1380 W5 CR — independent round-trip).
 *
 * Favorites are a first-class per-account concept — the set of exact
 * printings a user has bookmarked, decoupled from `deckStore.collection`
 * (which tracks OWNED quantities, not bookmarks). The W5 handback flagged
 * the previous orchestrator derivation (favorites = collection keys) as
 * insufficient: unbookmarking a card the user still owns MUST NOT touch
 * the collection, and vice versa. This store gives favorites their own
 * persisted state, addressable by `${cardNumber}|${printing}` with an
 * `addedAt` timestamp so the client history stays truthful across a
 * cross-device merge.
 *
 * The AccountSyncPatch shape (`AccountSyncFavorite[]`) is what the
 * orchestrator serialises for the server; this store's `favorites` field
 * is the exact same array so no adapter is needed at the sync boundary.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

export interface FavoriteEntry {
  cardNumber: string;
  printing: string;
  cardId?: string;
  addedAt: string;
}

interface FavoritesState {
  favorites: FavoriteEntry[];
  addFavorite: (input: { cardNumber: string; printing: string; cardId?: string; now?: string }) => void;
  removeFavorite: (cardNumber: string, printing: string) => void;
  toggleFavorite: (input: { cardNumber: string; printing: string; cardId?: string; now?: string }) => boolean;
  isFavorite: (cardNumber: string, printing: string) => boolean;
  /** Wholesale replacement — used by the sync orchestrator on hydrate. */
  replaceAll: (favorites: FavoriteEntry[]) => void;
  clearAll: () => void;
}

function favKey(cardNumber: string, printing: string): string {
  return `${cardNumber}|${printing}`;
}

function normalizeFavorite(fav: unknown): FavoriteEntry | null {
  if (!fav || typeof fav !== 'object') return null;
  const f = fav as Partial<FavoriteEntry>;
  const cardNumber = typeof f.cardNumber === 'string' ? f.cardNumber.trim() : '';
  const printing = typeof f.printing === 'string' ? f.printing.trim() : '';
  if (!cardNumber || !printing) return null;
  const addedAt = typeof f.addedAt === 'string' && f.addedAt.length > 0
    ? f.addedAt
    : new Date().toISOString();
  const out: FavoriteEntry = { cardNumber, printing, addedAt };
  if (typeof f.cardId === 'string' && f.cardId.length > 0) out.cardId = f.cardId;
  return out;
}

export const useFavoritesStore = create<FavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      addFavorite: ({ cardNumber, printing, cardId, now }) => {
        const cn = (cardNumber ?? '').trim();
        const pr = (printing ?? '').trim();
        if (!cn || !pr) return;
        const state = get();
        if (state.favorites.some((f) => f.cardNumber === cn && f.printing === pr)) return;
        const entry: FavoriteEntry = {
          cardNumber: cn,
          printing: pr,
          addedAt: now || new Date().toISOString(),
        };
        if (cardId) entry.cardId = cardId;
        set({ favorites: [...state.favorites, entry] });
      },
      removeFavorite: (cardNumber, printing) => set((s) => ({
        favorites: s.favorites.filter((f) => !(f.cardNumber === cardNumber && f.printing === printing)),
      })),
      toggleFavorite: (input) => {
        const cn = (input.cardNumber ?? '').trim();
        const pr = (input.printing ?? '').trim();
        if (!cn || !pr) return false;
        const state = get();
        const existed = state.favorites.some((f) => f.cardNumber === cn && f.printing === pr);
        if (existed) {
          set({ favorites: state.favorites.filter((f) => !(f.cardNumber === cn && f.printing === pr)) });
          return false;
        }
        const entry: FavoriteEntry = {
          cardNumber: cn,
          printing: pr,
          addedAt: input.now || new Date().toISOString(),
        };
        if (input.cardId) entry.cardId = input.cardId;
        set({ favorites: [...state.favorites, entry] });
        return true;
      },
      isFavorite: (cardNumber, printing) => {
        return get().favorites.some((f) => f.cardNumber === cardNumber && f.printing === printing);
      },
      replaceAll: (favorites) => {
        const seen = new Set<string>();
        const cleaned: FavoriteEntry[] = [];
        for (const raw of favorites || []) {
          const norm = normalizeFavorite(raw);
          if (!norm) continue;
          const key = favKey(norm.cardNumber, norm.printing);
          if (seen.has(key)) continue;
          seen.add(key);
          cleaned.push(norm);
        }
        cleaned.sort((a, b) =>
          a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
        );
        set({ favorites: cleaned });
      },
      clearAll: () => set({ favorites: [] }),
    }),
    {
      name: 'hunterCard-favorites',
      version: 1,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ favorites: s.favorites }),
    },
  ),
);

export { favKey as favoriteKey };
