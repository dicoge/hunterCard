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
  subscription_id      UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, -- 對應的 AUTH subscriptions row（1:1）
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
  -- last-writer 排序依據（provider 權威的生效時間 / 版本，見 §2.2）：
  last_event_time      TIMESTAMPTZ,             -- 該 provider row 目前反映的事件生效時間
  last_event_version   BIGINT,                  -- 版本序（Play RTDN 用；無則以 last_event_time 判斷）
  product_id           TEXT NOT NULL,           -- 平台方案 id（sku / price id）
  environment          TEXT NOT NULL DEFAULT 'production'
                         CHECK (environment IN ('production','sandbox')),
  raw_verification     JSONB,                   -- 驗證後保留的必要欄位（非整包收據，見下）
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一平台帳戶範圍的同一訂閱只能對應一個 internal user，防「一單綁多帳號」與重複入帳：
  CONSTRAINT uq_platform_sub UNIQUE (platform, provider_account, environment, provider_sub_ref)
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
  event_time           TIMESTAMPTZ NOT NULL,    -- provider 權威生效時間（signedDate / eventTimeMillis / object.created）
  event_version        BIGINT,                  -- Play RTDN 版本序（無則 NULL）
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_event UNIQUE (platform, provider_account, environment, event_id)
);
```

設計要點：

- **對應鍵永遠是 `users.id`，永不是 email**（沿用 AUTH §2）。平台把購買錨定到我方 user 的方式見 §3（Apple `appAccountToken` / Google `obfuscatedAccountId` / Stripe `client_reference_id`），三者一律填 internal user id（UUID）。
- **`uq_platform_sub` 是去重與防盜綁的核心**：唯一鍵含 **`provider_account`（平台帳戶範圍）+ `environment`**，同一 scope 下的同一 `originalTransactionId` / `purchaseToken` / Stripe `sub_id` 只能存在一列。若同一平台訂閱嘗試綁到**不同** user（換手機、帳號轉移、共享 Apple ID）→ 走 §2.4 衝突處理，不自動改綁。
- **`subscription_events` 帳本讓事件冪等且可重播**：`uq_provider_event` 以 provider 事件 id（Apple `notificationUUID` / Google Pub/Sub `messageId` / Stripe `evt_...`）去重；`event_time`/`event_version` 提供 last-writer 排序，杜絕 Stripe「不保證事件順序」造成的舊事件覆蓋新狀態（§2.2）。
- **`subscription_id` 為 1:1 且 `NOT NULL`**：每個 platform 訂閱對應**恰好一個** AUTH `subscriptions` row（§2.2 以此 row 為寫入目標，而非用不存在唯一鍵的 `user_id` upsert）。同一 user 可同時有多個 platform 的 `subscriptions` row（AUTH 允許多列），active 判定跨所有 row 聚合（§2.2）。
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
| **退款 / 撤銷 / 拒付**（立即失效） | ASSN `REFUND`、Play `SUBSCRIPTION_REVOKED` / voided、Stripe `charge.refunded` / dispute | **`cancelled`** + `cancelled_at=now()` | — | **立即降回 free_user**，且記 audit |
| 暫停（Play pause / Stripe pause） | `SUBSCRIPTION_PAUSED`、`pause_collection` | `paused` | — | 暫停期間**視為無 active 訂閱** → free_user |

> **判定不變式**：`hasActiveSubscription`（Product §2）= 該 user **任一** `subscriptions` row 滿足 `status='active' AND (expires_at IS NULL OR expires_at > now())`（跨多平台 row 聚合，OR 語意）。`paused` / `expired` / `cancelled` 都不算 active。寬限期刻意保持 `active`（權限不中斷），到期時間交由平台事件延長。

### 2.2 reconcile 觸發（權威在 server，單一交易、冪等、跨 row 聚合）

每次狀態變更（webhook / 排程）在**單一 DB transaction** 內依序執行，任一步失敗即整筆 rollback（不留半套狀態）：

```
BEGIN
  # (a) 驗證：簽章 + 平台帳戶範圍 scope（§3），失敗直接拒收，不進交易
  verifyEventAuthAndScope(evt)              # 見 §3：Apple JWS+bundleId / Play push-JWT+packageName / Stripe sig+account+livemode

  # (b) 冪等去重：先寫 processed-event ledger；撞唯一鍵 → 已處理過 → COMMIT 空操作
  INSERT INTO subscription_events (platform, provider_account, environment, event_id,
              event_type, provider_sub_ref, event_time, event_version)
    VALUES (...) ON CONFLICT (platform, provider_account, environment, event_id) DO NOTHING;
  if row_count == 0: COMMIT; return   # 重播 / 重送，安全丟棄

  # (c) 定位 internal user 與對應的「單一」subscriptions row（非 user_id upsert）
  user_id = resolveUser(evt)                # appAccountToken / obfuscatedAccountId / client_reference_id（UUID）
  rec = SELECT * FROM subscription_receipts
          WHERE platform=$p AND provider_account=$acct AND environment=$env AND provider_sub_ref=$ref
          FOR UPDATE;                       # 命中既有訂閱
  if rec exists AND rec.user_id != user_id: ROLLBACK; raise SUBSCRIPTION_ALREADY_LINKED   # §2.4

  # (d) last-writer 排序：舊事件不得回退新狀態（Stripe 不保證順序）
  if rec exists AND (evt.event_time, evt.event_version) <= (rec.last_event_time, rec.last_event_version):
      COMMIT; return                        # 過期事件，忽略（ledger 已記錄，仍冪等）

  # (e) 首購 → 建立恰好一個 subscriptions row 並回填 receipt.subscription_id；
  #     續訂/取消/退款 → UPDATE receipt.subscription_id 指到的「那一個」row（§2.1 映射）
  if rec not exists:
      sub = INSERT INTO subscriptions (user_id, plan, status, started_at, expires_at) VALUES (...) RETURNING id;
      INSERT INTO subscription_receipts (user_id, subscription_id, ...) VALUES (..., sub.id, ...);
  else:
      UPDATE subscriptions SET status=$mappedStatus, expires_at=$exp, cancelled_at=... WHERE id = rec.subscription_id;
      UPDATE subscription_receipts SET latest_txn_ref=$txn, last_event_time=evt.event_time,
             last_event_version=evt.event_version, updated_at=now() WHERE id = rec.id;

  # (f) 跨「該 user 全部 subscriptions row」聚合後 reconcile（見下方不變式）
  active = EXISTS (SELECT 1 FROM subscriptions
                     WHERE user_id=$user_id AND status='active'
                       AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE);
  reconcile entitlements(user_id): active ? pro(NULL,NULL) : free(NULL,100)   # Product §5.3
  audit_log(event_type='subscription_<evt>', metadata={platform, event_id, sub_id})
COMMIT
```

- **row-targeted，不用 `user_id` upsert**：AUTH `subscriptions` **無** `user_id` 唯一鍵、明確允許一個 user 多列（多平台並存）。因此寫入永遠針對 `subscription_receipts.subscription_id` 指到的**那一個** row；`entitlements` 的 active 判定則**跨該 user 所有 subscriptions row 聚合**。這樣「A 平台退款」不會誤蓋/降級「B 平台仍 active」的訂閱（CR finding 3）。
- **冪等且抗亂序**：`subscription_events` 帳本（唯一鍵去重）+ `last_event_time/version`（last-writer）確保同一事件重送只生效一次、較舊事件不回退較新狀態（CR finding 1）。全部在同一交易內完成 receipt / subscription / reconcile 三寫，無中間可觀察的不一致。
- **權威計算在 server**：client 端的購買回呼只是「提示去 pull」，真正入帳一律以**平台簽章事件 + server 驗證**為準（§3），本機不可寫 tier。這對齊需求「quota 重置由 backend 權威計算，防本機竄改」——`entitlements`/`scan_usage` 都在 server，本機時間/快取無法影響。
- **月 quota 重置**同理由 server 權威：`scan_usage` 以 `period='YYYY-MM'`（server clock）為 PK，換月即新 row，不靠 client（AUTH §3.5 / Product §6.1 已定義；此處僅重申來源不可竄改）。

### 2.3 到期補判與「到期空窗不得無限掃描」（fail-closed 一致性）

**風險（CR finding 2）**：`hasActiveSubscription` 在 `expires_at` 當下**即刻**變 false（role 立刻降為 free_user），但 `entitlements.tier` 是**物化快取**，若只靠**每日排程** reconcile，兩者之間存在空窗——此時 Product §5.1 讀到 `tier='pro'` 的 `monthly_limit=NULL` 卻搭配 free_user role，會回**不限量**，等於「到期後仍無限掃描」。

必須兩道防線同時成立：

1. **effectiveEntitlement 加 role↔tier 一致性檢查，mismatch 一律 fail-closed**（不是降級為 free、也不是放行）：
   ```
   role = resolveRole(user)                 # 依 subscriptions active（含 expires_at 即時判定）
   ent  = entitlements[user.id]
   # 到期空窗 / reconcile 落後：role 已非 subscriber，但快取仍 pro（limit=NULL）→ 不一致
   if role != 'subscriber' and (ent.tier == 'pro' or ent.monthly_limit IS NULL):
       triggerReconcile(user.id)            # 立即修復（同 §2.2 邏輯，非同步）
       raise EntitlementError(ENTITLEMENT_UNAVAILABLE)   # 500，擋掃描；絕不因 quota=NULL 放行不限量
   # 反向不一致（role=subscriber 但 tier=free）亦 fail-closed，避免誤扣付費者額度
   if role == 'subscriber' and ent.tier != 'pro':
       triggerReconcile(user.id); raise EntitlementError(ENTITLEMENT_UNAVAILABLE)
   ```
   > 這是對 Product §5.1 `effectiveEntitlement` 的**強化要求**：不限量放行的唯一合法條件是 **role 解析為 subscriber**（即 subscriptions 當下確有 active row），而非「快取 tier 剛好是 pro」。實作 Product gating 時必須落實此檢查（列入 §7 交棒與 §7 QA）。
2. **邊界 reconcile，不只每日排程**：除了每日掃 `status='active' AND expires_at < now()` 標 `expired` 並 reconcile（Product §5.3），另**在寫入訂閱時排一個 `expires_at` 到點即觸發的 reconcile job**（延遲佇列 / cron-at），使快取在到期當下即翻回 free，把空窗窗口壓到最小。每日排程僅為兜底。

webhook 與排程對同一 row 的寫入沿用 §2.2 的冪等/last-writer 規則（`subscription_events` 去重 + `last_event_time/version`），較舊事件不回退較新狀態。

### 2.4 同一平台訂閱綁不同 user（衝突）

`uq_platform_sub` 命中既有 row 但 `user_id` 不同時（例：同一 Apple ID 在兩個 HoloHunter 帳號還原購買）：**不自動改綁**，回 `409 SUBSCRIPTION_ALREADY_LINKED`，記 audit，導向客服/人工，與 AUTH §4 merge 的 `requires_support` 門檻一致（任一方有 active pro 即需人工）。避免「盜綁他人訂閱」或「一單洗多帳號」。

---

## 3. 三平台驗證與狀態同步

共同原則：**client 出示購買 → server 向平台驗證 → 錨定 internal user id → 寫 receipt/subscriptions**。三平台把「這筆購買屬於哪個 internal user」的載體都設為我方 UUID：

| 平台 | 我方 user 載體（購買時帶入） | 驗證 / 事件來源 | 事件真偽驗證 | 範圍（scope）驗證 | 穩定訂閱鍵 |
| --- | --- | --- | --- | --- | --- |
| **iOS App Store** | StoreKit2 `Purchase.appAccountToken` = `users.id`(UUID) | App Store Server API + **Server Notifications V2**（signed JWS `signedPayload`） | JWS 憑證鏈用 Apple root CA 驗；解出的 `notificationUUID` 進 ledger | payload 內 `bundleId`（及 `appAppleId`）、`environment` 須等於本 app 的預期值，否則拒收 | `originalTransactionId` |
| **Android Google Play** | Play Billing `obfuscatedAccountId` = `users.id` | Play Developer API `purchases.subscriptionsv2.get` + **RTDN**（Pub/Sub push） | **push 本身**驗 authenticated Pub/Sub JWT（`aud` = 我方 endpoint、`email` = 指定 service account、`email_verified`）；**再**用 service account 呼叫 Developer API 覆核 token 取權威狀態 | RTDN payload `packageName` 須等於預期；Developer API 用綁定該 package 的 service account | `purchaseToken`（經 `linkedPurchaseToken` 追溯根 token） |
| **Web Stripe** | Checkout `client_reference_id` = `users.id`（並存 `customer.metadata.user_id`） | Stripe **Webhooks** | `Stripe-Signature` 用 webhook secret 驗；`event.id`(`evt_...`) 進 ledger | `event.account`（Connect 時）與 `event.livemode` 須等於預期帳戶與模式，否則拒收 | `subscription` id（`sub_...`） |

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
4. **QA 契約**：訂閱生命週期各轉移（首購/續訂/寬限/到期/取消/退款）→ tier 正確升降；**事件冪等與亂序重播**（同一 `notificationUUID`/`messageId`/`evt_id` 重送只生效一次、較舊事件不回退較新狀態）；**多平台並存**時單一平台退款不誤降其他仍 active 的訂閱（跨 row 聚合）；**漏 webhook 到期空窗**：模擬到期後 reconcile 落後，`effectiveEntitlement` 對 role(free)↔tier(pro) 不一致回 `ENTITLEMENT_UNAVAILABLE` 擋掃描、絕不放行不限量；**scope 驗證**：偽造/跨 app / 跨帳戶 / 未驗 Pub/Sub push JWT 的事件被拒；同一平台訂閱綁不同 user → 409；跨裝置同帳號共享 premium；刪帳號後 `subscription_receipts`/`subscription_events` 已清、`billing_records_retained` 僅存假名化必要欄位、有 `legal_basis`、`retain_until` 到期可硬刪；UI 六種額度狀態與 premium 鎖態、離線 fail-closed。

---

## 附：需產品拍板事項
1. **Web Stripe（§4）**是否納入本季（預設否，Phase 1 只讀即滿足跨裝置共享）。
2. **法定交易保留年限**（§6.2 `retain_until`）依營運所在地財稅法規填定。
3. AI 趨勢預測是否維持 subscriber-only（沿用 Product §3 決策，如需開放 free_user 只改該 matrix 一列）。
