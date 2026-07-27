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

### 3.5 collision merge 與審計

```sql
CREATE TABLE account_merge_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id UUID NOT NULL REFERENCES users(id),  -- 被併走（保留舊 provider 的那個 user）
  target_user_id UUID NOT NULL REFERENCES users(id),  -- 存活方（當下登入中的 user）
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
   - 任一方有付費 / premium / 交易類資料（未來擴充時）。
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

merge 過程中 identities 的 `revoked_at` / `user_id` 轉移必須在一個 DB transaction 內完成，確保中途失敗可 rollback。具體步驟與審計規格：

**步驟 A — 驗證雙方 identity**
1. 查詢 `merge_token` 指向的 source / target user id，確認 `merge_token` 未過期且未使用。
2. 驗證請求中附帶的雙方 provider ID token（§4 步驟 2），確保呼叫者同時掌握兩個帳號；任一驗證失敗 → 回 `401`，終止。
3. 確認任一 user 狀態非 `disabled` / `pending_deletion`；任一為此類 → 轉 `requires_support`，終止。

**步驟 B — identity 轉移（針對 source 每個 `revoked_at IS NULL` 的 identity）**
1. 對每個 `(provider, subject)`：
   - 查 target 是否有同 provider 的 **active** identity (`revoked_at IS NULL`)。
   - **無衝突** → UPDATE `auth_identities SET user_id = target.id WHERE id = <source_identity.id>`（`uq_provider_subject_active` partial unique index 保證 target 新組合不衝突）。identity 保持 active，`linked_at` 不變，`revoked_at = NULL`。
   - **有衝突** → 保留 target 既有 identity；source 該 identity SET `revoked_at = now()`，記 audit_log `event_type='merge_revoke'`，`metadata` 含 `{reason:'target_has_same_provider', target_identity_id, source_identity_id}`。因 partial unique index 只在 `revoked_at IS NULL` 時作用，revoked row 不阻塞日後同一 `(provider, subject)` 重新綁定。
2. 以上全部在同一個 DB transaction 內。

**步驟 C — source user 標記**
- `UPDATE users SET status = 'pending_deletion', deleted_at = now() WHERE id = <source.id>`。

**步驟 D — session 處理**
- 撤銷 source user 全部 active session（`UPDATE sessions SET revoked_at = now() WHERE user_id = <source.id> AND revoked_at IS NULL`）。
- 可選：若 target 的 session 也過期 / 數量過多，可保留最新 N 個，其餘撤銷。

**步驟 E — 審計（audit_log）**
merge 完成後寫入以下審計記錄：

| event_type | metadata |
| --- | --- |
| `merge_created` | `{merge_request_id, source_user_id, target_user_id, source_provider, source_subject}` |
| `merge_revoke`（每個衝突 identity 一筆） | `{merge_request_id, source_identity_id, target_identity_id, reason:'target_has_same_provider'}` |
| `merge_transfer`（每個無衝突轉移 identity 一筆） | `{merge_request_id, source_identity_id, provider, subject, from_user_id→to_user_id}` |
| `merge_favorites` / `merge_watchlist` / `merge_settings` / `merge_push_tokens` | `{merge_request_id, count_added, count_skipped}` |
| `merge_completed` | `{merge_request_id, source_user_id, target_user_id, status:'completed'}` |

- `account_merge_requests.status` 更新為 `'completed'`，`resolved_at = now()`，`resolver = 'auto'`。
- 日後追溯單一 user 的合併歷史，可對 audit_log 篩 `user_id = source_user_id OR metadata->>'target' = <target_user_id>` 得知完整合併鏈。

---

## 5. Auth Flows

### 5.1 登入 / 註冊（login-or-create）
```
Client 取得 provider ID token
  └─ POST /api/auth/login { provider, id_token, [nonce] }
       ├─ 後端用 JWKS 驗 token（iss / aud / exp / nonce），取 subject = sub
       ├─ 查 auth_identities(provider, subject)
       │     ├─ 命中 → 該 identity.user_id 登入，更新 last_login_at
       │     └─ 未命中 → 建 users + auth_identities（is_new_user=true）
       └─ 簽發 access + refresh token（寫 sessions）
```
> **絕不**用 email 去比對或合併既有 user；只認 `(provider, subject)`。

### 5.2 綁定第二 provider（authenticated link）
```
已登入（access token）→ POST /api/auth/link { provider, id_token }
  ├─ 驗 token 取 subject
  ├─ (provider,subject) 未被使用 → 新增 identity 到目前 user（200）
  ├─ (provider,subject) 已屬「目前 user」 → 冪等回 200
  └─ (provider,subject) 屬「別的 user」 → 409 + merge_token（見 §4）
```

### 5.3 解除綁定（unlink）
```
DELETE /api/auth/link/:provider
  ├─ 計算解綁後 revoked_at IS NULL 的 identity 數
  │     ├─ >= 1 → 允許：set revoked_at = now()，撤銷該 identity 產生的 sessions
  │     └─ == 0 → 409 CANNOT_UNLINK_LAST_METHOD
```

### 5.4 刪除帳號（delete）
```
DELETE /api/account
  ├─ users.status = 'pending_deletion'、deleted_at = now()（軟刪 + 撤銷所有 session）
  ├─ （可選）grace period（如 14 天）可自行復原
  └─ purge job：實體刪除 users → CASCADE 清 auth_identities / sessions /
       user_settings / favorites / watchlist / push_tokens；audit_log 保留（user_id 無 FK）
```

---

## 6. API 契約（平台實作任務接口）

REST，沿用現有 Vercel handler 風格（`Request → Response.json`）。Access token 走 `Authorization: Bearer <jwt>`。

| Method & Path | 需登入 | Request | Response |
| --- | --- | --- | --- |
| `POST /api/auth/login` | 否 | `{ provider:'google'\|'apple', id_token, nonce? }`（Apple web 另帶 `code`） | `{ user, session:{access_token,refresh_token,expires_in}, is_new_user }` |
| `POST /api/auth/refresh` | 否（帶 refresh） | `{ refresh_token }` | `{ access_token, refresh_token, expires_in }` |
| `POST /api/auth/logout` | 是 | `{ refresh_token }` | `{ ok:true }` |
| `GET /api/auth/me` | 是 | – | `{ user, identities:[{provider,masked_email,linked_at,is_primary}] }` |
| `POST /api/auth/link` | 是 | `{ provider, id_token, nonce? }` | `200 { ok:true }` \| `409 { error:'IDENTITY_ALREADY_LINKED', merge_token }` |
| `POST /api/auth/merge/confirm` | 是 | `{ merge_token, google_id_token?, apple_id_token? }` | `{ ok:true, user }` \| `409 { requires_support:true, merge_request_id }` |
| `DELETE /api/auth/link/:provider` | 是 | – | `200 { ok:true }` \| `409 { error:'CANNOT_UNLINK_LAST_METHOD' }` |
| `DELETE /api/account` | 是 | `{ confirm:true }` | `{ ok:true, purge_after }` |

**標準錯誤碼**：`INVALID_TOKEN`(401)、`TOKEN_EXPIRED`(401)、`IDENTITY_ALREADY_LINKED`(409)、`CANNOT_UNLINK_LAST_METHOD`(409)、`MERGE_REQUIRES_SUPPORT`(409)、`ACCOUNT_DISABLED`(403)。

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
