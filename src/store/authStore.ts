// ══════════════════════════════════════════════════════════════
// 🚧 [MOCK/DEMO STAGE] — 本 AuthStore 目前為前端模擬測試階段
//
// - loginWithGoogle / loginWithApple 寫入的是固定假資料
//   (email、displayName、providerId 皆為 mock，非真實 OAuth)
// - toggleSubscription 是一鍵模擬切換角色 (非真實 IAP)
// - deleteAccount 僅清除本機 Zustand/localStorage 狀態
//   (無真實後端 delete-account API，雲端資料刪除需 email 人工申請)
// - linkGoogle / linkApple / mergeMockIdentity 為前端碰撞模擬
//
// 所有硬編碼的假身分資料與訂閱狀態僅供開發/測試使用。
// ══════════════════════════════════════════════════════════════
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { useWatchlistStore } from '../stores/watchlistStore';

export type UserRole = 'guest' | 'free_user' | 'subscriber';

export interface UserIdentity {
  email: string;
  displayName: string;
  provider: 'google' | 'apple';
  providerId: string;
}

export interface UserSession {
  internalUserId: string;
  role: UserRole;
  identities: UserIdentity[];
  scanCount: number; // monthly scans count
}

interface AuthState {
  isLoggedIn: boolean;
  session: UserSession | null;
  loginWithGoogle: () => void;
  loginWithApple: () => void;
  loginAsGuest: () => void;
  linkGoogle: (forceCollision?: boolean) => boolean; // returns true if linked successfully, false if collision
  linkApple: (forceCollision?: boolean) => boolean;  // returns true if linked successfully, false if collision
  unlinkProvider: (provider: 'google' | 'apple') => boolean;
  incrementScanCount: () => boolean; // returns true if scan is allowed, false otherwise
  toggleSubscription: () => void;    // toggles role between free_user and subscriber for testing
  logout: () => void;
  deleteAccount: () => void;
  // Merges a collided mock identity into the current user
  mergeMockIdentity: (identity: UserIdentity) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isLoggedIn: false,
      session: null,

      loginWithGoogle: () => {
        set({
          isLoggedIn: true,
          session: {
            internalUserId: 'user_u78291a2bc90',
            role: 'free_user',
            identities: [
              {
                email: 'holofan@gmail.com',
                displayName: 'Holo Fan (Google)',
                provider: 'google',
                providerId: 'g_1092837465241',
              },
            ],
            scanCount: 15, // starts with mock scan count
          },
        });
      },

      loginWithApple: () => {
        set({
          isLoggedIn: true,
          session: {
            internalUserId: 'user_u78291a2bc90',
            role: 'free_user',
            identities: [
              {
                email: 'holofan@icloud.com',
                displayName: 'Holo Fan (Apple)',
                provider: 'apple',
                providerId: 'ap_88273619472',
              },
            ],
            scanCount: 15,
          },
        });
      },

      loginAsGuest: () => {
        set({
          isLoggedIn: true,
          session: {
            internalUserId: 'guest_user',
            role: 'guest',
            identities: [],
            scanCount: 0,
          },
        });
      },

      linkGoogle: (forceCollision = false) => {
        const { session } = get();
        if (!session) return false;

        // If user already has google linked, do nothing
        if (session.identities.some(id => id.provider === 'google')) {
          return true;
        }

        if (forceCollision) {
          // Simulate account collision (Google belongs to another user)
          return false;
        }

        const newIdentity: UserIdentity = {
          email: 'holofan@gmail.com',
          displayName: 'Holo Fan (Google)',
          provider: 'google',
          providerId: 'g_1092837465241',
        };

        set({
          session: {
            ...session,
            identities: [...session.identities, newIdentity],
          },
        });
        return true;
      },

      linkApple: (forceCollision = false) => {
        const { session } = get();
        if (!session) return false;

        // If user already has apple linked, do nothing
        if (session.identities.some(id => id.provider === 'apple')) {
          return true;
        }

        if (forceCollision) {
          // Simulate account collision (Apple belongs to another user)
          return false;
        }

        const newIdentity: UserIdentity = {
          email: 'holofan@icloud.com',
          displayName: 'Holo Fan (Apple)',
          provider: 'apple',
          providerId: 'ap_88273619472',
        };

        set({
          session: {
            ...session,
            identities: [...session.identities, newIdentity],
          },
        });
        return true;
      },

      unlinkProvider: (provider) => {
        const { session } = get();
        if (!session) return false;

        // Cannot unlink if there is only 1 provider left
        if (session.identities.length <= 1) {
          return false;
        }

        set({
          session: {
            ...session,
            identities: session.identities.filter(id => id.provider !== provider),
          },
        });
        return true;
      },

      incrementScanCount: () => {
        const { session } = get();
        if (!session) return false;

        if (session.role === 'guest') {
          return false; // Guest cannot scan at all
        }

        if (session.role === 'subscriber') {
          return true; // Subscriber has unlimited scans
        }

        // For free user, check limit
        if (session.scanCount >= 100) {
          return false; // Limit exceeded
        }

        set({
          session: {
            ...session,
            scanCount: session.scanCount + 1,
          },
        });
        return true;
      },

      toggleSubscription: () => {
        const { session } = get();
        if (!session || session.role === 'guest') return;

        const nextRole = session.role === 'free_user' ? 'subscriber' : 'free_user';
        set({
          session: {
            ...session,
            role: nextRole,
          },
        });
      },

      logout: () => {
        set({ isLoggedIn: false, session: null });
      },

      deleteAccount: () => {
        // Clear watchlist on account deletion
        try {
          useWatchlistStore.setState({ items: [] });
        } catch (e) {
          console.warn('Failed to clear watchlist:', e);
        }
        set({ isLoggedIn: false, session: null });
      },

      mergeMockIdentity: (identity) => {
        const { session } = get();
        if (!session) return;
        set({
          session: {
            ...session,
            identities: [...session.identities.filter(id => id.provider !== identity.provider), identity],
          },
        });
      },
    }),
    {
      name: 'hunterCard-auth-v3',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);
