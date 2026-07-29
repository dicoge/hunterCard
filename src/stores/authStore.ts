/**
 * Auth Store (Zustand + persistent)
 *
 * 保存目前登入 session。產品決策：只支援 Apple / Google，不提供自家帳密。
 *
 * Apple 只在「首次」授權回傳姓名 / email，後續為 null——所以登入時會把新拿到的
 * 姓名 / email 與既有 session 合併，避免重新登入後名字消失。
 *
 * 不儲存任何密碼；identityToken 僅供後端驗證 / 帳號刪除撤銷使用。
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';

import type { AuthProvider, AuthSession } from '../types/auth';
import {
  signInWithApple,
  signInWithGoogle,
  registerAppleSession,
  requestAccountDeletion,
} from '../services/auth';

/** 帳號刪除結果：只有後端確認撤銷成功才 'deleted'（fail-closed）。 */
export type DeleteAccountResult = 'deleted' | 'failed';

interface AuthStore {
  session: AuthSession | null;
  /** persist 是否已還原完成——navigator 要等這個為 true 才能決定顯示登入頁。 */
  hasHydrated: boolean;

  isAuthenticated: () => boolean;
  signIn: (provider: AuthProvider) => Promise<void>;
  signOut: () => void;
  /**
   * 通知後端撤銷 token / 刪除資料。**fail-closed**：只有後端確認成功才清除本機
   * session 並回 'deleted'；失敗回 'failed' 且**維持登入狀態**，避免讓使用者
   * 誤以為已刪除但 Apple 授權 / 伺服器資料仍存在。
   */
  deleteAccount: () => Promise<DeleteAccountResult>;
  setHasHydrated: (v: boolean) => void;
}

/**
 * 合併新舊 session：Apple 重新登入時姓名 / email 會是 null，若既有 session 的
 * 使用者相同，就保留先前保存的姓名 / email。
 */
function mergeSession(prev: AuthSession | null, next: AuthSession): AuthSession {
  if (!prev || prev.user.id !== next.user.id) return next;
  return {
    ...next,
    user: {
      ...next.user,
      name: next.user.name ?? prev.user.name,
      email: next.user.email ?? prev.user.email,
    },
  };
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      session: null,
      hasHydrated: false,

      isAuthenticated: () => get().session !== null,

      signIn: async (provider) => {
        const next =
          provider === 'apple' ? await signInWithApple() : await signInWithGoogle();
        set({ session: mergeSession(get().session, next) });
        // 登入當下用 fresh authorizationCode 換 refresh_token 保存於後端（best-effort）。
        await registerAppleSession(next);
      },

      signOut: () => {
        set({ session: null });
      },

      deleteAccount: async () => {
        const { session } = get();
        if (!session) return 'deleted';
        const { ok } = await requestAccountDeletion(session);
        if (!ok) return 'failed';
        set({ session: null });
        return 'deleted';
      },

      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => platformStorage),
      // authorizationCode 為單次使用短效憑證，**絕不持久化**——只在登入當下換
      // refresh_token 後即丟棄。持久化的 session 一律剝除它。
      partialize: (state) => ({
        session: state.session
          ? { ...state.session, authorizationCode: null }
          : null,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
