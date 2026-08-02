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
          // The caller's session normally survives unlink (CR round-5 blocker #1):
          // if it was minted by the removed provider the server re-binds the SAME
          // token to a still-linked provider, so we keep the existing session and
          // only adopt the updated user. But the atomic re-bind can fail if a
          // concurrent logout already revoked the token (CR round-6 blocker #1);
          // the server then reports callerSessionRevoked and we must drop the dead
          // token and sign out locally instead of keeping a session that no longer
          // works.
          const { user: updatedUser, callerSessionRevoked } = await unlinkProvider(session, provider);
          if (callerSessionRevoked) {
            set({
              user: null,
              session: null,
              isAuthenticated: false,
              isGuest: false,
              isLoading: false,
              role: 'guest',
              error: '已解除綁定，但你目前的登入工作階段已失效，請重新登入。',
            });
          } else {
            set({
              user: updatedUser,
              session,
              isAuthenticated: true,
              isLoading: false,
            });
          }
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
          // keep the local session so the user can retry (CR round-6 blocker #3).
          // A successful delete revokes every bearer including this one, but a
          // retry after a lost/indeterminate response still converges via the
          // server's durable deletion receipt. We preserve the thrown error's
          // truthful message (indeterminate vs. genuinely-not-deleted) verbatim
          // rather than flattening it to a generic failure.
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
          set({ isLoading: false, error: err.message || '刪除帳號時發生問題，請稍後再試。' });
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
