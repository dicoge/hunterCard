import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import {
  HoloUser,
  AuthTokens,
  AuthProvider,
  UserRole,
} from '../types/auth';
import {
  signInWithProvider,
  linkProvider,
  unlinkProvider,
  deleteAccount,
  providerSignOut,
  isAppleCredentialAuthorized,
  APPLE_CANCEL_CODE,
} from '../services/authService';

interface AuthStore {
  user: HoloUser | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  isLoading: boolean;
  hasHydrated: boolean;
  error: string | null;
  role: UserRole;

  loginWithGoogle: () => Promise<void>;
  loginWithApple: () => Promise<void>;
  verifyAppleCredential: () => Promise<void>;
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
      tokens: null,
      isAuthenticated: false,
      isGuest: false,
      isLoading: false,
      hasHydrated: false,
      error: null,
      role: 'guest',

      loginWithGoogle: async () => {
        set({ isLoading: true, error: null });
        try {
          const { user, tokens } = await signInWithProvider('google');
          set({
            user,
            tokens,
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
          const { user, tokens } = await signInWithProvider('apple');
          set({
            user,
            tokens,
            isAuthenticated: true,
            isGuest: false,
            isLoading: false,
            role: 'free_user',
          });
        } catch (err: any) {
          // 使用者主動取消原生 Apple 授權彈窗：靜默結束，不顯示錯誤、不彈 alert。
          if (err?.code === APPLE_CANCEL_CODE) {
            set({ isLoading: false, error: null });
            return;
          }
          set({ isLoading: false, error: err.message || 'Login failed' });
          throw err;
        }
      },

      // 啟動時檢查 iOS Apple 憑證狀態：若使用者已在「設定 → Apple ID」撤銷授權，
      // 強制登出以要求重新驗證（AUTH-Architecture：credential state / revoked / re-auth）。
      // 非 iOS 或非 Apple 使用者一律 no-op（isAppleCredentialAuthorized 回 true）。
      verifyAppleCredential: async () => {
        const { user, isAuthenticated } = get();
        if (!isAuthenticated || !user) return;
        const appleId = user.linkedProviders.find((p) => p.provider === 'apple')?.providerId;
        if (!appleId) return;
        try {
          const authorized = await isAppleCredentialAuthorized(appleId);
          if (!authorized) {
            await get().logout();
          }
        } catch {
          // 查詢失敗不強制登出，避免誤踢正常使用者。
        }
      },

      continueAsGuest: () => {
        set({
          user: null,
          tokens: null,
          isAuthenticated: false,
          isGuest: true,
          role: 'guest',
          isLoading: false,
          error: null,
        });
      },

      linkNewProvider: async (provider) => {
        const { user } = get();
        if (!user) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          const updatedUser = await linkProvider(user, provider);
          set({ user: updatedUser, isLoading: false });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Failed to link provider' });
          throw err;
        }
      },

      removeLinkedProvider: async (provider) => {
        const { user } = get();
        if (!user) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          const updatedUser = await unlinkProvider(user, provider);
          set({ user: updatedUser, isLoading: false });
        } catch (err: any) {
          set({ isLoading: false, error: err.message || 'Failed to unlink provider' });
          throw err;
        }
      },

      logout: async () => {
        const { tokens } = get();
        await providerSignOut(tokens);
        set({
          user: null,
          tokens: null,
          isAuthenticated: false,
          isGuest: false,
          isLoading: false,
          error: null,
          role: 'guest',
        });
      },

      deleteUserAccount: async () => {
        const { user } = get();
        if (!user) throw new Error('No authenticated user');
        set({ isLoading: true, error: null });
        try {
          await deleteAccount(user);
          set({
            user: null,
            tokens: null,
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
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated,
        isGuest: state.isGuest,
        role: state.role,
      }),
    }
  )
);
