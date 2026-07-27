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
  requestAccountDeletion,
} from '../services/auth';

interface AuthStore {
  session: AuthSession | null;
  /** persist 是否已還原完成——navigator 要等這個為 true 才能決定顯示登入頁。 */
  hasHydrated: boolean;

  isAuthenticated: () => boolean;
  signIn: (provider: AuthProvider) => Promise<void>;
  signOut: () => void;
  /** 通知後端撤銷 token 後清除本機 session。回傳後端是否成功撤銷。 */
  deleteAccount: () => Promise<boolean>;
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
      },

      signOut: () => {
        set({ session: null });
      },

      deleteAccount: async () => {
        const { session } = get();
        if (!session) return true;
        const revoked = await requestAccountDeletion(session);
        set({ session: null });
        return revoked;
      },

      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => platformStorage),
      partialize: (state) => ({ session: state.session }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
