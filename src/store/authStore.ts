import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { GoogleUser, AuthTokens } from '../types/auth';
import { googleSignIn, googleSignOut } from '../services/authService';

interface AuthStore {
  user: GoogleUser | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: () => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async () => {
        set({ isLoading: true, error: null });
        try {
          const { user, tokens } = await googleSignIn();
          set({ user, tokens, isAuthenticated: true, isLoading: false });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Login failed' });
          throw err;
        }
      },

      logout: async () => {
        const { tokens } = get();
        await googleSignOut(tokens);
        set({
          user: null,
          tokens: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'holohunter-auth',
      storage: createJSONStorage(() => platformStorage),
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
