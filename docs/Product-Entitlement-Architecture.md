# HoloHunter 權限角色與 Onboarding 擴充架構

> DIC-674 · 產品設計提案 v1
> 目標：在 [AUTH 共通帳號架構（DIC-662）](./AUTH-Architecture.md) 之上，設計 **guest / free_user / subscriber** 三級權限、Onboarding / auth-to-entitlement flow、掃描額度與 premium 內容的 gating，以及交棒給 Web / iOS / Android / QA / 隱私權政策任務的接口契約。**現階段只設計登入後的擴充架構，不立即實作金流。**

---

## 0. 與 AUTH 架構的關係（不重複、只擴充）

AUTH 文件（DIC-662 / PR #50）已定義：`users`、`auth_identities`、`sessions`、`scan_usage`、`subscriptions`、`entitlements`、merge、delete/purge 與 `POST /api/auth/*` 契約。**本文件不重新定義那些表**，只補上「產品角色語意層」：

- 角色（guest/free_user/subscriber）**如何從 AUTH 的資料推導**（§2）。
- 每個角色**能做什麼**（§3 capability matrix，對應實際畫面）。
- Onboarding **從進場到取得 entitlement 的 flow**（§4）。
- server **如何回傳 effective entitlement**、如何 gate 掃描與 premium（§5、§6）。
- 金流 / 訂閱來源的**擴充點**，先保留不實作（§7）。
- 下游平台任務**接口契約**（§8）。

> ⚠️ **需與 AUTH 對齊的一個數字**：AUTH `entitlements` 目前 `free` 預設 `monthly_limit = 500`；本產品需求要求 **free_user 每月 100 張**。以本文件 §5.2 的數字為準，AUTH migration 的 seed 值需改為 `monthly_limit = 100`（daily_limit 由產品決定，見 §5.2）。這是唯一需回頭修改 AUTH 的點。

---

## 1. 設計原則

1. **角色是「推導值」，不是存在 users 上的欄位**。角色 = f(有無 internal user id, 有無有效訂閱)，避免與 `subscriptions` / `entitlements` 產生第二份真相而漂移。
2. **email 永不決定權限**（沿用 AUTH §2）。角色、quota、subscription 全歸屬 `users.id`。
3. **guest 沒有 internal user id**（僅匿名裝置 session），因此在 server 端**沒有** `entitlements` / `scan_usage` row；guest 能力是「常數」，不查 DB。
4. **未登入體驗不壞**（沿用 AUTH §8.4）：查卡片、看規則、基本價格維持純本機、免登入。登入是 opt-in 加值。
5. **gating 在 server 為權威**，client 只做 UX 提示（隱藏/引導），不可信 client 判斷。
6. **金流延後**：`subscriber` 的判定只依賴 `subscriptions` 表是否有 active row；訂閱來源（IAP / Stripe）是可插拔的 writer，本階段不實作。

---

## 2. 權限角色模型（derived role）

| 角色 | 判定條件 | AUTH 對應 |
| --- | --- | --- |
| **guest** | 無 `Authorization` / 無有效 session → 無 `users.id` | 無 user、無 entitlements row |
| **free_user** | 有有效 session（`users.status='active'`）且**無** active subscription | `entitlements.tier = 'free'` |
| **subscriber** | 有有效 session 且 `subscriptions` 有 `status='active'` 且（`expires_at IS NULL OR expires_at > now()`） | `entitlements.tier = 'pro'` |

推導函式（server 端，pseudo）：

```
resolveRole(req):
  user = authenticate(req)          # 驗 access token；失敗 → guest
  if user is null:            return 'guest'
  if user.status != 'active': return 'guest'   # disabled/pending_deletion 視同無權限
  if hasActiveSubscription(user.id): return 'subscriber'
  return 'free_user'
```

- `entitlements.tier` 是這個推導的**快取/物化結果**，由訂閱事件（purchase / renew / expire / cancel）與 merge（AUTH §3.5.1）維護。gating 讀 `entitlements`（單表、有 PK、快），對帳/後台顯示才回 `subscriptions`。
- `subscriptions` 為 tier 的**真相來源**；`entitlements.tier` 落後時以 §5.3 的 reconcile job 修正。

---

## 3. Capability Matrix（對應現有畫面）

以 repo 現況（`src/screens/*`、`src/store/*`）為準，標出每個能力的 gating。

| 能力 | 對應程式 | guest | free_user | subscriber | gate 點 |
| --- | --- | --- | --- | --- | --- |
| 看規則 / 教學 | `TutorialScreen`、`TutorialDetailScreen`、`TutorialSimulationScreen` | ✅ | ✅ | ✅ | 無 |
| 查卡片（搜尋 / 卡片詳情） | `SearchScreen`、`SearchResultsScreen`、`CardDetailScreen` | ✅ | ✅ | ✅ | 無 |
| 基本價格（現價 / 歷史漲跌） | `PriceTrend.tsx`（依 priceHistory 計算） | ✅ | ✅ | ✅ | 無 |
| **卡片掃描** | `ScanScreen`、`autoScanService`、`scanSessionStore` | ❌ 需登入 | ✅ 每月 100 張 | ✅ 不限量 | server 掃描 API（§6.1） |
| 收藏 / watchlist 跨裝置同步 | `holoStore`、`watchlistStore`（現為本機） | ⚠️ 僅本機 | ✅ 雲端 | ✅ 雲端 | AUTH §8.3 sync |
| **premium：AI 趨勢預測** | `trendStore`（`TrendPrediction` score/confidence）、`PriceTrendBadge` | ❌ | ❌ | ✅ | server trend API（§6.2） |
| 推播入手提醒 | `api/push/*`（AUTH §6 受保護 API） | ⚠️ 裝置級 | ✅ user 級 | ✅ user 級 | AUTH claim token |

**產品決策點（需確認）**：需求明訂「guest 不可看 premium 價格/趨勢預測」「subscriber 可看 premium」。本文件把 **AI 趨勢預測（`trendStore` 的 `TrendPrediction`）設為 subscriber-only**，free_user 看基本價格但看不到 AI 預測。`PriceTrend.tsx`（純歷史漲跌計算）屬「基本價格」，所有人可見。若產品希望 free_user 也能看 AI 預測，只需把該列改為 free_user ✅——gating 表是唯一改動點。

---

## 4. Onboarding / auth-to-entitlement Flow

### 4.1 首次進場（Home / Onboarding）

```
App 啟動
  └─ Home（免登入即可用）
       ├─ [以訪客進入] → guest：可看規則、查卡片、基本價格
       │                     掃描按鈕 / premium badge 顯示「登入解鎖」引導
       ├─ [使用 Google 登入] ─┐
       └─ [使用 Apple 登入] ──┴─→ AUTH §5.1 login-or-create
                                    → 取得 session（access + refresh）
                                    → GET /api/entitlements（§6.3）取 role/quota
                                    → 首次登入：本機 favorites/settings/watchlist 一次性上雲（AUTH §8.3）
                                    → 進入 free_user 體驗
```

- 訪客進入**不建立** `users` row（無 internal user id）。只有走 OAuth 才建立。
- 平台登入按鈕依 AUTH §7 / §9：Web = Google（+ Apple 若就緒）、iOS = Apple + Google、Android = Google 優先。

### 4.2 guest 觸發受限能力 → 登入牆

```
guest 點「掃描」或 premium badge
  └─ 顯示登入引導（value prop：免費每月 100 張掃描 / 跨裝置同步）
       └─ 選 Google/Apple → §4.1 login → 回原本要做的動作（deferred action）
```

### 4.3 free_user → subscriber（升級，金流延後）

```
free_user 掃描額度用罄 或 點 premium 內容
  └─ 顯示 upgrade 引導（Paywall）
       └─ 本階段：Paywall 只呈現方案與「即將推出」；不接金流
       └─ 未來：走平台金流（§7）→ 收到 receipt → 寫 subscriptions(active)
                → entitlements.tier='pro' → 角色升級為 subscriber
```

---

## 5. Entitlement 解析與 quota

### 5.1 Effective entitlement（server 計算，client 只顯示）

```
effectiveEntitlement(user):
  role = resolveRole(...)                        # §2
  if role == 'guest':
      return { role:'guest', can_scan:false, scan_limit:0, premium:false }
  ent  = entitlements[user.id]  (缺 row → 視為 free 預設)
  used = scan_usage[user.id][currentPeriod].scan_count  (缺 → 0)
  return {
    role, tier: ent.tier,
    scan_limit:   role=='subscriber' ? null : ent.monthly_limit,   # null = 不限量
    scan_used:    used,
    scan_remaining: role=='subscriber' ? null : max(ent.monthly_limit - used, 0),
    premium: role=='subscriber',
    period: currentPeriod
  }
```

### 5.2 數字（產品定案，供 AUTH migration seed）

| tier | daily_limit | monthly_limit | premium |
| --- | --- | --- | --- |
| free（free_user） | 10（建議，可調） | **100** | ❌ |
| pro（subscriber） | 不限（`NULL`） | 不限（`NULL`） | ✅ |

- **不限量以 `NULL` 表示**（而非 sentinel 數字），gate 時 `limit IS NULL → 永遠放行`。
- guest 不進 `entitlements`，能力為常數 `scan_limit = 0`（§5.1 提早 return）。
- `daily_limit` 為防濫用副軌，月額度才是產品承諾；MVP 可只實作 monthly，daily 先寬鬆。

### 5.3 tier reconcile（訂閱事件驅動）

`subscriptions` 變動時（購買 / 續訂 / 到期 / 取消 / merge）以 upsert 維護 `entitlements`：

```
on subscription change(user_id):
  active = exists active subscription(user_id)
  upsert entitlements(user_id) set
    tier = active ? 'pro' : 'free',
    monthly_limit = active ? NULL : 100,
    daily_limit   = active ? NULL : 10,
    updated_at = now()
```

- 到期改判：可由 (a) IAP/Stripe webhook，或 (b) 每日排程掃 `expires_at < now()` 的 active subscription 標 `expired` 並 reconcile。
- merge 時的 scan_usage / subscriptions / entitlements 歸併沿用 AUTH §3.5.1、§4.1、§4.2（capped sum、原子轉移），本文件不覆寫。

---

## 6. API 契約（gating 面，擴充 AUTH §6）

### 6.1 掃描（受 quota gate）

| Method & Path | 角色需求 | 行為 |
| --- | --- | --- |
| `POST /api/scan`（或現有掃描辨識端點加上 gate） | 需登入 | guest → `401 SCAN_REQUIRES_LOGIN`；free_user 超額 → `403 SCAN_QUOTA_EXCEEDED`（帶 `scan_used/scan_limit/reset_at`）；否則放行 |

quota 消耗必須**原子**，避免併發掃描超額：

```
POST /api/scan:
  user = requireAuth()            # 缺 → 401 SCAN_REQUIRES_LOGIN
  BEGIN;
    SELECT scan_count FROM scan_usage
      WHERE user_id=user AND period=cur FOR UPDATE;   # 無 row 視為 0
    limit = effectiveEntitlement(user).scan_limit
    if limit IS NOT NULL AND scan_count >= limit:
        ROLLBACK; return 403 SCAN_QUOTA_EXCEEDED
    INSERT ... ON CONFLICT (user_id,period) DO UPDATE SET scan_count = scan_count+1;
  COMMIT;
  → 執行辨識，回結果 + 更新後的 remaining
```
> subscriber（`limit IS NULL`）跳過 `>=` 檢查但仍可**選擇性**累加計數供分析；產品若不需要 subscriber 用量統計可略過。計數與辨識同一 transaction 邊界，辨識失敗需決定是否退還（建議：辨識服務錯誤 → 不計數/退還一次）。

### 6.2 premium 內容（趨勢預測）

| Method & Path | 角色需求 | 行為 |
| --- | --- | --- |
| `GET /api/trends...`（`trendStore` 資料來源） | subscriber | 非 subscriber → `403 PREMIUM_REQUIRES_SUBSCRIPTION`；client 顯示模糊/鎖 + upgrade 引導 |

### 6.3 entitlement 查詢（client 啟動 / 登入後拉一次）

| Method & Path | 角色需求 | Response |
| --- | --- | --- |
| `GET /api/entitlements` | 任意（含 guest） | §5.1 的 `effectiveEntitlement`：`{ role, tier, scan_limit, scan_used, scan_remaining, premium, period }` |

- 也可併入 AUTH `GET /api/auth/me`，多回一個 `entitlement` 物件，省一次 round-trip。二擇一，建議獨立 `GET /api/entitlements` 讓 guest 也能查（`me` 需登入）。

**新增錯誤碼**（延續 AUTH §6 命名）：`SCAN_REQUIRES_LOGIN`(401)、`SCAN_QUOTA_EXCEEDED`(403)、`PREMIUM_REQUIRES_SUBSCRIPTION`(403)。

---

## 7. 金流 / 訂閱來源擴充點（本階段不實作）

`subscriber` 判定只看 `subscriptions` 是否 active，**訂閱來源是可插拔 writer**，留三個接口不實作：

| 平台 | 來源 | 未來 writer | 備註 |
| --- | --- | --- | --- |
| iOS | App Store IAP | StoreKit receipt → server 驗證 → upsert `subscriptions` | Apple 審核要求 App 內購買走 IAP |
| Android | Google Play Billing | Play purchase token → server 驗證 → upsert `subscriptions` | 同上 |
| Web | Stripe（或 Web 暫不開訂閱） | Stripe webhook → upsert `subscriptions` | Web 可先只提供 free_user，不賣訂閱 |

- 共同契約：任何來源最終都寫入同一 `subscriptions(user_id, plan, status, started_at, expires_at)`，再由 §5.3 reconcile 到 `entitlements`。跨平台不做「一處買、他處自動生效」的承諾在 MVP，但因訂閱歸 `users.id`，同一帳號跨裝置登入即共享（純 server 判定，無需額外機制）。
- 本階段交付**只到「Paywall 呈現方案 + 即將推出」**；不接任何金流 SDK。

---

## 8. 交棒給後續任務（接口契約）

| 任務 | 依賴本文件 | 契約重點 |
| --- | --- | --- |
| **Web** | §4 Onboarding、§6.3 `GET /api/entitlements`、§6.1 掃描 gate | Home 提供 訪客/Google(/Apple) 進場；依 entitlement 隱藏/引導掃描與 premium；Paywall 靜態方案頁 |
| **iOS** | §4、§6、§7(IAP 佔位) | Apple+Google 登入按鈕；掃描前查 remaining；premium 鎖；IAP 佔位不接金流 |
| **Android** | §4、§6、§7(Play 佔位) | Google 登入優先；同上 gating |
| **QA** | §3 matrix、§6 錯誤碼、§4 flow | 三角色 × 各能力的可否矩陣；quota 邊界（99/100/101）；guest 登入牆 deferred action；跨裝置訂閱共享；併發掃描不超額 |
| **隱私權政策** | §2、§5 | 揭露：依 `users.id` 記錄掃描用量與訂閱狀態；email 不決定權限；訪客不建立帳號；刪除帳號連帶清除 scan_usage/subscriptions/entitlements（AUTH §3.5.2 purge） |

---

## 9. DB Migration 方向

1. **沿用 AUTH `migrations/0001_auth.sql`** 的 `scan_usage` / `subscriptions` / `entitlements`；本文件不新增表。
2. **調整 seed / 預設值**：`entitlements` free 預設 `monthly_limit = 100`（配合 §5.2），`daily_limit` 依產品定；不限量欄位允許 `NULL`（若 AUTH 目前為 `NOT NULL DEFAULT`，pro tier 需放寬為 nullable 或以 reconcile 時寫入大值——建議改 nullable 語意最乾淨）。
3. **新增 gate middleware**：掃描端點與 trend 端點套用 §6 的 role / quota 檢查；`GET /api/entitlements` 新端點。
4. **相容期**：未登入（guest）維持純本機查卡片；登入解鎖掃描與同步；訂閱先無來源，`subscriptions` 恆空 → 全體 free_user，架構已就緒待金流接入。
