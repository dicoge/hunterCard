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
  logoutSession,
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
        // Revoke the session server-side, then always clear local state. If the
        // server did NOT confirm revocation (non-2xx or network failure) we don't
        // pretend the token is dead — we surface a warning so the user knows the
        // bearer token stays valid until its server TTL expires (CR blocker #2),
        // while still signing them out locally.
        const { session } = get();
        const revoked = session ? await logoutSession(session) : true;
        set({
          user: null,
          session: null,
          isAuthenticated: false,
          isGuest: false,
          isLoading: false,
          error: revoked
            ? null
            : '已在本機登出，但伺服器未能立即撤銷這個工作階段，該登入權杖會在到期前仍有效。',
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
