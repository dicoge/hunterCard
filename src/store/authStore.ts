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
  validateSession as validateSessionRemote,
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
  validateSession: () => Promise<void>;
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

      // Never trust a persisted authenticated flag on its own: a rehydrated
      // session must be re-validated against the server before the app enters
      // authenticated UI (CR DIC-866: persisted auth fail-open). A rejected
      // session (401) is dropped; a transient/network failure keeps the session
      // but stays unauthenticated so we fail closed, not open.
      validateSession: async () => {
        const { session } = get();
        if (!session) {
          set({ isAuthenticated: false });
          get().setHasHydrated(true);
          return;
        }
        try {
          const user = await validateSessionRemote(session);
          set({ user, isAuthenticated: true, isGuest: false, role: 'free_user' });
        } catch (err: any) {
          if (err?.status === 401) {
            set({ user: null, session: null, isAuthenticated: false, role: 'guest' });
          } else {
            set({ isAuthenticated: false });
          }
        } finally {
          get().setHasHydrated(true);
        }
      },
    }),
    {
      name: 'holohunter-auth',
      version: 1,
      // Any state persisted before session re-validation existed (unversioned /
      // v0) may carry a blindly-trusted isAuthenticated. Drop its auth so the
      // user is re-validated rather than admitted on a legacy/tampered flag.
      migrate: (persisted: any, fromVersion: number) => {
        if (fromVersion < 1) {
          return {
            ...(persisted ?? {}),
            user: null,
            session: null,
            isAuthenticated: false,
            isGuest: false,
            role: 'guest',
          };
        }
        return persisted;
      },
      onRehydrateStorage: () => (state) => {
        // Enter unauthenticated; validateSession flips hasHydrated once the
        // server has confirmed (or rejected) the persisted session.
        state?.validateSession();
      },
      storage: createJSONStorage(() => platformStorage),
      // isAuthenticated is intentionally NOT persisted: it is derived from a
      // server-validated session on each launch, never restored from disk.
      partialize: (state) => ({
        user: state.user,
        session: state.session,
        isGuest: state.isGuest,
        role: state.role,
      }),
    }
  )
);
