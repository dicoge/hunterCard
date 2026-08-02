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
  getAppleCredentialStatus,
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
      // 非 iOS / 非 Apple 使用者一律 no-op（getAppleCredentialStatus 回 not_applicable）。
      verifyAppleCredential: async () => {
        const { user, isAuthenticated } = get();
        if (!isAuthenticated || !user) return;
        const appleId = user.linkedProviders.find((p) => p.provider === 'apple')?.providerId;
        if (!appleId) return;
        try {
          const status = await getAppleCredentialStatus(appleId);
          // 只有明確 'revoked'（已在設定撤銷 / 已轉移 / 找不到）才強制登出。
          // 'unknown'（查詢失敗）不登出，避免因暫時性錯誤誤踢——但也不再被當成
          // 已授權（見 getAppleCredentialStatus fail-safe）。
          if (status === 'revoked') {
            await get().logout();
          }
        } catch {
          // 極端情況（re-export 失效等）：保守不登出。
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
          const result = await deleteAccount(user);
          // 本機資料已刪除→清 session。但若後端未確認撤銷 Apple 授權，據實記錄
          // 未完成狀態，切勿讓 UI 宣稱「已完全刪除 / Apple 授權已撤銷」（CR #2）。
          set({
            user: null,
            tokens: null,
            isAuthenticated: false,
            isGuest: false,
            isLoading: false,
            error: result.serverRevoked
              ? null
              : 'account_deletion_partial: 本機資料已刪除，但伺服器端 Apple 授權撤銷尚未確認（後端未上線）。',
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
