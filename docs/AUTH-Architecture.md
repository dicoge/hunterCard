# HoloHunter 共通帳號 AUTH 架構與 Provider Identities 資料模型

> DIC-662 · 設計提案 v1
> 目標：設計「共通帳號」認證架構，internal user id 為唯一主體，支援 Google / Apple 綁定、解綁、collision merge、刪除帳號。

---

## 1. 背景與現況

HoloHunter 目前 **沒有任何帳號系統**：

| 資料 | 現況儲存位置 | Key |
| --- | --- | --- |
| 收藏 / 最近瀏覽 / 掃描紀錄 | 本機 `zustand + persist`（`src/store/holoStore.ts`） | 裝置本機，無 user |
| 設定（幣別 / 語言 / 主題 / 價格來源） | 本機（`src/store/settingsStore.ts`） | 裝置本機 |
| Watchlist（入手提醒） | 本機（`src/stores/watchlistStore.ts`） | 裝置本機 |
| 推播 token / watchlist（server） | GitHub JSON（`data/push-tokens.json`、`data/push-watchlist.json`） | **push token**（裝置），非 user |

- 後端是 **Vercel Serverless Functions**（`api/*.ts`，`@vercel/node`，Web Fetch `Request/Response`），儲存用 GitHub JSON + Vercel KV，**目前沒有關聯式資料庫**。
- App：Expo（React Native + Web），iOS/Android 皆 `com.dicoge.holohunter`，Web 由 metro export 部署在 Vercel。

**結論**：需要新增（a）一個關聯式資料庫作為 user / identity 的權威來源，（b）一層自管的 OAuth/OIDC 驗證與 session 層，（c）把現有 push / watchlist / 收藏 / 設定從「裝置為主」遷移到「internal user id 為主」。

---

## 2. 設計原則

1. **internal user id（UUID）為唯一主體**。所有使用者資料（收藏、設定、watchlist、推播 token）都外鍵到 `users.id`。
2. **不提供自家帳密**，只支援 OIDC provider：`google`、`apple`。
3. **email 永不作唯一身份依據**。唯一鍵是 `(provider, provider_subject)`。email 僅供聯絡 / 顯示 / 風險輔助，且可能為 Apple private relay 或跨 provider 不一致。
4. **一個 user 可綁多個 identity**（Google + Apple），且任一 provider 都能作為「第一個」登入方式再綁另一個。
5. **解綁需保留至少一個有效登入方式**。
6. **collision 預設拒絕，不自動 merge**；merge 必須雙方重新驗證且留審計。
7. **provider ID token 於後端自行驗證**（JWKS），session 由我方簽發，掌握完整 user model 與 collision 邏輯（不依賴 broker 的隱式 identity linking）。

---

## 3. 資料模型

建議 **PostgreSQL**（Vercel Postgres / Neon / Supabase 皆可；Supabase 另可作 Web Apple 的 OAuth broker，見 §7）。以下為權威 schema。

### 3.1 users

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    TEXT,
  avatar_url      TEXT,
  primary_email   TEXT,                       -- 僅顯示/聯絡，非唯一、可為 null
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','pending_deletion')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ                 -- soft delete，purge job 後才實體刪除
);
-- 注意：primary_email 不加 UNIQUE，允許重複/空。
```

### 3.2 auth_identities（= linked_auth_providers）

```sql
CREATE TABLE auth_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google','apple')),
  provider_subject  TEXT NOT NULL,            -- Google sub / Apple user identifier (sub)
  raw_email         TEXT,                     -- provider 回傳的原始 email（可能 relay）
  normalized_email  TEXT,                     -- lower(trim())，僅風險輔助，不唯一
  email_verified    BOOLEAN NOT NULL DEFAULT false,
  is_private_relay  BOOLEAN NOT NULL DEFAULT false, -- Apple @privaterelay.appleid.com
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,              -- 解綁 = soft revoke（保留審計），實體刪除交給 purge
);
-- 唯 active (unrevoked) identity 才佔唯一鍵；revoked 後同一 (provider, subject) 可重新 link / merge 移轉。
CREATE UNIQUE INDEX uq_provider_subject_active ON auth_identities(provider, provider_subject) WHERE revoked_at IS NULL;
-- 同一 user 同一 provider 只能有一個 active identity；防止併發 unlink 出現兩筆同 provider active row。
CREATE UNIQUE INDEX uq_user_provider_active ON auth_identities(user_id, provider) WHERE revoked_at IS NULL;
CREATE INDEX idx_identities_user ON auth_identities(user_id) WHERE revoked_at IS NULL;
```

> 「有效登入方式」 = `revoked_at IS NULL` 的 identity。解綁與刪除都依此計數。

### 3.3 sessions / refresh tokens

```sql
CREATE TABLE sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_id         UUID REFERENCES auth_identities(id) ON DELETE SET NULL, -- 本次登入用哪個 provider
  refresh_token_hash  TEXT NOT NULL,          -- 只存雜湊（如 SHA-256），明碼不落地
  device_platform     TEXT,                   -- ios / android / web
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
```

- Access token：短效 JWT（15 分鐘），claim `sub = users.id`；不進 DB。
- Refresh token：長效（如 30 天）、只存雜湊、可撤銷、rotation。

### 3.4 使用者資料（由裝置本機 / push token 遷移過來）

```sql
CREATE TABLE user_settings (
  user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_currency TEXT NOT NULL DEFAULT 'TWD',
  preferred_language TEXT NOT NULL DEFAULT 'zh',
  theme              TEXT NOT NULL DEFAULT 'light',
  price_source       TEXT NOT NULL DEFAULT 'yuyu',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE favorites (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_number TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_number)
);

CREATE TABLE watchlist (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_number  TEXT NOT NULL,
  target_price NUMERIC,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, card_number)
);

CREATE TABLE push_tokens (
  token       TEXT PRIMARY KEY,               -- Expo push token
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE, -- 可為 null：未登入裝置仍可註冊
  platform    TEXT NOT NULL CHECK (platform IN ('ios','android')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);
CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);
```

### 3.5 掃描用量 / 額度 / 訂閱（future）

> **目前 repo 尚無這些 server-side tables**。以下為引入功能前須先定義的 schema，所有表以 `users.id` 為 FK。

```sql
-- 月掃描次數追蹤（每月 reset）
CREATE TABLE scan_usage (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,              -- 'YYYY-MM'
  scan_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

-- 訂閱方案與到期
CREATE TABLE subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','cancelled','expired','paused')),
  started_at      TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id) WHERE status = 'active';

-- entitlement（某 user 的 tier 與 quota）。**此 executable schema 是全系統 quota 的
-- 單一 enforced 權威**（DB CHECK 實際強制）：free = free_user、pro = subscriber。
-- Product-Entitlement-Architecture.md (DIC-674) 的產品角色語意層必須引用此處數值，
-- 不得另立第二套。NULL = 無上限（unlimited）。DIC-674/DIC-774 acceptance：free 無 daily cap。
CREATE TABLE entitlements (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier            TEXT NOT NULL DEFAULT 'free'
                    CHECK (tier IN ('free','pro')),   -- free=free_user, pro=subscriber
  daily_limit     INTEGER,                            -- NULL = 無日上限（本契約 free/pro 皆 NULL）
  monthly_limit   INTEGER DEFAULT 100,                -- free 預設 100；pro reconcile 時改 NULL
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- tier 與 quota 綁死為單一真相：
  CONSTRAINT quota_matches_tier CHECK (
    (tier = 'free' AND daily_limit IS NULL AND monthly_limit = 100) OR   -- free 每月 100、無日上限
    (tier = 'pro'  AND daily_limit IS NULL AND monthly_limit IS NULL)    -- subscriber 不限量
  )
);
```

- **Seed（新 free user，executable + 冪等）** — 只給 `user_id`，靠 `tier`/`monthly_limit` DEFAULT 形成合法 `(free, NULL, 100)`，不會違反 `quota_matches_tier`：
  ```sql
  INSERT INTO entitlements (user_id) VALUES ($user) ON CONFLICT (user_id) DO NOTHING;
  ```
- **升級 subscriber（reconcile，Product §5.3 事件驅動）**：`UPDATE entitlements SET tier='pro', daily_limit=NULL, monthly_limit=NULL WHERE user_id=$user;`
- **Backfill（migration `0001_auth.sql`）** — 既有 user 補 free entitlement：`INSERT INTO entitlements (user_id) SELECT id FROM users WHERE deleted_at IS NULL ON CONFLICT (user_id) DO NOTHING;`
- **guest**（DIC-674：無 internal user id / 匿名 session）不落 `entitlements`，能力為常數、不可掃描。

> **Quota gating（fail-closed）**：掃描前讀 `entitlements`。`monthly_limit IS NULL`（pro）→ 不限量放行；否則比對當期 `scan_usage.scan_count < monthly_limit`（free = 100）才放行，達標回 `403 QUOTA_EXCEEDED`。因 login-or-create（§5.1）與 backfill 保證每個 **active internal user 必有 entitlement row**，唯一「無 row」情形是 guest（無 internal user id），fail-closed 不放行正確。任何地方都以 `entitlements.tier` + limit 欄位為唯一 quota 依據，不得在別處硬編數字。

#### 3.5.1 Merge 規則（scan_usage / subscriptions / entitlements）

| 資料 | 規則 |
| --- | --- |
| scan_usage | **每 period 取 capped sum，封頂值取 merge 後 target 的權威 `entitlement.monthly_limit`**：`monthly_limit IS NULL`（merge 後為 pro / unlimited）→ target.scan_count = target + source（不封頂）；否則 target.scan_count = min(target + source, monthly_limit)（free = 100）。source 的 `scan_usage` 全部寫入 audit_log 後設 `scan_count = 0`。capped 部分記 audit_log `merge_quota_capped` 含原始值。全部在 merge transaction 內以 `FOR UPDATE` 執行，且在 §3.5.1 entitlements 合併「之後」計算，確保封頂用的是合併後的 tier；防止並發掃描/merge 導致超額。 |
| subscriptions | **原子轉移所有 active rows**：`UPDATE subscriptions SET user_id = target.id WHERE user_id = source.id AND status = 'active'`。轉移後若 target 有多個 active subscription → 保留單一 survivor：依 `expires_at DESC NULLS FIRST`（永久 plan 優先）、`started_at DESC`（到期日一致則保留最新訂購）、`id DESC`（連 started_at 都一致則保留最新 insert 的 row）。其餘 `cancelled_at = now()`、`status = 'cancelled'`。若 survivor 為 pro 且另有 active pro → 轉 `requires_support`。全部在 merge transaction 內。 |
| subscription_receipts | **隨其對應 subscription 原子搬移**（維持 receipt/subscription 同 user 不變式）：在 `subscriptions` 搬移「之後」、同一 merge transaction 內執行 `UPDATE subscription_receipts r SET user_id = target.id, updated_at = now() FROM subscriptions s WHERE r.subscription_id = s.id AND s.user_id = target.id AND r.user_id = source.id`。留在 source 的非 active subscription 及其 receipt 一併隨 source purge 清除（同屬 source，仍一致）。牽涉 pro 併入時沿用上列 `requires_support` 門檻，改綁待人工確認。（表結構見 Entitlement-Subscription-Gate-Design.md §1；provider 事件在 merge 後的帳戶重導見該文件 §2.5） |
| entitlements | **upsert-then-delete**（entitlements PK = user_id）：先 `INSERT INTO entitlements (user_id, tier, daily_limit, monthly_limit) SELECT <target.id>, tier, daily_limit, monthly_limit FROM entitlements WHERE user_id = <source.id> ON CONFLICT (user_id) DO UPDATE SET tier = CASE WHEN entitlements.tier = 'pro' OR EXCLUDED.tier = 'pro' THEN 'pro' ELSE 'free' END, daily_limit = CASE WHEN entitlements.tier = 'pro' THEN entitlements.daily_limit WHEN EXCLUDED.tier = 'pro' THEN EXCLUDED.daily_limit ELSE entitlements.daily_limit END, monthly_limit = CASE WHEN entitlements.tier = 'pro' THEN entitlements.monthly_limit WHEN EXCLUDED.tier = 'pro' THEN EXCLUDED.monthly_limit ELSE entitlements.monthly_limit END, updated_at = now()`。接著 `DELETE FROM entitlements WHERE user_id = <source.id>`。**limits 判定以 target 既有 tier 為準**：`entitlements.tier`（= target 現值）為 `'pro'` 時 CASE 一律保留 target 的 tier/daily_limit/monthly_limit，完全不採 `EXCLUDED`（source）值；只有在 **target 非 pro、source 為 pro** 時才採用 source 的 limits。因 pro row 的 daily/monthly limit 皆為 `NULL`（unlimited）、free row 為 `(NULL, 100)`，故合併結果一律落在 `quota_matches_tier` CHECK 允許的兩組值上（pro→NULL/NULL、free→NULL/100），不會產生第三套數字。此 entitlements 合併必須排在 §3.5.1 scan_usage capped-sum 之前，讓 scan_usage 封頂讀到的是合併後的權威 tier。source 與 target 同為 pro → target 權威保留、limits 不變。任一情況只要牽涉 pro entitlement 併入，記 audit_log 後轉 `requires_support` 供人工確認最終 tier。

#### 3.5.2 Purge 規則

- `scan_usage`、`subscriptions`、`entitlements` 全設 `ON DELETE CASCADE`，user purge 時一併刪除。
- 刪除前 `audit_log` 寫入 `delete_purged` 事件，metadata 含最後 known tier / 累計 scan 數 / 最後 active subscription plan。

### 3.6 collision merge 與審計

```sql
CREATE TABLE account_merge_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- user purge 時 set null；原始 UUID 存 snapshot
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_user_snapshot UUID NOT NULL,                   -- 不可逆快照，即使 source user 被 purge 仍可追溯
  target_user_snapshot UUID NOT NULL,                   -- 不可逆快照，即使 target user 被 purge 仍可追溯
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','verified','completed','rejected','cancelled')),
  requires_support BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ,
  resolver       TEXT                                  -- 'auto' / 'support:<id>'
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID,                     -- 不加 FK，帳號刪除後仍保留審計
  actor       TEXT,                     -- 'user:<id>' / 'support:<id>' / 'system'
  event_type  TEXT NOT NULL,            -- login / link / unlink / merge / delete_requested / delete_purged ...
  provider    TEXT,
  ip          TEXT,
  user_agent  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. Provider Collision（明確定義）

**情境**：使用者以 user A（Google）登入後嘗試綁 Apple，但該 Apple `(apple, sub)` 已屬於另一個 user B。

**預設策略 = 拒絕 + 提供 merge 選項**（不自動合併）。

流程：

1. `POST /api/auth/link` 偵測到 `(provider, subject)` 已存在於 **不同** user → 回 `409 IDENTITY_ALREADY_LINKED`，附一個短效 `merge_token`（描述 source/target 候選、雙方 masked email、資料量摘要）。
2. 若使用者要合併 → 進入 **merge 流程**，要求 **雙方 provider 都在短時窗（如 10 分鐘）內重新驗證**（重跑 `login` 拿到雙方新鮮 ID token）。這證明使用者確實同時掌握兩個帳號，防止「綁到別人帳號」。
3. **存活方 (target)** 預設為「當下登入中的 user」；被併方 (source) 的資料轉移過去，`source` 標記 `pending_deletion`，其 identities `revoke` 後改指向 target（或建立新 identity 於 target 並 revoke 舊的），全程寫 `audit_log`。
4. **需人工/客服介入的門檻**（`requires_support = true`，暫停自動 merge）：
   - 任一方有 active pro subscription 或 pro entitlement（見 §3.5）。
   - 任一方資料量超過安全上限（防濫用批量併吞）。
   - 兩次 merge 嘗試在短期內失敗（風險訊號）。

### 4.1 Merge 資料歸併規則

| 資料 | 規則 |
| --- | --- |
| favorites | 依 `card_number` 聯集去重；保留最早 `created_at` |
| watchlist | 依 `card_number` 聯集去重；`target_price` 取 target；target 無值才用 source；保留最早 `added_at` |
| user_settings | 保留 **target**（存活方）的設定；source 捨棄 |
| push_tokens | 全部改指向 target；依 `token` 去重 |
| identities | 逐條處理 source 的 active identity（`revoked_at IS NULL`）：(a) 若 target 尚無同 provider → UPDATE `user_id = target.id`；(b) 若 target 已有同 provider → source 該 identity SET `revoked_at = now()`（保留為審計紀錄），target 既有者保留。因 `uq_provider_subject_active` 為 partial unique index，revoke 後不佔唯一鍵，不阻擋現有 active identity，也不妨礙日後同一 `(provider, subject)` 重新綁定。 |

所有 merge 動作記審計紀錄（見 §4.2）。

### 4.2 Merge 之 identity 狀態轉移與審計

merge 過程中所有資料移轉（identities / favorites / watchlist / settings / push_tokens / scan_usage / subscriptions / entitlements）、source disable、session revoke、audit_log 寫入、merge request completion 必須在 **同一個 DB transaction** 內完成，確保中途失敗可 rollback。

**交易開鎖順序**（避免 deadlock）：
1. `SELECT ... FROM account_merge_requests WHERE id = <merge_request_id> FOR UPDATE`
   → 鎖後立即 recheck：若 status != 'pending' → 409 MERGE_ALREADY_RESOLVED
2. `SELECT ... FROM users WHERE id IN (<source>, <target>) ORDER BY id FOR UPDATE`
   → recheck：source 與 target 的 status 仍為 'active'；任一非 active → 409
3. `SELECT ... FROM auth_identities WHERE user_id IN (<source>, <target>) FOR UPDATE`
   → 防止其他 writer 在 merge 過程中對這些 identity 做 unlink/relink

> **Mandatory user-lock protocol**：任何會改變 user data ownership 的操作（login/new-identity creation、unlink、delete、merge）都必須先鎖住對應 users row (`FOR UPDATE`)。merge transaction 已鎖 source + target + identities，故 merge 過程中不會有其他 writer 把資料留在 source 上。

**步驟 A — 驗證 merge_request + 雙方 identity**
1. 查詢 `merge_token` 指向的 source / target user id，確認 `merge_token` 未過期且未使用。
2. 驗證請求中附帶的雙方 provider ID token（§4 步驟 2），確保呼叫者同時掌握兩個帳號；任一驗證失敗 → 回 `401`，終止。
3. 確認任一 user 狀態非 `disabled` / `pending_deletion`；任一為此類 → 轉 `requires_support`，終止。

**步驟 B — identity 轉移（針對 source 每個 `revoked_at IS NULL` 的 identity）**
1. 對每個 `(provider, subject)`：
   - 查 target 是否有同 provider 的 **active** identity (`revoked_at IS NULL`)。
   - **無衝突** → UPDATE `auth_identities SET user_id = target.id WHERE id = <source_identity.id>`（`uq_provider_subject_active` partial unique index 保證 target 新組合不衝突）。identity 保持 active，`linked_at` 不變，`revoked_at = NULL`。
   - **有衝突** → 保留 target 既有 identity；source 該 identity SET `revoked_at = now()`，記 audit_log `event_type='merge_revoke'`，`metadata` 含 `{reason:'target_has_same_provider', target_identity_id, source_identity_id}`。因 partial unique index 只在 `revoked_at IS NULL` 時作用，revoked row 不阻塞日後同一 `(provider, subject)` 重新綁定。
2. 以上全部在同一個 DB transaction 內。

**步驟 C — 使用者資料 ownership 轉移**
在步驟 B 同一 transaction 內，依 §4.1 與 §3.5.1 規則執行資料轉移（**entitlements 先於 scan_usage**，讓 quota 封頂讀到合併後的 tier）：
- favorites / watchlist → INSERT ... ON CONFLICT DO NOTHING（聯集去重）
- user_settings → target 保留，source 捨棄
- push_tokens → `UPDATE push_tokens SET user_id = target.id WHERE user_id = source.id`
- entitlements → `INSERT ... SELECT ... FROM entitlements WHERE user_id = source.id ON CONFLICT (user_id) DO UPDATE`（upsert，見 §3.5.1），then `DELETE FROM entitlements WHERE user_id = source.id`
- scan_usage → 每 period capped sum：合併後 `monthly_limit IS NULL`（pro）→ `source + target` 不封頂；否則 `min(source + target, monthly_limit)`（free = 100），記 audit_log `merge_quota_capped`
- subscriptions → `UPDATE subscriptions SET user_id = target.id WHERE user_id = source.id AND status = 'active'`；轉移後取 survivor（`expires_at DESC NULLS FIRST`, then `started_at DESC`），其餘 cancel
- subscription_receipts → 緊接 subscriptions 搬移後：`UPDATE subscription_receipts r SET user_id = target.id, updated_at = now() FROM subscriptions s WHERE r.subscription_id = s.id AND s.user_id = target.id AND r.user_id = source.id`（維持 receipt/subscription 同 user；見 §3.5.1 與 Entitlement-Subscription-Gate-Design.md §2.5）

**步驟 D — source user 標記**
- `UPDATE users SET status = 'pending_deletion', deleted_at = now() WHERE id = <source.id>`。

**步驟 E — session 處理**
- 撤銷 source user 全部 active session（`UPDATE sessions SET revoked_at = now() WHERE user_id = <source.id> AND revoked_at IS NULL`）。
- 可選：若 target 的 session 也過期 / 數量過多，可保留最新 N 個，其餘撤銷。

**步驟 F — 審計（audit_log）**
merge 完成後寫入以下審計記錄：

| event_type | metadata |
| --- | --- |
| `merge_created` | `{merge_request_id, source_user_id, target_user_id, source_provider, source_subject}` |
| `merge_revoke`（每個衝突 identity 一筆） | `{merge_request_id, source_identity_id, target_identity_id, reason:'target_has_same_provider'}` |
| `merge_transfer`（每個無衝突轉移 identity 一筆） | `{merge_request_id, source_identity_id, provider, subject, from_user_id→to_user_id}` |
| `merge_favorites` / `merge_watchlist` / `merge_settings` / `merge_push_tokens` | `{merge_request_id, count_added, count_skipped}` |
| `merge_quota_capped`（每 period 一筆） | `{merge_request_id, period, source_count, target_before, target_after, capped_at}` |
| `merge_subscription_transfer`（每筆轉移） | `{merge_request_id, subscription_id, from_user_id→to_user_id, plan, expires_at}` |
| `merge_subscription_cancelled`（去重取消） | `{merge_request_id, subscription_id, plan, reason:'duplicate_pro' | 'shorter_expiry'}` |
| `merge_entitlement_transfer` | `{merge_request_id, source_tier, target_tier_before, target_tier_after}` |
| `merge_completed` | `{merge_request_id, source_user_id, target_user_id, status:'completed'}` |

- `UPDATE account_merge_requests SET status = 'completed', resolved_at = now(), resolver = 'auto' WHERE id = <merge_request_id> AND status = 'pending' RETURNING id`。
  → 若 RETURNING 回 0 rows → merge request 已被另一 writer 完成/取消，rollback 不回寫 audit_log。
- 日後追溯單一 user 的合併歷史，可對 audit_log 篩 `user_id = source_user_id OR metadata->>'target' = <target_user_id>` 得知完整合併鏈。

---

## 5. Auth Flows

### 5.1 登入 / 註冊（login-or-create）
```
Client 取得 provider ID token
  └─ POST /api/auth/login { provider, id_token, [nonce] }
       ├─ 後端用 JWKS 驗 token（iss / aud / exp / nonce），取 subject = sub
       ├─ 在一個 DB transaction 內：
       │     ├─ 查 auth_identities WHERE provider=<provider> AND provider_subject=<sub> AND revoked_at IS NULL
       │     │     ├─ 命中 → SELECT users WHERE id=<identity.user_id> FOR UPDATE
       │     │     │          若 users.status != 'active' → 401 ACCOUNT_DISABLED
       │     │     │          若 status = 'active' → UPDATE users.last_login_at，登入
       │     │     └─ 未命中 → 直接 INSERT users（status='active'）+ INSERT auth_identities
       │     │          + INSERT entitlements (user_id) VALUES (<new_user>) ON CONFLICT (user_id) DO NOTHING
       │     │            → 依 DEFAULT 形成 (free, NULL, 100)，新 free_user 立即擁有每月 100 額度
       │     │          （uq_provider_subject_active 保證同一 (provider,sub) 同一 transaction 內
       │     │           不會被另一筆 login 插入重複 active row）
       │     └─ 簽發 access + refresh token → INSERT sessions → COMMIT
```
> - 查詢過濾 `revoked_at IS NULL`，已解綁 row 不會被誤選。
> - **新帳號在同一 transaction 內建立 entitlement**（冪等 `ON CONFLICT DO NOTHING`），配合 §3.5 backfill，保證每個 active user 必有 entitlement row；不會出現「新 free_user 無 row 被 fail-closed 擋掉掃描」。
> - `FOR UPDATE` lock 與 login-or-create 在同一 transaction：若 delete 流程同時將同一 user 標記 `pending_deletion`，login 的 lock 會等到 delete COMMIT 後看到 `status = 'pending_deletion'` 而回 ACCOUNT_DISABLED，不會出現「剛 delete 又登入」的競態。
> - INSERT users + INSERT identities 無需 lock：未命中表示全新 user，無競態對手。`uq_provider_subject_active` 在 DB 層保證唯一性，transaction 內失敗可 retry。

### 5.2 綁定第二 provider（authenticated link）

collision owner 與 current user 都可能被改動 ownership，因此**兩個 user row 必須在單一 `SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE` 一次鎖定**（依 UUID 排序，避免兩個互綁請求各持一鎖形成 deadlock）。owner 必須「先探測、鎖定、再於鎖後重讀確認」。

```
已登入（access token）→ POST /api/auth/link { provider, id_token }
  1. 驗 token 取 subject。
  2. Pre-probe（無鎖）：
       owner0 := SELECT user_id FROM auth_identities
                 WHERE provider=<p> AND provider_subject=<sub> AND revoked_at IS NULL
  3. lock_ids := {current} ∪ ({owner0} 若 owner0 非 null 且 ≠ current)
  4. BEGIN；一次鎖定全部（deterministic，無 deadlock）：
       SELECT id, status FROM users WHERE id IN (lock_ids) ORDER BY id FOR UPDATE
  5. 鎖後重讀權威 owner：
       owner := SELECT user_id FROM auth_identities
                WHERE provider=<p> AND provider_subject=<sub> AND revoked_at IS NULL
       ├─ 若 owner 是「不在 lock_ids 內的第三 user」（pre-probe 後才出現）
       │     → ROLLBACK，將 owner 併入 lock_ids，重開 transaction（bounded retry，≤3 次；
       │       仍未收斂 → 503 LINK_CONTENTION，請重試）
       └─ 否則 owner ∈ {null, current, 已鎖的 other}，繼續
  6. 若 current.status != 'active' → 403 ACCOUNT_DISABLED。
  7. 依 owner 分派（此時 current 與 owner 皆已鎖）：
       Case owner == current            → 200 幂等（已綁定）
       Case owner == other 且 status='active'
                                        → 409 IDENTITY_ALREADY_LINKED + merge_token（§4）
       Case owner == other 且 status!='active'（stale owner）
                                        → UPDATE auth_identities SET revoked_at = now()
                                             WHERE provider=<p> AND provider_subject=<sub>
                                               AND user_id=<other> AND revoked_at IS NULL；
                                           釋放 (provider,subject) 後 fall through 到 Case null
       Case owner == null（含上一步 revoke 後）→ 進入步驟 8 的 INSERT
  8. INSERT（唯一寫入點，結果一律以 RETURNING 判定，絕不假設「必不衝突」）：
       INSERT INTO auth_identities (user_id, provider, provider_subject, ...)
         VALUES (<current>, <p>, <sub>, ...)
         ON CONFLICT DO NOTHING RETURNING id
       ├─ RETURNING 有 row → 200 ok
       └─ RETURNING 0 rows → 重跑步驟 5 的兩路判定（不可假設衝突來源）：
            Ⓐ 重讀 (provider,subject) active owner
               ├─ == current                → 200 幂等
               ├─ == 已鎖的 other 且 active  → 409 IDENTITY_ALREADY_LINKED + merge_token
               └─ == 不在 lock_ids 的第三 user（併發 login-create 搶插）
                                             → ROLLBACK，併入 lock_ids 後重開（同步驟 5 bounded retry）
            Ⓑ 若 Ⓐ 無 active owner → 必為 uq_user_provider_active 衝突
               （current 同 provider 已有不同 subject 的 active identity）
                                             → 409 SAME_PROVIDER_ALREADY_LINKED
  9. COMMIT
```

> - **兩 user 一次鎖定 + UUID 排序**：無論誰先發起、owner UUID 大小如何，鎖取得順序一致，杜絕 §DIC-759 指出的「先鎖 current、後鎖 owner」互等 deadlock。
> - **owner 鎖後重讀 + bounded restart**：pre-probe 無鎖只用來決定要鎖誰；真正判定一律以「鎖後重讀」為準。第三方在窗口內搶下 ownership 時，rollback 併入 lock_ids 後重開，最終仍以已鎖狀態做決定。
> - **INSERT 一律驗 RETURNING**：revoke stale owner 後的 retry 不假設「此時不衝突」——若 current 已有同 provider 不同 subject 的 active identity，retry 仍會撞 `uq_user_provider_active` 而回 0 rows，此時重跑 Ⓐ→Ⓑ 判定，正確回 409 SAME_PROVIDER_ALREADY_LINKED，不會誤判為成功。
> - same-provider/different-subject 一律回 **409 SAME_PROVIDER_ALREADY_LINKED**（非 200 idempotent）；要換綁需先 unlink 舊 identity 再 link 新的。

### 5.3 解除綁定（unlink）
```
DELETE /api/auth/link/:provider
  ├─ 在一個 DB transaction 內（鎖定順序：users FOR UPDATE → identities FOR UPDATE）：
  │     ├─ SELECT id, status FROM users WHERE id = <user> FOR UPDATE
  │     │     → 若 status != 'active' → 409
  │     ├─ SELECT * FROM auth_identities WHERE user_id = <user> FOR UPDATE
  │     │      （row-level lock 鎖住該 user 所有 identity row，防止併發 unlink
  │     │       造成兩個 goroutine 各自看到 ≥2 筆而都 revoke，違反至少保留一個登入方式）
  │     ├─ 計算 revoked_at IS NULL 的 identity 數
  │     │     ├─ AFTER 本次 revoke 仍 ≥ 1 → 允許：set revoked_at = now()，
  │     │     │     撤銷該 identity 產生的 sessions
  │     │     └─ AFTER 本次 revoke == 0 → 409 CANNOT_UNLINK_LAST_METHOD
  │     └─ COMMIT
```
> `FOR UPDATE` + transaction 保證「計數 → 檢查 → revoke」為原子操作；兩個 unlink 併發時，後者會在 lock 釋放後看見 revoke 後的真實數量。`uq_user_provider_active` 同時保證單一 user 同 provider 不會意外出現第二個 active identity。

### 5.4 刪除帳號（delete）
```
DELETE /api/account
  ├─ 在一個 DB transaction 內：
  │     ├─ SELECT id, status FROM users WHERE id = <user> FOR UPDATE
  │     │     → 若 status != 'active' → 409（已刪除 / 已停用）
  │     │     → 若 status = 'active' → UPDATE users SET status='pending_deletion',
  │     │          deleted_at = now()；UPDATE sessions SET revoked_at = now()
  │     │          WHERE user_id = <user> AND revoked_at IS NULL
  │     └─ COMMIT
  ├─ （可選）grace period（如 14 天）可自行復原
  └─ purge job：實體刪除 users → CASCADE 清 auth_identities / sessions /
       user_settings / favorites / watchlist / push_tokens / scan_usage / subscriptions / entitlements；
       audit_log 保留（user_id 無 FK）；
       account_merge_requests 因 FK 為 ON DELETE SET NULL，source/target UUID 存於 snapshot 欄位不遺失。
```
> `FOR UPDATE` lock + transaction 保證 login/link 與 delete 間的序列化：login/link 中若同一 user 已 `pending_deletion`，login 的 `FOR UPDATE` 會在 `re-read` status 時看見 `pending_deletion` 而拒絕；反過來，若 login 先拿到 lock，delete 會 blocked 直到 login COMMIT，兩者不會同時成功。

---

## 6. API 契約（平台實作任務接口）

REST，沿用現有 Vercel handler 風格（`Request → Response.json`）。Access token 走 `Authorization: Bearer <jwt>`。

| Method & Path | 需登入 | Request | Response |
| --- | --- | --- | --- |
| `POST /api/auth/login` | 否 | `{ provider:'google'\|'apple', id_token, nonce? }`（Apple web 另帶 `code`） | `{ user, session:{access_token,refresh_token,expires_in}, is_new_user }` |
| `POST /api/auth/refresh` | 否（帶 refresh） | `{ refresh_token }` | `{ access_token, refresh_token, expires_in }` |
| `POST /api/auth/logout` | 是 | `{ refresh_token }` | `{ ok:true }` |
| `GET /api/auth/me` | 是 | – | `{ user, identities:[{provider,masked_email,linked_at,is_primary}] }` |
| `POST /api/auth/link` | 是 | `{ provider, id_token, nonce? }` | `200 { ok:true }` \| `409 { error:'IDENTITY_ALREADY_LINKED', merge_token }` \| `409 { error:'SAME_PROVIDER_ALREADY_LINKED' }` \| `403 { error:'ACCOUNT_DISABLED' }` |
| `POST /api/auth/merge/confirm` | 是 | `{ merge_token, google_id_token?, apple_id_token? }` | `{ ok:true, user }` \| `409 { requires_support:true, merge_request_id }` |
| `DELETE /api/auth/link/:provider` | 是 | – | `200 { ok:true }` \| `409 { error:'CANNOT_UNLINK_LAST_METHOD' }` |
| `DELETE /api/account` | 是 | `{ confirm:true }` | `{ ok:true, purge_after }` |

**標準錯誤碼**：`INVALID_TOKEN`(401)、`TOKEN_EXPIRED`(401)、`IDENTITY_ALREADY_LINKED`(409)、`SAME_PROVIDER_ALREADY_LINKED`(409)、`CANNOT_UNLINK_LAST_METHOD`(409)、`MERGE_REQUIRES_SUPPORT`(409)、`ACCOUNT_DISABLED`(403)。

**受保護的既有 API**：`api/push/register`、`api/push/watchlist` 從「以 push token 為 key」改為「帶 `Authorization` → 用 `users.id`」；未登入裝置仍可註冊 push token（`push_tokens.user_id = null`），登入後把該 token 認領 (claim) 到 user。

### 6.1 Provider ID token 驗證細節
- **Google**：JWKS `https://www.googleapis.com/oauth2/v3/certs`；`iss ∈ {accounts.google.com, https://accounts.google.com}`；`aud` = 對應平台的 OAuth client id（web / ios / android 各一）；subject = `sub`。
- **Apple**：JWKS `https://appleid.apple.com/auth/keys`；`iss = https://appleid.apple.com`；`aud` = Services ID（web）或 Bundle ID（native）；驗 `nonce`；subject = `sub`；`email` 只在首次授權出現，`is_private_email` 判 relay。

---

## 7. Web Apple 登入設定需求（Apple Developer）

Web 的 Sign in with Apple 需要下列設定（無論自管或用 Firebase/Supabase broker 都要）：

| 項目 | 值 / 說明 |
| --- | --- |
| App ID | `com.dicoge.holohunter`（native iOS），啟用 Sign in with Apple capability |
| **Services ID** | 新建，如 `com.dicoge.holohunter.web`，作為 Web OAuth client（= Apple 的 `aud`/client_id） |
| Return URLs / redirect URI | 必須 https 且事先登記，如 `https://<domain>/api/auth/apple/callback`；Apple 用 `response_mode=form_post` POST 回來 |
| Domain verification | 於 Services ID 綁定 domain，並在網站服務 `/.well-known/apple-developer-domain-association.txt` |
| Sign in with Apple Key | 產生 `.p8` 私鑰 → 記錄 **Key ID + Team ID**；後端用 ES256 簽 `client_secret`（JWT），**Apple client_secret 最長 6 個月**，需排程輪替 |
| CORS / 網域 | Web app 網域需與 Services ID 登記一致 |

- **broker 選擇**：若採 Supabase/Firebase 作 Apple web 的 OAuth broker，仍以「我方後端驗其回傳的 provider id_token / 取得 Apple `sub`」寫入我方 `auth_identities`，**不使用 broker 內建的 user 表作為權威**，以保有 §4 collision 控制。
- native iOS 用 `expo-apple-authentication`（原生），Google 用 Google Sign-In；各平台的 `aud` 對應不同 client id / bundle id，後端 `aud` 白名單需涵蓋三者。

---

## 8. DB Migration 方向

1. **導入 Postgres**（Vercel Postgres / Neon / Supabase），建立 §3 全部資料表（一份 `migrations/0001_auth.sql`）。
2. **push_tokens 遷移**：把 `data/push-tokens.json` 匯入 `push_tokens`（`user_id = null`）；`data/push-watchlist.json`（token → cards）暫留，待裝置登入 claim token 後，將其 watchlist 併入 `watchlist(user_id, card_number)`。
3. **本機資料上雲**：App 端在首次登入後，把本機 zustand persist 的 favorites / settings / watchlist 一次性 push 到 server（`POST /api/sync`，或分別打 favorites/watchlist/settings endpoint），之後以 server 為準（本機作快取）。
4. **相容期**：未登入使用者維持純本機體驗（現況不壞）；登入為 opt-in 加值（跨裝置同步、雲端 watchlist 提醒）。

---

## 9. 交棒給後續任務

- **DIC-663 [WEB AUTH]**：實作 `POST /api/auth/login`（Google 先行）、Web Apple 依 §7 設定；綁定/解綁走本文件 §5 flow。
- **iOS / Mobile Google**：`aud` 對應各自 client id / bundle id；native Apple 用 `expo-apple-authentication`。
- **QA**：涵蓋 §5 全 flow + §4 collision + §5.3 last-method 保護 + §5.4 刪除。
- **隱私權政策**：揭露收集 provider `sub`、email（含 relay）、刪除流程與保留期。
