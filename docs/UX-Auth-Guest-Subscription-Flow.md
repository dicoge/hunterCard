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

### 1.4 安全原則（RLS 最小權限）

本設計採用 **RLS 最小權限模型**：所有 table 只開放 `SELECT` policy 給 authenticated user（只讀自己的 row），**不開放 INSERT/UPDATE/DELETE**。Server-owned 欄位（`role`, quota, subscription, identity mapping）的 mutation 一律透過 controlled RPC / Edge Function / service_role 執行，client 端無法直接寫入。前端 overlay 僅作 UX 層，所有授權決策必須在 server 端驗證。

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

所有 user 相關資料儲存於 Supabase Postgres，以 **internal user id** 為單一資料歸屬與 RLS 邊界。`public.users` 由 Supabase Auth trigger 在 `auth.users` INSERT 時自動建立（以 `NEW.id` 為 profile id），不以 `gen_random_uuid()` 另產 UUID。

```sql
-- ═══════════════════════════════════════════════════════════
-- Trigger: 當 Supabase Auth 建立新使用者時，自動建立 profile
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, role)
  VALUES (NEW.id, 'free_user');
  RETURN NEW;
END;
$$;

-- 掛在 auth.users 的 INSERT trigger 上
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ═══════════════════════════════════════════════════════════
-- 核心使用者表（profile，id = auth.users.id）
-- ═══════════════════════════════════════════════════════════
CREATE TABLE public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  avatar_url    text,
  role          text NOT NULL DEFAULT 'free_user',            -- 'free_user' | 'subscriber'（server-owned）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 多 provider 身份連結表（身份真源 = auth.identities，此表為 mirror/快取）
-- (provider, provider_subject) 為 identity key
CREATE TABLE public.linked_auth_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          text NOT NULL,                            -- 'google' | 'apple'
  provider_subject  text NOT NULL,                            -- provider-issued sub claim
  provider_email    text,                                     -- 屬性（Apple private relay 可能為空）
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

-- 掃描額度表（每月一筆 per user）
CREATE TABLE public.scan_usage_monthly (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  period_key  text NOT NULL,                                  -- 'YYYY-MM'
  used        integer NOT NULL DEFAULT 0,                     -- server-owned
  limit_count integer NOT NULL DEFAULT 100,

  UNIQUE (user_id, period_key)
);

-- 訂閱狀態表（未來 IAP 對接，預留欄位）
CREATE TABLE public.subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'none',                   -- server-owned
  platform     text,
  product_id   text,
  expires_at   timestamptz,
  auto_renew   boolean DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════
-- RLS policies — 最小權限：SELECT only（client 不可修改 server-owned 欄位）
-- ═══════════════════════════════════════════════════════════
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_self ON public.users
  FOR SELECT USING (auth.uid() = id);

ALTER TABLE public.linked_auth_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY providers_read_self ON public.linked_auth_providers
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.scan_usage_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY scan_read_self ON public.scan_usage_monthly
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subs_read_self ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- 說明：INSERT/UPDATE/DELETE 不開 policy 給 authenticated/anonymous。
-- role、quota、subscription、identity 的 mutation 只透過：
--   1. SECURITY DEFINER RPC（內部用 auth.uid()）
--   2. Supabase Edge Function（service_role key）
--   3. DB trigger（handle_new_user 等）
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

身份真源為 **Supabase `auth.identities`**（由 GoTrue 在每次 OAuth sign-in 時自動管理）。`public.linked_auth_providers` 為 mirror 快取供前端讀取。**不使用自建平行 table 取代 Supabase Auth 本身的 user/identity mapping**。

**重要：關閉 Supabase 預設的 automatic email linking**。Supabase GoTrue 預設會將相同 verified email 的 OAuth 登入自動連結到同一個 `auth.users` row。這與本設計「絕不因 email 無聲合併」衝突。必須在 Supabase Dashboard → Authentication → Settings 關閉 `Automatic linking`，或透過 GoTrue config 設定 `GOTRUE_EXTERNAL_EMAIL_AUTO_CONFIRM_AND_LINK=false`。

| 操作 | 規則 |
|------|------|
| **首次登入** | `signInWithOAuth({ provider })` → Supabase Auth 在 `auth.users` 建立 row → `auth.identities` 自動記錄 `(provider, provider_id)` → trigger `on_auth_user_created` 在 `public.users` 建立 profile → RPC/service_role 同步寫入 `linked_auth_providers` |
| **已登入 user 連結第二個 provider** | 使用 `supabase.auth.linkIdentity({ provider })`（**不是** `signInWithOAuth`），Supabase Auth 在 `auth.identities` 新增 identity → service_role 同步 mirror 至 `linked_auth_providers` |
| **身份衝突（collision）** | 若新 provider 的 `(provider, provider_id)` 已存在於另一個 `auth.users` → Supabase Auth 的 `linkIdentity()` 會回傳 `provider already linked` 錯誤 → 預設拒絕，不自動合併 |
| **解除連結（unlink）** | 使用 `supabase.auth.unlinkIdentity({ identity_id })`。至少保留一個登入方式；若只剩一個 identity，Supabase Auth 拒絕移除（但可嘗試用前端判斷攔截於呼叫前） |
| **郵件屬性** | `provider_email` 僅為顯示/聯絡屬性，**絕不作為身份識別 key**（Apple private relay、Gmail 別名等不保證 email 固定）。關閉 automatic email linking 後，GoTrue 即使看到相同 email 也不會合併 |
| **無聲郵件合併** | **已透過關閉 `Automatic linking` 封鎖** — 不因兩個 provider 回傳同一個 email 就自動合併帳號（DIC-652 規定） |

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

**基礎設施**：使用 Supabase Auth 管理 OAuth flow、session token（JWT）、refresh token 等（DIC-646 決策）。

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

**必須關閉的設定**（避免與 DIC-652 衝突）：
- Supabase Dashboard → Authentication → Settings → **Automatic linking** → 關閉（否則相同 email 的 OAuth 會自動合併帳號）

### 4.2 Login flow（以 Google 為例）

```
使用者點擊 [Google 登入]
  → supabase.auth.signInWithOAuth({ provider: 'google' })
  → Supabase Auth 重導向至 Google 同意畫面
  → 使用者同意 → callback 回 Supabase GoTrue
  → GoTrue 在 auth.users 建立/對應帳號 + auth.identities 記錄 provider
  → Trigger on_auth_user_created 在 public.users 自動建立 profile
  → 前端收到 session（JWT）
  → 前端從 session 解析 auth.uid() = internal user id
  → 查 public.linked_auth_providers（mirror）取得已連結的 provider 清單 → 進入 MainDrawer
```

### 4.3 Session 驗證（全端共用）

- 前端：Supabase JWT 自動存在 `Authorization: Bearer <token>` header。
- Postgres RLS：`auth.uid()` 自動解析 JWT 中的 `sub` claim。
- Quota / subscription / identity 操作：呼叫 Supabase RPC（SECURITY DEFINER，內部取 `auth.uid()`）或 Edge Function（service_role key），不開放 client 直接寫入 table。
- 本階段可先以 **mock OAuth service（`src/services/authService.ts`）** 讓 UI flow 可跑，真實 Supabase SDK 之後替換該檔即可，不動 UI。

---

## 5. 掃描 Quota 系統（防竄改 / Supabase RPC）

### 5.1 原則：**伺服器為準（server-authoritative）**

本機（Zustand persist / localStorage / AsyncStorage）易被竄改，因此：

- 本機只做 **UI 快取與樂觀顯示**，不可作為授權依據。
- 每次掃描前呼叫 Supabase RPC `consume_scan_quota()`（無參數，由函式內部取 `auth.uid()`）。
- Quota 紀錄存在 `public.scan_usage_monthly`，以 RLS（SELECT only）+ SECURITY DEFINER RPC 防竄改。

### 5.2 Supabase RPC（Server-side）

```sql
-- Scans RPC: 原子遞增並檢查。
-- 由 server 內部取 auth.uid()，不接受前端傳入 user_id。
-- 只授權 authenticated user 執行。
CREATE OR REPLACE FUNCTION public.consume_scan_quota()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_period text := to_char(now(), 'YYYY-MM');
  v_role   text;
  v_rec    public.scan_usage_monthly;
  v_limit  integer := 100;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0002';
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_uid;

  INSERT INTO public.scan_usage_monthly (user_id, period_key, limit_count)
  VALUES (v_uid, v_period, v_limit)
  ON CONFLICT (user_id, period_key) DO NOTHING;

  IF v_role = 'subscriber' THEN
    UPDATE public.scan_usage_monthly
    SET used = used + 1, limit_count = -1
    WHERE user_id = v_uid AND period_key = v_period
    RETURNING * INTO v_rec;
  ELSE
    SELECT * INTO v_rec FROM public.scan_usage_monthly
    WHERE user_id = v_uid AND period_key = v_period
    FOR UPDATE;

    IF v_rec.used >= v_limit THEN
      RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.scan_usage_monthly
    SET used = used + 1
    WHERE user_id = v_uid AND period_key = v_period
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

-- 權限控制：撤銷 PUBLIC / anon，只 grant authenticated
REVOKE EXECUTE ON FUNCTION public.consume_scan_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_scan_quota() TO authenticated;
```

### 5.3 前端呼叫

```ts
// src/services/quotaService.ts
import { supabase } from '../lib/supabase';

export async function consumeScanQuota() {
  const { data, error } = await supabase
    .rpc('consume_scan_quota');  // 無參數，server 取 auth.uid()

  if (error) {
    if (error.message?.includes('quota_exceeded')) {
      return { success: false, reason: 'quota_exceeded' as const };
    }
    throw error;
  }

  return { success: true, ...data } as const;
}
```

- subscriber：RPC 內直接放行（不計上限但仍記錄使用量）。
- 掃描實際扣額時機：建議在 **OCR/辨識成功送出查價前**扣一次，避免相機開啟即扣。
- 離線 / API 失敗策略：拒絕掃描並提示重試，**不可**因失敗就本機放行（否則等同繞過上限）。

### 5.4 每月自動重置

Postgres 的 `period_key` 為 `YYYY-MM` 格式，**每月自然分區**。無需排程 cron job 刪除舊 row——查詢時自動建立新月份的 row（見 RPC `ON CONFLICT ... DO NOTHING`）。舊 row 可保留作為使用紀錄（用戶儀表板 / 隱私權政策提及的「使用量」）。

### 5.5 與現有掃描流程的接點

`src/screens/ScanScreen.tsx` / `src/services/autoScanService.ts`：在觸發辨識前插入 `consume` 檢查；成功才續跑既有辨識 → 查價流程。

---

## 6. 訂閱狀態（Subscription）

### 6.1 資料模型

`SubscriptionState`（見 §2.1 ）以 Supabase Postgres `public.subscriptions` table 為準，本機快取顯示。以 RLS（SELECT only）保護；mutation 由 service_role 執行。

### 6.2 平台策略

| 平台 | 方案 | 本階段 |
|------|------|--------|
| iOS | App Store IAP（auto-renewable subscription） | 僅設計介面，`UpgradeScreen` 佔位 |
| Android | Google Play Billing | 同上 |
| Web | Stripe（或先不做） | 先不做，保留 `platform: 'stripe'` 欄位 |

- 未來以 `expo-in-app-purchases` / RevenueCat 類抽象層對接；`SubscriptionState` 介面已可容納。
- **收據驗證必須在後端**（Supabase Edge Function → 寫入 `public.subscriptions`），前端不可信任本機訂閱旗標。
- 合規：iOS/Android 的訂閱購買必須走各平台 IAP，不可導流到外部網頁金流（App Store / Google Play 規範）。

### 6.3 訂閱與 Quota 的邊界

- `scan_usage_monthly.limit_count` 在 free 階段固定為 100。
- subscriber 階段：RPC `consume_scan_quota` 在 `users.role = 'subscriber'` 時跳過上限檢查（但仍記錄使用量）。
- 訂閱過期回落：`subscriptions.status = 'expired'` 時，將 `users.role` 還原為 `'free_user'`（由 Supabase Edge Function scheduler 觸發）→ 下次掃描時進入 free 邏輯。
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

### 7.3 Entitlement 判斷（雙層授權）

**前端**：`permissions.ts` → `can(role, 'premium.pricePrediction')`；role 來自 server（透過 Supabase session 中的 `app_metadata` / public.users.role）。前端 overlay 僅作 UX，**不作為安全邊界**。

**後端**（必須）：所有 premium 資料的 API / RPC / Edge Function / 資料查詢端點必須**獨立檢查 entitlement**：

```sql
-- Premium entity check RPC（範例）
CREATE OR REPLACE FUNCTION public.require_premium()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0002';
  END IF;
  SELECT role INTO v_role FROM public.users WHERE id = auth.uid();
  IF v_role != 'subscriber' THEN
    RAISE EXCEPTION 'premium_required' USING ERRCODE = 'P0003';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.require_premium() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_premium() TO authenticated;
```

所有 premium RPC / endpoint 必須在最前呼叫 `require_premium()`，確保即使使用者繞過前端、直接呼叫 API，也無法取得 premium 資料。

---

## 8. Provider Link / Unlink / Collision / Delete Account（DIC-652 邊界）

### 8.1 身份真源

**真源 = Supabase `auth.identities`**（GoTrue 管理，不可繞過）。`public.linked_auth_providers` 僅為 mirror 快取供前端讀取（SELECT-only RLS）。Link/unlink 一律透過 Supabase Auth API，[Automatic email linking 必須關閉](#41-supabase-auth-設定)。

### 8.2 Provider 連結流程（Link）

```
前提：使用者已登入（持有 session）

1. 使用者在設定頁點擊「連結 Google / Apple 帳號」
2. 呼叫 supabase.auth.linkIdentity({ provider: 'google' })
   （注意：不是 signInWithOAuth，是 linkIdentity）
3. 使用者完成 Google OAuth
4. Supabase Auth 在 auth.identities 新增 identity
5. 後端（Supabase Auth Hook / Edge Function service_role）同步 mirror 至 linked_auth_providers
6. 若 provider 已連結到其他 user → linkIdentity() 回傳 error "provider already linked"
7. 前端更新 linkedProviders 清單
```

### 8.3 身份衝突（Collision）處理

| 情境 | 處理 |
|------|------|
| linkIdentity() → provider 已屬於同一個 user | 無動作（idempotent） |
| linkIdentity() → provider 已屬於另一個 user | Supabase Auth 回傳 `provider already linked` → 預設拒絕，不自動合併。UI 訊息："此帳號已連結至其他使用者。如需合併帳號，請聯繫客服。" |
| 兩個 provider 回傳相同 email 但不相同的 provider_id | Automatic email linking 已關閉 → 兩個獨立的 `auth.users` row，**不自動合併**（DIC-652 規定） |

> 手動合併流程（兩個 internal user 合併為一）為高風險操作，不在本階段 scope。僅在本文件預留碰撞規則，避免日後設計矛盾。

### 8.4 Provider 解除連結（Unlink）

```
前提：使用者已登入，auth.identities COUNT >= 2

1. 使用者在設定頁選擇要移除的 provider
2. 前端確認："移除後將無法使用此帳號登入，確定要移除嗎？"
3. 呼叫 supabase.auth.unlinkIdentity({ identity_id: '<from auth.identities>' })
4. Supabase Auth 移除 auth.identities 該筆
5. 若只剩一個 identity → unlinkIdentity() 回傳 error
6. 後端 service_role 同步刪除 linked_auth_providers mirror
7. 前端更新 linkedProviders 清單
```

### 8.5 帳號刪除（Cascade）

需求（DIC-661）：帳號刪除須一併刪除 scan usage / quota / subscription mapping，或匿名化必要交易紀錄。

```
前提：使用者已登入

1. 使用者在設定頁點擊「刪除帳號」→ 二次確認
2. Supabase Edge Function（service_role）執行 cascade delete：
   a. supabase.auth.admin.deleteUser(uid) — 移除 auth.users → ON DELETE CASCADE 自動觸發
   b. public.users（profile）
   c. linked_auth_providers
   d. scan_usage_monthly
   e. subscriptions
   f. watchlists / push_tokens / favorites（加入 schema 時建 FOREIGN KEY … ON DELETE CASCADE）
3. 所有 cascade 由 Postgres ON DELETE CASCADE 保證交易性
4. 若法規要求保留交易紀錄 → 不刪除、改**匿名化**（移除 user_id，保留金額 / 時間），在隱私權政策中說明
```

---

## 9. UI 元件與狀態（新增）

| 元件 | 位置 | 說明 |
|------|------|------|
| `QuotaIndicator` | 掃描頁頂部常駐 | 顯示「本月剩餘 N / 100」；subscriber 顯示「無上限」 |
| 達上限提示 | 掃描頁 modal | `已用完本月 100 次` → `[ 升級無限掃描 ]` `[ 下月再來 ]` |
| `UpgradeCTA` | 剩餘 < 10 時橫幅 | 溫和提示升級，不強制 |
| `PremiumLockOverlay` | 任何 premium 內容前 | §7.2（UX only，不替代 server-side check） |
| 帳號區塊 | `SettingsScreen` | 顯示身分 / linked providers / 訂閱狀態 / 剩餘額度 / link provider / unlink / 登出 / 刪除帳號 |

沿用現有色彩系統（`src/constants/index.ts` 的 `COLORS`，見 `docs/UI-Design-Scan-Feature.md`）：主色 Hololive Pink、金色代表 premium。

---

## 10. 隱私權政策與商店文案（需同步更新）

因新增「帳號、訂閱、使用量/quota 紀錄」，以下需一併調整。

### 10.1 完整資料清單

| 資料類別 | 欄位 / 儲存位置 | 蒐集原因 | 保存期間 | 刪除方式 |
|----------|----------------|----------|----------|----------|
| OAuth 識別 | `auth.users.id`, `auth.identities` 的 `provider` / `provider_id` | 身份辨識與登入 | 帳號存在期間 | `auth.admin.deleteUser()` cascade |
| 個人檔案 | `public.users`: display_name, avatar_url | 個人化顯示 | 帳號存在期間 | ON DELETE CASCADE |
| 聯絡資訊 | `linked_auth_providers.provider_email`（可能為 Apple private relay） | 聯絡 / 通知（選填） | 帳號存在期間 | ON DELETE CASCADE |
| 掃描使用量 | `scan_usage_monthly`: used, limit_count, period_key | quota 控管與服務改善 | 最多保留 24 個月（含已過期月份的 aggregate 紀錄） | ON DELETE CASCADE 或匿名化（法規要求時） |
| 訂閱狀態 | `subscriptions`: status, platform, product_id, expires_at | 訂閱服務交付 | 帳號存在期間 + 法定稽核保留期 | ON DELETE CASCADE 或匿名化 |
| 收藏 / 入手提醒 | `watchlists`, `favorites`（加入 schema 時） | 使用者自選功能 | 帳號存在期間 | ON DELETE CASCADE |
| 推播 token | `push_tokens`: expo Push Token | 入手提醒推播通知 | 帳號存在期間或 token 失效 | ON DELETE CASCADE |
| 裝置資訊 | 作業系統版本 / App 版本（經由 Supabase Auth session metadata） | 安全性與問題排解 | 180 天 | 隨 session 過期清除 |
| App 設定 | 語言、幣別偏好（Zustand localStorage/AsyncStorage，本機不傳送） | 個人化體驗 | 本機持久化，刪除 App 時清除 | 本機資料清除 |

### 10.2 隱私權政策需揭露

- 透過 Supabase Auth（Google / Apple OAuth）蒐集的識別資料（auth user id, provider identity，可能為 Apple private relay email）。
- 掃描使用量與 quota 紀錄之目的（quota 上限控管、服務品質改善）與保存期間。
- 訂閱狀態與交易對應紀錄（不儲存信用卡號，金流由 Apple / Google 平台處理）。
- 使用者行使刪除權的方式（見 §8.5）。刪除時一併清除所有可識別資料；依法規需保留的交易紀錄將匿名化處理。
- 本 App 不追蹤使用者跨 App/網站行為、不分享個人資料予第三方（除金流平台 Apple / Google）。

### 10.3 商店上架文案

（App Store / Google Play）需揭露：帳號登入（OAuth、不提供帳號密碼）、訂閱制內購項目與價格（$X/月或年）、資料蒐集用途（Apple Privacy Nutrition Label / Google Data Safety Section）。

---

## 11. QA 測試矩陣（guest / free / subscriber）

| # | 情境 | guest | free_user | subscriber |
|---|------|-------|-----------|------------|
| 1 | 冷啟動落點 | AuthScreen | 主頁 | 主頁 |
| 2 | 查看現價 | ✅ | ✅ | ✅ |
| 3 | 進入掃描 | 登入引導 | ✅ | ✅ |
| 4 | 掃描第 100 張 | — | ✅（達上限） | ✅ |
| 5 | 掃描第 101 張 | — | RPC 阻擋 + 升級 CTA | ✅ |
| 6 | 跨月後額度 | — | 重置為 100 | 無上限 |
| 7 | 本機竄改 quota 後掃描 | — | RPC 仍阻擋（只取 auth.uid()） | RPC 放行 |
| 8 | 檢視趨勢預測 | 前端鎖定 + server 拒回 | 前端鎖定 + server 拒回 | ✅ |
| 9 | 直接呼叫 premium API（繞過前端） | server-side check 拒回 | server-side check 拒回 | ✅ |
| 10 | 透過 API 直接修改自己的 role | RLs SELECT-only 拒絕 | RLs SELECT-only 拒絕 | RLs SELECT-only 拒絕 |
| 11 | 升級成功後 | — | 變 subscriber（server 端更新 role） | — |
| 12 | 訂閱過期 | — | — | 回落 free 權限 |
| 13 | 刪除帳號 | — | cascade 清除、回 Auth | cascade 清除、回 Auth |
| 14 | 登出 | — | 回 Auth | 回 Auth |
| 15 | 連結第二個 provider | — | linkIdentity() ✅ | linkIdentity() ✅ |
| 16 | 解除最後一個 provider | — | unlinkIdentity() 拒絕 | unlinkIdentity() 拒絕 |
| 17 | Provider 身份衝突（collision） | — | linkIdentity() 拒絕 | linkIdentity() 拒絕 |
| 18 | Automatic email linking 合併帳號 | — | 已關閉，不合併 | 已關閉，不合併 |

---

## 12. 限制與注意事項

- **不使用 Copilot**（額度已滿）、**不使用 OpenRouter**。
- iOS/Android 訂閱必須符合 App Store / Google Play 規範（IAP、Sign in with Apple、隱私標籤）。
- 額度授權一律以 Supabase RPC（SECURITY DEFINER，內部取 `auth.uid()`）為準，本機值僅供顯示。
- 身份識別真源為 Supabase `auth.identities`；`linked_auth_providers` 僅為 mirror。
- **Supabase Automatic email linking 必須關閉**（見 §4.1），避免與 DIC-652「不因 email 無聲合併」衝突。
- 底層基礎設施為 **Supabase Auth + Supabase Postgres/RLS**（DIC-646 決策）。
- 所有 server-owned 欄位（role, quota, subscription, identity）只透過 controlled channel 變更，client 端 RLs SELECT-only。

---

## 13. 建議實作階段（Roadmap）

| 階段 | 內容 | 產出 |
|------|------|------|
| **P1 架構（本階段設計對象）** | 型別、`permissions.ts` 能力矩陣、`authStore`、路由分流、AuthScreen（mock OAuth）、QuotaIndicator/PremiumLockOverlay/UpgradeCTA 佔位 | 可跑的 UI flow，角色可手動切換測試 |
| **P2 後端授權** | Supabase Auth integration（OAuth + session + linkIdentity/unlinkIdentity）、關閉 auto email linking、Postgres schema + RLS（SELECT-only）+ RPC（consume_scan_quota / require_premium）、trigger `on_auth_user_created` | session-based 授權，掃描額度以伺服器為準、防竄改 |
| **P3 訂閱金流** | IAP（iOS/Android）+ 後端收據驗證（Supabase Edge Function service_role → 寫入 `subscriptions` + 更新 `users.role`）；Web Stripe 另評估 | 真正可訂閱、premium 解鎖 |
| **P4 合規與刪除** | 隱私權政策、商店文案（含完整資料清單）、provider link/unlink/collision UI、`auth.admin.deleteUser()` cascade 清除 | 上架合規 |

> P1 不含金流，符合「先設計登入後的擴充架構、不一定立刻實作金流」的需求；P3 之前所有 premium/quota 判斷均可用手動角色切換驗證。
> P2 對齊 DIC-646（Supabase Auth + Postgres/RLS）與 DIC-652（多 provider 連結模型）。
