/**
 * Favorites store (DIC-1380 W5 CR — independent round-trip; W6 CR —
 * deletion tombstones for the 409 merge).
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
 * W6 CR — deletion tombstones: the 409 merge path was previously union-
 * only. An unfavorite that raced with a concurrent write from another
 * device silently reappeared on the retry. `removals` now records the
 * `removedAt` timestamp for every key the user unfavorited since the last
 * hydrate; the orchestrator's merge honors it so a genuine deletion
 * survives the concurrent add.
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
  /** Per-key removal tombstones since the last server hydrate. Keyed by
   *  `${cardNumber}|${printing}`; value is the ISO removedAt timestamp.
   *  Consumed by the account-sync orchestrator's 409 merge so a genuine
   *  local unfavorite is not resurrected by a concurrent server add. */
  removals: Record<string, string>;
  addFavorite: (input: { cardNumber: string; printing: string; cardId?: string; now?: string }) => void;
  removeFavorite: (cardNumber: string, printing: string, now?: string) => void;
  toggleFavorite: (input: { cardNumber: string; printing: string; cardId?: string; now?: string }) => boolean;
  isFavorite: (cardNumber: string, printing: string) => boolean;
  /** Wholesale replacement — used by the sync orchestrator on hydrate.
   *  Also clears `removals` because the server snapshot is the new
   *  authoritative baseline. */
  replaceAll: (favorites: FavoriteEntry[]) => void;
  clearAll: () => void;
  /** Consumed after a successful push — the server now knows about our
   *  removals, so the tombstones can be dropped. */
  clearRemovals: () => void;
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
      removals: {},
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
        // Add wins over an older tombstone for the same key: the user
        // re-favorited, so drop the removal so the sync retry cannot
        // "delete" the re-add.
        const removals = { ...state.removals };
        delete removals[favKey(cn, pr)];
        set({ favorites: [...state.favorites, entry], removals });
      },
      removeFavorite: (cardNumber, printing, now) => set((s) => {
        const filtered = s.favorites.filter((f) => !(f.cardNumber === cardNumber && f.printing === printing));
        if (filtered.length === s.favorites.length) return {};
        return {
          favorites: filtered,
          removals: { ...s.removals, [favKey(cardNumber, printing)]: now || new Date().toISOString() },
        };
      }),
      toggleFavorite: (input) => {
        const cn = (input.cardNumber ?? '').trim();
        const pr = (input.printing ?? '').trim();
        if (!cn || !pr) return false;
        const state = get();
        const existed = state.favorites.some((f) => f.cardNumber === cn && f.printing === pr);
        const now = input.now || new Date().toISOString();
        if (existed) {
          set({
            favorites: state.favorites.filter((f) => !(f.cardNumber === cn && f.printing === pr)),
            removals: { ...state.removals, [favKey(cn, pr)]: now },
          });
          return false;
        }
        const entry: FavoriteEntry = { cardNumber: cn, printing: pr, addedAt: now };
        if (input.cardId) entry.cardId = input.cardId;
        const removals = { ...state.removals };
        delete removals[favKey(cn, pr)];
        set({ favorites: [...state.favorites, entry], removals });
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
        // Server snapshot is now the baseline — every prior removal has
        // either been reflected server-side or was overwritten by the pull.
        set({ favorites: cleaned, removals: {} });
      },
      clearAll: () => set({ favorites: [], removals: {} }),
      clearRemovals: () => set({ removals: {} }),
    }),
    {
      name: 'hunterCard-favorites',
      version: 2,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ favorites: s.favorites, removals: s.removals }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<FavoritesState>;
        if (version < 2) state.removals = {};
        if (!state.removals || typeof state.removals !== 'object') state.removals = {};
        return state as FavoritesState;
      },
    },
  ),
);

export { favKey as favoriteKey };
