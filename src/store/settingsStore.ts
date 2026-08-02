/**
 * Settings Store (Zustand + persistent)
 *
 * Global app settings for language, currency, and display preferences.
 * Persisted via platform-specific storage (localStorage / AsyncStorage).
 *
 * Usage:
 *   const { preferredCurrency, preferredLanguage, setCurrency, setLanguage } = useSettingsStore();
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

export type CurrencyCode = 'TWD' | 'JPY' | 'USD';
export type LanguageCode = 'zh' | 'ja';

interface SettingsState {
  /** Preferred display currency (default: TWD) */
  preferredCurrency: CurrencyCode;
  /** Preferred display language (default: zh) */
  preferredLanguage: LanguageCode;
  /**
   * 驗證期用的「顯示原始市場對帳」開關（default: false = 正式預設 fail-closed）。
   * 開啟後卡詳情頁會顯示各版本原始 yuyu／raw buyPrice／對版狀態／原始差價計算，
   * 方便對資料；關閉時正式 UI 不把未可靠對版的差價當主數字。
   */
  showMarketReconciliation: boolean;

  // Actions
  setCurrency: (currency: CurrencyCode) => void;
  setLanguage: (language: LanguageCode) => void;
  setShowMarketReconciliation: (show: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      preferredCurrency: 'TWD',
      preferredLanguage: 'zh',
      showMarketReconciliation: false,

      setCurrency: (currency) => set({ preferredCurrency: currency }),
      setLanguage: (language) => set({ preferredLanguage: language }),
      setShowMarketReconciliation: (show) => set({ showMarketReconciliation: show }),
    }),
    {
      name: 'hunterCard-settings',
      storage: createJSONStorage(() => platformStorage),
    }
  )
);
