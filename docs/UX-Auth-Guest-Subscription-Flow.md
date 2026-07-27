# HoloHunter 登入 / 訪客 / 升級訂閱 UX Flow 與擴充架構設計
# HoloHunter Auth / Guest / Subscription UX Flow & Extensible Architecture

> 對應議題：DIC-661 `[UX] HoloHunter 登入/訪客/升級訂閱 UI Flow`
>
> **本文件範圍**：設計「登入功能後的擴充架構」與完整 UX flow。依需求限制，**現階段先定架構、不立刻實作金流（IAP / Stripe）**。所有金流相關項目以「介面 + 佔位」方式預留，之後可無痛接上。
>
> **底層基礎設施**：本設計對齊 DIC-646（Auth 架構決策 = **Supabase Auth + Supabase Postgres/RLS**）與 DIC-652（多 provider 身份連結模型），**不使用自建 callback token 驗證 / Vercel KV**。

---

## 1. 設計總覽

### 1.1 目標
1. 首頁提供三條入口：**Google/Apple 登入**、**訪客瀏覽**。
2. 建立 `guest / free_user / subscriber` 三層權限模型，全 App 一致套用。
3. 免費使用者每月掃描 100 張，**額度以伺服器為準、可防本機竄改**，每月重置。
4. Premium 內容（價格預測 / 趨勢預測 / 進階市場數據）僅 subscriber 可見。
5. 訂閱狀態設計為未來可對接 App Store / Google Play IAP（Web 端 Stripe 另評估）。
6. 帳號刪除時連動清除 scan usage / quota / subscription mapping。

### 1.2 底層基礎設施（DIC-646 決策）

| 項目 | 方案 |
|------|------|
| Auth provider | **Supabase Auth**（Google + Apple OAuth） |
| 資料儲存 | **Supabase Postgres**（含 RLS 行級安全） |
| Session 管理 | Supabase `auth.users` + GoTrue session（JWT），前端 `@supabase/supabase-js` |
| API 授權 | RLS policy 綁定 `auth.uid()` = internal user id |
| Quota / 訂閱 | Postgres table，以 RLS + server-side RPC 防竄改 |
| 金流預留 | IAP 介面 + `subscriptions` table；本階段不串接 |

### 1.3 非目標（本階段不做）
- 真實金流串接（IAP 收據驗證、Stripe checkout）— 僅設計介面與資料模型。
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

### 2.1 資料模型（Supabase Postgres / DIC-646 + DIC-652）

所有 user 相關資料儲存於 Supabase Postgres，以 **internal user id** 為單一資料歸屬與 RLS 邊界。

```sql
-- 核心使用者表（對應 Supabase auth.users，internal user id = auth.uid()）
CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- internal user id
  display_name  text,
  avatar_url    text,
  role          text NOT NULL DEFAULT 'free_user',            -- 'free_user' | 'subscriber'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 多 provider 身份連結表（DIC-652 核心模型）
-- (provider, provider_subject) 為 identity key；email 只作為屬性儲存，不作為唯一鍵
CREATE TABLE public.linked_auth_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          text NOT NULL,                            -- 'google' | 'apple'
  provider_subject  text NOT NULL,                            -- provider-issued sub claim
  provider_email    text,                                     -- 屬性（Apple private relay 可能為空）
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_subject),                        -- identity key 唯一
  UNIQUE (user_id, provider)                                  -- 同一個 user 同一個 provider 只能連結一次
);

-- 掃描額度表（每月一筆 per user）
CREATE TABLE public.scan_usage_monthly (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  period_key  text NOT NULL,                                  -- 'YYYY-MM'
  used        integer NOT NULL DEFAULT 0,
  limit_count integer NOT NULL DEFAULT 100,                   -- free = 100; subscriber: RPC 放行

  UNIQUE (user_id, period_key)
);

-- 訂閱狀態表（未來 IAP 對接，預留欄位）
CREATE TABLE public.subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'none',                   -- 'none' | 'active' | 'expired' | 'in_grace' | 'pending'
  platform     text,                                          -- 'app_store' | 'google_play' | 'stripe'
  product_id   text,
  expires_at   timestamptz,
  auto_renew   boolean DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- RLS policies（範例）
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON public.users
  FOR ALL USING (auth.uid() = id);

ALTER TABLE public.linked_auth_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY providers_self ON public.linked_auth_providers
  FOR ALL USING (auth.uid() = user_id);

ALTER TABLE public.scan_usage_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY scan_self ON public.scan_usage_monthly
  FOR ALL USING (auth.uid() = user_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subs_self ON public.subscriptions
  FOR ALL USING (auth.uid() = user_id);
```

### 2.2 型別設計（新增至 `src/types/index.ts`）

```ts
// Auth / permission types
export type UserRole = 'guest' | 'free_user' | 'subscriber';

export interface AuthUser {
  id: string;                       // internal user id（Supabase auth.uid()）
  displayName?: string;
  avatarUrl?: string;
  role: UserRole;
  linkedProviders: LinkedProvider[];
}

export interface LinkedProvider {
  provider: 'google' | 'apple';
  providerSubject: string;          // provider-issued sub claim
  providerEmail?: string;           // 屬性，非 identity key（Apple private relay 安全）
  linkedAt: string;
  lastLoginAt: string;
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
  expiresAt?: string;               // RFC3339
  autoRenew?: boolean;
}

export interface ScanQuota {
  periodKey: string;                // 'YYYY-MM'，每月一個 key
  used: number;
  limit: number;                    // free = 100，subscriber = Infinity（以 -1 表示無限）
  serverSyncedAt: string;           // 最後一次以伺服器為準對齊的時間
}
```

### 2.3 能力判斷（單一真源）

新增 `src/services/permissions.ts`，所有畫面統一呼叫，不各自判斷角色：

```ts
export function can(role: UserRole, cap: Capability): boolean { /* 能力矩陣 */ }
```

> 好處：未來新增角色（例如 `trial`）或調整權限，只改一處。

### 2.4 多 Provider 身份連結規則（DIC-652）

| 操作 | 規則 |
|------|------|
| **首次登入** | Google OAuth → 查 `linked_auth_providers` by `(provider, provider_subject)`；無則建立新 `users` + `linked_auth_providers` 紀錄 |
| **連結第二個 provider** | 使用者須 **已登入**（持有 session）；完成新 provider OAuth → 在 `linked_auth_providers` 新增一筆，關聯到同一 `user_id` |
| **身份衝突（collision）** | 若新 provider 的 `(provider, provider_subject)` 已屬於另一個 `user_id` → **預設拒絕**，不自動合併。錯誤訊息："此帳號已連結至其他使用者"。僅在未來設計的手動合併流程中處理（高風險，不放入本階段 scope） |
| **解除連結（unlink）** | 使用者至少保留一個登入方式；若只剩一個 provider，拒絕解除。若有多於一個，允許移除 |
| **郵件屬性** | `provider_email` 僅為顯示/聯絡屬性，**絕不作為身份識別 key**（Apple private relay 不保證 email 固定） |
| **無聲郵件合併** | **禁止**：不因兩個 provider 回傳同一個 email 就自動合併帳號（安全考量，DIC-652 規定） |

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

## 4. OAuth 設計（Google / Apple / Supabase Auth）

**基礎設施**：使用 Supabase Auth 管理 OAuth flow、session token（JWT）、refresh token 等（DIC-646 決策）。前端使用 `@supabase/supabase-js` 的 `signInWithOAuth()`。

| 平台 | Supabase Auth 後端 | 前端 |
|------|-------------------|------|
| iOS / Android | Supabase GoTrue → Google / Apple OAuth provider | `@supabase/supabase-js` + `expo-auth-session` 做原生 OAuth redirect |
| Web | 同上，PKCE flow | `@supabase/supabase-js` 內建 `signInWithOAuth({ provider })` |

### 4.1 Supabase Auth 設定

```ts
// lib/supabase.ts — 前端初始化
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);
```

**Google OAuth Provider 設定**（Supabase Dashboard → Authentication → Providers → Google）：
- Client ID / Secret 來自 Google Cloud Console
- Authorized redirect URI: `https://<project>.supabase.co/auth/v1/callback`

**Apple OAuth Provider 設定**（同上 → Apple）：
- Service ID / Team ID / Key ID / Private Key 來自 Apple Developer
- 不支援本機開發的 `localhost` redirect（Apple 僅允許 HTTPS）

### 4.2 Login flow（以 Google 為例）

```
使用者點擊 [Google 登入]
  → supabase.auth.signInWithOAuth({ provider: 'google' })
  → Supabase Auth 重導向至 Google 同意畫面
  → 使用者同意 → callback 回 Supabase
  → Supabase 在 auth.users 建立/對應帳號
  → 前端收到 session（JWT）
  → 前端從 session 解析 auth.uid() = internal user id
  → 查 public.linked_auth_providers 取得已連結的 provider 清單
  → 進入 MainDrawer（role = 'free_user'）
```

### 4.3 Session 驗證（全端共用）

- 前端：Supabase JWT 自動存在 `Authorization: Bearer <token>` header。
- Postgres RLS：`auth.uid()` 自動解析 JWT 中的 `sub` claim。
- Quota API：呼叫 Supabase RPC（`rpc('consume_scan_quota')`）而非自建 API——RLS 保證使用者只能操作自己的 row。
- 本階段可先以 **mock OAuth service（`src/services/authService.ts`）** 讓 UI flow 可跑，真實 Supabase SDK 之後替換該檔即可，不動 UI。

---

## 5. 掃描 Quota 系統（防竄改 / Supabase RPC）

### 5.1 原則：**伺服器為準（server-authoritative）**

本機（Zustand persist / localStorage / AsyncStorage）易被竄改，因此：

- 本機只做 **UI 快取與樂觀顯示**，不可作為授權依據。
- 每次掃描前呼叫 Supabase RPC `consume_scan_quota(user_id)`，由伺服器原子遞增並回傳最新 `used/limit`。
- Quota 紀錄存在 `public.scan_usage_monthly`，以 RLS binding `auth.uid()` 保護。

### 5.2 Supabase RPC（Server-side）

```sql
-- Scans RPC: 原子遞增並檢查，回傳最新狀態
CREATE OR REPLACE FUNCTION public.consume_scan_quota(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER                                              -- 以 owner 權限執行
SET search_path = ''
AS $$
DECLARE
  v_period text := to_char(now(), 'YYYY-MM');
  v_role   text;
  v_rec    public.scan_usage_monthly;
  v_limit  integer := 100;
BEGIN
  -- 查使用者訂閱狀態
  SELECT role INTO v_role FROM public.users WHERE id = p_user_id;

  -- 確保本月 row 存在
  INSERT INTO public.scan_usage_monthly (user_id, period_key, limit_count)
  VALUES (p_user_id, v_period, v_limit)
  ON CONFLICT (user_id, period_key) DO NOTHING;

  -- Subscriber: 不限制，但記錄使用量
  IF v_role = 'subscriber' THEN
    UPDATE public.scan_usage_monthly
    SET used = used + 1, limit_count = -1
    WHERE user_id = p_user_id AND period_key = v_period
    RETURNING * INTO v_rec;
  ELSE
    -- Free user: 檢查上限
    SELECT * INTO v_rec FROM public.scan_usage_monthly
    WHERE user_id = p_user_id AND period_key = v_period
    FOR UPDATE;

    IF v_rec.used >= v_limit THEN
      RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.scan_usage_monthly
    SET used = used + 1
    WHERE user_id = p_user_id AND period_key = v_period
    RETURNING * INTO v_rec;
  END IF;

  RETURN json_build_object(
    'used',     v_rec.used,
    'limit',    v_rec.limit_count,
    'remaining', GREATEST(v_rec.limit_count - v_rec.used, 0),
    'period',   v_period
  );
END;
$$;
```

### 5.3 前端呼叫

```ts
// src/services/quotaService.ts
import { supabase } from '../lib/supabase';

export async function consumeScanQuota(userId: string) {
  const { data, error } = await supabase
    .rpc('consume_scan_quota', { p_user_id: userId });

  if (error) {
    if (error.message?.includes('quota_exceeded')) {
      return { success: false, reason: 'quota_exceeded' as const };
    }
    throw error;
  }

  return { success: true, ...data } as const;
}
```

- subscriber：RPC 內直接放行（不計數或計數但不設上限）。
- 掃描實際扣額時機：建議在 **OCR/辨識成功送出查價前**扣一次，避免相機開啟即扣。
- 離線 / API 失敗策略：拒絕掃描並提示重試，**不可**因失敗就本機放行（否則等同繞過上限）。

### 5.4 每月自動重置

Postgres 的 `period_key` 為 `YYYY-MM` 格式，**每月自然分區**。無需排程 cron job 刪除舊 row——查詢時自動建立新月份的 row（見 RPC `ON CONFLICT ... DO NOTHING`）。舊 row 可保留作為使用紀錄（用戶儀表板 / 隱私權政策提及的「使用量」），透過 TTL cleanup script（optional）定期清理。

### 5.5 與現有掃描流程的接點

`src/screens/ScanScreen.tsx` / `src/services/autoScanService.ts`：在觸發辨識前插入 `consume` 檢查；成功才續跑既有辨識 → 查價流程。

---

## 6. 訂閱狀態（Subscription）

### 6.1 資料模型

`SubscriptionState`（見 §2.1 ）以 Supabase Postgres `public.subscriptions` table 為準，本機快取顯示。以 RLS 保護。

### 6.2 平台策略

| 平台 | 方案 | 本階段 |
|------|------|--------|
| iOS | App Store IAP（auto-renewable subscription） | 僅設計介面，`UpgradeScreen` 佔位 |
| Android | Google Play Billing | 同上 |
| Web | Stripe（或先不做） | 先不做，保留 `platform: 'stripe'` 欄位 |

- 未來以 `expo-in-app-purchases` / RevenueCat 類抽象層對接；`SubscriptionState` 介面已可容納。
- **收據驗證必須在後端**（Supabase Edge Function 或 Vercel function → 寫入 `public.subscriptions`），前端不可信任本機訂閱旗標。
- 合規：iOS/Android 的訂閱購買必須走各平台 IAP，不可導流到外部網頁金流（App Store / Google Play 規範）。

### 6.3 訂閱與 Quota 的邊界

- `scan_usage_monthly.limit_count` 在 free 階段固定為 100。
- subscriber 階段：RPC `consume_scan_quota` 在 `users.role = 'subscriber'` 時跳過上限檢查（但仍記錄使用量）。
- 訂閱過期回落：`subscriptions.status = 'expired'` 時，將 `users.role` 還原為 `'free_user'`（由 Supabase Edge Function scheduler 或其他排程觸發）→ 下次掃描時進入 free 邏輯。
- Entitlement 以 `users.role` 為單一真源，不直接參考 `subscriptions.status`（解耦：金流層只負責更新 role），避免訂閱表變動導致 UI 行為不一致。

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

### 7.3 Entitlement 判斷

前端 `permissions.ts` → `can(role, 'premium.pricePrediction')`；role 來自 server（透過 Supabase session / `users.role`）。不依賴本機 role 旗標做授權。

---

## 8. Provider Link / Unlink / Collision / Delete Account（DIC-652 邊界）

### 8.1 Provider 連結流程（Link）

```
前提：使用者已登入（持有 session，可解析 internal user id）

1. 使用者在設定頁點擊「連結 Google / Apple 帳號」
2. 呼叫 supabase.auth.signInWithOAuth({ provider: 'google' })
3. 使用者完成 Google OAuth
4. 後端（Supabase Auth Hook / Edge Function / RPC）處理：
   a. 解析 callback 取得 provider_subject
   b. 查 linked_auth_providers WHERE (provider, provider_subject) = (X, Y)
   c. 若無對應 → 插入 linked_auth_providers（user_id = 目前登入的 auth.uid()）
   d. 若已有對應且 user_id 相同 → 更新 last_login_at（重複 link 無害）
   e. 若已有對應但 user_id 不同 → **拒絕**（collision，見 §8.2）
5. 前端更新 linkedProviders 清單
```

### 8.2 身份衝突（Collision）處理

| 情境 | 處理 |
|------|------|
| 新 provider OAuth 回傳的 `provider_subject` 已存在於 `linked_auth_providers`，且屬於同一個 `user_id` | 無動作（或更新 `last_login_at`） |
| 新 provider OAuth 回傳的 `provider_subject` 已存在於另一個 `user_id` | **預設拒絕**，回傳錯誤 `identity_conflict`。不自動合併帳號。UI 訊息："此帳號已連結至其他使用者。如需合併帳號，請聯繫客服。" |
| 兩個 provider 回傳相同 email 但不相同的 `provider_subject` | **禁止無聲合併**（DIC-652 規定）。不因 email 相同而自動關聯兩個獨立的 internal user |

> 手動合併流程（兩個 internal user 合併為一）為高風險操作，不在本階段 scope。僅在本文件 §8.2 預留碰撞規則，避免日後設計矛盾。

### 8.3 Provider 解除連結（Unlink）

```
前提：使用者已登入，linked_auth_providers COUNT >= 2

1. 使用者在設定頁選擇要移除的 provider
2. 前端確認："移除後將無法使用此帳號登入，確定要移除嗎？"
3. 後端 DELETE FROM linked_auth_providers WHERE user_id = X AND provider = Y
4. 若只剩一個 provider（或試圖移除最後一個）→ 拒絕，回傳 "must_retain_one_provider"
5. 前端更新 linkedProviders 清單
```

### 8.4 帳號刪除（Cascade）

需求（DIC-661）：帳號刪除須一併刪除 scan usage / quota / subscription mapping，或匿名化必要交易紀錄。

```
前提：使用者已登入

1. 使用者在設定頁點擊「刪除帳號」→ 二次確認
2. 後端執行 cascade delete（由 Supabase Edge Function / DB trigger 處理）：
   a. DELETE FROM linked_auth_providers WHERE user_id = X
   b. DELETE FROM scan_usage_monthly WHERE user_id = X
   c. DELETE FROM subscriptions WHERE user_id = X
   d. DELETE FROM watchlists WHERE user_id = X
   e. DELETE FROM push_tokens WHERE user_id = X
   f. DELETE FROM favorites WHERE user_id = X
   g. DELETE FROM public.users WHERE id = X
   h. supabase.auth.admin.deleteUser(X) — 移除 auth.users 中的紀錄
3. 所有 cascade 由 Supabase Postgres `ON DELETE CASCADE` 保證交易性
4. 若法規要求保留交易紀錄 → 不刪除、改**匿名化**（移除 user_id，保留金額 / 時間），在隱私權政策中說明
```

---

## 9. UI 元件與狀態（新增）

| 元件 | 位置 | 說明 |
|------|------|------|
| `QuotaIndicator` | 掃描頁頂部常駐 | 顯示「本月剩餘 N / 100」；subscriber 顯示「無上限」 |
| 達上限提示 | 掃描頁 modal | `已用完本月 100 次` → `[ 升級無限掃描 ]` `[ 下月再來 ]` |
| `UpgradeCTA` | 剩餘 < 10 時橫幅 | 溫和提示升級，不強制 |
| `PremiumLockOverlay` | 任何 premium 內容前 | §7.2 |
| 帳號區塊 | `SettingsScreen` | 顯示身分 / linked providers / 訂閱狀態 / 剩餘額度 / link provider / unlink / 登出 / 刪除帳號 |

沿用現有色彩系統（`src/constants/index.ts` 的 `COLORS`，見 `docs/UI-Design-Scan-Feature.md`）：主色 Hololive Pink、金色代表 premium。

---

## 10. 隱私權政策與商店文案（需同步更新）

因新增「帳號、訂閱、使用量/quota 紀錄」，以下需一併調整：

- **隱私權政策**需揭露：
  - 透過 Supabase Auth（Google / Apple OAuth）蒐集的識別資料（internal user id, provider_subject，可能為 Apple relay）。
  - 掃描使用量與 quota 紀錄之目的與保存期間。
  - 訂閱狀態與交易對應紀錄（不儲存信用卡號，金流由平台處理）。
  - 使用者行使刪除權的方式（見 §8.4）。
- **商店上架文案**（App Store / Google Play）需揭露：帳號登入、訂閱制內購項目與價格、資料蒐集用途（Apple Privacy Nutrition Label / Google Data Safety）。

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
| 7 | 本機竄改 quota 後掃描 | — | RLS + RPC 仍阻擋 | RPC 放行 |
| 8 | 檢視趨勢預測 | 鎖定 | 鎖定 | ✅ |
| 9 | 升級成功後 | — | 變 subscriber，解鎖 | — |
| 10 | 訂閱過期 | — | — | 回落 free 權限 |
| 11 | 刪除帳號 | — | 資料清除、回 Auth | 資料清除、回 Auth |
| 12 | 登出 | — | 回 Auth | 回 Auth |
| 13 | 連結第二個 provider | — | ✅ 可連結 | ✅ 可連結 |
| 14 | 解除最後一個 provider | — | ❌ 拒絕 | ❌ 拒絕 |
| 15 | Provider 身份衝突（collision） | — | 拒絕、不回傳合併 UI | 拒絕、不回傳合併 UI |

---

## 12. 限制與注意事項

- **不使用 Copilot**（額度已滿）、**不使用 OpenRouter**。
- iOS/Android 訂閱必須符合 App Store / Google Play 規範（IAP、Sign in with Apple、隱私標籤）。
- 額度授權一律以 Supabase RPC / RLS 為準，本機值僅供顯示。
- 身份識別以 `(provider, provider_subject)` 為 key，email 僅屬性（DIC-652）。
- 底層基礎設施為 **Supabase Auth + Supabase Postgres/RLS**（DIC-646 決策）。

---

## 13. 建議實作階段（Roadmap）

| 階段 | 內容 | 產出 |
|------|------|------|
| **P1 架構（本階段設計對象）** | 型別、`permissions.ts` 能力矩陣、`authStore`、路由分流、AuthScreen（mock OAuth）、QuotaIndicator/PremiumLockOverlay/UpgradeCTA 佔位 | 可跑的 UI flow，角色可手動切換測試 |
| **P2 後端授權** | Supabase Auth integration（OAuth + session）、Supabase Postgres schema / RLS / RPC（quota consume）、多 provider 身份連結 | session-based 授權，掃描額度以伺服器為準、防竄改 |
| **P3 訂閱金流** | IAP（iOS/Android）+ 後端收據驗證（Supabase Edge Function → 寫入 `subscriptions`）；Web Stripe 另評估 | 真正可訂閱、premium 解鎖 |
| **P4 合規與刪除** | 隱私權政策、商店文案、provider link/unlink/collision UI、`DELETE /api/user` 連動清除 | 上架合規 |

> P1 不含金流，符合「先設計登入後的擴充架構、不一定立刻實作金流」的需求；P3 之前所有 premium/quota 判斷均可用手動角色切換驗證。
> P2 對齊 DIC-646（Supabase Auth + Postgres/RLS）與 DIC-652（多 provider 連結模型）。
