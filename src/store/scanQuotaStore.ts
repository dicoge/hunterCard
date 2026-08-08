import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { UserRole } from '../types/auth';
import { isQuotaExceeded, effectiveRole } from '../services/permissionService';
import { useAuthStore } from './authStore';

interface ScanQuotaState {
  scanCount: number;
  currentMonth: string;

  incrementScan: () => boolean;
  getRemaining: () => number;
  resetQuota: () => void;
}

function getCurrentMonth(): string {
  return `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
}

// Role is owned solely by the auth store (single source of truth). Reading it
// here avoids the previous desync where a persisted `guest` quota role blocked
// freshly-logged-in free users from scanning.
function currentRole(): UserRole {
  return useAuthStore.getState().role;
}

export const useScanQuotaStore = create<ScanQuotaState>()(
  persist(
    (set, get) => ({
      scanCount: 0,
      currentMonth: getCurrentMonth(),

      incrementScan: () => {
        const role = currentRole();
        const { scanCount, currentMonth } = get();
        const now = getCurrentMonth();
        let newCount = currentMonth !== now ? 0 : scanCount;

        if (isQuotaExceeded(role, newCount)) {
          return false;
        }

        newCount += 1;
        set({ scanCount: newCount, currentMonth: now });
        return true;
      },

      getRemaining: () => {
        // effectiveRole collapses subscriber→free_user in Store MVP so unlimited
        // scan (-1) is never returned when premium is disabled (CR DIC-913 #2).
        const role = effectiveRole(currentRole());
        const { scanCount, currentMonth } = get();
        const now = getCurrentMonth();
        const effectiveCount = currentMonth !== now ? 0 : scanCount;
        if (role === 'subscriber') return -1;
        if (role === 'guest') return 0;
        return Math.max(0, 100 - effectiveCount);
      },

      resetQuota: () => {
        set({ scanCount: 0, currentMonth: getCurrentMonth() });
      },
    }),
    {
      name: 'holohunter-scan-quota',
      storage: createJSONStorage(() => platformStorage),
      partialize: (state) => ({
        scanCount: state.scanCount,
        currentMonth: state.currentMonth,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const now = getCurrentMonth();
          if (state.currentMonth !== now) {
            state.scanCount = 0;
            state.currentMonth = now;
          }
        }
      },
    }
  )
);
