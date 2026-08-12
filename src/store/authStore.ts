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
  signOutNativeGoogle,
  validateSession as validateSessionRemote,
  completePendingWebGoogleLogin,
  hasPendingWebGoogleRedirectReturn,
} from '../services/authService';
import {
  friendlyAuthErrorMessage,
  isCancelAuthError,
} from '../services/authErrorMessages';

interface AuthStore {
  user: HoloUser | null;
  session: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  isLoading: boolean;
  hasHydrated: boolean;
  error: string | null;
  role: UserRole;
  // True on a boot that is a web-Google redirect RETURN (DIC-976 CR blocker 2).
  // While set, persisted-session validation defers to completeWebRedirectLogin
  // so a stale /auth/me cannot overwrite/clear the fresh callback result. Never
  // persisted — it describes THIS launch only.
  redirectPending: boolean;

  loginWithGoogle: () => Promise<void>;
  loginWithApple: () => Promise<void>;
  completeWebRedirectLogin: () => Promise<void>;
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
      redirectPending: false,

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
            role: user.role,
          });
        } catch (err: any) {
          // The root login gate (LoginScreen) renders `error` verbatim, so we
          // must map it to a friendly-but-safe string HERE — never store a raw
          // provider/SDK/network/backend message that could leak an id_token,
          // email, or internal detail (DIC-928 blocker 1). A user cancel is not
          // a failure, so it shows no error banner.
          set({
            isLoading: false,
            error: isCancelAuthError(err) ? null : friendlyAuthErrorMessage(err, 'google'),
          });
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
            role: user.role,
          });
        } catch (err: any) {
          // Same friendly-but-safe mapping as Google (DIC-928 blocker 1): the
          // gate renders this string, so it must never be a raw provider error.
          set({
            isLoading: false,
            error: isCancelAuthError(err) ? null : friendlyAuthErrorMessage(err, 'apple'),
          });
          throw err;
        }
      },

      // Return leg of the web-Google same-window redirect flow (DIC-976). Runs
      // ONCE on app boot. When this launch is a redirect return, boot routes
      // hydration THROUGH here instead of validateSession (see onRehydrateStorage)
      // so the two never race: this call OWNS the auth result and flips
      // hasHydrated. It completes the PKCE exchange + server call and dispatches
      // on the operation — 'login' adopts the fresh session+user; 'link' keeps
      // the existing session and only updates the user (the account was
      // augmented, not switched, CR blocker 1). A no-op on ordinary launches and
      // native. On completion it clears the redirect-pending guard and, whether
      // it succeeded, failed, or found nothing, marks the app hydrated so the UI
      // never hangs on a blank gate (CR blocker 2). A cancel/redirecting sentinel
      // shows no error banner.
      completeWebRedirectLogin: async () => {
        try {
          const result = await completePendingWebGoogleLogin();
          if (!result) return; // no pending redirect return — normal boot.
          // For 'login' result.session is the fresh session; for 'link' it is the
          // existing session the callback resumed with (account augmented, not
          // switched). Either way it is the session to adopt now.
          set({
            user: result.user,
            session: result.session,
            isAuthenticated: true,
            isGuest: false,
            isLoading: false,
            role: result.user.role,
            error: null,
          });
        } catch (err: any) {
          set({
            isLoading: false,
            error: isCancelAuthError(err) ? null : friendlyAuthErrorMessage(err, 'google'),
          });
        } finally {
          // This call owned boot for a redirect return: release the guard and
          // mark hydrated exactly once so validateSession (which deferred) does
          // not also need to run, and the gate is never stuck un-hydrated.
          set({ redirectPending: false });
          get().setHasHydrated(true);
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
          // The web-Google link flow full-page-navigates to Google and throws the
          // 'redirecting' sentinel (also true of a user cancel). That is NOT a
          // failure — do not set an error banner (the login gate renders it) and
          // do not stop loading as if it failed; just rethrow so the caller's
          // suppression runs. For real errors, store a friendly-but-SAFE mapped
          // string (never the raw err.message) — same discipline as login
          // (DIC-976 CR).
          if (isCancelAuthError(err)) {
            set({ isLoading: false, error: null });
            throw err;
          }
          set({ isLoading: false, error: friendlyAuthErrorMessage(err, provider) });
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
        // Clear the native Google SDK's cached account (Android) so the next
        // login re-prompts the account chooser and a different Gmail can be
        // chosen — without this the SDK silently reuses the last account. The
        // server session is authoritative; SDK sign-out is best-effort and never
        // blocks logout.
        await signOutNativeGoogle();
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
          // Server confirmed deletion — also clear the native Google SDK's
          // cached account so a subsequent login starts from a clean chooser.
          await signOutNativeGoogle();
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
      // authenticated UI (CR DIC-866: persisted auth fail-open). A definitively
      // rejected session — 401 (invalid) or 403 (account disabled / pending
      // deletion, CR DIC-866 #3) — is dropped; a transient/network failure keeps
      // the session but stays unauthenticated so we fail closed, not open. On
      // success the server-authoritative role is applied, never hard-coded
      // (CR DIC-866 #4).
      validateSession: async () => {
        // Defer entirely when this boot is a web-Google redirect return:
        // completeWebRedirectLogin OWNS the auth result and hydration for that
        // launch, so re-validating the OLD persisted session here would race it
        // (CR blocker 2). It clears redirectPending + flips hasHydrated itself.
        if (get().redirectPending) return;

        const capturedSession = get().session;
        if (!capturedSession) {
          set({ isAuthenticated: false });
          get().setHasHydrated(true);
          return;
        }
        try {
          const user = await validateSessionRemote(capturedSession);
          // Guard against a late landing: if the session changed underneath us
          // (e.g. a redirect callback adopted a NEW session while /auth/me was in
          // flight), this validation is stale — discard it rather than overwrite
          // the newer authenticated state (CR blocker 2).
          if (get().session !== capturedSession) return;
          set({ user, isAuthenticated: true, isGuest: false, role: user.role });
        } catch (err: any) {
          // Same staleness guard on the failure path: a late 401/403 for the OLD
          // session must NOT clear a session the callback just established.
          if (get().session !== capturedSession) return;
          if (err?.status === 401 || err?.status === 403) {
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
        if (!state) return;
        // Serialize the two boot flows so they can't race (CR blocker 2). If THIS
        // launch is a web-Google redirect return, route hydration ONLY through
        // completeWebRedirectLogin (it owns the auth result + hasHydrated); mark
        // redirectPending first so any incidental validateSession call defers.
        // Otherwise, the ordinary path: re-validate the persisted session.
        if (hasPendingWebGoogleRedirectReturn()) {
          state.redirectPending = true;
          state.completeWebRedirectLogin();
        } else {
          state.validateSession();
        }
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
