import type { ReleaseCardFlags } from '../utils/cardReleaseFilter';
import { IS_STAGING } from './appEnv';

// Single source of truth for Store MVP release gating (DIC-908 → DIC-1380).
//
// Store MVP is an allowlist / fail-closed release profile: every advanced
// surface (favorites/collection browser, market-data section, external price
// links, buy-back price, price spread/arbitrage, trend & prediction, news
// sentiment, YouTube stats, watchlist trend alerts, push alerts, subscription /
// premium) is HIDDEN unless the profile is explicitly turned off. Do not add
// scattered `if (__DEV__)` / magic booleans elsewhere — read from FEATURES.
//
// Resolution of STORE_MVP (fail-closed — DIC-1380 user correction):
//   EXPO_PUBLIC_STORE_MVP = '0' | 'false' → Store MVP OFF (full app). This is
//       the ONLY way to disable the profile; nothing else opens the gate.
//   EXPO_PUBLIC_STORE_MVP = '1' | 'true'  → Store MVP ON  (hide advanced)
//   unset / whitespace / malformed / unknown:
//     ALL platforms (native AND web) → ON (fail-closed). A missing or garbled
//     env must never leak a disabled feature into any Production surface, and
//     Web Production must ship the same allowlist as native Production. The
//     previous per-platform default (`Platform.OS !== 'web'`) is removed
//     because it kept Web Production full whenever the deploy profile forgot
//     to inject the define — the exact regression the release train blocks.
//
//     Web Develop/Staging and local `expo start --web` must set
//     `EXPO_PUBLIC_STORE_MVP=0` in their env (see `.env.example`) to keep
//     seeing advanced surfaces during development. Web Production, mobile
//     Production, and production-apk profiles must inject
//     `EXPO_PUBLIC_STORE_MVP=1` (see `eas.json` / deploy profiles owned by
//     Mac-Copilot).
function resolveStoreMvp(): boolean {
  const raw = typeof process.env.EXPO_PUBLIC_STORE_MVP === 'string'
    ? process.env.EXPO_PUBLIC_STORE_MVP.trim().toLowerCase()
    : '';
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return true;
}

export const STORE_MVP = resolveStoreMvp();

// Feature allowlist. Everything here is derived from STORE_MVP so the profile is
// the only switch. When STORE_MVP is on, all advanced surfaces are off.
export const FEATURES = {
  // 收藏庫 / Collection ownership-browser ROUTE (DIC-1481). The corrected
  // new-interface release contract requires the Collection route to stay
  // registered and reachable in EVERY release profile — full, preview,
  // production and Store MVP — superseding DIC-1256's route-unregistration
  // criterion for this one route (the criterion CR run 037b339f enforced
  // before this product decision existed). The screen only browses/edits
  // ownership counts and shows the exact-printing sale-price valuation that
  // FEATURES.sellPrice surfaces already carry; bookmarks (favorites),
  // watchlist and market data stay independently gated below and remain
  // fail-closed under Store MVP. Constant `true` on purpose: the flag is the
  // single named contract point that route registration and every control
  // navigating to the route share, so a regression that re-derives it from
  // STORE_MVP is caught by test:store-mvp-ui-gates instead of shipping.
  collection: true,
  // 收藏 / bookmarks (Favorites route, 趨勢 segment) AND per-card ownership
  // widget on the card-detail screen (DIC-1256): the bookmark surfaces
  // disappear and the +/- ownership adjuster on card detail is hidden. The
  // deck editor continues to expose its own ownership editing. Since
  // DIC-1481 this flag no longer gates the Collection route itself (see
  // `collection` above).
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
  // 賽事月報 / tournament monthly report (owner decision 2026-10-19: hidden in the FIRST
  // release, in every profile). false unregisters the TournamentReport route and removes
  // every entry — Home quick action, drawer item, Landing copy — so neither navigation nor
  // a direct route can open it. The report data and its pipeline are kept untouched;
  // restoring data is NOT a reason to re-expose it. Constant on purpose (one named
  // contract point, pinned by test:store-mvp-ui-gates).
  tournamentReport: false,
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
