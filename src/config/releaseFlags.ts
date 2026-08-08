import { Platform } from 'react-native';

// Single source of truth for Store MVP release gating (DIC-908).
//
// Store MVP is an allowlist / fail-closed release profile: every advanced
// surface (buy-back price, price spread/arbitrage, trend & prediction, news
// sentiment, YouTube stats, watchlist trend alerts, push alerts, subscription /
// premium) is HIDDEN unless the profile is explicitly turned off. Do not add
// scattered `if (__DEV__)` / magic booleans elsewhere — read from FEATURES.
//
// Resolution of STORE_MVP:
//   EXPO_PUBLIC_STORE_MVP = '1' | 'true'  → Store MVP ON  (hide advanced)
//   EXPO_PUBLIC_STORE_MVP = '0' | 'false' → Store MVP OFF (full app)
//   unset:
//     • native (iOS / Android store builds) → ON  (fail-closed: a missing env
//       must never leak a disabled feature into a store submission)
//     • web                                  → OFF (the existing web production
//       site keeps its full feature set; the release flag must not break it)
function resolveStoreMvp(): boolean {
  const raw = process.env.EXPO_PUBLIC_STORE_MVP;
  if (raw != null && raw !== '') {
    const v = raw.toLowerCase();
    return v === '1' || v === 'true';
  }
  return Platform.OS !== 'web';
}

export const STORE_MVP = resolveStoreMvp();

// Feature allowlist. Everything here is derived from STORE_MVP so the profile is
// the only switch. When STORE_MVP is on, all advanced surfaces are off.
export const FEATURES = {
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
  // 入手提醒 / watchlist trend alerts
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
