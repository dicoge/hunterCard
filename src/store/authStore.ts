import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { useWatchlistStore } from '../stores/watchlistStore';

export interface UserSession {
  email: string;
  displayName: string;
  provider: 'google' | 'apple';
  providerId: string;
}

interface AuthState {
  isLoggedIn: boolean;
  user: UserSession | null;
  loginWithGoogle: () => void;
  loginWithApple: () => void;
  logout: () => void;
  deleteAccount: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isLoggedIn: false,
      user: null,

      loginWithGoogle: () => {
        set({
          isLoggedIn: true,
          user: {
            email: 'holofan@gmail.com',
            displayName: 'Holo Fan (Google)',
            provider: 'google',
            providerId: 'g_1092837465241',
          },
        });
      },

      loginWithApple: () => {
        set({
          isLoggedIn: true,
          user: {
            email: 'holofan@icloud.com',
            displayName: 'Holo Fan (Apple)',
            provider: 'apple',
            providerId: 'ap_88273619472',
          },
        });
      },

      logout: () => {
        set({ isLoggedIn: false, user: null });
      },

      deleteAccount: () => {
        // Clear watchlist on account deletion
        try {
          useWatchlistStore.setState({ items: [] });
        } catch (e) {
          console.warn('Failed to clear watchlist:', e);
        }
        set({ isLoggedIn: false, user: null });
      },
    }),
    {
      name: 'hunterCard-auth',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);
