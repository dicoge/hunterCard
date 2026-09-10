export const APP_NAME = 'HoloHunter';
export const APP_VERSION = '1.0.0';

// hololive 卡牌類別
export const HOLO_CATEGORIES = [
  { id: 'hololive', name: 'hololive', icon: '🌸' },
  { id: 'holostars', name: 'holostars', icon: '⭐' },
  { id: 'inukomis', name: 'InuKomi', icon: '🐾' },
  { id: 'other', name: '其他', icon: '🎴' },
];

// 稀有度
export const RARITIES = [
  { id: 'C', name: 'C', color: '#6b7280' },
  { id: 'U', name: 'U', color: '#10b981' },
  { id: 'R', name: 'R', color: '#3b82f6' },
  { id: 'SR', name: 'SR', color: '#8b5cf6' },
  { id: 'UC', name: 'UC', color: '#f59e0b' },
  { id: 'CP', name: 'CP', color: '#ef4444' },
];

// Currency options
export const CURRENCIES = [
  { code: 'TWD', symbol: 'NT$', name: '新台幣' },
  { code: 'JPY', symbol: '¥', name: '日圓' },
  { code: 'USD', symbol: '$', name: '美元' },
];

// Exchange rates (from JPY to target currency)
// 1 JPY = 0.22 TWD, 1 JPY = 0.0067 USD
export const EXCHANGE_RATES: Record<string, number> = {
  TWD: 0.22,
  USD: 0.0067,
  JPY: 1,
};

/**
 * Convert a JPY price to the target currency.
 * Returns the converted value and currency symbol.
 */
export function convertPrice(
  jpyPrice: number | null,
  targetCurrency: string,
  rates: Record<string, number> = EXCHANGE_RATES,
): { value: number | null; symbol: string } {
  if (jpyPrice == null) {
    const found = CURRENCIES.find(c => c.code === targetCurrency);
    return { value: null, symbol: found?.symbol || '¥' };
  }
  const rate = rates[targetCurrency] ?? 1;
  const converted = Math.round(jpyPrice * rate);
  const symbol = CURRENCIES.find(c => c.code === targetCurrency)?.symbol || '¥';
  return { value: converted, symbol };
}

// 價格來源
export const PRICE_SOURCES = [
  {
    name: '遊々亭',
    baseUrl: 'https://yuyu-tei.jp',
    searchEndpoint: '/top/hocg/',
    enabled: true,
  },
  {
    name: 'Carousell',
    baseUrl: 'https://www.carousell.com.tw',
    searchEndpoint: '/search/',
    enabled: true,
  },
];

// Default settings
export const DEFAULT_SETTINGS = {
  defaultCategory: 'hololive' as string,
  preferredCurrency: 'TWD',
  notifications: true,
  theme: 'system' as 'light' | 'dark' | 'system',
};

// UI Constants
export const SCREEN_OPTIONS = {
  headerStyle: {
    backgroundColor: '#1a1a2e',
  },
  headerTintColor: '#fff',
  headerTitleStyle: {
    fontWeight: 'bold' as const,
  },
};

// v2 palette — sourced from `docs/pen-v2/holohunter-landing-v2-updated.pen`
// (DIC-1409 Phase 2). Legacy `COLORS` stays exported so existing screens keep
// compiling, but every value routes through the v2 tokens in
// `src/theme/tokensV2.ts`. New code should import from `src/theme` directly.
import { PALETTE as V2, SEMANTIC as V2S, CATEGORY_COLORS as V2C } from '../theme/tokensV2';

export const COLORS = {
  primary: V2.accent,           // v1 hololive 粉紅 -> v2 $accent #FF4D9D
  primaryLight: '#FF80B8',      // hover tone for v2 accent
  primaryDark: '#D93B84',       // pressed tone for v2 accent
  secondary: V2.accent3,        // v1 藍紫色 -> v2 $accent-3 #8B5CF6
  accent: V2.cYellow,           // v1 金色 -> v2 $c-yellow #FBBF24
  success: V2S.success,
  warning: V2S.warning,
  error: V2S.error,
  background: V2.appBg,         // v1 深藍黑 -> v2 $app-bg #0A0A13
  surface: V2.appSurface,       // v1 深藍 -> v2 $app-surface #14141F
  surfaceLight: V2.appElev,     // v2 $app-elev #1C1C2B
  text: V2.textPrimary,         // v2 $text-primary #F6F6FB
  textSecondary: V2.textSecondary,
  border: V2.border,
  hololive: V2.accent,
  holostars: V2.accent2,
  inukomis: V2.cYellow,
  rarityC: V2.textMuted,
  rarityU: V2.cGreen,
  rarityR: V2.cBlue,
  raritySR: V2.accent3,
  rarityUC: V2.cYellow,
  rarityCP: V2.cRed,
};

// Re-export the raw v2 palette/semantic tokens for gradual migration.
export { V2 as PALETTE_V2, V2S as SEMANTIC_V2, V2C as CATEGORY_V2 };
