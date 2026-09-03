import { Platform } from 'react-native';
import type { ReleaseCardFlags } from '../utils/cardReleaseFilter';

// Single source of truth for Store MVP release gating (DIC-908 → DIC-1256).
//
// Store MVP is an allowlist / fail-closed release profile: every advanced
// surface (favorites/collection browser, market-data section, external price
// links, buy-back price, price spread/arbitrage, trend & prediction, news
// sentiment, YouTube stats, watchlist trend alerts, push alerts, subscription /
// premium) is HIDDEN unless the profile is explicitly turned off. Do not add
// scattered `if (__DEV__)` / magic booleans elsewhere — read from FEATURES.
//
// Resolution of STORE_MVP (fail-closed — CR DIC-913 #1):
//   EXPO_PUBLIC_STORE_MVP = '0' | 'false' → Store MVP OFF (full app). This is
//       the ONLY way to disable the profile; nothing else opens the gate.
//   EXPO_PUBLIC_STORE_MVP = '1' | 'true'  → Store MVP ON  (hide advanced)
//   unset / whitespace / malformed / unknown:
//     • native (iOS / Android store builds) → ON  (fail-closed: a missing or
//       garbled env must never leak a disabled feature into a store build)
//     • web                                  → OFF (the existing web production
//       site keeps its full feature set; the release flag must not break it)
function resolveStoreMvp(): boolean {
  const raw = typeof process.env.EXPO_PUBLIC_STORE_MVP === 'string'
    ? process.env.EXPO_PUBLIC_STORE_MVP.trim().toLowerCase()
    : '';
  // Explicit opt-out is the only path to OFF.
  if (raw === '0' || raw === 'false') return false;
  // Explicit opt-in.
  if (raw === '1' || raw === 'true') return true;
  // Anything else (unset / whitespace / typo like 'yes' / '01' / 'off') is
  // treated as unresolved → fail-closed on native, preserve full web prod.
  return Platform.OS !== 'web';
}

export const STORE_MVP = resolveStoreMvp();

// Feature allowlist. Everything here is derived from STORE_MVP so the profile is
// the only switch. When STORE_MVP is on, all advanced surfaces are off.
export const FEATURES = {
  // 收藏 / Collection browser drawer entry AND per-card ownership widget on the
  // card-detail screen (DIC-1256): the browse-by-collection surface disappears
  // and the +/- ownership adjuster on card detail is hidden. The deck editor
  // continues to expose its own ownership editing.
  favorites: !STORE_MVP,
  // 售價 / plain sale price of the ONE printing the player is holding. ALWAYS
  // ON, Store MVP included (DIC-1319). Scanning a card and immediately seeing
  // what that exact printing sells for is the product's primary path, not an
  // advanced market surface — DIC-1256 folded it into `marketData`, and that is
  // why the v21 closed test shipped with every price blank.
  //
  // Scope is deliberately narrow: the sale price of a single printing on the
  // surfaces that already identify that printing (scan result, scan candidate
  // meta, search-result row, card-detail price block). Buy-back price, 買賣差價,
  // cross-printing comparison, trend/prediction, session & deck valuation
  // totals, external price links and price alerts all stay behind their own
  // flags below and remain hidden under Store MVP.
  sellPrice: true,
  // 市場數據 / Market data section on the card-detail screen (DIC-1256):
  // MarketDataPanel version pills, 買賣差價, YT stats, trend charts, and the
  // cross-printing 其他版本 comparisons are hidden. Cards keep their image,
  // name, number, type, colors, skills, keywords — and, since DIC-1319, the
  // sale price of their own printing (see `sellPrice`).
  marketData: !STORE_MVP,
  // 外部價格連結 / External price-lookup links on the card-detail screen
  // (DIC-1256): 遊々亭 (價格查詢) and Carousell 二手價格 links are hidden.
  // 官方卡表 stays available regardless.
  externalPriceLinks: !STORE_MVP,
  // 店家收購價 / buyPrice / 回收價
  buyPrice: !STORE_MVP,
  // 買賣差價 / 套利 / 值差 / 值得買賣 / 入手時機
  priceSpread: !STORE_MVP,
  // 漲跌預測 / trendScore / 信心度 / 價格趨勢圖與預測文案
  trendPrediction: !STORE_MVP,
  // 新聞數量 / 新聞情緒
  newsSentiment: !STORE_MVP,
  // YT 訂閱 / 觀看成長及衍生預測
  ytStats: !STORE_MVP,
  // 到價提醒
  watchlist: !STORE_MVP,
  // 價格預判通知 / push trend alerts
  pushAlerts: !STORE_MVP,
  // 訂閱 / 付費 / premium / paywall
  premium: !STORE_MVP,
} as const;

export type FeatureKey = keyof typeof FEATURES;

export function isFeatureEnabled(key: FeatureKey): boolean {
  return FEATURES[key];
}

// Resolved card-field flags for the mapping-boundary filter. Every card mapper
// passes this to stripDisabledCardFields so Store MVP objects never carry the
// disabled advanced fields (buyPrice / priceHistory / ytStats) — QA DIC-915.
export function releaseCardFlags(): ReleaseCardFlags {
  return {
    buyPrice: FEATURES.buyPrice,
    trendPrediction: FEATURES.trendPrediction,
    ytStats: FEATURES.ytStats,
  };
}
