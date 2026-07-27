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
-- 注意：不使用 ON DELETE CASCADE；帳號刪除時匿名化而非清除（法規稽核保留）
CREATE TABLE public.subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,   -- 匿名化：刪除 user 時 user_id → NULL
  status       text NOT NULL DEFAULT 'none',                           -- server-owned
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

**重要**：Supabase 託管平台的 GoTrue 預設會按 verified email 自動連結 OAuth identity。此行為**無法在 managed plan 關閉**。本設計接受此平台行為，但不依賴它作為 multi-provider 合併策略。所有 user-initiated linking 一律使用 `linkIdentity()` API。若需嚴格禁止所有 email-based auto-linking 並鎖定為純 manual linking，唯一可執行的方案為 self-hosted GoTrue 並自訂 before-identity-link Auth Hook 拒絕 email-based link。Managed plan 無法滿足此需求。

| 操作 | 規則 |
|------|------|
| **首次登入** | `signInWithOAuth({ provider })` → GoTrue 在 `auth.users` 建立/對應 row → `auth.identities` 自動記錄 `(provider, provider_id)` → trigger `on_auth_user_created` 在 `public.users` 建立 profile → service_role 同步寫入 `linked_auth_providers` mirror |
| **已登入 user 連結第二個 provider** | 使用 `supabase.auth.linkIdentity({ provider })`（**不是** `signInWithOAuth`）。Supabase Auth 在 `auth.identities` 新增 identity → service_role 同步 mirror 至 `linked_auth_providers` |
| **身份衝突（collision）** | `linkIdentity()` 時若 provider 已連結到同一個 user → **回傳 error**（非 idempotent no-op）。若連結到不同 user → 回傳 `provider already linked` error → 預設拒絕，不自動合併 |
| **解除連結（unlink）** | 使用 `supabase.auth.unlinkIdentity(identity)`，其中 `identity` 為 `getUserIdentities()` 回傳的完整 identity object（含 `id`, `provider`, `identity_data` 等欄位）。至少保留一個登入方式；若只剩一個 identity，`unlinkIdentity()` 回傳 error |
| **郵件屬性** | `provider_email` 僅為顯示/聯絡屬性，**絕不作為身份識別 key**（Apple private relay、Gmail 別名等不保證 email 固定） |
| **Verified-email auto-linking（平台行為）** | Managed Supabase GoTrue 若發現相同的 verified email 來自不同 OAuth → 會自動連結到同一個 `auth.users` row。此行為無法關閉，但可被 audit（`auth.identities` 會記錄）且不影響 user 身份管理。DIC-652 的「不因 email 無聲合併」在此範圍內受平台限制；對於嚴格不允許 auto-link 的情境，需評估 self-hosted |

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

**Supabase GoTrue verified-email automatic linking 背景**：Supabase 託管平台的 GoTrue 預設會將相同 verified email 的 OAuth 登入自動連結到同一個 `auth.users` row。此行為**無法在 managed Supabase 上關閉**（截至撰寫時）。本設計接受此平台行為無法避免，但不依賴它作為 multi-provider 合併機制。實質的身份邊界以 `auth.identities` 為真源；user-chosen linking 一律透過 `linkIdentity()`。

**必須啟用的設定**：
- Supabase Dashboard → Authentication → Settings → **Allow manual linking** → 開啟（self-hosted 設 `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=true`）。這是 `linkIdentity()` / `unlinkIdentity()` 的前置條件；未開啟則這些 API 不可用。

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

  -- fail-closed：沒有有效 active unexpired subscription → 一律走 free quota
  -- 不使用 users.role 作為 fallback；entitlement 只以 subscriptions 表為準
  v_role := 'free_user';
  IF EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = v_uid
      AND status = 'active'
      AND expires_at > now()
  ) THEN
    v_role := 'subscriber';
  END IF;

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

### 6.3 訂閱與 Quota / Premium 的邊界

- `scan_usage_monthly.limit_count` 在 free 階段固定為 100。
- **Quota 消費時直接驗證 `subscriptions`**（status + expires_at），不依賴可能延遲的 `users.role`。RPC `consume_scan_quota` 在同一個交易內查 `subscriptions` 表判斷是否 subscriber（見 §5.2），確保 entitlement 決策是即時的。
- **Premium entitlement 驗證同樣 fail-closed**：`require_premium()` RPC 直接查 `subscriptions` 表（status = 'active' AND expires_at > now()），role scheduler 未觸發時仍會正確拒絕。前端 role 僅供 UI 顯示。
- **Role scheduler**（備援機制，非 primary gate）：Edge Function 每日定時將 `subscriptions.status = 'active' AND expires_at > now()` 的使用者 `users.role` 同步為 `'subscriber'`；過期不 active 的還原為 `'free_user'`。此 scheduler 僅作為效能優化（避免每次 RPC 都 join subscriptions），不作為安全邊界。
- Entitlement 真源為 `subscriptions.status = 'active' AND expires_at > now()`；`users.role` 僅為 cached display value。

### 6.4 IAP Webhook Reconciliation（P3 實作設計）

App Store / Google Play 的 server-to-server notification（`SERVER_NOTIFICATION` / `RTDN`）可能丟失、重複、亂序到達。本設計遵循 fail-closed 原則：

**接收層（Supabase Edge Function service_role）**：

| 項目 | 設計 |
|------|------|
| Endpoint | `POST /api/subscription/webhook`（Edge Function，service_role） |
| 來源驗證 | App Store: 驗證 signed JWS（x-apple-certificate）；Google Play: 驗證 `developerNotification` signature + `purchaseToken` |
| 入口 | 先 INSERT `webhook_events` log table（deduplication key = `(platform, notification_uuid / purchase_token)`），成功後才處理 |
| 訂單去重 | `UNIQUE(notification_id)` + `ON CONFLICT DO NOTHING`（idempotent） |
| 亂序容忍 | 依 `latest_receipt_info` / `purchase_token` 的實際 status + expires_date_ms 覆蓋 `subscriptions` row 而非用 event timestamp 排序 |

**事件處理（idempotent per event type）**：

| 事件 | 處理 |
|------|------|
| DID_CHANGE_RENEWAL_STATUS / SUBSCRIPTION_PURCHASED | 寫入/更新 `subscriptions` row：`status='active'`, `expires_at` = receipt expires_date_ms, `auto_renew` = auto_renew_status |
| DID_FAIL_TO_RENEW / SUBSCRIPTION_EXPIRED | 寫入 `subscriptions.status='expired'`（若 receipt 已無 active period） |
| REFUND / SUBSCRIPTION_REVOKED | 寫入 `subscriptions.status='expired'`, `expires_at` = now()（立即撤銷 entitlement）。新增 `refund_events` log table 保留稽核軌跡 |
| DID_RECOVER（billing retry 成功） | 寫入 `subscriptions.status='active'` + 更新 `expires_at` |
| GRACE_PERIOD | `subscriptions.status='in_grace'`；quota/premium 在 grace period 內**仍維持 subscriber 權限**（Apple 政策要求） |

**定期 reconciliation（備援）**：
- Edge Function cron（daily）：對 `subscriptions.status = 'active' AND expires_at < now()` 的 row → 向 Apple/Google server API **重新查詢 subscription status**（GET `verifyReceipt` / `purchases.subscriptions.get`）
- 若 real-time webhook 遺漏 → reconciliation 在 24 小時內修正 `status` + `expires_at`
- Reconciliation 結果寫入 `reconciliation_log` table（含 timestamp, platform, receipt, before/after status）

**Fail-closed 行為**：每個 RPC（`consume_scan_quota` / `require_premium`）均直接查 `subscriptions` 表（status = 'active' AND expires_at > now()）。即使 webhook 完全失效 + reconciliation 未觸發，subscription 仍會在 `expires_at` 到期後自動拒絕（fail-closed）。

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
-- Premium entitlement check RPC
-- 直接驗證 subscriptions 狀態，fail-closed：role scheduler 未觸發時仍會檢查
CREATE OR REPLACE FUNCTION public.require_premium()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = v_uid
      AND status = 'active'
      AND expires_at > now()
  ) THEN
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

**真源 = Supabase `auth.identities`**（GoTrue 管理，不可繞過）。`public.linked_auth_providers` 僅為 mirror 快取供前端讀取（SELECT-only RLS）。Link/unlink 一律透過 Supabase Auth API `linkIdentity()` / `unlinkIdentity()`。Managed Supabase verified-email auto-linking 為平台預設行為（見 §2.4）。

### 8.2 Provider 連結流程（Link）

```
前提：使用者已登入（持有 session）

1. 使用者在設定頁點擊「連結 Google / Apple 帳號」
2. 呼叫 supabase.auth.linkIdentity({ provider: 'google' })
   （注意：不是 signInWithOAuth，是 linkIdentity）
3. 使用者完成 Google OAuth
4. GoTrue 在 auth.identities 新增 identity
5. 後端（Supabase Auth Hook / Edge Function service_role）同步 mirror 至 linked_auth_providers
6. 若 provider 已連結到當前 user → linkIdentity() 回傳 error（非 no-op）
7. 若 provider 已連結到其他 user → linkIdentity() 回傳 error "already linked"
8. 前端更新 linkedProviders 清單
```

### 8.3 身份衝突（Collision）處理

| 情境 | 處理 |
|------|------|
| linkIdentity() → provider 已屬於當前 user | linkIdentity() 回傳 error（非 idempotent）。前端應先檢查 `getUserIdentities()` 避免重複呼叫 |
| linkIdentity() → provider 已屬於另一個 user | 回傳 `provider already linked` error → 預設拒絕，不自動合併。UI 訊息："此帳號已連結至其他使用者。如需合併帳號，請聯繫客服。" |
| Verified-email auto-linking（managed Supabase 平台行為） | GoTrue 可能自動將相同 verified email 的 OAuth 連結到同一 row。本設計接受此行為，不依賴也無法阻止。若需要嚴格阻止，評估 self-hosted GoTrue（見 §2.4） |

> 手動合併流程（兩個 internal user 合併為一）為高風險操作，不在本階段 scope。僅在本文件預留碰撞規則，避免日後設計矛盾。

### 8.4 Provider 解除連結（Unlink）

```
前提：使用者已登入，auth.identities COUNT >= 2

1. 使用者在設定頁選擇要移除的 provider
2. 呼叫 supabase.auth.getUserIdentities() 取得完整 identity 清單
3. 前端確認："移除後將無法使用此帳號登入，確定要移除嗎？"
4. 呼叫 supabase.auth.unlinkIdentity(identity)
   — identity 參數為 getUserIdentities() 回傳的完整 identity object
   — 此 object 含 id, provider, identity_data, created_at 等欄位
5. GoTrue 移除 auth.identities 該筆
6. 若只剩一個 identity → unlinkIdentity() 回傳 error
7. 後端 service_role 同步刪除 linked_auth_providers mirror
8. 前端更新 linkedProviders 清單
```

### 8.5 帳號刪除（Cascade + 匿名化保留 + 復原性）

需求（DIC-661）：帳號刪除須一併刪除 scan usage / quota / subscription mapping，或匿名化必要交易紀錄。

```
前提：使用者已登入

1. 使用者在設定頁點擊「刪除帳號」→ 二次確認
2. Supabase Edge Function（service_role）執行兩階段刪除：

   階段 A：Postgres transaction（單一 DB connection，ACID）
     a. 將 public.subscriptions 的 user_id SET NULL（匿名化保留，ON DELETE SET NULL）
     b. DELETE FROM public.users WHERE id = v_uid
        → CASCADE 自動觸發 linked_auth_providers / scan_usage_monthly / watchlists / push_tokens / favorites
     c. COMMIT（以上操作在同一 Postgres transaction）

   階段 B：Admin API（跨越服務邊界，非同一 transaction）
     d. supabase.auth.admin.deleteUser(v_uid) — 移除 auth.users + auth.identities
        → 若 Admin API 失敗（網路/權限）→ DB 層已無 public.users row，user 無法再登入
        → 殘留的 auth.users row 為 orphan，不影響授權（RLS 綁定 auth.uid() 無對應 public.users → SELECT 回空）

3. 復原性（partial-failure recovery）：
   - 若階段 A 成功但階段 B 失敗 → schedule retry task（Edge Function DB queue 或 cron sweep），
     對 public.users 中不存在但 auth.users 中仍存在的 orphan user ID 補執行 deleteUser()
   - 若階段 A 失敗（任何原因）→ 完整 rollback，不觸發階段 B，user 不受影響

4. Subscription 匿名化保留為法規/稽核需要（App Store / Google Play 交易紀錄保留義務）

注意：auth.admin.deleteUser() 與 Postgres transaction **不共享 ACID 邊界**（Admin API 為 HTTP RPC 呼叫，非 SQL transaction）。文件不宣稱兩者為同一 atomic operation。
```

**刪除 vs 匿名化邊界**：

| 資料表 | 處理 | 原因 |
|--------|------|------|
| auth.users, public.users | CASCADE 刪除 | 核心識別資料 |
| linked_auth_providers | CASCADE 刪除 | 關聯識別資料 |
| scan_usage_monthly | CASCADE 刪除 | usage/quota 關聯（可選擇保留 aggregate 統計後刪除） |
| watchlists, favorites, push_tokens | CASCADE 刪除 | 使用者自選功能 |
| **subscriptions** | **匿名化（ON DELETE SET NULL）** | 平台 IAP 交易稽核保留義務 |

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
| 掃描使用量 | `scan_usage_monthly`: used, limit_count, period_key | quota 控管與服務改善 | 最多保留 24 個月（可選擇帳號刪除時 aggregate 統計後刪除單筆） | ON DELETE CASCADE |
| 訂閱狀態 | `subscriptions`: status, platform, product_id, expires_at | 訂閱服務交付 / 平台稽核 | **匿名化保留**：user_id → NULL；保留稽核軌跡（為 Apple/Google 金流合規） | ON DELETE SET NULL（匿名化，不刪除） |
| 收藏 / 入手提醒 | `watchlists`, `favorites`（加入 schema 時） | 使用者自選功能 | 帳號存在期間 | ON DELETE CASCADE |
| 推播 token | `push_tokens`: expo Push Token（由 Expo Push API 產生，經由 FCM/APNs 傳送） | 入手提醒推播通知 | 帳號存在期間或 token 手動失效 | ON DELETE CASCADE |
| Expo 處理者資料 | Expo Push Notification Service 遞送推播時使用的 Expo Push Token + 推播內容 payload。傳送過程經由 FCM（Android）/ APNs（iOS） | 推播通知遞送 | Expo Push Token 儲存於本 App 資料庫；FCM/APNs 端依 Apple/Google 政策保留 | 刪除 `push_tokens` row 即不再傳送；Expo/FCM/APNs 的服務端資料留存依各平台隱私權政策（非本 App 可控） |
| 裝置資訊 | 作業系統版本 / App 版本（經由 Supabase Auth session metadata） | 安全性與問題排解 | 180 天 | 隨 session 過期清除 |
| Supabase 處理者資料 | Supabase 平台本身的 logs / metrics / auth events（非本 App 可控，儲存於 Supabase 基礎設施） | 平台營運 | 依 Supabase 隱私權政策與資料處理合約 | 不屬本 App 刪除範圍；平台端留存依 Supabase policy |
| App 設定 | 語言、幣別偏好（Zustand localStorage/AsyncStorage，**僅本機儲存，不傳送 server**，不經 Supabase。沒有 server sync） | 個人化體驗 | 本機持久化；刪除 App 時清除 | 本機資料清除 |

### 10.2 隱私權政策需揭露

- 透過 Supabase Auth（Google / Apple OAuth）蒐集的識別資料（auth user id, provider identity，可能為 Apple private relay email）。
- 掃描使用量與 quota 紀錄之目的（quota 上限控管、服務品質改善）與保存期間。
- 訂閱狀態與交易對應紀錄（不儲存信用卡號，金流由 Apple / Google 平台處理）。
- 使用者行使刪除權的方式（見 §8.5）。刪除時一併清除所有可識別資料；依法規需保留的交易紀錄（subscriptions）將匿名化處理。
- 本 App 使用以下第三方資料處理者：**Supabase**（認證、資料庫、session）、**Expo**（推播通知遞送，經由 FCM/APNs）、**Apple / Google**（OAuth 登入、應用內購金流）。各處理者的資料留存政策請見其隱私權政策。
- 本 App 不追蹤使用者跨 App/網站行為、不分享個人資料予第三方（除上述處理者於服務必要範圍內）。

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
| 18 | Verified-email auto-linking | — | 平台行為，GoTrue 自動合併（接受） | 平台行為，GoTrue 自動合併（接受） |

---

## 12. 限制與注意事項

- **不使用 Copilot**（額度已滿）、**不使用 OpenRouter**。
- iOS/Android 訂閱必須符合 App Store / Google Play 規範（IAP、Sign in with Apple、隱私標籤）。
- 額度授權一律以 Supabase RPC（SECURITY DEFINER，內部取 `auth.uid()`）為準，本機值僅供顯示。
- 身份識別真源為 Supabase `auth.identities`；`linked_auth_providers` 僅為 mirror。
- Managed Supabase verified-email auto-linking 為 GoTrue 預設行為，無法在 managed plan 上關閉；本設計接受此限制並以 `auth.identities` / `linkIdentity()` 管理 user-chosen linking。嚴格禁止 auto-link 且需可執行的方案為 self-hosted GoTrue + Auth Hook。
- 底層基礎設施為 **Supabase Auth + Supabase Postgres/RLS**（DIC-646 決策）。
- 所有 server-owned 欄位（role, quota, subscription, identity）只透過 controlled channel 變更，client 端 RLS SELECT-only。
- Premium/quota entitlement 以 transaction 內直接查 `subscriptions` 表（status + expires_at）為準，fail-closed；`users.role` 僅為 cached display。

---

## 13. 建議實作階段（Roadmap）

| 階段 | 內容 | 產出 |
|------|------|------|
| **P1 架構（本階段設計對象）** | 型別、`permissions.ts` 能力矩陣、`authStore`、路由分流、AuthScreen（mock OAuth）、QuotaIndicator/PremiumLockOverlay/UpgradeCTA 佔位 | 可跑的 UI flow，角色可手動切換測試 |
| **P2 後端授權** | Supabase Auth integration（OAuth + session + linkIdentity/unlinkIdentity）、啟用 Allow manual linking、Postgres schema + RLS（SELECT-only）+ RPC（consume_scan_quota / require_premium）+ trigger `on_auth_user_created` | session-based 授權，掃描額度以伺服器為準、防竄改 |
| **P3 訂閱金流** | IAP（iOS/Android）+ 後端收據驗證（Supabase Edge Function service_role → 寫入 `subscriptions` + 更新 `users.role`）；Web Stripe 另評估 | 真正可訂閱、premium 解鎖 |
| **P4 合規與刪除** | 隱私權政策、商店文案（含完整資料清單）、provider link/unlink/collision UI、`auth.admin.deleteUser()` cascade 清除 | 上架合規 |

> P1 不含金流，符合「先設計登入後的擴充架構、不一定立刻實作金流」的需求；P3 之前所有 premium/quota 判斷均可用手動角色切換驗證。
> P2 對齊 DIC-646（Supabase Auth + Postgres/RLS）與 DIC-652（多 provider 連結模型）。
