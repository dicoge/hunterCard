import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import { UserRole } from '../types/auth';
import { isQuotaExceeded } from '../services/permissionService';

interface ScanQuotaState {
  role: UserRole;
  scanCount: number;
  currentMonth: string;

  incrementScan: () => boolean;
  getRemaining: () => number;
  resetQuota: () => void;
  setRole: (role: UserRole) => void;
}

function getCurrentMonth(): string {
  return `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
}

export const useScanQuotaStore = create<ScanQuotaState>()(
  persist(
    (set, get) => ({
      role: 'guest',
      scanCount: 0,
      currentMonth: getCurrentMonth(),

      incrementScan: () => {
        const { role, scanCount, currentMonth } = get();
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
        const { role, scanCount, currentMonth } = get();
        const now = getCurrentMonth();
        const effectiveCount = currentMonth !== now ? 0 : scanCount;
        if (role === 'subscriber') return -1;
        if (role === 'guest') return 0;
        return Math.max(0, 100 - effectiveCount);
      },

      resetQuota: () => {
        set({ scanCount: 0, currentMonth: getCurrentMonth() });
      },

      setRole: (role: UserRole) => set({ role }),
    }),
    {
      name: 'holohunter-scan-quota',
      storage: createJSONStorage(() => platformStorage),
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
