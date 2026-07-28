# HoloHunter 登入 / 訪客 / 升級訂閱 UX Flow 與擴充架構設計
# HoloHunter Auth / Guest / Subscription UX Flow & Extensible Architecture

> 對應議題：DIC-661 `[UX] HoloHunter 登入/訪客/升級訂閱 UI Flow`
>
> **本文件範圍**：設計「登入功能後的擴充架構」與完整 UX flow。依需求限制，**現階段先定架構、不立刻實作金流（IAP / Stripe）**。所有金流相關項目以「介面 + 佔位」方式預留，之後可無痛接上。
>
> **底層基礎設施**：本設計對齊 DIC-646（Auth 架構決策 = **Supabase Auth + Supabase Postgres/RLS**）與 DIC-652（多 provider 身份連結模型）。使用 Supabase 作為後端基礎設施，不使用自建 callback token 驗證 / Vercel KV / @vercel/kv。

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
- 明確限制：**不使用 Copilot**。OpenRouter 僅供現有卡牌辨識（非本設計新增依賴）。

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
-- Trigger: 當 Supabase Auth 建立新使用者時，自動建立 profile
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

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 核心使用者表（profile，id = auth.users.id）
CREATE TABLE public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text,
  avatar_url    text,
  role          text NOT NULL DEFAULT 'free_user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Mirror table: 對應 auth.identities（SELECT-only RLS）
CREATE TABLE public.linked_auth_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  provider_subject  text NOT NULL,
  provider_email    text,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE TABLE public.scan_usage_monthly (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  period_key  text NOT NULL,
  used        integer NOT NULL DEFAULT 0,
  limit_count integer NOT NULL DEFAULT 100,

  UNIQUE (user_id, period_key)
);

-- 匿名化保留（ON DELETE SET NULL，不 cascade）
CREATE TABLE public.subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'none',
  platform                text,
  product_id              text,
  original_transaction_id text,                       -- Apple: original_transaction_id（stable across renewal）
  purchase_token          text,                       -- Google: current purchase_token（會在 upgrade/downgrade/re-signup 時變更；非 stable identity）
  linked_purchase_token   text,                       -- Google: linkedPurchaseToken（指向前一 token，用於 reconciliation）
  expires_at              timestamptz,                -- 一般 expires_date_ms / expiryTime
  grace_expires_at        timestamptz,                -- Apple: gracePeriodExpiresDate; Google: 依 grace period end 計算
  auto_renew              boolean DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT subs_platform_check CHECK (
    platform IN ('app_store', 'google_play', 'stripe') AND
    (platform != 'app_store' OR (original_transaction_id IS NOT NULL AND purchase_token IS NULL)) AND
    (platform != 'google_play' OR (purchase_token IS NOT NULL AND original_transaction_id IS NULL))
  ),
  CONSTRAINT subs_apple_tx_unique UNIQUE NULLS NOT DISTINCT (platform, original_transaction_id),
  CONSTRAINT subs_google_token_unique UNIQUE NULLS NOT DISTINCT (platform, purchase_token)
);

-- Google linkedPurchaseToken reconciliation:
-- upgrade/downgrade/re-signup 會產生新 purchase_token，linkedPurchaseToken 指向舊 token。
-- Webhook 收到新 token → 查 subscriptions WHERE purchase_token = linkedPurchaseToken → 將舊 row SET status='superseded'
-- → 新 row 繼承同 user_id。亂序時：若舊 token 事件較晚到 → 僅記錄 superseded history，不影響 active entitlement。

-- 帳號刪除 deny marker（階段 A commit 前寫入；所有 RPC/route 入口處檢查）
CREATE TABLE public.deleted_users (
  user_id    uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deleted_users ENABLE ROW LEVEL SECURITY;
-- 無 SELECT policy（只由 SECURITY DEFINER 函式內部查詢，client 不可見）

-- RLS: SELECT only + deleted_users marker
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_self ON public.users
  FOR SELECT USING (auth.uid() = id AND NOT EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid()));

ALTER TABLE public.linked_auth_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY providers_read_self ON public.linked_auth_providers
  FOR SELECT USING (auth.uid() = user_id AND NOT EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid()));

ALTER TABLE public.scan_usage_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY scan_read_self ON public.scan_usage_monthly
  FOR SELECT USING (auth.uid() = user_id AND NOT EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid()));

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subs_read_self ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id AND NOT EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid()));
```

### 2.2 型別設計（新增至 `src/types/index.ts`）

```ts
export type UserRole = 'guest' | 'free_user' | 'subscriber';

export interface AuthUser {
  id: string;
  displayName?: string;
  avatarUrl?: string;
  role: UserRole;
  linkedProviders: LinkedProvider[];
}

export interface LinkedProvider {
  provider: 'google' | 'apple';
  providerSubject: string;
  providerEmail?: string;
  linkedAt: string;
  lastLoginAt: string;
}

export type Capability =
  | 'card.browse' | 'card.scan' | 'favorites.use' | 'watchlist.use'
  | 'premium.pricePrediction' | 'premium.trendPrediction' | 'premium.advancedMarket';

export interface SubscriptionState {
  status: 'none' | 'active' | 'expired' | 'in_grace' | 'pending';
  platform?: 'app_store' | 'google_play' | 'stripe';
  productId?: string;
  expiresAt?: string;
  autoRenew?: boolean;
}

export interface ScanQuota {
  periodKey: string;
  used: number;
  limit: number;
  serverSyncedAt: string;
}
```

### 2.3 能力判斷（單一真源）

```ts
// src/services/permissions.ts
export function can(role: UserRole, cap: Capability): boolean { /* 能力矩陣 */ }
```

### 2.4 多 Provider 身份連結規則（DIC-652）

身份真源為 **Supabase `auth.identities`**。`linked_auth_providers` 為 mirror 快取供前端讀取（SELECT-only RLS）。

**Managed Supabase verified-email auto-linking 背景**：GoTrue 預設會按 verified email 自動連結 OAuth identity。此行為無法在 managed plan 關閉。本設計接受此平台行為，不依賴它作為合併策略。所有 user-initiated linking 使用 `linkIdentity()` API。

**Mirror 同步機制**：後端以 Edge Function（service_role）定時 polling `auth.identities`（`supabase.auth.admin.listUsers()` 的 identities 欄位），將差異同步到 `linked_auth_providers`（INSERT missing, DELETE orphaned）。不依賴不存在的 `before-identity-link` Auth Hook。Polling interval 建議 60 秒；可搭配 On linkIdentity/unlinkIdentity 完成後的前端 callback 觸發即時 mirror 更新。

若需嚴格禁止 email-based auto-linking：唯一可執行方案為 **self-hosted GoTrue + fork 修改**（在 GoTrue 的 `linkIdentityToUser` 邏輯中拒絕 email-based link）。Managed plan 無法滿足此需求。

| 操作 | 規則 |
|------|------|
| 首次登入 | `signInWithOAuth({ provider })` → GoTrue 建立/對應 auth.users → auth.identities 記錄 → trigger `on_auth_user_created` → mirror 由 polling sync |
| 連結第二 provider | `linkIdentity({ provider })`（非 `signInWithOAuth`）→ auth.identities 新增 → mirror sync |
| 身份衝突 | `linkIdentity()` same user → error。different user → `provider already linked` error → 拒絕 |
| 解除連結 | `unlinkIdentity(identity)` — identity = `getUserIdentities()` 回傳的完整 object |
| 郵件屬性 | `provider_email` 僅屬性，不作 identity key |

---

## 3. 首頁 / Onboarding Flow

（內容同前，略）

### 3.1 路由分流

```
NavigationContainer → RootStack
  ├─ Auth（未選擇入口時）
  └─ MainDrawer（已選擇）
```

### 3.2 AuthScreen

- Google / Apple OAuth 按鈕 + 訪客入口
- 不提供自家帳密

---

## 4. OAuth 設計（Google / Apple / Supabase Auth）

### 4.1 設定

```ts
// lib/supabase.ts
export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);
```

**必須啟用**：Supabase Dashboard → Authentication → Settings → **Allow manual linking** → ON（self-hosted: `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=true`）。這是 `linkIdentity()` / `unlinkIdentity()` 的前置條件。

Managed GoTrue verified-email auto-linking 為平台行為，無法關閉。本設計接受此限制。

### 4.2 Login flow

```
signInWithOAuth → GoTrue → auth.users + auth.identities → trigger on_auth_user_created
→ session JWT → 前端 auth.uid() → mirror query linked_auth_providers → MainDrawer
```

### 4.3 Session

前端 JWT → RLS `auth.uid()`。Quota/subscription 操作走 SECURITY DEFINER RPC 或 Edge Function service_role。P1 階段可用 mock OAuth（`src/services/authService.ts`），P2 替換為真實 Supabase SDK。

---

## 5. 掃描 Quota 系統

### 5.2 RPC（fail-closed，無 role fallback）

```sql
CREATE OR REPLACE FUNCTION public.consume_scan_quota()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_period text := to_char(now(), 'YYYY-MM');
  v_rec    public.scan_usage_monthly;
  v_limit  integer := 100;
  v_is_sub boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.check_not_deleted();

  -- fail-closed: 直接查 subscriptions，無 fallback
  SELECT EXISTS(
    SELECT 1 FROM public.subscriptions
    WHERE user_id = v_uid
      AND status IN ('active', 'in_grace')
      AND (
        (status = 'active' AND expires_at > now())
        OR
        (status = 'in_grace' AND grace_expires_at IS NOT NULL AND grace_expires_at > now())
      )
  ) INTO v_is_sub;

  INSERT INTO public.scan_usage_monthly (user_id, period_key, limit_count)
  VALUES (v_uid, v_period, v_limit) ON CONFLICT (user_id, period_key) DO NOTHING;

  IF v_is_sub THEN
    UPDATE public.scan_usage_monthly SET used = used + 1, limit_count = -1
    WHERE user_id = v_uid AND period_key = v_period RETURNING * INTO v_rec;
  ELSE
    SELECT * INTO v_rec FROM public.scan_usage_monthly
    WHERE user_id = v_uid AND period_key = v_period FOR UPDATE;
    IF v_rec.used >= v_limit THEN RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0001'; END IF;
    UPDATE public.scan_usage_monthly SET used = used + 1
    WHERE user_id = v_uid AND period_key = v_period RETURNING * INTO v_rec;
  END IF;

  RETURN json_build_object('used', v_rec.used, 'limit', v_rec.limit_count,
    'remaining', GREATEST(v_rec.limit_count - v_rec.used, 0), 'period', v_period);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.consume_scan_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_scan_quota() TO authenticated;
```

---

## 6. 訂閱狀態（Subscription）

### 6.2 平台策略

| 平台 | 方案 | 本階段 |
|------|------|--------|
| iOS | App Store IAP | 僅設計介面 |
| Android | Google Play Billing | 同上 |
| Web | Stripe（先不做） | 保留欄位 |

### 6.3 Grace period 與 entitlement 一致性

**Entitlement 政策（全系統一致）**：`status = 'active'` 且 `expires_at > now()`，或 `status = 'in_grace'` 且 `grace_expires_at > now()` 視為 subscriber。

- 理由：Apple 要求在 Billing Grace Period 期間仍提供服務（App Store Review Guidelines 3.1.2）。Google Play 的 Account Hold / Grace Period 同樣要求。
- Schema：`subscriptions.grace_expires_at` 儲存 Apple `gracePeriodExpiresDate` 或 Google equivalent grace end time。`expires_at` 保持一般到期時間。
- RPC `consume_scan_quota` / `require_premium`：active 檢查 `expires_at > now()`；in_grace 檢查 `grace_expires_at > now()`（兩欄位可能不同）
- 前端 Role scheduler：`(status='active' AND expires_at > now()) OR (status='in_grace' AND grace_expires_at > now())` → `users.role = 'subscriber'`
- Webhook GRACE_PERIOD_START：收到時寫入 `status='in_grace'` + `grace_expires_at` = Apple `gracePeriodExpiresDate` / Google 計算的 grace end。不變更 `expires_at`（保持原 active 到期日）。GRACE_PERIOD_END：若 renewal 成功 → `status='active'`；失敗 → `status='expired'`
- 此政策在 schema、RPC、scheduler、webhook、QA 中保持一致

### 6.4 IAP Webhook Reconciliation（P3 設計）

**接收層（Supabase Edge Function service_role）**：

| 項目 | 設計 |
|------|------|
| Apple V2 Endpoint | 接收 `signedPayload` JWS。驗證：以 header `x5c` 鏈中的憑證驗證簽名（Apple Root CA → G1 → notification signing cert）。解碼 outer `data`（含 `appAppleId`, `bundleId`, `environment`），再解碼 `notificationType` + `subtype`。**`signedTransactionInfo` 與 `signedRenewalInfo` 本身也是 JWS**（各由 App Store 簽名）→ 需分別驗證。從 signedTransactionInfo 取得 `originalTransactionId`, `transactionId`, `expiresDate`。dedup key = `notificationUUID`（Apple 提供的唯一 notification identifier） |
| Google RTDN | Pub/Sub subscription 接收 `developerNotification`。驗證：Pub/Sub push 自帶 JWT（由 GCP service account 簽發），驗證 token 的 `audience` + `email`。用 `purchaseToken` 呼叫 `purchases.subscriptionsv2.get()` 取得 `SubscriptionPurchaseV2`。dedup 使用 Pub/Sub 官方 `message.messageId`（唯一 per-delivery identifier） + fallback `(notificationType, purchaseToken, eventTimeMillis)` |
| 共同 schema | `webhook_events` table: `platform, event_type, dedup_key UNIQUE, original_transaction_id, purchase_token, raw_payload jsonb, processed_at timestamptz` |
| 去重 | `UNIQUE(dedup_key)` + `ON CONFLICT DO NOTHING`（idempotent） |
| 亂序容忍 | 依 receipt `expiresDate` / `expiryTime` 的實際值覆蓋 `subscriptions.expires_at`，不依賴 event 到達時間排序 |

**事件處理（platform-specific event → unified action）**：

| Apple V2 notificationType | Google subscriptionState / RTDN type | 處理 |
|------|------|------|
| SUBSCRIBED | SUBSCRIPTION_STATE_ACTIVE（首次） | INSERT: `status='active'`, `expires_at` 取 expiresDate/expiryTime, `auto_renew`=auto_renew_status |
| DID_CHANGE_RENEWAL_STATUS（subtype=AUTO_RENEW_ENABLED/DISABLED） | RTDN (4) SUBSCRIPTION_RENEWED | UPDATE: `auto_renew`, `expires_at` |
| DID_RENEW | SUBSCRIPTION_STATE_ACTIVE（renewal） | UPDATE: `status='active'`, `expires_at` 取新 expiresDate/expiryTime |
| DID_FAIL_TO_RENEW（subtype=GRACE_PERIOD） | SUBSCRIPTION_STATE_IN_GRACE_PERIOD | UPDATE: `status='in_grace'`, `grace_expires_at`=gracePeriodExpiresDate / Google grace end, `expires_at` 保持原值 |
| EXPIRED（subtype=GRACE_PERIOD） | SUBSCRIPTION_STATE_ON_HOLD / SUBSCRIPTION_STATE_EXPIRED | UPDATE: `status='expired'` |
| DID_RECOVER | SUBSCRIPTION_STATE_ACTIVE（recover） | UPDATE: `status='active'`, `grace_expires_at`=NULL |
| REFUND（subtype=REVOKE） | RTDN (3) SUBSCRIPTION_REVOKED | UPDATE: `status='expired'`, `expires_at`=now()。新建 `refund_events` log |

**定期 reconciliation（備援）**：

- Daily cron：對所有 `status IN ('active', 'in_grace')` 的 row，以 `subscriptions.original_transaction_id`（Apple）/ `purchase_token`（Google）向 platform API 重新查詢最新 subscription status
- 捕捉 refund / revocation in period（發生在 expiry 之前）、webhook 遺漏的狀態變化
- Reconciliation 結果寫入 `reconciliation_log`（timestamp, platform, key, before/after status）
- Fail-closed：每個 RPC 直接查 `subscriptions` 表（active 用 `expires_at > now()`；in_grace 用 `grace_expires_at > now()`），webhook 全失效 + cron 未觸發時，expiry 到期後自動拒絕

---

## 7. Premium Gate

### 7.3 Entitlement（雙層授權，uniform grace policy）

```sql
CREATE OR REPLACE FUNCTION public.require_premium()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.check_not_deleted();
  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE user_id = v_uid
      AND status IN ('active', 'in_grace')
      AND (
        (status = 'active' AND expires_at > now())
        OR
        (status = 'in_grace' AND grace_expires_at IS NOT NULL AND grace_expires_at > now())
      )
  ) THEN RAISE EXCEPTION 'premium_required' USING ERRCODE = 'P0003'; END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.require_premium() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_premium() TO authenticated;
```

---

## 8. Provider Link / Unlink / Collision / Delete Account

### 8.1 身份真源

真源 = `auth.identities`。`linked_auth_providers` 為 mirror（由 service_role polling sync 維護）。

### 8.5 帳號刪除（兩階段 + 本地 store 清除）

```
1. 使用者點擊「刪除帳號」→ 二次確認
2. Edge Function（service_role）執行兩階段刪除：

   階段 A：Postgres transaction
     a. UPDATE subscriptions SET user_id = NULL WHERE user_id = v_uid（匿名化）
     b. INSERT INTO deleted_users (user_id, deleted_at) VALUES (v_uid, now())
        — server-side deny marker；所有 protected RPC/routes 的最前檢查
     c. DELETE FROM public.users WHERE id = v_uid → CASCADE 觸發:
        linked_auth_providers / scan_usage_monthly / watchlists / push_tokens / favorites
     d. COMMIT

   階段 B：Admin API（非同一 transaction）
     e. supabase.auth.admin.updateUserById(v_uid, { ban_duration: '876600h' })
        — 立即 ban user，所有現有 session/refresh token 失效（Supabase GoTrue 在 token refresh 時檢查 ban status）
     f. supabase.auth.admin.deleteUser(v_uid) — 移除 auth.users + auth.identities
     g. 若階段 B 失敗 → deleted_users marker 存在於 DB，所有 RPC 在入口處呼叫 `public.check_not_deleted()`:
        CREATE OR REPLACE FUNCTION public.check_not_deleted()
        RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid()) THEN
            RAISE EXCEPTION 'account_deleted' USING ERRCODE = 'P0004';
          END IF;
        END; $$;
        — 每個 protected RPC（consume_scan_quota, require_premium）在 auth check 後立即呼叫
        — RLS SELECT policy 強制附加 marker：AND NOT EXISTS (SELECT 1 FROM public.deleted_users WHERE user_id = auth.uid())
     h. 排程 retry（Edge Function cron sweep）：對 deleted_users 中（在 RPC check_not_deleted 被觸發時記錄的）尚未完成 deleteUser 的 orphan ID 補執行

3. 前端帳號刪除完成後清空所有本機 Zustand persisted stores（reset memory state + 清除 persist storage）：

   各 store 及其 persist key：

   | Store | Zustand persist key | Fields reset |
   |-------|---------------------|-------------|
   | authStore | `holohunter-auth` | `logout()`: isAuthenticated=false, authResolved=false, role='guest', profile=null, scanQuota={used:0,limit:0}, subscription={tier:'none',isActive:false} |
   | holoStore (both instances) | `holohunter-storage` | `useHoloStorePersisted.persist.clearStorage()` + `useHoloStorePersisted.setState()` + `useHoloStore.setState()`: `favorites:[], recentViews:[], scanHistory:[], lastScannedCard:null, theme:'dark', priceSource:'yuyu', searchQuery:'', searchResults:[], searchFilters:{}, isSearching:false, searchError:null, isLoading:false, activeTab:'home'` |
   | scanSessionStore | `hunterCard-scan-session` | `clearStorage()` + `clearSession()`: `cards:[], totalValue:0, cardCount:0, isSessionActive:false` |
   | watchlistStore | `watchlist-storage` | `clearStorage()` + force reset state via `setState`: `items:[]` |
   | settingsStore | `hunterCard-settings` | `clearStorage()` + force reset via `setState`: `preferredCurrency:'TWD', preferredLanguage:'zh'` |

   注意：holoStore 有兩個 instance（`useHoloStore` 非持久化 + `useHoloStorePersisted` 持久化），**兩個都必須 reset**。watchlistStore 與 settingsStore 目前無 bulk reset action → delete flow 中以 `setState()` 直接重置 internal state，再 `clearStorage()` 清除 persist。

4. 復原性：
   - 階段 A 失敗 → rollback，不觸發 B，user 不受影響
   - 階段 B 失敗 → orphan sweep recovery（見上 e）
   - 前端 store 清除失敗 → user 重新啟動 App 時，因 auth.users 已 ban+delete 或 deleted_users marker 存在 → RLS/RPC 拒絕所有操作 → authStore 偵測 auth failure → 自動清空並回到 AuthScreen（此為最後防線，不取代 delete flow 當下的 full memory reset）

注意：auth.admin.deleteUser() 與 Postgres transaction 不共享 ACID 邊界（Admin API 為 HTTP RPC）。
```

---

## 9. UI 元件

| 元件 | 位置 | 說明 |
|------|------|------|
| `QuotaIndicator` | 掃描頁頂部 | N / 100 或 無上限 |
| `PremiumLockOverlay` | premium 內容前 | UX only |
| `UpgradeCTA` | 剩餘 < 10 時 | 升級提示 |
| 帳號區塊 | SettingsScreen | providers / 訂閱 / 額度 / link / unlink / 登出 / 刪除 |

---

## 10. 隱私權政策與商店文案

### 10.1 資料清單（Current vs Future 區分）

**Current（本階段，mock OAuth + 本機 only，無 Supabase 後端）**：

| 資料 | 儲存/傳輸 | 備註 |
|------|-----------|------|
| 掃描影像 | 拍攝後以 base64/image data 上傳至 `/api/recognize-card`（本 App Vercel backend），再轉送至 OpenRouter API → Google Gemini Vision 進行卡牌辨識。影像不在 server 端持久儲存（辨識完成即丟棄） | OpenRouter / Google Gemini 為第三方 AI 處理者；詳見其隱私權政策 |
| App 設定 | Zustand localStorage/AsyncStorage（本機，不傳送 server） | 語言、幣別偏好 |
| 收藏/掃描歷史 | Zustand persist 本機 | holoStore, scanSessionStore, watchlistStore |
| 搜尋查詢 | 前端直接 fetch `/data/database.json`（public CDN，無 auth） | 卡牌資料查閱 |

**Future / Launch prerequisite（P2+ 接上 Supabase 後生效，Current 項目仍保留）**：

| 資料類別 | 儲存位置 | 目的 | 保存期間 | 刪除方式 |
|----------|----------|------|----------|----------|
| OAuth 識別 | auth.users.id, auth.identities | 身份辨識 | 帳號存在期間 | admin.deleteUser() |
| 個人檔案 | public.users: display_name, avatar_url | 個人化 | 帳號存在期間 | ON DELETE CASCADE |
| 聯絡資訊 | linked_auth_providers.provider_email | 聯絡/通知 | 帳號存在期間 | ON DELETE CASCADE |
| 掃描使用量 | scan_usage_monthly | quota 控管 | 最多 24 個月 | ON DELETE CASCADE |
| 訂閱狀態 | subscriptions | 服務交付/稽核 | 匿名化保留（user_id→NULL） | ON DELETE SET NULL |
| 收藏/提醒 | watchlists, favorites | 使用者自選 | 帳號存在期間 | ON DELETE CASCADE |
| 推播 token | push_tokens: Expo Push Token | 推播通知 | 帳號存在期間/token 失效 | ON DELETE CASCADE |
| Expo 處理者 | Expo Push Service → FCM/APNs | 推播遞送 | 依 Apple/Google/Expo 政策 | 刪除 push_tokens 即停止 |
| Supabase 處理者 | 平台 logs/metrics | 平台營運 | 依 Supabase policy | 非本 App 可控 |
| Session | Supabase GoTrue session | 授權 | session 過期後清除 | 登出/session expire |

### 10.2 隱私權政策（Current + Future sections）

**Current**：本 App 目前的掃描功能會將拍攝的卡牌影像上傳至後端伺服器進行 AI 辨識（透過 OpenRouter / Google Gemini Vision），影像在辨識完成後即丟棄、不持久儲存。其他使用者資料（設定、收藏、掃描歷史）僅儲存於裝置本機，不傳送 server。刪除 App 即清除所有本機資料。

**Future**：當帳號系統上線後（P2+），將透過 Supabase Auth（Google/Apple OAuth）收集識別資料。詳見完整資料清單（§10.1 Future）。使用第三方處理者：Supabase（認證、資料庫）、Expo（推播）、Apple/Google（OAuth、金流）。

### 10.3 商店文案

（App Store / Google Play）揭露：帳號登入（OAuth）、內購項目、資料用途（Privacy Nutrition Label / Data Safety）。

---

## 11. QA 測試矩陣

| # | 情境 | guest | free_user | subscriber |
|---|------|-------|-----------|------------|
| 1 | 冷啟動 | AuthScreen | 主頁 | 主頁 |
| 2 | 現價 | ✅ | ✅ | ✅ |
| 3 | 掃描 | 登入引導 | ✅ (≤100) | ✅ |
| 4 | 掃描第 100 張 | — | ✅（達上限） | ✅ |
| 5 | 掃描第 101 張 | — | RPC 阻擋 | ✅ |
| 6 | 跨月 | — | 重置 100 | 無上限 |
| 7 | 本機竄改 quota | — | RPC 阻擋 | RPC 放行 |
| 8 | 趨勢預測 | 鎖定+server 拒 | 鎖定+server 拒 | ✅ |
| 9 | 直接呼叫 premium API | server 拒 | server 拒 | ✅ |
| 10 | 改 own role | RLS SELECT-only 拒 | RLS SELECT-only 拒 | RLS SELECT-only 拒 |
| 11 | 升級成功 | — | 變 subscriber | — |
| 12 | 訂閱過期 | — | — | fallback free |
| 13 | 刪除帳號 | — | cascade + stores cleared + 回 Auth | 同 left |
| 14 | 登出 | — | 回 Auth | 回 Auth |
| 15 | link provider | — | linkIdentity() ✅ | linkIdentity() ✅ |
| 16 | unlink last provider | — | 拒絕 | 拒絕 |
| 17 | collision | — | 拒絕 | 拒絕 |
| 18 | Auto-linking | — | GoTrue 平台行為（接受） | 同 left |
| 19 | Grace period (active→in_grace) | — | — | entitlement 維持：`grace_expires_at > now()` |
| 20 | Grace period end (no renewal→expired) | — | — | entitlement 回 free；status='expired' |
| 21 | Grace period end (renewal succeeds→active) | — | — | entitlement 維持；status='active', grace_expires_at=NULL |
| 22 | Admin API failure on delete | — | deleted_users marker 阻擋 orphan session | 同 left |

---

## 12. 限制與注意事項

- 不使用 Copilot（額度已滿）。**OpenRouter 僅限現有卡牌辨識 API 使用**（`/api/recognize-card` → Gemini Vision），不作為 agent 編碼/LLM 後援額度。本設計文件內不新增對 OpenRouter 的新依賴。
- 訂閱符合 App Store / Google Play 規範（IAP, Sign in with Apple, 隱私標籤）。
- Quota/premium gate fail-closed：直接查 `subscriptions`（status + expires_at），不 fallback 到 `users.role`。
- Grace period `status = 'in_grace'` 視同 subscriber（Apple/Google 政策要求）。
- Identity 真源 = `auth.identities`；mirror 由 service_role polling sync 維護。不依賴不存在的 Auth Hook。
- 底層基礎設施為 Supabase Auth + Supabase Postgres/RLS（DIC-646 決策），不使用 Vercel KV。
- server-owned 欄位 mutation 只走 controlled channel。

---

## 13. Roadmap

| 階段 | 內容 |
|------|------|
| **P1 架構** | types, permissions.ts, authStore（mock OAuth）, AuthScreen, QuotaIndicator/PremiumLockOverlay/UpgradeCTA 佔位 |
| **P2 後端授權** | Supabase Auth integration（OAuth + session + linkIdentity/unlinkIdentity）、Allow manual linking ON、RLS（SELECT-only）+ RPC（consume_scan_quota / require_premium）、mirror polling sync |
| **P3 訂閱金流** | IAP + webhook reconciliation + 收據驗證 Edge Function + daily cron |
| **P4 合規** | 隱私權政策（Current + Future sections）、商店文案、link/unlink/collision UI、delete cascade + local store clearing + orphan sweep |

> P1 不含金流，對齊「先設計架構、不立刻實作金流」的需求。
