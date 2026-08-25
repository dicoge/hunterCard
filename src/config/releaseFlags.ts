import { Platform } from 'react-native';
import type { ReleaseCardFlags } from '../utils/cardReleaseFilter';
import { IS_STAGING } from './appEnv';

// Single source of truth for Store MVP release gating (DIC-908).
//
// Store MVP is an allowlist / fail-closed release profile: every advanced
// surface (buy-back price, price spread/arbitrage, trend & prediction, news
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

// DIC-1189: staging-only allowlist. Features under active development that are
// NOT ready for production (實戰模擬、教學、未驗收支付與其他半成品) are gated
// through STAGING_ONLY so they light up in the staging deployment (APP_ENV=
// staging) and stay hidden in production (APP_ENV unset / unknown / literally
// 'production' — all resolve to !IS_STAGING via the fail-closed rule in
// src/config/appEnv.ts).
//
// Fail-closed rule: default here is FALSE outside staging. Adding a new
// experimental surface means adding a key with value `IS_STAGING`; forgetting
// to gate a surface at its callsite means it is on for everyone, so the flag
// is a defence, not the primary switch. Use isStagingOnlyEnabled(key) at the
// render / mount boundary.
export const STAGING_ONLY = {
  // 實戰模擬 — battle simulator (未實作)
  battleSimulation: IS_STAGING,
  // 教學 / 入門引導 — onboarding tutorial (未驗收)
  tutorial: IS_STAGING,
  // Stripe / RevenueCat / StoreKit — 未驗收支付整合的 UI 入口。The
  // api/_lib/env-guard.ts module fails closed on secret prefixes; this flag
  // hides the client-side affordance in production even if the backend
  // accidentally exposes an endpoint.
  paymentPreview: IS_STAGING,
} as const;

export type StagingOnlyKey = keyof typeof STAGING_ONLY;

export function isStagingOnlyEnabled(key: StagingOnlyKey): boolean {
  return STAGING_ONLY[key];
}
