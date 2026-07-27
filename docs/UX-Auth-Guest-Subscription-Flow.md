# HoloHunter 登入 / 訪客 / 升級訂閱 UX Flow 與擴充架構設計
# HoloHunter Auth / Guest / Subscription UX Flow & Extensible Architecture

> 對應議題：DIC-661 `[UX] HoloHunter 登入/訪客/升級訂閱 UI Flow`
>
> **本文件範圍**：設計「登入功能後的擴充架構」與完整 UX flow。依需求限制，**現階段先定架構、不立刻實作金流（IAP / Stripe）**。所有金流相關項目以「介面 + 佔位」方式預留，之後可無痛接上。

---

## 1. 設計總覽

### 1.1 目標
1. 首頁提供三條入口：**Google/Apple 登入**、**訪客瀏覽**。
2. 建立 `guest / free_user / subscriber` 三層權限模型，全 App 一致套用。
3. 免費使用者每月掃描 100 張，**額度以伺服器為準、可防本機竄改**，每月重置。
4. Premium 內容（價格預測 / 趨勢預測 / 進階市場數據）僅 subscriber 可見。
5. 訂閱狀態設計為未來可對接 App Store / Google Play IAP（Web 端 Stripe 另評估）。
6. 帳號刪除時連動清除 scan usage / quota / subscription mapping。

### 1.2 非目標（本階段不做）
- 真實金流串接（IAP 收據驗證、Stripe checkout）— 僅設計介面與資料模型。
- 後端使用者資料庫遷移 — 沿用現有 Vercel Serverless + `@vercel/kv`。
- 明確限制：**不使用 Copilot、不使用 OpenRouter**（見 §12）。

---

## 2. 權限模型（Roles / Permission Model）

三種角色，capability 以「能力矩陣」定義，避免散落在各畫面用 `if` 硬判斷。

| 能力 | guest（訪客） | free_user（登入未訂閱） | subscriber（訂閱） |
|------|:---:|:---:|:---:|
| 瀏覽卡片 / 查價（現價） | ✅ | ✅ | ✅ |
| 規則教學 / 模擬實戰 | ✅ | ✅ | ✅ |
| 卡牌掃描 | ❌ | ✅（每月 ≤ 100） | ✅（無上限） |
| 收藏 / 入手提醒 | ❌（需登入） | ✅ | ✅ |
| 價格預測 / 趨勢預測 | ❌ | ❌ | ✅ |
| 進階市場數據 | ❌ | ❌ | ✅ |

### 2.1 型別設計（新增至 `src/types/index.ts`）

```ts
// Auth / permission types
export type UserRole = 'guest' | 'free_user' | 'subscriber';

export interface AuthUser {
  id: string;                 // server-issued user id
  provider: 'google' | 'apple';
  displayName?: string;
  email?: string;             // 可能為 Apple private relay
  avatarUrl?: string;
}

export type Capability =
  | 'card.browse'
  | 'card.scan'
  | 'favorites.use'
  | 'watchlist.use'
  | 'premium.pricePrediction'
  | 'premium.trendPrediction'
  | 'premium.advancedMarket';

export interface SubscriptionState {
  status: 'none' | 'active' | 'expired' | 'in_grace' | 'pending';
  platform?: 'app_store' | 'google_play' | 'stripe';
  productId?: string;
  expiresAt?: string;         // RFC3339
  autoRenew?: boolean;
}

export interface ScanQuota {
  periodKey: string;          // 'YYYY-MM'，每月一個 key
  used: number;
  limit: number;              // free = 100，subscriber = Infinity（以 -1 表示無限）
  serverSyncedAt: string;     // 最後一次以伺服器為準對齊的時間
}
```

### 2.2 能力判斷（單一真源）

新增 `src/services/permissions.ts`，所有畫面統一呼叫，不各自判斷角色：

```ts
export function can(role: UserRole, cap: Capability): boolean { /* 能力矩陣 */ }
```

> 好處：未來新增角色（例如 `trial`）或調整權限，只改一處。

---

## 3. 首頁 / Onboarding Flow

### 3.1 路由改動（`src/navigation/AppNavigator.tsx`）

目前 root 直接進入 `MainDrawer`。改為在最外層依「是否已選擇入口」分流：

```
NavigationContainer
└─ RootStack
   ├─ Auth（未選擇入口時）        ← 新增
   └─ App（StackNavigator → MainDrawer）  ← 現有
```

- 冷啟動：若 `authStore` 尚無 session 且未選過訪客 → 顯示 **AuthScreen**。
- 已登入 / 已選訪客 → 進入現有 `MainDrawer`。
- 登出 → 清除狀態並回到 **AuthScreen**。

### 3.2 AuthScreen（新增 `src/screens/AuthScreen.tsx`）

```
┌───────────────────────────────┐
│           HoloHunter          │
│            卡牌獵人            │
│                               │
│   [  使用 Google 登入  ]       │
│   [  使用 Apple 登入   ]       │
│                               │
│   ──────  或  ──────           │
│                               │
│   [   以訪客身分瀏覽   ]        │
│   訪客僅能查看卡片與規則教學      │
└───────────────────────────────┘
```

- **不提供自家帳密**；只走 Google / Apple OAuth（符合需求）。
- Apple 登入為 iOS 上架必要條件（若提供第三方登入，App Store 要求同時提供 Sign in with Apple）。
- 訪客按鈕：設定 `role = 'guest'`，不建立 session。

### 3.3 掃描前的「訪客攔截」

訪客在 Drawer 仍可看到「掃描卡牌」入口，但點入時顯示登入引導（而非直接隱藏），以利轉換：

```
此功能需要登入
登入後每月可免費掃描 100 張卡牌
[ 立即登入 ]   [ 稍後再說 ]
```

---

## 4. OAuth 設計（Google / Apple）

| 平台 | 建議套件 | 備註 |
|------|----------|------|
| iOS / Android | `expo-auth-session` + `expo-apple-authentication` | Apple 僅 iOS 原生，Android 走 web OAuth |
| Web | Google Identity Services / Apple JS | 沿用 Vercel 部署 |

- Client ID / Service ID 以 `app.json` `extra` + 環境變數注入，**不硬編碼於原始碼**。
- 後端新增 `api/auth/callback.ts`：驗證 provider token → 建立 / 對應 user → 簽發自家 session token（短期 JWT）。
- 本階段可先以 **mock OAuth service（`src/services/authService.ts`）** 讓 UI flow 可跑，真實 SDK 之後替換該檔即可，不動 UI。

---

## 5. 掃描 Quota 系統（防竄改）

### 5.1 原則：**伺服器為準（server-authoritative）**

本機（Zustand persist / localStorage / AsyncStorage）易被竄改，因此：

- 本機只做 **UI 快取與樂觀顯示**，不可作為授權依據。
- 每次掃描前呼叫 `POST /api/quota/consume`，由伺服器原子遞增並回傳最新 `used/limit`。
- 伺服器以 `@vercel/kv` 儲存，key 設計：`quota:{userId}:{YYYY-MM}`，並設定 TTL 至月底自動失效 → **每月自動重置**，免排程。

### 5.2 API（新增）

| Endpoint | 作用 |
|----------|------|
| `GET /api/quota/check` | 回傳本月 `used / limit / remaining`（唯讀，不遞增） |
| `POST /api/quota/consume` | 原子 `INCR` 後判斷；超限回 `429 { reason: 'quota_exceeded' }` |

```ts
// api/quota/consume.ts（示意）
const key = `quota:${userId}:${periodKey}`;      // periodKey = 'YYYY-MM'
const used = await kv.incr(key);
if (used === 1) await kv.expire(key, secondsUntilMonthEnd());
if (role !== 'subscriber' && used > 100) {
  await kv.decr(key);                             // 回滾，維持準確
  return res.status(429).json({ reason: 'quota_exceeded' });
}
```

- subscriber：伺服器端直接放行（不計數或計數但不設上限）。
- 掃描實際扣額時機：建議在 **OCR/辨識成功送出查價前**扣一次，避免相機開啟即扣。
- 離線 / API 失敗策略：拒絕掃描並提示重試，**不可**因失敗就本機放行（否則等同繞過上限）。

### 5.3 與現有掃描流程的接點

`src/screens/ScanScreen.tsx` / `src/services/autoScanService.ts`：在觸發辨識前插入 `consume` 檢查；成功才續跑既有辨識 → 查價流程。

---

## 6. 訂閱狀態（Subscription）

### 6.1 資料模型
`SubscriptionState`（見 §2.1）以伺服器為準，本機快取顯示。key：`sub:{userId}`。

### 6.2 平台策略

| 平台 | 方案 | 本階段 |
|------|------|--------|
| iOS | App Store IAP（auto-renewable subscription） | 僅設計介面，`UpgradeScreen` 佔位 |
| Android | Google Play Billing | 同上 |
| Web | Stripe（或先不做） | 先不做，保留 `platform: 'stripe'` 欄位 |

- 未來以 `expo-in-app-purchases` / RevenueCat 類抽象層對接；`SubscriptionState` 介面已可容納。
- **收據驗證必須在後端**（`api/subscription/verify.ts`），前端不可信任本機訂閱旗標。
- 合規：iOS/Android 的訂閱購買必須走各平台 IAP，不可導流到外部網頁金流（App Store / Google Play 規範）。

---

## 7. Premium Gate

### 7.1 受保護內容
- 價格**預測** / 趨勢**預測**（現有 `src/components/PriceTrend.tsx`、`CardDetailScreen.tsx` 中的預測區塊）。
- 進階市場數據（成交量、多來源比價等）。
- **現價查詢維持免費**（含訪客）— 只有「預測 / 進階」鎖 premium。

### 7.2 呈現方式（`PremiumLockOverlay`）
非 subscriber 看到內容輪廓 + 毛玻璃遮罩 + 升級 CTA，而非整塊消失（提高轉換）：

```
┌── 趨勢預測 ──────────────┐
│  ▒▒▒▒ 模糊化的圖表 ▒▒▒▒   │
│        🔒 Premium 專屬     │
│   [ 升級解鎖價格預測 ]      │
└──────────────────────────┘
```

---

## 8. UI 元件與狀態（新增）

| 元件 | 位置 | 說明 |
|------|------|------|
| `QuotaIndicator` | 掃描頁頂部常駐 | 顯示「本月剩餘 N / 100」；subscriber 顯示「無上限」 |
| 達上限提示 | 掃描頁 modal | `已用完本月 100 次` → `[ 升級無限掃描 ]` `[ 下月再來 ]` |
| `UpgradeCTA` | 剩餘 < 10 時橫幅 | 溫和提示升級，不強制 |
| `PremiumLockOverlay` | 任何 premium 內容前 | §7.2 |
| 帳號區塊 | `SettingsScreen` | 顯示身分 / 訂閱狀態 / 剩餘額度 / 登出 / 刪除帳號 |

沿用現有色彩系統（`src/constants/index.ts` 的 `COLORS`，見 `docs/UI-Design-Scan-Feature.md`）：主色 Hololive Pink、金色代表 premium。

---

## 9. 隱私權政策與商店文案（需同步更新）

因新增「帳號、訂閱、使用量/quota 紀錄」，以下需一併調整：

- **隱私權政策**需揭露：
  - 透過 Google / Apple OAuth 蒐集的識別資料（user id、email，可能為 Apple relay）。
  - 掃描使用量與 quota 紀錄之目的與保存期間。
  - 訂閱狀態與交易對應紀錄（不儲存信用卡號，金流由平台處理）。
  - 使用者行使刪除權的方式（見 §10）。
- **商店上架文案**（App Store / Google Play）需揭露：帳號登入、訂閱制內購項目與價格、資料蒐集用途（Apple Privacy Nutrition Label / Google Data Safety）。

---

## 10. 帳號刪除（資料連動）

需求：帳號刪除須一併刪除 scan usage / quota / subscription mapping，或匿名化必要交易紀錄。

- 新增 `DELETE /api/user`：交易性地刪除
  - `quota:{userId}:*`
  - `sub:{userId}`
  - user 主檔 / OAuth 對應
- **交易稽核**（若法規要求保留）：不刪除、改**匿名化**（移除可識別欄位，保留金額 / 時間），並在隱私權政策說明。
- 前端：`SettingsScreen` 提供「刪除帳號」入口 → 二次確認 → 呼叫 API → 清本機狀態 → 回 AuthScreen。

---

## 11. QA 測試矩陣（guest / free / subscriber）

| # | 情境 | guest | free_user | subscriber |
|---|------|-------|-----------|------------|
| 1 | 冷啟動落點 | AuthScreen | 主頁 | 主頁 |
| 2 | 查看現價 | ✅ | ✅ | ✅ |
| 3 | 進入掃描 | 登入引導 | ✅ | ✅ |
| 4 | 掃描第 100 張 | — | ✅（達上限） | ✅ |
| 5 | 掃描第 101 張 | — | 阻擋 + 升級 CTA | ✅ |
| 6 | 跨月後額度 | — | 重置為 100 | 無上限 |
| 7 | 本機竄改 quota 後掃描 | — | 伺服器仍阻擋 | 放行 |
| 8 | 檢視趨勢預測 | 鎖定 | 鎖定 | ✅ |
| 9 | 升級成功後 | — | 變 subscriber，解鎖 | — |
| 10 | 訂閱過期 | — | — | 回落 free 權限 |
| 11 | 刪除帳號 | — | 資料清除、回 Auth | 資料清除、回 Auth |
| 12 | 登出 | — | 回 Auth | 回 Auth |

---

## 12. 限制與注意事項

- **不使用 Copilot**（額度已滿）、**不使用 OpenRouter**。
- iOS/Android 訂閱必須符合 App Store / Google Play 規範（IAP、Sign in with Apple、隱私標籤）。
- 額度授權一律以伺服器為準，本機值僅供顯示。

---

## 13. 建議實作階段（Roadmap）

| 階段 | 內容 | 產出 |
|------|------|------|
| **P1 架構（本階段設計對象）** | 型別、`permissions.ts` 能力矩陣、`authStore`、路由分流、AuthScreen（mock OAuth）、QuotaIndicator/PremiumLockOverlay/UpgradeCTA 佔位 | 可跑的 UI flow，角色可手動切換測試 |
| **P2 後端授權** | `api/auth/*`、`api/quota/*`（KV + 月結 TTL）、真實 OAuth SDK | 掃描額度以伺服器為準、防竄改 |
| **P3 訂閱金流** | IAP（iOS/Android）+ 後端收據驗證；Web Stripe 另評估 | 真正可訂閱、premium 解鎖 |
| **P4 合規與刪除** | 隱私權政策、商店文案、`DELETE /api/user` 連動清除 | 上架合規 |

> P1 不含金流，符合「先設計登入後的擴充架構、不一定立刻實作金流」的需求；P3 之前所有 premium/quota 判斷均可用手動角色切換驗證。
