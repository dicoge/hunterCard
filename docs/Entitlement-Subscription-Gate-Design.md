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
5. **§6** 帳號刪除 / 交易紀錄保留與匿名化。

> ⚠️ `subscriptions.status` 沿用 AUTH §3.5 的 enum `('active','cancelled','expired','paused')`。本文件所有 grace / billing-retry / refund 狀態都**映射進這四個既有值**，不擴充 enum，以免與權威 schema 衝突（映射見 §2）。

---

## 1. 訂閱來源驗證資料模型（歸屬 internal user id）

AUTH `subscriptions` 是 tier 的真相來源，但它**只記「這個 user 有沒有 active 訂閱」**，不足以做「平台交易驗證、重複回報去重、退款/取消對應、跨裝置還原購買」。因此新增一張 **平台交易對應表**，把每一筆平台訂閱事件錨定到 `users.id`：

```sql
-- 平台訂閱交易 → internal user 的權威對應（每筆平台訂閱一列，隨續訂更新）
CREATE TABLE subscription_receipts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id      UUID REFERENCES subscriptions(id) ON DELETE SET NULL, -- 對應的 AUTH subscriptions row
  platform             TEXT NOT NULL CHECK (platform IN ('app_store','google_play','stripe')),
  -- 平台側的「穩定訂閱識別」，續訂/回報去重都以它為準：
  --   app_store   = originalTransactionId
  --   google_play = purchaseToken（或 linkedPurchaseToken 追溯後的根 token）
  --   stripe      = subscription id (sub_...)
  provider_sub_ref     TEXT NOT NULL,
  latest_txn_ref       TEXT,                    -- 最近一次交易/續訂識別（app store transactionId / stripe invoice 等）
  product_id           TEXT NOT NULL,           -- 平台方案 id（sku / price id）
  environment          TEXT NOT NULL DEFAULT 'production'
                         CHECK (environment IN ('production','sandbox')),
  raw_verification     JSONB,                   -- 驗證後保留的必要欄位（非整包收據，見下）
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一平台的同一訂閱只能對應一個 internal user，防「一單綁多帳號」與重複入帳：
  CONSTRAINT uq_platform_sub UNIQUE (platform, provider_sub_ref)
);
CREATE INDEX idx_sub_receipts_user ON subscription_receipts(user_id);
```

設計要點：

- **對應鍵永遠是 `users.id`，永不是 email**（沿用 AUTH §2）。平台把購買錨定到我方 user 的方式見 §3（Apple `appAccountToken` / Google `obfuscatedAccountId` / Stripe `client_reference_id`），三者一律填 internal user id（UUID）。
- **`uq_platform_sub` 是去重與防盜綁的核心**：同一 `originalTransactionId` / `purchaseToken` / Stripe `sub_id` 只能存在一列。若同一平台訂閱嘗試綁到**不同** user（換手機、帳號轉移、共享 Apple ID）→ 走 §2.4 衝突處理，不自動改綁。
- **`raw_verification` 只留驗證所需的最小欄位**（`expires_date`、`auto_renew_status`、`product_id`、環境、最近事件類型），**不落原始 receipt / signed JWS 全文**（含裝置/帳戶敏感資訊，且會膨脹）。這也讓 §6 匿名化只需清 `user_id` 與去識別化幾個欄位。
- `subscription_receipts` 是驗證/對帳層；`subscriptions`（AUTH）仍是 gating 讀取的 tier 真相；`entitlements` 是物化快取。三層關係：**receipt 事件 → upsert `subscriptions` → reconcile `entitlements`（Product §5.3）**。

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

> **判定不變式**：`hasActiveSubscription`（Product §2）= 存在 `status='active' AND (expires_at IS NULL OR expires_at > now())` 的 row。`paused` / `expired` / `cancelled` 都不算 active。寬限期刻意保持 `active`（權限不中斷），到期時間交由平台事件延長。

### 2.2 reconcile 觸發（權威在 server）

每次狀態變更（webhook / 排程）都：

```
verifyEventSignature(evt)                 # §3：平台簽章驗證，杜絕偽造回報
resolve user_id                           # 由 appAccountToken / obfuscatedAccountId / client_reference_id
upsert subscription_receipts (uq_platform_sub)   # 去重 + 記 latest_txn_ref
upsert subscriptions(user_id) status/expires_at  # §2.1 映射
reconcile entitlements(user_id)           # Product §5.3：active → pro(NULL,NULL)；否則 free(NULL,100)
audit_log(event_type='subscription_<evt>')
```

- **權威計算在 server**：client 端的購買回呼只是「提示去 pull」，真正入帳一律以**平台簽章事件 + server 驗證**為準（§3），本機不可寫 tier。這對齊需求「quota 重置由 backend 權威計算，防本機竄改」——`entitlements`/`scan_usage` 都在 server，本機時間/快取無法影響。
- **月 quota 重置**同理由 server 權威：`scan_usage` 以 `period='YYYY-MM'`（server clock）為 PK，換月即新 row，不靠 client（AUTH §3.5 / Product §6.1 已定義；此處僅重申來源不可竄改）。

### 2.3 到期補判（不依賴 webhook 也正確）

Webhook 可能延遲/漏送，故加一條 **每日排程**：把 `status='active' AND expires_at < now()` 的訂閱標 `expired` 並 reconcile（Product §5.3 已列此路徑）。webhook 與排程對同一 row 的寫入需冪等：以 `provider_sub_ref` + 事件時間戳做 last-writer 判斷，較舊事件不回退較新狀態。

### 2.4 同一平台訂閱綁不同 user（衝突）

`uq_platform_sub` 命中既有 row 但 `user_id` 不同時（例：同一 Apple ID 在兩個 HoloHunter 帳號還原購買）：**不自動改綁**，回 `409 SUBSCRIPTION_ALREADY_LINKED`，記 audit，導向客服/人工，與 AUTH §4 merge 的 `requires_support` 門檻一致（任一方有 active pro 即需人工）。避免「盜綁他人訂閱」或「一單洗多帳號」。

---

## 3. 三平台驗證與狀態同步

共同原則：**client 出示購買 → server 向平台驗證 → 錨定 internal user id → 寫 receipt/subscriptions**。三平台把「這筆購買屬於哪個 internal user」的載體都設為我方 UUID：

| 平台 | 我方 user 載體（購買時帶入） | 驗證 / 事件來源 | 穩定訂閱鍵 |
| --- | --- | --- | --- |
| **iOS App Store** | StoreKit2 `Purchase.appAccountToken` = `users.id`(UUID) | App Store Server API 驗簽 + **App Store Server Notifications V2**（signed JWS `signedPayload`） | `originalTransactionId` |
| **Android Google Play** | Play Billing `obfuscatedAccountId` = `users.id` | Play Developer API `purchases.subscriptionsv2.get` + **RTDN**（Pub/Sub 推送） | `purchaseToken`（經 `linkedPurchaseToken` 追溯根 token） |
| **Web Stripe** | Checkout `client_reference_id` = `users.id`（並存 `customer.metadata.user_id`） | Stripe **Webhooks**（`Stripe-Signature` 驗簽） | `subscription` id（`sub_...`） |

- **一律 server 端驗簽**：Apple JWS 用 Apple root CA 驗證憑證鏈；Google 用 service account 呼叫 Developer API 覆核 token；Stripe 用 webhook secret 驗 `Stripe-Signature`。**絕不信任 client 自報的購買結果**（防偽造升級）。
- **沙盒/正式環境分流**：`subscription_receipts.environment`；Apple V2 sandbox 事件與 production 分流，避免測試訂閱污染 production entitlement。
- **還原購買（restore）**：以平台帳號重新出示 → 用 `originalTransactionId` / `purchaseToken` 命中既有 `subscription_receipts`；若當前登入 user ≠ receipt.user_id → §2.4 衝突。
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

## 6. 帳號刪除 / 資料保留與匿名化

需求：刪帳號要刪 scan usage / quota / subscription mapping；但交易/稅務/退款/平台規範要求保留者，須匿名化只留必要交易紀錄。

### 6.1 刪除即清（沿用 AUTH §3.5.2 purge）

user purge 時 `ON DELETE CASCADE` 一併刪除：`scan_usage`、`subscriptions`、`entitlements`、`scan_reservations`（Product §9）、以及本文件的 **`subscription_receipts`**（含 `raw_verification`，內有平台帳戶關聯，屬個資，必須刪）。刪前 `audit_log` 寫 `delete_purged`（AUTH §3.5.2）。

### 6.2 法遵/財稅必要紀錄 → 去識別化保留

退款、稅務、對帳、平台稽核可能要求保留「發生過一筆交易」的最小事實，但**不需要**保留「是誰」。因此在 purge 前把必要交易欄位轉存到一張**與 user 脫鉤**的保留表：

```sql
-- 去識別化的交易保留（無 users FK；刪帳號後仍存在，供財稅/退款對帳）
CREATE TABLE billing_records_anonymized (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_snapshot      UUID NOT NULL,          -- 原 user_id 的不可逆快照，不再 FK 到 users（比照 AUTH merge snapshot）
  platform           TEXT NOT NULL,
  provider_sub_ref_hash TEXT NOT NULL,       -- originalTransactionId/token 的單向雜湊（可對帳去重，不可還原帳戶）
  product_id         TEXT NOT NULL,
  amount             NUMERIC,                 -- 金額 / 稅（若平台回報）
  currency           TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,    -- 交易/退款時間
  record_type        TEXT NOT NULL CHECK (record_type IN ('purchase','renewal','refund','chargeback')),
  retain_until       TIMESTAMPTZ,             -- 依法定保存年限；到期後由排程硬刪
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

去識別化規則：

- **不含**任何可直接識別個人的欄位：無 `user_id` FK、無 email、無平台帳戶原文；`provider_sub_ref` 只留**單向雜湊**（能對帳去重、不能回推帳戶）。`user_snapshot` 是隨機 UUID 快照，脫離 `users` 後無法反查（比照 AUTH `account_merge_requests` 的 snapshot 做法）。
- **只保留財稅/退款必要欄位**（金額、幣別、方案、時間、類型），不留掃描行為、裝置、IP 等。
- **保存期限化**：`retain_until` 依當地法定年限設定，到期由排程**硬刪**，落實資料最小化。
- 觸發時機：user purge 交易內，先寫 `billing_records_anonymized`（僅在該 user 有過真實付費/退款時），再 CASCADE 刪 `subscription_receipts` 等。若無任何交易則不留任何列。

> 與隱私權政策的銜接（DIC-667 已更新之政策）：刪帳號會清除帳號主體與使用者資料；因財稅/平台規範保留的僅為**去識別化交易紀錄**，無法識別個人。此段需回填隱私權政策的「資料保留」章節（交棒 PRIVACY 任務）。

---

## 7. 交棒 / 落地順序

1. **前置相依**：本設計消費 AUTH（`users`/`sessions`/`subscriptions`/`entitlements`）與 Product（reserve gate）**執行期基礎**，須待該後端落地（Postgres + session 驗證）後才實作；目前 repo 仍為 local mock（`Monetization-Architecture-Plan.md §0`）。
2. **可先做（不等金流）**：§5 UI 狀態改為讀 `GET /api/entitlements`（server 權威）、fail-closed / 離線提示、Paywall 靜態頁、`PremiumGate` CTA 接 Paywall。
3. **金流實作 sub-issue**：§1 `subscription_receipts` + §3 三平台 writer/webhook + §2 狀態機 + §6 保留表，建議每平台一個實作子任務，Web Stripe 依 §4 預設留到 Phase 2。
4. **QA 契約**：訂閱生命週期各轉移（首購/續訂/寬限/到期/取消/退款）→ tier 正確升降；同一平台訂閱綁不同 user → 409；跨裝置同帳號共享 premium；刪帳號後 `subscription_receipts` 已清、`billing_records_anonymized` 僅存去識別化必要欄位且 `retain_until` 到期可硬刪；UI 六種額度狀態與 premium 鎖態、離線 fail-closed。

---

## 附：需產品拍板事項
1. **Web Stripe（§4）**是否納入本季（預設否，Phase 1 只讀即滿足跨裝置共享）。
2. **法定交易保留年限**（§6.2 `retain_until`）依營運所在地財稅法規填定。
3. AI 趨勢預測是否維持 subscriber-only（沿用 Product §3 決策，如需開放 free_user 只改該 matrix 一列）。
