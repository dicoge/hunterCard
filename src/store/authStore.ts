import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { useWatchlistStore } from '../stores/watchlistStore';

export interface UserIdentity {
  email: string;
  displayName: string;
  provider: 'google' | 'apple';
  providerId: string;
}

export interface UserSession {
  internalUserId: string;
  identities: UserIdentity[];
}

interface AuthState {
  isLoggedIn: boolean;
  session: UserSession | null;
  loginWithGoogle: () => void;
  loginWithApple: () => void;
  linkGoogle: (forceCollision?: boolean) => boolean; // returns true if linked successfully, false if collision
  linkApple: (forceCollision?: boolean) => boolean;  // returns true if linked successfully, false if collision
  unlinkProvider: (provider: 'google' | 'apple') => boolean;
  logout: () => void;
  deleteAccount: () => void;
  // Merges a collided mock identity into the current user
  mergeMockIdentity: (identity: UserIdentity) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isLoggedIn: false,
      session: null,

      loginWithGoogle: () => {
        set({
          isLoggedIn: true,
          session: {
            internalUserId: 'user_u78291a2bc90',
            identities: [
              {
                email: 'holofan@gmail.com',
                displayName: 'Holo Fan (Google)',
                provider: 'google',
                providerId: 'g_1092837465241',
              },
            ],
          },
        });
      },

      loginWithApple: () => {
        set({
          isLoggedIn: true,
          session: {
            internalUserId: 'user_u78291a2bc90',
            identities: [
              {
                email: 'holofan@icloud.com',
                displayName: 'Holo Fan (Apple)',
                provider: 'apple',
                providerId: 'ap_88273619472',
              },
            ],
          },
        });
      },

      linkGoogle: (forceCollision = false) => {
        const { session } = get();
        if (!session) return false;

        // If user already has google linked, do nothing
        if (session.identities.some(id => id.provider === 'google')) {
          return true;
        }

        if (forceCollision) {
          // Simulate account collision (Google belongs to another user)
          return false;
        }

        const newIdentity: UserIdentity = {
          email: 'holofan@gmail.com',
          displayName: 'Holo Fan (Google)',
          provider: 'google',
          providerId: 'g_1092837465241',
        };

        set({
          session: {
            ...session,
            identities: [...session.identities, newIdentity],
          },
        });
        return true;
      },

      linkApple: (forceCollision = false) => {
        const { session } = get();
        if (!session) return false;

        // If user already has apple linked, do nothing
        if (session.identities.some(id => id.provider === 'apple')) {
          return true;
        }

        if (forceCollision) {
          // Simulate account collision (Apple belongs to another user)
          return false;
        }

        const newIdentity: UserIdentity = {
          email: 'holofan@icloud.com',
          displayName: 'Holo Fan (Apple)',
          provider: 'apple',
          providerId: 'ap_88273619472',
        };

        set({
          session: {
            ...session,
            identities: [...session.identities, newIdentity],
          },
        });
        return true;
      },

      unlinkProvider: (provider) => {
        const { session } = get();
        if (!session) return false;

        // Cannot unlink if there is only 1 provider left
        if (session.identities.length <= 1) {
          return false;
        }

        set({
          session: {
            ...session,
            identities: session.identities.filter(id => id.provider !== provider),
          },
        });
        return true;
      },

      logout: () => {
        set({ isLoggedIn: false, session: null });
      },

      deleteAccount: () => {
        // Clear watchlist on account deletion
        try {
          useWatchlistStore.setState({ items: [] });
        } catch (e) {
          console.warn('Failed to clear watchlist:', e);
        }
        set({ isLoggedIn: false, session: null });
      },

      mergeMockIdentity: (identity) => {
        const { session } = get();
        if (!session) return;
        set({
          session: {
            ...session,
            identities: [...session.identities.filter(id => id.provider !== identity.provider), identity],
          },
        });
      },
    }),
    {
      name: 'hunterCard-auth-v2',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);
