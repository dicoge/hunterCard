import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import {
  HoloUser,
  AuthProvider,
  UserRole,
} from '../types/auth';
import {
  signInWithProvider,
  linkProvider,
  unlinkProvider,
  deleteAccount,
} from '../services/authService';

interface AuthStore {
  user: HoloUser | null;
  session: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  isLoading: boolean;
  hasHydrated: boolean;
  error: string | null;
  role: UserRole;

  loginWithGoogle: () => Promise<void>;
  loginWithApple: () => Promise<void>;
  continueAsGuest: () => void;
  linkNewProvider: (provider: AuthProvider) => Promise<void>;
  removeLinkedProvider: (provider: AuthProvider) => Promise<void>;
  logout: () => Promise<void>;
  deleteUserAccount: () => Promise<void>;
  clearError: () => void;
  setRole: (role: UserRole) => void;
  setHasHydrated: (v: boolean) => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      session: null,
      isAuthenticated: false,
      isGuest: false,
      isLoading: false,
      hasHydrated: false,
      error: null,
      role: 'guest',

      loginWithGoogle: async () => {
        set({ isLoading: true, error: null });
        try {
          const { user, session } = await signInWithProvider('google');
          set({
            user,
            session,
            isAuthenticated: true,
            isGuest: false,
            isLoading: false,
            role: 'free_user',
          });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Login failed' });
          throw err;
        }
      },

      loginWithApple: async () => {
        set({ isLoading: true, error: null });
        try {
          const { user, session } = await signInWithProvider('apple');
          set({
            user,
            session,
            isAuthenticated: true,
            isGuest: false,
            isLoading: false,
            role: 'free_user',
          });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Login failed' });
          throw err;
        }
      },

      continueAsGuest: () => {
        set({
          user: null,
          session: null,
          isAuthenticated: false,
          isGuest: true,
          role: 'guest',
          isLoading: false,
          error: null,
        });
      },

      linkNewProvider: async (provider) => {
        const { user, session } = get();
        if (!user || !session) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          const updatedUser = await linkProvider(session, user, provider);
          set({ user: updatedUser, isLoading: false });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Failed to link provider' });
          throw err;
        }
      },

      removeLinkedProvider: async (provider) => {
        const { user, session } = get();
        if (!user || !session) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          const updatedUser = await unlinkProvider(session, provider);
          set({ user: updatedUser, isLoading: false });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Failed to unlink provider' });
          throw err;
        }
      },

      logout: async () => {
        set({
          user: null,
          session: null,
          isAuthenticated: false,
          isGuest: false,
          isLoading: false,
          error: null,
          role: 'guest',
        });
      },

      deleteUserAccount: async () => {
        const { user, session } = get();
        if (!user || !session) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          // Resolves only on server-confirmed deletion; otherwise throws and we
          // keep the session (do not claim the account was deleted).
          await deleteAccount(session);
          set({
            user: null,
            session: null,
            isAuthenticated: false,
            isGuest: false,
            isLoading: false,
            error: null,
            role: 'guest',
          });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Failed to delete account' });
          throw err;
        }
      },

      clearError: () => set({ error: null }),
      setRole: (role) => set({ role }),
      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      name: 'holohunter-auth',
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
      storage: createJSONStorage(() => platformStorage),
      partialize: (state) => ({
        user: state.user,
        session: state.session,
        isAuthenticated: state.isAuthenticated,
        isGuest: state.isGuest,
        role: state.role,
      }),
    }
  )
);
