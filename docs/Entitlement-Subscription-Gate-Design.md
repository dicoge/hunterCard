# HoloHunter 掃描 Quota、訂閱狀態與 Premium Gate 設計

> DIC-679 · 設計提案
> 在既有兩份權威文件之上，補齊「訂閱來源驗證 / 生命週期 / UI 狀態 / 帳號刪除保留」四塊尚未落定的設計，銜接 internal user id 與未來 IAP / Web 付費方案。

---

## 0. 與既有權威文件的關係（本文件只補缺口，不重定義）

本文件**不重新定義**資料模型、額度數值與掃描 gate；那些的權威來源是：

| 主題 | 權威來源 | 本文件如何處理 |
| --- | --- | --- |
| `users` / `auth_identities` / `sessions` / merge / delete-purge | [AUTH-Architecture.md](./AUTH-Architecture.md)（DIC-662 / PR #50） | 引用，不覆寫 |
| `scan_usage` / `subscriptions` / `entitlements` schema | AUTH §3.5 | 引用；只**新增** receipt 對應表與 billing 保留表 |
| **額度數值單一權威** `quota_matches_tier` CHECK（`free=(NULL,100)`、`pro=(NULL,NULL)`） | AUTH §3.5 | 引用，數值不另立第二套 |
| 角色推導、capability matrix、Onboarding、reserve/commit/release、premium 端點 | [Product-Entitlement-Architecture.md](./Product-Entitlement-Architecture.md)（DIC-674 / PR #59） | 引用，不覆寫 |

**本文件的 net-new（四塊缺口）**：
1. **§1–§2** 訂閱來源驗證資料模型（receipt / purchase token → **internal user id** 對應，非 email）與生命週期狀態機。
2. **§3** 三平台驗證與狀態同步（App Store / Google Play / Stripe）。
3. **§4** Web Stripe 取捨建議。
4. **§5** Premium gate 與 quota 的 **UI 狀態需求**（對齊現有 `ScanQuotaBanner` / `PremiumGate`）。
5. **§6** 帳號刪除 / 交易紀錄假名化保留（誠實區分 pseudonymization vs anonymization）。

> ⚠️ `subscriptions.status` 沿用 AUTH §3.5 的 enum `('active','cancelled','expired','paused')`。本文件所有 grace / billing-retry / refund 狀態都**映射進這四個既有值**，不擴充 enum，以免與權威 schema 衝突（映射見 §2）。

---

## 1. 訂閱來源驗證資料模型（歸屬 internal user id）

AUTH `subscriptions` 是 tier 的真相來源，但它**只記「這個 user 有沒有 active 訂閱」**，不足以做「平台交易驗證、重複回報去重、退款/取消對應、跨裝置還原購買」。因此新增一張 **平台交易對應表**，把每一筆平台訂閱事件錨定到 `users.id`：

```sql
-- (1) 平台訂閱交易 → internal user 的權威對應（每筆平台訂閱一列，隨續訂更新）
CREATE TABLE subscription_receipts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id      UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, -- 對應的 AUTH subscriptions row（1:1，由 uq_receipt_subscription 強制）
  platform             TEXT NOT NULL CHECK (platform IN ('app_store','google_play','stripe')),
  -- 平台帳戶範圍（scope），驗證與去重都必須綁進來，防跨 app / 跨帳戶事件污染（§3）：
  --   app_store   = bundleId（或 appAppleId）
  --   google_play = packageName
  --   stripe      = Stripe account id (acct_...) + livemode
  provider_account     TEXT NOT NULL,
  -- 平台側的「穩定訂閱識別」，續訂/回報去重都以它為準：
  --   app_store   = originalTransactionId
  --   google_play = purchaseToken（或 linkedPurchaseToken 追溯後的根 token）
  --   stripe      = subscription id (sub_...)
  provider_sub_ref     TEXT NOT NULL,
  latest_txn_ref       TEXT,                    -- 最近一次交易/續訂識別（app store transactionId / stripe invoice 等）
  -- 目前反映的「provider 權威狀態」的生效時間與同步時間（見 §2.2；事件只是觸發，狀態一律回抓 provider）：
  state_effective_at   TIMESTAMPTZ,             -- **狀態轉移的 order cursor**：該狀態「發生」的 provider 權威時點，恆為過去/現在、**絕非未來效期界線**。
                                                --   Apple = 狀態變更通知 signedDate；Google = 當期 startTime（**非** lineItems.expiryTime）；
                                                --   Stripe = 該狀態變更事件/物件 created（renewal invoice / refund / dispute / dispute.closed Event 的 created）。
                                                --   效期界線（current_period_end / expiry）另存於 subscriptions.expires_at，只作 active-window 判斷，**不作排序**（避免未來 period_end 讓當下退款誤判為 stale，見 §2.2 note）。
  state_synced_at      TIMESTAMPTZ,             -- server 端最近一次套用 provider 權威回抓的時間（stale-guard 用）
  product_id           TEXT NOT NULL,           -- 平台方案 id（sku / price id）
  environment          TEXT NOT NULL DEFAULT 'production'
                         CHECK (environment IN ('production','sandbox')),
  raw_verification     JSONB,                   -- 驗證後保留的必要欄位（非整包收據，見下）
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一平台帳戶範圍的同一訂閱只能對應一個 internal user，防「一單綁多帳號」與重複入帳：
  CONSTRAINT uq_platform_sub UNIQUE (platform, provider_account, environment, provider_sub_ref),
  -- 每個 AUTH subscriptions row 至多對應一列 receipt（強制 §1 宣稱的 1:1；§2.2 以此 row 為寫入目標）：
  CONSTRAINT uq_receipt_subscription UNIQUE (subscription_id)
);
CREATE INDEX idx_sub_receipts_user ON subscription_receipts(user_id);

-- (2) 已處理事件帳本（processed-event ledger）：去重 + 只處理一次的權威來源。
-- 每個 provider 事件在 mutate 狀態前先 INSERT 此表；唯一鍵撞上 → 已處理過，直接丟棄（冪等）。
CREATE TABLE subscription_events (
  id                   BIGSERIAL PRIMARY KEY,
  platform             TEXT NOT NULL CHECK (platform IN ('app_store','google_play','stripe')),
  provider_account     TEXT NOT NULL,           -- 同上 scope；跨帳戶事件 id 可能重複，故納入唯一鍵
  environment          TEXT NOT NULL DEFAULT 'production',
  -- provider 的事件唯一識別：
  --   app_store   = notificationUUID
  --   google_play = Pub/Sub messageId
  --   stripe      = event id (evt_...)
  event_id             TEXT NOT NULL,
  event_type           TEXT NOT NULL,           -- SUBSCRIBED / DID_RENEW / REFUND / invoice.paid ...
  provider_sub_ref     TEXT,                    -- 事件對應的訂閱（去重後用來定位 receipt row）
  event_time           TIMESTAMPTZ NOT NULL,    -- provider 事件時間（signedDate / eventTimeMillis / object.created）；僅記錄與稽核用，不作跨事件排序依據
  provider_version     TEXT,                    -- Play RTDN 信封版本，文件值為字串 `"1.0"`（DeveloperNotification.version）；**非序號、不可排序**，僅稽核留存。其他平台填 NULL
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_event UNIQUE (platform, provider_account, environment, event_id)
);
```

設計要點：

- **對應鍵永遠是 `users.id`，永不是 email**（沿用 AUTH §2）。平台把購買錨定到我方 user 的方式見 §3（Apple `appAccountToken` / Google 購買時 `setObfuscatedAccountId` / Stripe `client_reference_id`），三者一律填 internal user id（UUID）。**注意 Google 的往返不對稱**：購買時我方設 `obfuscatedAccountId`，但該值**不出現在 RTDN 通知**內，只在 `purchases.subscriptionsv2.get` 回應的 `externalAccountIdentifiers.obfuscatedExternalAccountId` 取回；因此 Google 的 user 解析**必須在回抓 provider 狀態之後**（§2.2 step b→c）。
- **`uq_platform_sub` 是去重與防盜綁的核心**：唯一鍵含 **`provider_account`（平台帳戶範圍）+ `environment`**，同一 scope 下的同一 `originalTransactionId` / `purchaseToken` / Stripe `sub_id` 只能存在一列。若同一平台訂閱嘗試綁到**不同** user（換手機、帳號轉移、共享 Apple ID）→ 走 §2.4 衝突處理，不自動改綁。
- **`subscription_events` 帳本讓事件冪等且可重播**：`uq_provider_event` 以 provider 事件 id（Apple `notificationUUID` / Google Pub/Sub `messageId` / Stripe `evt_...`）去重，同一事件重送只生效一次。**排序不靠事件本身**：所有平台的事件都只當「去 provider 回抓權威狀態」的觸發，真正的訂閱狀態一律以 provider 的 current-state API 為準（Apple App Store Server API / Google `subscriptionsv2.get` / Stripe `Subscription.retrieve`）。因此 Google RTDN `version` 是 **schema 版本、非單調序**，絕不用於排序；亂序 / 遲到事件因回抓的是「當下」狀態而自然無害（§2.2、§3）。
- **`subscription_id` 為 1:1 且 `NOT NULL`（`uq_receipt_subscription` 強制）**：每個 platform 訂閱對應**恰好一個** AUTH `subscriptions` row，且該 row **至多**被一列 receipt 引用（DB 層強制，非僅口頭宣稱）。§2.2 以 `subscription_receipts.subscription_id` 指到的**那一列** row 為寫入目標，而非用不存在唯一鍵的 `user_id` upsert。同一 user 可同時有多個 platform 的 `subscriptions` row（AUTH 允許多列），active 判定跨所有 row 聚合（§2.2）。
- **`raw_verification` 只留驗證所需的最小欄位**（`expires_date`、`auto_renew_status`、`product_id`、環境、最近事件類型），**不落原始 receipt / signed JWS 全文**（含裝置/帳戶敏感資訊，且會膨脹）。這也讓 §6 假名化只需清 `user_id` 與去識別化幾個欄位。
- `subscription_receipts` 是驗證/對帳層；`subscriptions`（AUTH）仍是 gating 讀取的 tier 真相；`entitlements` 是物化快取。三層關係：**receipt 事件 → 定位並更新對應 `subscriptions` row → 跨所有 row reconcile `entitlements`（Product §5.3）**。

---

## 2. 訂閱生命週期狀態機

所有平台事件最終都收斂成對 `subscriptions.status` 的一次 upsert，再觸發 Product §5.3 的 `entitlements` reconcile。跨平台共用同一條狀態機：

```
                 purchase / restore
        (none) ─────────────────────────▶ active ──────────────┐
                                            │  ▲  renew          │ user 取消自動續訂
       billing retry / grace period         │  │  (expires_at++) │ (仍付費到期)
        （平台仍視為有權限）  ───────────────┘  │                ▼
                                               │            active(auto_renew=off)
        寬限期滿仍未付款                        │                │ 到期
             │                                 │                ▼
             ▼                                 └───────────  expired
          expired ◀───────────────────────────────────────────  │
             ▲                                                    │
             │  refund / chargeback / 平台撤銷（立即失效）          │
        ─────┴──────────────────────────────────────────────▶ cancelled
```

### 2.1 平台事件 → `subscriptions.status` 映射（不擴充 enum）

| 生命週期情境 | 平台訊號（代表例） | `subscriptions.status` | `expires_at` / 其他 | 產品語意 |
| --- | --- | --- | --- | --- |
| 首購 / 還原購買 | ASSN `SUBSCRIBED`、Play `SUBSCRIPTION_PURCHASED`、Stripe `customer.subscription.created` | `active` | 設 `expires_at` | 升級 subscriber |
| 續訂成功 | `DID_RENEW`、`SUBSCRIPTION_RENEWED`、`invoice.paid` | `active` | 延後 `expires_at` | 維持 subscriber |
| **帳單重試 / 寬限期**（付款失敗但平台仍給權限） | `DID_FAIL_TO_RENEW`(grace)、`IN_GRACE_PERIOD`、Stripe `past_due` | **`active`**（保留權限） | `expires_at` 暫延到寬限截止 | **仍為 subscriber**（依平台規範不可立即降級） |
| 使用者關閉自動續訂（付費到期前） | `DID_CHANGE_RENEWAL_STATUS(off)`、`SUBSCRIPTION_CANCELED`(仍有效)、`cancel_at_period_end=true` | `active` | 不變 | 到期前仍 subscriber；UI 顯示「到期後不續訂」 |
| 到期未續 | 排程掃 `expires_at < now()`、`SUBSCRIPTION_EXPIRED`、`customer.subscription.deleted` | `expired` | — | 降回 free_user |
| **退款 / 撤銷 / 拒付**（立即失效） | ASSN `REFUND`、Play `SUBSCRIPTION_REVOKED` / voided、Stripe `charge.refunded`（全額）/ `charge.dispute.created` | **`cancelled`** + `cancelled_at=now()` | — | **立即降回 free_user**，且記 audit（Stripe 全額/部分退款、爭議勝/敗政策見 §2.6） |
| 暫停（Play pause / Stripe pause） | `SUBSCRIPTION_PAUSED`、`pause_collection` | `paused` | — | 暫停期間**視為無 active 訂閱** → free_user |

> **判定不變式**：`hasActiveSubscription`（Product §2）= 該 user **任一** `subscriptions` row 滿足 `status='active' AND (expires_at IS NULL OR expires_at > now())`（跨多平台 row 聚合，OR 語意）。`paused` / `expired` / `cancelled` 都不算 active。寬限期刻意保持 `active`（權限不中斷），到期時間交由平台事件延長。

### 2.2 reconcile 觸發（權威在 server，單一交易、冪等、跨 row 聚合）

每次狀態變更（webhook / 排程）在**單一 DB transaction** 內依序執行，任一步失敗即整筆 rollback（不留半套狀態）：

```
# (a) 驗證：簽章 + 平台帳戶範圍 scope（§3），失敗直接拒收，不進交易（DB 之外）
verifyEventAuthAndScope(evt)               # Apple JWS+bundleId / Play push-JWT+packageName / Stripe sig+account+livemode

# (b) 回抓 provider current-state —— 在 user 解析與鎖定「之前」（DB 之外）。
#     原因：Google RTDN 的 SubscriptionNotification **只帶 purchaseToken，不帶帳戶識別**，
#     內部 UUID 不在通知內，必須先向 provider 查詢才拿得到（見 §3）。三平台一律先取權威狀態：
#     Apple  → App Store Server API Get Subscription Status（含 appAccountToken）
#     Google → purchases.subscriptionsv2.get（含 externalAccountIdentifiers.obfuscatedExternalAccountId）
#     Stripe → 依事件型別回抓（見 §2.6，退款/爭議不能只靠 Subscription.retrieve）：
#              lifecycle（customer.subscription.*）→ Subscription.retrieve(sub_id)
#              退款/爭議（charge.refunded / charge.dispute.*）→ Refund/Charge/Dispute.retrieve
#              + charge.invoice → Invoice.retrieve → invoice.subscription 解出 sub_id
#     事件只是「觸發」，狀態與帳戶歸屬都以此回應為準（Blocker 1：ordering-independent）。
state = fetchProviderCurrentState(platform, provider_account, environment, provider_sub_ref, event_type)

# (c) 由「provider 權威回應」導出並驗證內部 UUID（**不從事件 payload 取**）；解不出合法 UUID
#     或該 user 不存在 → 立即 fail closed，不進交易、不鎖、不寫。
user_id = deriveInternalUserId(platform, state)
#     Apple  = state.appAccountToken
#     Google = state.externalAccountIdentifiers.obfuscatedExternalAccountId
#     Stripe = subscription.metadata.user_id（Checkout 時由 client_reference_id 持久化）；
#              缺則 customer.metadata.user_id；再缺則既有 uq_platform_sub receipt 映射（sub_id）。
#              注意：Subscription.retrieve **不含** client_reference_id（該欄位在 Checkout Session）。
# provider 端的帳戶識別在「原始購買」當下固定，不隨我方帳號 merge 更新；若該 UUID 是已被
# merge 併走的來源帳號，須 follow account_merge_requests 重導到存活 target，讓事件落在正確帳號（§2.5）。
user_id = followMergeRedirect(user_id)     # completed merge: source_user_snapshot → target；無 merge 則原值
if not isUuid(user_id) or not EXISTS(SELECT 1 FROM users WHERE id=user_id AND status='active'):
    raise USER_UNRESOLVED                  # 500，fail closed（帳戶歸屬無法確立，絕不臆測入帳）
(mappedStatus, expiresAt, stateEffectiveAt) = mapProviderState(state)   # §2.1 映射
#     ⚠️ 兩個時鐘分離（見 §1 state_effective_at / §2.2 note）：
#       stateEffectiveAt = 狀態「發生」的權威時點（order cursor，恆非未來），供 step g 排序；
#       expiresAt        = 效期界線（current_period_end / expiry），寫入 subscriptions.expires_at 只作 active-window 判斷。
#     絕不把 expiresAt 當 stateEffectiveAt——否則未來 period_end 會讓當下退款/爭議在 step g 被誤判 stale。

BEGIN
  # (d) 每-user 序列化：先鎖住該 user，讓同一 user 的所有訂閱寫入嚴格串行，
  #     跨平台並發事件不會交錯（Blocker 3：per-user serialization）
  SELECT 1 FROM users WHERE id=$user_id FOR UPDATE;   # 序列化點；此後該 user 的訂閱狀態不被他人並發改動

  # (e) 冪等去重：先寫 processed-event ledger；撞唯一鍵 → 已處理過 → COMMIT 空操作
  INSERT INTO subscription_events (platform, provider_account, environment, event_id,
              event_type, provider_sub_ref, event_time, provider_version)
    VALUES (...) ON CONFLICT (platform, provider_account, environment, event_id) DO NOTHING;
  if row_count == 0: COMMIT; return        # 重播 / 重送，安全丟棄

  # (f) 以 provider 穩定訂閱鍵做「確定性」定位（Google = purchaseToken 經 linkedPurchaseToken
  #     追溯後的根 token；升/降級/重訂會發新 token 但鏈回同一根，確保命中同一 receipt）。
  #     命中則「一併鎖定其對應的 subscriptions row」，供 (g) 讀 status 做 tie-break、並驗整合完整性。
  rec = SELECT * FROM subscription_receipts
          WHERE platform=$p AND provider_account=$acct AND environment=$env AND provider_sub_ref=$ref
          FOR UPDATE;
  if rec exists:
      sub = SELECT * FROM subscriptions WHERE id = rec.subscription_id FOR UPDATE;   # 鎖住目標 row
      # 完整性不變式：receipt 必與其 subscription 同屬「由 provider 回應導出（含 merge 重導）」的 user。
      # 任一不等 → 不自動改綁、不臆測，回 409 並記 audit（涵蓋 §2.4 already-linked 與 merge 未搬移的破損）。
      if rec.user_id != user_id OR sub IS NULL OR sub.user_id != rec.user_id:
          ROLLBACK; raise SUBSCRIPTION_LINK_INTEGRITY   # 409（§2.4 / §2.5）

  # (g) stale re-fetch guard（同一 provider 的較舊回抓不得覆蓋較新狀態）：
  #     以回抓狀態的 provider 生效時間比較；相等時用「較嚴格者優先」的確定性 tie-break（讀 sub.status）
  if rec exists AND stateEffectiveAt < rec.state_effective_at: COMMIT; return
  if rec exists AND stateEffectiveAt == rec.state_effective_at
        AND statusRank(mappedStatus) <= statusRank(sub.status)
        # 例外（§2.6 規則 5）：同一 dispute.id 的 terminal 結案相位優先於自身 provisional 撤權，
        # 等時仍讓 won 恢復 active / lost 維持 cancelled，不套 fail-closed statusRank。
        AND NOT (isTerminalDisputeClose AND rec.latest_txn_ref == dispute.id): COMMIT; return

  # (h) 首購 → 建立恰好一個 subscriptions row 並回填 receipt.subscription_id；
  #     續訂/取消/退款 → UPDATE receipt.subscription_id 指到的「那一個」row
  if rec not exists:
      sub = INSERT INTO subscriptions (user_id, plan, status, started_at, expires_at) VALUES (...) RETURNING id;
      INSERT INTO subscription_receipts (user_id, subscription_id, ..., state_effective_at, state_synced_at)
        VALUES (..., sub.id, ..., stateEffectiveAt, now());        # uq_receipt_subscription 保證 1:1
  else:
      UPDATE subscriptions SET status=$mappedStatus, expires_at=$expiresAt, cancelled_at=... WHERE id = rec.subscription_id;
      UPDATE subscription_receipts SET latest_txn_ref=$txn, state_effective_at=stateEffectiveAt,
             state_synced_at=now(), updated_at=now() WHERE id = rec.id;

  # (i) 原子跨平台聚合 reconcile：該 user 的全部 subscriptions row（已被 (d) 鎖序列化）一次算出 active
  active = EXISTS (SELECT 1 FROM subscriptions
                     WHERE user_id=$user_id AND status='active'
                       AND (expires_at IS NULL OR expires_at > now()));
  reconcile entitlements(user_id): active ? pro(NULL,NULL) : free(NULL,100)   # Product §5.3
  audit_log(event_type='subscription_<evt>', metadata={platform, event_id, sub_id})
COMMIT
```

其中 `statusRank`（確定性 tie-break，**較嚴格 / 失權者優先**，同生效時間時取較高 rank，fail-closed）：
`cancelled`（退款/撤銷，立即失權）> `expired` > `paused` > `active`。
兩個生效時間相同的訊號同時到達時（例：續訂與退款理論上同秒），一律採失權方，寧可短暫少給權限、不誤給。

> **note — order cursor 與效期界線是兩個時鐘，不可混用（Blocker：未來 period_end 不得讓當下退款誤判 stale）**：`state_effective_at` 是「狀態**發生**的時點」（order cursor），`subscriptions.expires_at` 是「權益**有效到**何時」（validity horizon）。若把續訂的 `current_period_end`（未來）寫進 `state_effective_at`，則當下的退款/爭議（`state_effective_at≈now` < 未來 period_end）會在 step g 被判為 stale → **(e) 已把 event_id 記入帳本、(g) 卻跳過寫入並 COMMIT**，該狀態永久停留 `active` 且重播因 `uq_provider_event` 去重而無法再套用（永久漏撤）。故續訂的 `state_effective_at` 必須取**該次續訂的轉移時點**（Apple signedDate / Google 當期 startTime / Stripe renewal invoice `created`），未來的 `current_period_end` 只落 `expires_at`。如此當下退款的 order cursor 恆晚於先前續訂，step g 正常寫入撤權；即便退款與續訂同秒，`statusRank` 仍讓失權方勝出（authenticated 退款/爭議撤權必勝）。
- **provider current-state 為真相、帳戶歸屬也以它為準（Blocker 1 + Google 帳戶識別）**：任何平台事件都只當「去回抓」的觸發，真正狀態與**內部 user 歸屬**一律讀 provider 的 current-state API（step b）再導出（step c）。Google 尤其關鍵——RTDN 只帶 `purchaseToken`，帳戶識別 `obfuscatedExternalAccountId` 只在 `subscriptionsv2.get` 的 `externalAccountIdentifiers` 回應內，故**必先查詢才能解析 user**，絕不從通知 payload 臆測。因此 Google RTDN `version`（schema 版本、非單調序）**永不用於排序**；亂序 / 遲到 / 重送因回抓的都是「當下」狀態而自然無害。唯一需要防的是「較舊的回抓覆蓋較新的回抓」（例：兩個 worker 各自回抓後寫回），以 `state_effective_at` + `statusRank` 的確定性比較擋下（step g），且 (d) 的 per-user 鎖已讓同一 user 的回抓串行、不交錯。
- **user 歸屬確立後才進交易，不確立即 fail closed（step c）**：`deriveInternalUserId` 只吃 provider 權威回應；導不出合法 UUID 或該 user 不存在即 `USER_UNRESOLVED`（500），不鎖不寫。既有 receipt 於 step f 再做「身分相等」檢查（`rec.user_id == user_id`），不等即 409、不自動改綁——首購與續訂/取消都無法把一筆平台訂閱綁到錯誤帳號。
- **per-user 序列化 + 原子跨平台聚合（Blocker 3）**：交易一開始即 `SELECT ... FROM users FOR UPDATE` 鎖住該 user，該 user 名下所有平台的訂閱寫入與 (i) 的跨 row active 聚合都在這把鎖內完成，不會與另一平台的並發事件交錯，聚合看到的是一致快照。寫入永遠針對 `subscription_receipts.subscription_id` 指到的**那一個** row（AUTH `subscriptions` 無 `user_id` 唯一鍵、允許多列），故「A 平台退款」只改 A 的 row，`entitlements` 再跨**所有** row 聚合，不會誤降「B 平台仍 active」的訂閱。
- **冪等**：`subscription_events` 帳本（唯一鍵去重）確保同一事件重送只生效一次；receipt / subscription / entitlements 三寫都在同一交易內完成，無中間可觀察的不一致。
- **權威計算在 server**：client 端的購買回呼只是「提示去 pull」，真正入帳一律以**平台簽章事件 + server 驗證**為準（§3），本機不可寫 tier。這對齊需求「quota 重置由 backend 權威計算，防本機竄改」——`entitlements`/`scan_usage` 都在 server，本機時間/快取無法影響。
- **月 quota 重置**同理由 server 權威：`scan_usage` 以 `period='YYYY-MM'`（server clock）為 PK，換月即新 row，不靠 client（AUTH §3.5 / Product §6.1 已定義；此處僅重申來源不可竄改）。

### 2.3 到期補判與「到期空窗不得無限掃描」（fail-closed 一致性）

**風險（CR finding 2）**：`hasActiveSubscription` 在 `expires_at` 當下**即刻**變 false（role 立刻降為 free_user），但 `entitlements.tier` 是**物化快取**，若只靠**每日排程** reconcile，兩者之間存在空窗——此時 Product §5.1 讀到 `tier='pro'` 的 `monthly_limit=NULL` 卻搭配 free_user role，會回**不限量**，等於「到期後仍無限掃描」。

必須兩道防線同時成立：

1. **effectiveEntitlement 的 role↔tier 一致性檢查（fail-closed）現為 Product §5.1 權威契約**。不限量放行的唯一合法條件是 **role 解析為 subscriber**（即 `subscriptions` 當下確有 active row），而非「快取 tier 剛好是 pro」；`role != 'subscriber'` 卻 `tier=='pro'`（或 `monthly_limit IS NULL`）一律回 `ENTITLEMENT_UNAVAILABLE`（500）擋掃描、絕不因 `quota=NULL` 放行不限量，反向不一致亦 fail-closed。此不變式**已寫入權威文件 [Product-Entitlement-Architecture.md](./Product-Entitlement-Architecture.md) §5.1 的 `effectiveEntitlement` 契約與其 fail-closed 不變式（第 2 條）**，不再只是本設計文件的「強化要求」——實作 Product gating 時 DB/service 必須落實該檢查（QA 見 §7）。
2. **邊界 reconcile，不只每日排程**：除了每日掃 `status='active' AND expires_at < now()` 標 `expired` 並 reconcile（Product §5.3），另**在寫入訂閱時排一個 `expires_at` 到點即觸發的 reconcile job**（延遲佇列 / cron-at），使快取在到期當下即翻回 free，把空窗窗口壓到最小。每日排程僅為兜底。

**排程的冪等（不虛構 provider event id）**：到期排程**不是** provider 事件，沒有 `notificationUUID`/`messageId`/`evt_id`，因此**不寫也不查** `subscription_events` 帳本。它的冪等來自「以當下狀態收斂」：排程 `UPDATE subscriptions SET status='expired' WHERE user_id=$u AND status='active' AND expires_at < now()`（在 §2.2 (d) 的 per-user `FOR UPDATE` 鎖內），已是 `expired` 的 row 不再命中篩選，重跑天然收斂、無副作用；隨後照 §2.2 (i) 跨 row 聚合 reconcile `entitlements`。webhook 側的回抓寫入則沿用 §2.2 的 `state_effective_at` + `statusRank` 確定性 guard（§2.2 step g，讀對應 `subscriptions.status`），較舊回抓不覆蓋較新狀態；排程把 `state_effective_at` 設為 `expires_at`（**到期這個轉移的發生時點就是 `expires_at`**，排程觸發時 `now() >= expires_at`，屬過去/現在，仍是 order cursor 語意、非未來效期界線，與上方 note 一致）、`state_synced_at=now()`，與 webhook 回抓走同一條比較規則，兩路徑對同一 row 的寫入互不回退。

### 2.4 同一平台訂閱綁不同 user（衝突）

`uq_platform_sub` 命中既有 row 但 `user_id` 不同時（例：同一 Apple ID 在兩個 HoloHunter 帳號還原購買）：**不自動改綁**，回 `409 SUBSCRIPTION_ALREADY_LINKED`，記 audit，導向客服/人工，與 AUTH §4 merge 的 `requires_support` 門檻一致（任一方有 active pro 即需人工）。避免「盜綁他人訂閱」或「一單洗多帳號」。

### 2.5 帳號 merge 與 receipt 歸屬（維持 receipt/subscription 同 user）

AUTH §4 的帳號 merge 會把 source 的 active `subscriptions.user_id` 原子搬到 target（§3.5.1 / §4.2 step C）。`subscription_receipts` 是本設計新增的 1:1 對應表，故 merge **必須一併搬移 receipt 歸屬**，否則會出現「receipt 仍指 source、但其 `subscription_id` 指到的 subscription 已屬 target」的裂解，導致日後 provider 事件在 source reconcile、卻更新 target 的 subscription，使 target entitlement 在退款/取消後殘留 stale，且 source purge 會 cascade 掉 receipt 卻留下已搬走的 subscription。

**規則（已寫入權威 AUTH §3.5.1 merge 表與 §4.2 step C，於同一 merge transaction 內）**：

1. **receipt 隨 subscription 原子搬移**：在 subscriptions 搬移之後執行
   `UPDATE subscription_receipts r SET user_id = target.id, updated_at = now() FROM subscriptions s WHERE r.subscription_id = s.id AND s.user_id = target.id AND r.user_id = source.id;`
   使每一列 receipt 與其對應 subscription 恆同屬一個 user。留在 source 的非 active subscription 及其 receipt 同屬 source、一併隨 purge 清除，仍一致。
2. **pro 併入走 requires_support**：任一方 active pro 時 merge 依 AUTH §3.5.1 轉人工確認，receipt 改綁待人工核可後才落，杜絕自動盜併。
3. **provider 事件的 merge 重導**：provider 端帳戶識別（Apple `appAccountToken` / Google `obfuscatedExternalAccountId` / Stripe `subscription.metadata.user_id`，源自 Checkout `client_reference_id`）在原始購買當下固定、**不隨 merge 更新**。因此 §2.2 step c 解析出的 UUID 若為已被 merge 併走的 source，`followMergeRedirect` 依 `account_merge_requests`（completed）重導到存活 target，事件才落在正確帳號；重導後 receipt（已於規則 1 搬到 target）與 user 相等，§2.2 step f 的完整性檢查通過。
4. **完整性 fail-closed**：§2.2 step f 鎖定 receipt 與其 `subscriptions` row 後驗 `rec.user_id == user_id AND sub.user_id == rec.user_id`；若因任何遺漏（如 merge 未搬移）而裂解 → 回 `409 SUBSCRIPTION_LINK_INTEGRITY`、不臆測寫入。
5. **搬移後 reconcile target**：merge 交易末尾照 AUTH §3.5.1（entitlements 先於 scan_usage）與本文件 §2.2 (i) 對 target 跨 row 聚合 reconcile，確保 target 立即反映併入後的 active 狀態。

### 2.6 Stripe 退款 / 爭議對帳（不可只靠 Subscription.retrieve）

Stripe 的退款（`charge.refunded`）與爭議（`charge.dispute.created` / `charge.dispute.closed`）**不會**改動 `Subscription` 物件——退款/爭議發生時該 `sub_...` 常仍是 `active`。若沿用 §2.2 只回抓 `Subscription.retrieve`，會與 §2.1「退款/撤銷立即失權」矛盾（漏撤權）。故 Stripe 這兩類事件走**事件專屬的權威回抓路徑**，仍在 §2.2 同一交易內入帳（(d)–(i) 不變）：

1. **權威回抓對象依事件型別（step b）**：
   - `charge.refunded` → `Charge.retrieve(expand=[refunds.data])` 取 `amount`, `amount_refunded`, `refunded`, `refunds[].created`。
   - `charge.dispute.created` / `charge.dispute.closed` → `Dispute.retrieve` 取 `status`, `amount`, `created`（Dispute **無 close 時戳**；結案生效時間改取已驗簽 Event `evt_...` 的 `created`，見規則 3 附註）。
   - 由 `charge.invoice → Invoice.retrieve → invoice.subscription` 解出 `sub_...`，作為定位 receipt / subscription 的 `provider_sub_ref`。事件 payload 內的金額/狀態一律**不信**，以上述 retrieve 回應為準（authenticated：webhook secret 驗簽 + `event.account`/`livemode` scope 驗，§3）。

2. **身分解析**：解出 `sub_...` 後讀 `subscription.metadata.user_id`（Checkout 時由 `client_reference_id` 持久化），缺則 `customer.metadata.user_id`，再缺則既有 `uq_platform_sub`（`provider_sub_ref=sub_...`）receipt 映射。**`Subscription.retrieve` 不含 `client_reference_id`**（該欄位在 Checkout Session）；身分絕不從已不存在的欄位取。

3. **退款政策（full vs partial，`mapProviderState` 對這些事件的輸出）**：
   - **全額退款**（`refunded==true`，或退款金額覆蓋當期發票金額）→ `cancelled` + 立即撤權；`state_effective_at = refund.created`。
   - **部分退款**（`amount_refunded < amount`，比例/善意退款）→ **不撤權**，維持 `Subscription.retrieve` 當下狀態；記 audit。避免因比例退款誤降仍在期內的訂閱。
   - **爭議建立**（`charge.dispute.created`，資金已被凍結/取回）→ 比照失權，`cancelled` + 撤權；`state_effective_at = dispute.created`（Dispute 物件的 `created`；fail-closed：資金已離開，先停權）。
   - **爭議結案—敗訴**（`charge.dispute.closed`，retrieved `dispute.status=lost`）→ 維持 `cancelled`；`state_effective_at` = 該 `charge.dispute.closed` Event（`evt_...`）的 `created`。
   - **爭議結案—勝訴**（`charge.dispute.closed`，retrieved `dispute.status=won`，資金退回）→ 回抓 `Subscription.retrieve` 以其當下狀態對帳（仍在期內且未另行取消則恢復 `active`）；`state_effective_at` = 該 `charge.dispute.closed` Event 的 `created`。
   > **close-transition 時點**：Stripe `Dispute` 物件**只有 `created` 與當前 `status`，沒有「closed 時戳」**。故結案的生效時間取**已驗簽/回抓的 Stripe Event `evt_...` 的 `created`**（provider-authenticated，非事件 payload 自報）。爭議必先 created 才能 closed，close Event 的 `created` **恆晚於** `dispute.created`。

4. **原子撤權 / 確定生效時間**：上述 `(mappedStatus, expiresAt, stateEffectiveAt)` 交回 §2.2，於 (h) 原子寫 `subscriptions.status`、(i) 跨 row 聚合把 entitlement 降回 free——撤權在**同一交易**完成，不依賴 Stripe 是否自動 cancel 訂閱（我方 entitlement 為權威；如需亦可另呼 `Subscription.cancel` 驗證 provider 端取消，但不作為撤權前提）。`state_effective_at` 一律取自 provider 的**真實**權威時間戳：refund `created`、`dispute.created`、以及結案的 charge.dispute.closed **Event `created`**（Dispute 物件無 close 時戳），讓 §2.2 step g 的 `statusRank` tie-break 對「退款/爭議 vs 續訂」仍成立（失權方勝出）。

5. **爭議 created→closed 的確定定序（equal-time 相位優先）**：因結案 Event 的 `created` **恆晚於** `dispute.created`，勝訴恢復走 step g 的 `stateEffectiveAt < rec.state_effective_at` 為偽、`==` 為偽 → 落入寫入路徑覆蓋先前撤權，定序天然確定、不回退。**去歧義規則**：萬一兩時戳因時鐘粒度相等，對**同一 `dispute.id`**（比對 receipt 上記錄的觸發爭議）terminal `charge.dispute.closed` **相位優先於**其自身 provisional `charge.dispute.created` 撤權——step g 等時分支加例外：`terminal_dispute_close AND 同一 dispute.id` 時**不套用** fail-closed `statusRank`，改依 retrieved `dispute.status`（won→`active`、lost→`cancelled`）。此例外**僅限**同一爭議的 created→closed，不鬆動其他獨立訊號（如續訂 vs 退款）的 fail-closed 等時 tie-break。

---

## 3. 三平台驗證與狀態同步

共同原則：**client 出示購買 → server 向平台驗證 → 錨定 internal user id → 寫 receipt/subscriptions**。三平台把「這筆購買屬於哪個 internal user」的載體都設為我方 UUID：

| 平台 | 我方 user 載體（購買時帶入） | 驗證 / 事件來源 | 事件真偽驗證 | 範圍（scope）驗證 | 穩定訂閱鍵 |
| --- | --- | --- | --- | --- | --- |
| **iOS App Store** | StoreKit2 `Purchase.appAccountToken` = `users.id`(UUID) | App Store Server API + **Server Notifications V2**（signed JWS `signedPayload`） | JWS 憑證鏈用 Apple root CA 驗；解出的 `notificationUUID` 進 ledger | payload 內 `bundleId`（及 `appAppleId`）、`environment` 須等於本 app 的預期值，否則拒收 | `originalTransactionId` |
| **Android Google Play** | 購買時 `setObfuscatedAccountId(users.id)`；**回抓時**由 `subscriptionsv2.get` 的 `externalAccountIdentifiers.obfuscatedExternalAccountId` 取回（**不在 RTDN 內**） | Play Developer API `purchases.subscriptionsv2.get` + **RTDN**（Pub/Sub push） | **push 本身**驗 authenticated Pub/Sub JWT（`aud` = 我方 endpoint、`email` = 指定 service account、`email_verified`）；**再**用 service account 呼叫 Developer API 覆核 token 取權威狀態與帳戶識別 | RTDN payload `packageName` 須等於預期；Developer API 用綁定該 package 的 service account | `purchaseToken`（經 `linkedPurchaseToken` 追溯根 token） |
| **Web Stripe** | Checkout `client_reference_id` = `users.id`（並存 `customer.metadata.user_id`） | Stripe **Webhooks** | `Stripe-Signature` 用 webhook secret 驗；`event.id`(`evt_...`) 進 ledger | `event.account`（Connect 時）與 `event.livemode` 須等於預期帳戶與模式，否則拒收 | `subscription` id（`sub_...`） |

- **事件是「觸發」，狀態一律回抓 provider current-state（排序無關）**：三平台的通知都不保證順序、可能亂序 / 遲到 / 重送。因此驗過真偽 + scope 後，**不信事件 payload 內的狀態欄位**，一律呼叫該平台的 current-state 查詢端點（Apple App Store Server API `Get Subscription Status` / Google `purchases.subscriptionsv2.get` / Stripe `Subscription.retrieve`）取「當下」權威狀態再入帳（§2.2 step e）。這使亂序天然無害，並讓 Google RTDN `version`（schema 版本、非單調序）**永不被用於排序**。**例外：Stripe 退款/爭議**（`charge.refunded` / `charge.dispute.*`）不改動 `Subscription` 物件，須改抓 Refund/Charge/Dispute 並由 invoice 解出 sub（§2.6），不可只靠 `Subscription.retrieve`。
- **「驗證購買 token」≠「驗證推送」**：Google RTDN 是一個 HTTP POST，能呼叫 Developer API 只證明「這個 purchaseToken 有效」，**不證明這個 HTTP 請求來自 Google**。因此**必先**驗 authenticated Pub/Sub push JWT（audience + service-account 宣稱），**再**打 Developer API 取權威狀態；兩者缺一即拒收。Apple/Stripe 同理先驗事件真偽（JWS / signature）再取狀態。
- **scope 綁進去重鍵**：驗過的 `provider_account`（bundleId / packageName / Stripe account）+ `environment` 一併寫入 `subscription_receipts` 與 `subscription_events` 的唯一鍵（§1），使跨 app / 跨帳戶 / 跨環境即使事件 id 或訂閱鍵偶然相同也不會互相污染。任何 scope 不符的事件在 mutate 狀態**之前**即被擋下（§2.2 step a）。
- **絕不信任 client 自報的購買結果**（防偽造升級）；client 回呼只作「提示 server 去 pull」。
- **沙盒/正式環境分流**：`environment` 進唯一鍵；Apple V2 sandbox 事件與 production 分流，避免測試訂閱污染 production entitlement。
- **還原購買（restore）**：以平台帳號重新出示 → 用 `(platform, provider_account, environment, provider_sub_ref)` 命中既有 `subscription_receipts`；若當前登入 user ≠ receipt.user_id → §2.4 衝突。
- **App 內購買必走平台 IAP**（Apple 3.1.1 / Google Play 政策）：iOS/Android 的訂閱**不得**導去 Web/Stripe 付款頁；Web 才可用 Stripe（§4）。

---

## 4. Web 訂閱：Stripe vs 只讀 entitlement（取捨建議）

需求允許「Web 先不做訂閱購買，只讀既有 entitlement」。建議**分兩階段**：

**Phase 1（建議先做）— Web 只讀，不在 Web 售訂閱。**
- Web 端登入後 `GET /api/entitlements` 讀 tier；已在 iOS/Android 訂閱的 subscriber，因訂閱歸 `users.id`，Web 登入**同帳號即自動享 premium**（純 server 判定，無需 Web 金流）。
- Web 的 Paywall 只呈現方案與「請於 App 內訂閱」引導（不放 Stripe 結帳）。
- **理由**：(a) 避開在 Web 賣訂閱後、iOS App 內若引導使用者去 Web 購買可能觸及 Apple 反導流條款的風險（保持 App 內只走 IAP）；(b) 免去 Phase 1 的 PCI / 稅務 / 退款客服負擔；(c) 覆蓋主要付費場景（行動裝置）。

**Phase 2（可選）— 開 Web 原生付費，接 Stripe。**
- 觸發條件：出現實際的「純 Web 使用者」付費需求，或要做促銷/年繳等 IAP 不便的方案。
- 接 §3 的 Stripe writer（`client_reference_id=user_id` + webhooks），與 IAP 併存於同一 `subscriptions`；跨平台不承諾「一處買他處自動生效」以外的東西——同帳號登入即共享已是既有能力。
- 需補：Stripe 稅務（Stripe Tax）、退款/爭議 webhook（§2.1）、以及 §6 的交易保留。

> 決策點（需產品拍板）：Phase 2 是否納入本季範圍。預設**否**（Phase 1 已滿足跨裝置共享 premium）。

---

## 5. Premium Gate 與 Quota 的 UI 狀態需求

現況：`src/components/ScanQuotaBanner.tsx`、`src/components/PremiumGate.tsx`、`src/store/scanQuotaStore.ts`、`src/services/permissionService.ts` 皆以**本機** `authStore.role` + 本機 `scanCount` 判斷（`Monetization-Architecture-Plan.md §0` 已標明目前是 local mock，可被清快取重置）。**本設計要求把這些 UI 的數值來源改為 server 權威**：登入後 / 掃描後以 `GET /api/entitlements`（Product §6.3）回填 `scan_used / scan_remaining / premium`，本機值只作離線顯示快取，**判斷放行一律以 server 為準**。

### 5.1 掃描額度顯示（`ScanQuotaBanner`）

| 狀態 | 觸發條件（server entitlement） | UI 要求 | 既有對應 |
| --- | --- | --- | --- |
| 訂閱無限 | `premium=true` / `scan_remaining=null` | 「訂閱會員 — 無限掃描」，不顯示數字 | ✅ 已有 `bannerUnlimited` |
| 一般剩餘 | free，`scan_remaining > 10` | 「本月剩餘掃描：N/100」 | ✅ `bannerNormal` |
| 即將用完 | free，`0 < scan_remaining ≤ 10` | 低額警示樣式 + 升級提示入口 | ✅ `bannerLow`（門檻 10） |
| 已達上限 | free，`scan_remaining = 0` | 「本月額度已用完 (100/100)」+ **升級 CTA**（導 Paywall §4）；下次重置日 `reset_at` | ✅ `bannerExhausted`（需補 reset 日與 CTA） |
| 需登入 | `role=guest` | 「請登入以使用掃描功能」→ 點擊進登入牆（Product §4.2 deferred action） | ✅ `bannerGuest` |
| 額度暫不可用 | `500 ENTITLEMENT_UNAVAILABLE`（Product §5.1 fail-closed） | 顯示暫時性錯誤+重試，**不顯示可掃描**，不放行 | ⚠️ 需新增 |

### 5.2 掃描動作的 UI 流（對齊 reserve gate，Product §6.1）

- 按下掃描 → 先 `POST /api/scan/reserve`：
  - `401 SCAN_REQUIRES_LOGIN` → 登入牆。
  - `403 SCAN_QUOTA_EXCEEDED` → **達上限彈窗** + 升級 CTA（帶 `scan_used/scan_limit/reset_at`）。
  - **離線 / 逾時 → fail-closed**：顯示「需連線才能掃描」，**不得**離線用本機 OCR 偷跑（Product §6.1 安全取捨）。
  - `200` → 進辨識；成功 `commit`、失敗/取消 `release`；成功後以回傳的 `scan_remaining` 更新 banner。
- 需求「達上限提示」= 5.1 的已達上限狀態 + 5.2 的 `403` 彈窗，兩處文案一致。

### 5.3 Premium 鎖（`PremiumGate`）

- 涵蓋能力：**AI 趨勢預測、進階市場數據**（Product §3 matrix：subscriber-only；guest/free_user 皆鎖）。
- 鎖態 UI：🔒 + 功能說明 + 目前角色 + **「升級訂閱」CTA**（現為 no-op → 需接 Paywall §4）。
- **資料層必須同步上鎖**：premium payload 由已驗證的 subscriber 端點供應（Product §6.2 `/api/trends/*`，已移出公開 `data/trends/*.json`）；UI 鎖只是體驗，真正 gate 在 server。`403 PREMIUM_REQUIRES_SUBSCRIPTION` → 顯示鎖 + 升級引導。
- 升級後（reconcile 完成，§2.2）client 重拉 `GET /api/entitlements`，`premium=true` → 解鎖，不需重登。

### 5.4 訂閱狀態顯示（設定頁）

- subscriber：顯示方案、下次續訂/到期日、來源平台（App Store / Google Play / Stripe）、以及「管理訂閱」深連結（iOS→App Store、Android→Play、Web→Stripe portal）。
- 寬限期（§2.1 billing retry）：顯示「付款處理中，權限維持」提示，不誤報為已到期。
- 已取消自動續訂但未到期：顯示「有效至 `expires_at`，之後不續訂」。

---

## 6. 帳號刪除 / 資料保留與假名化

需求：刪帳號要刪 scan usage / quota / subscription mapping；但交易/稅務/退款/平台規範要求保留者，須去識別化只留必要交易紀錄。

> ⚠️ **用詞誠實：這是「假名化（pseudonymization）」而非「匿名化（anonymization）」。** 保留一個穩定的 `user_pseudonym` 與可對帳的交易鍵，資料仍**可被單一化 / 可連結**（linkable），依 GDPR 屬**個資（pseudonymous data）**，不是匿名資料。因此本文件**不宣稱**「不保留是誰」「無法識別個人」——那需要一份正式的再識別風險評估才能成立。此外 AUTH `audit_log.user_id`（AUTH §3.6）在刪帳號後**仍保留**，屬另一份可連結資料，其保留/清除依同一保留政策處理（見下）。參考：[ICO pseudonymisation guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-sharing/anonymisation/pseudonymisation/)。

### 6.1 刪除即清（沿用 AUTH §3.5.2 purge）

user purge 時 `ON DELETE CASCADE` 一併刪除：`scan_usage`、`subscriptions`、`entitlements`、`scan_reservations`（Product §9）、`subscription_events`（無 users FK，但含 provider 事件明細，purge 時一併清）、以及本文件的 **`subscription_receipts`**（含 `raw_verification`，內有平台帳戶關聯，屬個資，必須刪）。刪前 `audit_log` 寫 `delete_purged`（AUTH §3.5.2）。

> **與 merge 的次序**：若 user 是先被 merge 併走的 source，其 active subscription 與對應 `subscription_receipts` 已在 merge 交易內搬到 target（§2.5），故 source purge 只 cascade 掉「留在 source 的非 active」殘料，不會孤立 target 已承接的 subscription/receipt。因 receipt/subscription 恆同 user，兩者要嘛同在 source 被清、要嘛同在 target 存活，不會裂解。

### 6.2 法遵/財稅必要紀錄 → 假名化保留

退款、稅務、對帳、平台稽核可能要求保留「發生過一筆交易」的最小事實。在 purge 前把必要交易欄位轉存到一張**與 `users` 脫鉤（無 FK）**的保留表，但明確視為**假名化的個資**：

```sql
-- 假名化的交易保留（無 users FK；刪帳號後仍存在，供財稅/退款對帳）。仍屬個資，受保留政策約束。
CREATE TABLE billing_records_retained (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_pseudonym     TEXT NOT NULL,           -- HMAC(sep_key, user_id)：與 user 脫鉤但穩定，可做對帳；非原始 UUID
  platform           TEXT NOT NULL,
  provider_sub_ref_token TEXT NOT NULL,       -- HMAC(sep_key, provider_sub_ref)：keyed tokenization，可對帳去重、不可離線暴力還原
  product_id         TEXT NOT NULL,
  amount             NUMERIC,                 -- 金額 / 稅（若平台回報）
  currency           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,    -- 交易/退款時間
  record_type        TEXT NOT NULL CHECK (record_type IN ('purchase','renewal','refund','chargeback')),
  legal_basis        TEXT NOT NULL,           -- 保留法源（如：tax_law:<jurisdiction> / platform_audit）
  retain_until       TIMESTAMPTZ NOT NULL,    -- 依法定保存年限；到期後由排程硬刪
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

假名化與保留規則：

- **不含直接識別欄位**：無 `user_id` FK、無 email、無平台帳戶原文。但 `user_pseudonym` / `provider_sub_ref_token` 仍是**穩定假名**，可單一化與連結，故整表按個資治理，不宣稱匿名。
- **keyed 雜湊 / tokenization + 金鑰分離**：假名以 **HMAC** 搭配一把**與應用 DB 隔離存放**（KMS / 獨立 secret store、不同存取權）的 `sep_key` 產生；未持金鑰者無法由 token 反查或關聯到來源訂閱。金鑰輪替時舊資料維持既有 token（不可回溯改寫），輪替策略需文件化。
- **存取分離（access separation）**：此表僅財稅/對帳角色可讀，與產品/客服資料權限隔離；讀取記 audit。
- **只保留財稅/退款必要欄位**（金額、幣別、方案、時間、類型、法源），不留掃描行為、裝置、IP 等。
- **法源與期限化**：`legal_basis` 標明保留依據，`retain_until` 依**營運所在司法管轄**的法定年限設定，到期由排程**硬刪**，落實資料最小化。`audit_log` 中與交易相關的 `user_id` 亦納入同一保留/到期清除政策。
- 觸發時機：user purge 交易內，先寫 `billing_records_retained`（僅在該 user 有過真實付費/退款時），再 CASCADE 刪 `subscription_receipts` 等。若無任何交易則不留任何列。

> 與隱私權政策的銜接（DIC-667 已更新之政策）：刪帳號會清除帳號主體與使用者資料；因財稅/平台規範**在法源與保留期限內**保留的，是**假名化的必要交易紀錄**（仍屬個資、受期限與存取控管）。此段（含法源、保留年限、假名化手法）需回填隱私權政策的「資料保留」章節（交棒 PRIVACY 任務）。

---

## 7. 交棒 / 落地順序

1. **前置相依**：本設計消費 AUTH（`users`/`sessions`/`subscriptions`/`entitlements`）與 Product（reserve gate）**執行期基礎**，須待該後端落地（Postgres + session 驗證）後才實作；目前 repo 仍為 local mock（`Monetization-Architecture-Plan.md §0`）。
2. **可先做（不等金流）**：§5 UI 狀態改為讀 `GET /api/entitlements`（server 權威）、fail-closed / 離線提示、Paywall 靜態頁、`PremiumGate` CTA 接 Paywall。
3. **金流實作 sub-issue**：§1 `subscription_receipts` + `subscription_events` 帳本 + §3 三平台 writer/webhook（含 scope/push-JWT 驗證）+ §2 狀態機 + §6 保留表，建議每平台一個實作子任務，Web Stripe 依 §4 預設留到 Phase 2。
4. **QA 契約**：
   - **生命週期轉移**：首購/續訂/寬限/到期/取消/退款 → tier 正確升降（§2.1 映射）。
   - **事件冪等**：同一 `notificationUUID`/`messageId`/`evt_id` 重送 → `subscription_events` 唯一鍵去重、只生效一次。
   - **亂序 / 遲到重播（每平台各一組）**：
     - Stripe：`customer.subscription.deleted` 先於較早的 `invoice.paid` 到達 → 因狀態一律回抓 `Subscription.retrieve`，最終落在 provider 當下狀態，舊事件不回退。
     - Google：同一 `purchaseToken` 的兩則 RTDN（例先 `SUBSCRIPTION_RENEWED` 後遲到的 `SUBSCRIPTION_PURCHASED`）亂序送達 → 驗證信封 `version`（字串）**未**被用於排序，兩次都回抓 `subscriptionsv2.get`，結果一致且等於當下狀態。
     - Apple：`DID_RENEW` 與 `REFUND` 亂序 → 回抓 `Get Subscription Status` 得當下狀態；若兩訊號 `state_effective_at` 相同，`statusRank` 使失權方（refund→cancelled）勝出（fail-closed tie-break）。
   - **Stripe 退款/爭議撤權（不可只靠 Subscription.retrieve，§2.6）**：
     - **全額退款**：`charge.refunded`（`refunded==true`）到達、但 `Subscription.retrieve` 仍 `active` → 斷言走事件專屬回抓（Charge → invoice → sub）、映射 `cancelled` 撤權降 free，`state_effective_at=refund.created`；**不因訂閱物件仍 active 而漏撤**。
     - **部分退款**：`amount_refunded < amount` → 斷言**維持**當下訂閱狀態、entitlement 不誤降。
     - **爭議建立**：`charge.dispute.created` → 立即 `cancelled` 撤權；斷言 `state_effective_at` = Dispute 物件的 `created`（真實欄位）。
     - **爭議結案定序（只用真實欄位）**：fixture 僅含真實 Stripe 欄位——`Dispute`{`id`,`status`,`created`}、以及 `charge.dispute.closed` **Event**{`id`,`created`}（**不得**出現不存在的 `dispute.closed` 時戳）。送 `created`（`t0`）後送 `closed`（Event `created`=`t1`）：
       - `status=won` → 回抓 `Subscription.retrieve`，`t1>t0` 使 step g 落入寫入路徑恢復 `active`；並斷言**時鐘粒度相等（`t1==t0`）時**，§2.6 規則 5 相位優先（同一 `dispute.id`）仍讓 `won` 恢復 `active`、不被 fail-closed `statusRank` 擋住。
       - `status=lost` → 維持 `cancelled`。
       - 斷言 close 生效時間源自**已驗簽 Event `created`**，非 `Dispute` 上不存在的欄位。
     - **Stripe 身分**：由 `subscription.metadata.user_id`（Checkout `client_reference_id` 持久化）/ `customer.metadata.user_id` / 既有 receipt 映射解析 → 斷言**不引用** `Subscription.retrieve` 上不存在的 `client_reference_id`。
   - **未來 period_end 不得讓當下退款/爭議誤判 stale（order cursor ≠ 效期界線）**：先送續訂 → `subscriptions.expires_at` = 未來 `current_period_end`（`t_future`），但 `receipt.state_effective_at` = 續訂**轉移時點**（`t_renew ≈ now`，**非** `t_future`）。隨後送當下全額退款/`charge.dispute.created`（`state_effective_at ≈ now > t_renew`）→ 斷言 (a) step g **不**因 `t_future` 判為 stale，`subscriptions.status` **確實**轉為 `cancelled`、entitlement 降 free；(b) 重播同一退款/爭議事件經 `uq_provider_event` 去重為安全 no-op，狀態維持 `cancelled`（不回退 active）。反例保護：若把 `state_effective_at` 誤設為 `t_future`，此案會退化成「記為已處理卻停留 active、永久漏撤」——斷言不得發生。
   - **schema-level replay regression（provider_version 型別）**：以 Google 文件記載的 RTDN 信封原文灌入 ledger 並斷言可持久化、無型別錯誤——
     ```json
     { "version": "1.0", "packageName": "com.holohunter.app", "eventTimeMillis": "1730000000000",
       "subscriptionNotification": { "version": "1.0", "notificationType": 4,
         "purchaseToken": "abc.def", "subscriptionId": "monthly_pro" } }
     ```
     `version` 是字串 `"1.0"` → 存入 `subscription_events.provider_version TEXT`（若存 `BIGINT` 會解析失敗）；`Pub/Sub messageId` 進 `event_id`；重送同一 `messageId` → `uq_provider_event` 去重、只生效一次。
   - **Google 首購 user 解析次序（帳戶識別不在 RTDN 內）**：灌入首購 RTDN（`notificationType=4`，payload **僅** `purchaseToken`、**無**任何帳戶識別）→ 斷言 (a) 在呼叫 `subscriptionsv2.get` **之前**無法解析 user（不得從通知臆測、不得建立 receipt/subscription）；(b) 唯有取得回應的 `externalAccountIdentifiers.obfuscatedExternalAccountId` 後才導出 UUID 並進交易；(c) 該值缺漏 / 非合法 UUID / 對不到 `users` → `USER_UNRESOLVED` fail closed，不寫任何 row；(d) 既有 receipt 但回應帳戶 ≠ `rec.user_id` → 409、不改綁。
   - **equal-effective-time tie-break 讀 `subscriptions.status`（非不存在的 receipt 欄位）**：續訂與退款同 `state_effective_at` → step f 鎖定 receipt 對應的 `subscriptions` row，step g 以 `statusRank(sub.status)` 決勝，失權方（cancelled）勝出；斷言 tie-break 只引用實際存在的 `subscriptions.status`、可由 schema 執行。
   - **merge 搬移 receipt 歸屬（§2.5）**：source 有 active 訂閱、merge 併入 target → 斷言 merge 交易內 `subscription_receipts.user_id` 隨其 subscription 一併改為 target；merge 後 `rec.user_id == sub.user_id`（完整性不變式成立）。
   - **merge → 退款（重導 + reconcile target）**：merge 後對該訂閱送退款事件 → `deriveInternalUserId` 得 provider 固定的 source UUID，`followMergeRedirect` 重導到 target → 在 target reconcile、target 降回 free；不因帳戶識別未更新而在 source 誤算或殘留 target stale pro。
   - **merge → source purge（不孤立）**：merge 後 purge source → 已搬到 target 的 subscription/receipt 存活、不被 cascade；留在 source 的非 active 殘料成對清除，無孤立 subscription 或裂解 receipt。
   - **完整性 fail-closed**：人為構造 receipt 與其 `subscriptions` row 不同 user（模擬 merge 漏搬）→ step f 回 `409 SUBSCRIPTION_LINK_INTEGRITY`、不寫入。
   - **per-user 序列化 + 跨平台原子聚合**：同一 user 的 A、B 兩平台事件並發 → `users` row 鎖使其串行；A 平台退款只改 A 的 `subscriptions` row，跨 row 聚合後 B 平台仍 active → tier 維持 pro（不誤降）。
   - **1:1 對應**：`uq_receipt_subscription` 使一個 `subscriptions` row 至多一列 receipt；重複回填被擋。
   - **漏 webhook 到期空窗**：模擬到期後 reconcile 落後，`effectiveEntitlement` 對 role(free)↔tier(pro) 不一致回 `ENTITLEMENT_UNAVAILABLE` 擋掃描、絕不放行不限量（Product §5.1 權威不變式）。
   - **scope 驗證**：偽造 / 跨 app / 跨帳戶 / 未驗 Pub/Sub push JWT 的事件被拒；同一平台訂閱綁不同 user → 409。
   - **其他**：跨裝置同帳號共享 premium；刪帳號後 `subscription_receipts`/`subscription_events` 已清、`billing_records_retained` 僅存假名化必要欄位、有 `legal_basis`、`retain_until` 到期可硬刪；UI 六種額度狀態與 premium 鎖態、離線 fail-closed。

---

## 附：需產品拍板事項
1. **Web Stripe（§4）**是否納入本季（預設否，Phase 1 只讀即滿足跨裝置共享）。
2. **法定交易保留年限**（§6.2 `retain_until`）依營運所在地財稅法規填定。
3. AI 趨勢預測是否維持 subscriber-only（沿用 Product §3 決策，如需開放 free_user 只改該 matrix 一列）。
