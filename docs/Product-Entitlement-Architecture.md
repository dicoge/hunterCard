# HoloHunter 權限角色與 Onboarding 擴充架構

> DIC-674 · 產品設計提案 v2（納入 CR DIC-761 修正：掃描全路徑 quota 預留、原子 UPSERT 併發、單一額度權威、premium 資料移出公開路徑）
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

> ⚠️ **entitlement 數值的單一權威（single source of truth）**：額度數值的 enforced 權威是 **AUTH-Architecture.md（DIC-662 / PR #50）§3.5 `entitlements` 的 `quota_matches_tier` CHECK**（DB 實際強制 `free=(daily NULL, monthly 100)`、`pro=(NULL, NULL)`）。本文件的 §5.2 / §9 只是該 CHECK 的產品語意鏡像，數值必須與之一致，不得另立第二套。**本契約 free 無 daily cap（`daily_limit = NULL`，DIC-774 acceptance）**；AUTH migration（`migrations/0001_auth.sql`，尚未撰寫）落地時採 AUTH §3.5 的 executable schema。**規範數字只存在一處（AUTH CHECK），本文件引用之。**

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
| **卡片掃描** | `ScanScreen`、`autoScanService`、`scanSessionStore`、`cardRecognition`、`webOcr` | ❌ 需登入 | ✅ 每月 100 張 | ✅ 不限量 | **quota 預留 gate（§6.1），涵蓋全部掃描路徑** |
| 收藏 / watchlist 跨裝置同步 | `holoStore`、`watchlistStore`（現為本機） | ⚠️ 僅本機 | ✅ 雲端 | ✅ 雲端 | AUTH §8.3 sync |
| **premium：AI 趨勢預測** | `trendStore`（`TrendPrediction` score/confidence）、`PriceTrendBadge` | ❌ | ❌ | ✅ | **已驗證的 entitlement 端點（§6.2），移除公開 JSON** |
| 推播入手提醒 | `api/push/*`（AUTH §6 受保護 API） | ⚠️ 裝置級 | ✅ user 級 | ✅ user 級 | AUTH claim token |

**產品決策點（需確認）**：需求明訂「guest 不可看 premium 價格/趨勢預測」「subscriber 可看 premium」。本文件把 **AI 趨勢預測（`trendStore` 的 `TrendPrediction`）設為 subscriber-only**，free_user 看基本價格但看不到 AI 預測。`PriceTrend.tsx`（純歷史漲跌計算）屬「基本價格」，所有人可見。若產品希望 free_user 也能看 AI 預測，只需把該列改為 free_user ✅——gating 表是唯一改動點。

### 3.1 掃描的實際路徑（gate 必須涵蓋全部，否則可繞過）

repo 現況（`src/screens/ScanScreen.tsx`、`src/services/cardRecognition.ts`、`src/services/webOcr.ts`、`src/services/autoScanService.ts`）中，「一次掃描」可經由**多條不同的辨識傳輸**完成，其中數條**完全不打 server**：

| 掃描路徑 | 現況傳輸 | 是否打 server |
| --- | --- | --- |
| 相機即時自動掃描 | `autoScanService.analyzeFrameWithStability`（本機 frame 分析）→ 命中後 `recognizeCardFromImage` → `/api/recognize-card` | 部分（辨識才打） |
| 相簿匯入圖片 | `expo-image-picker` → `recognizeCardFromImage` → `/api/recognize-card` | 是 |
| **Web / 本機 OCR fallback** | `webOcr.recognizeTextWeb`（Tesseract.js 本機）→ `recognizeCardFromOcr(rawText)` → **本機比對 `/data/database.json`** | **否，純本機** |
| **文字直接比對** | `recognizeCard(searchText)` → 本機 DB | **否，純本機** |

> **結論**：只在 `/api/recognize-card` 掛 quota gate **會被本機 OCR / 本機比對路徑整段繞過**。因此 quota 必須由一個**與辨識傳輸解耦的「預留（reservation）gate」**掌管：所有掃描路徑（含純本機辨識）在跑任何 OCR / 比對**之前**都必須先向 server 成功預留一次額度（§6.1），拿不到 ticket 就不得掃描。此為 client 端契約，QA 需針對每條路徑各驗一次（§8）。

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

### 5.2 額度數值（產品角色語意；數值鏡像自 AUTH executable schema）

**數值的 enforced 權威是 AUTH-Architecture.md (DIC-662/PR #50) §3.5 `entitlements` 的 `quota_matches_tier` CHECK**（DB 實際強制）。本表描述產品角色語意，數值必須與該 CHECK 一致，不得另立第二套。

| tier | daily_limit | monthly_limit | premium |
| --- | --- | --- | --- |
| free（free_user） | 無（`NULL`） | **100** | ❌ |
| pro（subscriber） | 不限（`NULL`） | 不限（`NULL`） | ✅ |

- **不限量與「無日上限」皆以 `NULL` 表示**（而非 sentinel 數字），gate 時 `limit IS NULL → 該維度永遠放行`。
- guest 不進 `entitlements`，能力為常數 `scan_limit = 0`（§5.1 提早 return）。
- **本契約不設 daily cap**（free/pro 的 `daily_limit` 皆 `NULL`，DIC-774 acceptance）；月額度是唯一的產品承諾。
- AUTH schema 的 `CHECK` 強制 `free=(NULL,100)`、`pro=(NULL,NULL)`；本表任何調整都必須同步該 CHECK。

### 5.3 tier reconcile（訂閱事件驅動）

`subscriptions` 變動時（購買 / 續訂 / 到期 / 取消 / merge）以 upsert 維護 `entitlements`：

```
on subscription change(user_id):
  active = exists active subscription(user_id)
  upsert entitlements(user_id) set
    tier = active ? 'pro' : 'free',
    monthly_limit = active ? NULL : 100,
    daily_limit   = NULL,   -- 本契約無 daily cap（free/pro 皆 NULL）
    updated_at = now()
```

- 到期改判：可由 (a) IAP/Stripe webhook，或 (b) 每日排程掃 `expires_at < now()` 的 active subscription 標 `expired` 並 reconcile。
- merge 時的 scan_usage / subscriptions / entitlements 歸併沿用 AUTH §3.5.1、§4.1、§4.2（capped sum、原子轉移），本文件不覆寫。

---

## 6. API 契約（gating 面，擴充 AUTH §6）

### 6.1 掃描 quota：預留 / 提交 / 補償（reserve-commit-compensate）

**設計核心**：quota 消耗與辨識傳輸解耦成三步，讓「額度扣減」在一個**極短的原子寫入**內完成，而**慢速/外部的 OCR 辨識在 DB transaction 之外**進行，失敗時明確補償。三個端點：

| Method & Path | 角色需求 | 行為 |
| --- | --- | --- |
| `POST /api/scan/reserve` | 需登入 | 原子預留一次額度，回 `{ scan_ticket, scan_remaining, expires_at }`。guest → `401 SCAN_REQUIRES_LOGIN`；超額 → `403 SCAN_QUOTA_EXCEEDED`（帶 `scan_used/scan_limit/reset_at`） |
| `POST /api/scan/commit` | 需登入 | 帶 `scan_ticket`：辨識完成後確認消耗（把 ticket 標 `consumed`）。冪等 |
| `POST /api/scan/release` | 需登入 | 帶 `scan_ticket`：辨識失敗 / 取消 → 補償退還額度（把 ticket 標 `released` 並回補計數）。冪等 |

**所有掃描路徑（§3.1 四條，含純本機 OCR）的 client 契約**：
```
掃描動作觸發
  1. r = await POST /api/scan/reserve
       ├─ 401 → 導向登入牆（§4.2）
       ├─ 403 SCAN_QUOTA_EXCEEDED → 導向 Paywall（§4.3），不得掃描
       ├─ 網路失敗 / 逾時 → **fail closed**：阻擋掃描，提示「需連線以掃描」，不得離線用本機 OCR 偷跑
       └─ 200 → 取得 r.scan_ticket
  2. 執行辨識（任一傳輸）：
       ├─ server 傳輸 /api/recognize-card：request 帶 scan_ticket，端點驗 ticket 屬本人且 status='reserved' 才處理（無效 ticket → 402/409，直接擋下）
       └─ 本機傳輸（webOcr Tesseract / 本機 DB 比對）：client 先確保步驟 1 已成功
  3. 收尾：辨識成功 → POST /api/scan/commit(ticket)；失敗/取消 → POST /api/scan/release(ticket)
```
> **為什麼 fail-closed**：純本機辨識路徑無法在事後被 server 稽核，若允許離線掃描即等於無限額度。因此「連不上 reserve」＝「不能掃描」。這是安全/產品取捨，需在 §8 QA 與 UX 明列。

**`POST /api/scan/reserve` 的原子預留（免長交易，處理 first-use 併發）**：
不使用「`SELECT ... FOR UPDATE` 一個可能不存在的 row」——缺 row 時 `FOR UPDATE` 鎖不到任何東西，兩個併發首扫會各自 INSERT 造成超扣。改用**條件式 UPSERT，單一語句原子完成 create-or-increment**：

```sql
-- free_user（有限額）：limit 由 effectiveEntitlement 求得（§5.1）
INSERT INTO scan_usage (user_id, period, scan_count)
VALUES ($user, $period, 1)
ON CONFLICT (user_id, period)
DO UPDATE SET scan_count = scan_usage.scan_count + 1
  WHERE scan_usage.scan_count < $limit          -- 條件寫入：達上限則 DO UPDATE 不觸發
RETURNING scan_count;
```
- **RETURNING 有 row** → 預留成功，`scan_remaining = $limit - scan_count`（subscriber 為 `NULL`）。
- **RETURNING 0 row** 且該 (user,period) 已存在 → 代表 `scan_count >= $limit`（WHERE 擋下）→ `403 SCAN_QUOTA_EXCEEDED`。
  （初次 INSERT 不會回 0 row；0 row 只可能發生在 conflict + WHERE 不成立，語意明確。）
- subscriber（`$limit IS NULL`，不限量）：省去 WHERE，用單純 upsert `... DO UPDATE SET scan_count = scan_usage.scan_count + 1 RETURNING scan_count`（或產品不需 subscriber 統計時直接發 ticket 不計數）。
- 這條 UPSERT 本身即原子，**無需外層 BEGIN/COMMIT 包住辨識**；DB 只在這一句停留微秒級。

**ticket 與補償（辨識失敗在交易外處理）**：
- 預留成功時另寫一筆 `scan_reservations(ticket UUID, user_id, period, status IN ('reserved','consumed','released'), expires_at)`，與上面的 UPSERT 同一個短交易。
- `commit`：`UPDATE scan_reservations SET status='consumed' WHERE ticket=$t AND user_id=$u AND status='reserved'`（冪等，重複 commit 無副作用）。
- `release`（辨識錯誤 / 使用者取消）：同一短交易內 `UPDATE scan_reservations SET status='released' WHERE ticket=$t AND status='reserved' RETURNING 1`，若回 1 row 才 `UPDATE scan_usage SET scan_count = scan_count - 1 WHERE user_id=$u AND period=$period AND scan_count > 0`。冪等：已 released/consumed 不再退。
- **逾時回收 sweeper**（排程）：把 `status='reserved' AND expires_at < now()` 的 ticket 視同 `release` 回補額度，避免 client crash / 斷線導致額度卡住。回收與 release 走同一條件式退還，確保只退一次。
- 辨識傳輸（外部 OCR）全程**不持有 DB 鎖**；成功走 commit、失敗走 release，皆為獨立短交易，滿足「external-recognition failure compensation outside a long DB transaction」。

### 6.2 premium 內容（趨勢預測）— 必須移出公開路徑

**現況漏洞**：`src/store/trendStore.ts` 直接 `fetch('/data/trends/index.json')` 與 `fetch('/data/trends/${id}.json')`，這些是 **Vercel 靜態公開檔**（`data/trends/*.json`），任何人可直接 `curl` 取得，subscriber gating 形同虛設。

**修正（二選一，本文件採 A）**：
- **A（採用）**：把 premium 預測 payload **移出公開 web root**，改由**已驗證且檢查 entitlement 的端點**供應：

| Method & Path | 角色需求 | 行為 |
| --- | --- | --- |
| `GET /api/trends/index` | subscriber | 非 subscriber → `403 PREMIUM_REQUIRES_SUBSCRIPTION` |
| `GET /api/trends/:cardId` | subscriber | 同上；命中才回 `TrendPrediction` |

  - 資料檔從 `data/trends/`（公開）遷至**非公開來源**（server 私有目錄 / 物件儲存 / KV），只由上述端點在驗證 subscriber 後讀出回傳。
  - 部署層同步封鎖公開存取：`vercel.json` route / `.vercelignore` 排除 `data/trends/**` 不被當靜態資源送出（避免舊 URL 仍可直取）。
  - client：`trendStore.fetchTrendIndex/fetchTrendForCard` 改打上述 API 並帶 `Authorization`；403 → 顯示鎖 + upgrade 引導（§4.3）。
- **B（備案）**：完全不輸出 AI 預測 payload 給前端，改為 server 端渲染成不可還原的展示資料。若產品未來要 free_user 也看，用 A 較有彈性。

> **不受影響**：`PriceTrend.tsx` 由公開價格歷史計算的「基本漲跌」屬非 premium，維持公開；只有 `TrendPrediction`（score/confidence/AI 預測）需移到驗證端點。

### 6.3 entitlement 查詢（client 啟動 / 登入後拉一次）

| Method & Path | 角色需求 | Response |
| --- | --- | --- |
| `GET /api/entitlements` | 任意（含 guest） | §5.1 的 `effectiveEntitlement`：`{ role, tier, scan_limit, scan_used, scan_remaining, premium, period }` |

- 也可併入 AUTH `GET /api/auth/me`，多回一個 `entitlement` 物件，省一次 round-trip。二擇一，建議獨立 `GET /api/entitlements` 讓 guest 也能查（`me` 需登入）。

**新增錯誤碼**（延續 AUTH §6 命名）：`SCAN_REQUIRES_LOGIN`(401)、`SCAN_QUOTA_EXCEEDED`(403)、`SCAN_TICKET_INVALID`(409，recognize 端點收到無效/已用/非本人 ticket)、`PREMIUM_REQUIRES_SUBSCRIPTION`(403)。

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
| **QA** | §3 matrix、§3.1 路徑、§6 錯誤碼、§4 flow | 三角色 × 各能力矩陣；quota 邊界（99/100/101、月初 reset）；**每條掃描路徑各驗一次（含 web/本機 OCR fallback、相簿匯入）確認都需 reserve**；**離線時掃描 fail-closed**；併發首扫不超額（多 tab/多裝置同時 reserve）；辨識失敗走 release 退還、逾時 sweeper 回收；**直接 `curl /data/trends/*.json` 應 404/403**、非 subscriber 打 `/api/trends/*` 得 403；guest 登入牆 deferred action；跨裝置訂閱共享 |
| **隱私權政策** | §2、§5 | 揭露：依 `users.id` 記錄掃描用量與訂閱狀態；email 不決定權限；訪客不建立帳號；刪除帳號連帶清除 scan_usage/subscriptions/entitlements（AUTH §3.5.2 purge） |

---

## 9. DB Migration 方向

1. **沿用 AUTH `migrations/0001_auth.sql`** 的 `scan_usage` / `subscriptions` / `entitlements`；本文件不新增這三張表，但**規範其額度數值**。
2. **entitlements 欄位與 seed（數值與 AUTH §3.5 CHECK 一致）**：`daily_limit` / `monthly_limit` 為 **nullable**（`NULL` = 該維度不限量）；AUTH schema 以 `monthly_limit DEFAULT 100` + `quota_matches_tier` CHECK 強制 `free=(NULL,100)`、`pro=(NULL,NULL)`。free 的 seed 即 AUTH login-or-create 於首建 user 的同 transaction 執行（見 AUTH §3.5 / §5.1）：

   ```sql
   -- 數值 enforced 權威：AUTH-Architecture.md §3.5 entitlements CHECK。
   -- free_user 建立時（AUTH login-or-create 首建 user 後，同 transaction）：
   -- 靠 tier/monthly_limit DEFAULT 形成合法 (free, NULL, 100)。
   INSERT INTO entitlements (user_id)
   VALUES ($user)
   ON CONFLICT (user_id) DO NOTHING;
   -- subscriber（reconcile 時，§5.3）：tier='pro', daily_limit=NULL, monthly_limit=NULL。
   ```
3. **新增 `scan_reservations` 表**（§6.1 ticket 生命週期）：

   ```sql
   CREATE TABLE scan_reservations (
     ticket      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     period      TEXT NOT NULL,                                   -- 'YYYY-MM'，與 scan_usage 對齊
     status      TEXT NOT NULL DEFAULT 'reserved'
                   CHECK (status IN ('reserved','consumed','released')),
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ NOT NULL                            -- sweeper 依此回收未 commit 的 ticket
   );
   CREATE INDEX idx_scan_reservations_sweep ON scan_reservations(expires_at) WHERE status = 'reserved';
   ```
   purge 隨 `users` CASCADE 清除（比照 AUTH §3.5.2）。
4. **新增 gate 端點 / middleware**：`POST /api/scan/reserve|commit|release`（§6.1）；`GET /api/entitlements`（§6.3）；trend 改為驗證端點 `GET /api/trends/index`、`GET /api/trends/:cardId`（§6.2）。`/api/recognize-card` 增加 `scan_ticket` 驗證，無效即 `409 SCAN_TICKET_INVALID`。
5. **關閉 premium 公開檔漏洞**：`data/trends/*.json` 遷出公開 web root（server 私有目錄 / 物件儲存 / KV）；`vercel.json` route 與 `.vercelignore` 排除 `data/trends/**` 不再作為靜態資源送出；`src/store/trendStore.ts` 由 `fetch('/data/trends/...')` 改打驗證端點並帶 `Authorization`。
6. **相容期**：未登入（guest）維持純本機查卡片；登入解鎖掃描與同步；訂閱先無來源，`subscriptions` 恆空 → 全體 free_user，架構已就緒待金流接入。
