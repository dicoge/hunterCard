# HoloHunter 首頁入口、權限模型與每月掃描 Quota 設計方案

本文件規劃為 HoloHunter (hOCG 卡牌查價 App) 設計 Onboarding 流程、權限防護模型 (guest / free_user / subscriber)、安全防竄改掃描配額機制、應用程式商店訂閱金流與隱私合規之完整架構。

---

## 🏗️ 1. 系統架構與流程圖

HoloHunter 的核心原則為**客戶端僅負責 UI 呈現與手勢操作，權限判定與 Quota 控制皆由伺服器端 (Server-side) 進行最終把關**。

### 1.1 使用者 Onboarding 與角色切換流程

```mermaid
graph TD
    Start([開啟 App]) --> CheckAuth{檢查本地 Session}
    CheckAuth -- 有有效 Session --> MainScreen[進入主畫面 - 已登入]
    CheckAuth -- 無 Session --> Onboarding[顯示 Onboarding 首頁]
    
    Onboarding --> LoginGoogle[Google 登入]
    Onboarding --> LoginApple[Apple 登入]
    Onboarding --> GuestMode[以訪客身份進入]
    
    LoginGoogle --> AuthServer[後端認證伺服器]
    LoginApple --> AuthServer
    
    AuthServer --> IssueJWT[發行 JWT Token 與安全 Quota 簽名]
    IssueJWT --> SaveSecure[儲存 Token 至本機安全儲存區]
    SaveSecure --> MainScreen
    
    GuestMode --> SetGuestRole[設定本地角色為 guest]
    SetGuestRole --> MainScreen
```

### 1.2 掃描請求與防竄改配額驗證流程

由於卡牌辨識（OCR/Gemini Vision API）是線上服務，所有掃描請求都必須通過後端 API。這使得配額控制可以完全由伺服器防禦，防止用戶修改本地時間或快取。

```mermaid
sequenceDiagram
    autonumber
    actor User as 使用者 (App)
    participant Client as App 前端 (Secure Storage)
    participant Server as 後端伺服器 (Edge Function)
    participant Cache as Redis 緩存區
    participant Vision as Gemini Vision API / DB

    User->>Client: 點擊「啟動掃描」
    Client->>Client: 檢查本地角色類型 & 產生 scan_request_id
    alt 角色為 guest
        Client-->>User: 阻擋並彈出「請先登入」引導
    else 角色為 free_user 或 subscriber
        Client->>Server: POST /api/recognize-card (帶 JWT、scan_request_id & 影像)
        Note over Server: 驗證 JWT 簽章並提取角色 & userId
        alt 角色為 subscriber
            Server->>Vision: 執行卡牌辨識
            Vision-->>Server: 回傳辨識結果
            Server-->>Client: 200 OK (結果 + 無限配額)
            Client-->>User: 顯示價格與預測資訊 (Premium)
        else 角色為 free_user
            Server->>Cache: quota_reserve(userId, YYYY-MM, scan_request_id, limit=100)
            Note over Cache: 單一原子 Lua：冪等回放 / 超額判定 / 允許才 INCR 保留
            alt 回傳 DENIED (current >= 100，未 INCR、無回退)
                Cache-->>Server: DENIED
                Server-->>Client: 429 Too Many Requests (配額已滿)
                Client-->>User: 顯示「配額已滿，升級訂閱」彈出視窗
            else 回傳 RESERVED (remaining)
                Cache-->>Server: RESERVED + remaining
                Server->>Vision: 執行卡牌辨識
                alt 辨識成功 (或使用者端無結果)
                    Vision-->>Server: 回傳辨識結果
                    Server->>Cache: quota_commit(scan_request_id) (reserved→committed，不變更計數)
                    Server-->>Client: 200 OK (結果 + 剩餘配額 + 加密 Quota 簽章)
                    Client->>Client: 將加密 Quota 簽章儲入安全儲存區
                    Client-->>User: 顯示價格 (無 Premium 預測資訊)
                else 系統性失敗 (Vision 例外/逾時)
                    Vision-->>Server: 錯誤/逾時
                    Server->>Cache: quota_refund(scan_request_id) (僅 reserved→refunded 才 DECR)
                    Server-->>Client: 5xx (請以同一 scan_request_id 重試)
                    Client-->>User: 顯示暫時性錯誤提示
                end
            end
        end
    end
```

---

## 🔐 2. 權限防護模型 (Role-Based Access Control)

系統區分為三種角色，權限矩陣如下：

| 功能項目 | 訪客 (guest) | 免費登入用戶 (free_user) | 訂閱用戶 (subscriber) |
| :--- | :---: | :---: | :---: |
| **卡片搜尋與篩選** | ✅ 允許 | ✅ 允許 | ✅ 允許 |
| **官方規則查閱** | ✅ 允許 | ✅ 允許 | ✅ 允許 |
| **基本市場價格顯示** | ✅ 允許 | ✅ 允許 | ✅ 允許 |
| **卡片詳情頁** | ✅ 允許 | ✅ 允許 | ✅ 允許 |
| **卡片相機掃描** | ❌ 拒絕 (彈出登入引導) | ✅ 每月上限 100 張 | ✅ 無限次數 |
| **價格預測 (Premium)** | ❌ 隱藏 (顯示升級鎖) | ❌ 隱藏 (顯示升級鎖) | ✅ 完整解鎖 |
| **趨勢預測 (Premium)** | ❌ 隱藏 (顯示升級鎖) | ❌ 隱藏 (顯示升級鎖) | ✅ 完整解鎖 |
| **進階市場數據與提醒** | ❌ 拒絕 | ❌ 拒絕 | ✅ 完整解鎖 |

---

## 🛡️ 3. 每月掃描 Quota 防竄改機制 (Anti-Tampering Engine)

為了完全避免使用者透過竄改本機 App 狀態或修改手機系統時間來規避 100 次的掃描上限，本架構採取**雙重安全保護機制**：

### 3.1 伺服器主控配額管理 (Server-Centric Control)
1. **無離線掃描支援**：由於 OCR 與 Gemini Vision 圖像識別服務需要連線到伺服器處理，後端將作為配額審查的唯一真理來源 (Source of Truth)。
2. **Redis 週期性計數器**：
   - 當月次數以 `user:{userId}:scans:{YYYY-MM}` 為 Redis Key 累計；其增量**一律經由 §3.3 的 `quota_reserve` 原子契約在確認未達上限時發生**，後端不在收到請求時先行裸 `INCR`。
   - 該 Key 設定過期時間為當月最後一天的 23:59:59 (基於伺服器 UTC 時間)，下月自動重置為 0。
3. **時鐘防禦 (Clock Attack Prevention)**：不依賴手機端時間判定月份，完全以伺服器端接收請求的時間戳記進行統計。

### 3.2 本地安全防護同步 (Local Security Storage)
1. **加密儲存**：
   - **Android**：參考 `AIQuotaWatch` 的安全實作，使用 AES-256 的 `EncryptedSharedPreferences` 配合 Android Keystore 進行 Token 與剩餘 Quota 資料的儲存。
   - **iOS**：使用 iOS Keychain 來儲存登入憑證與 Quota Meta。
2. **加密防篡改簽章 (Cryptographic Quota Signature)**：
   - 伺服器回傳 Quota 剩餘數量時，會額外附帶一個 HMAC 簽名：
     $$\text{Signature} = \text{HMAC-SHA256}(\text{Server-Private-Key}, \text{userId} + \text{remainingScans} + \text{expireTimestamp})$$
   - 當 App 每次載入時，會讀取本地快取並驗證簽章；若發現簽名不符或過期，App 會強制與後端 API `/api/user/sync-quota` 同步以取得最新資料。

### 3.3 扣額原子語意、冪等與失敗處理 (Atomicity / Idempotency / Fail-closed)

配額扣減必須是原子的，且在逾時、辨識失敗、重試等狀況下**不重複扣額也不漏扣**。核心是**單一伺服器端原子契約**：一個 Redis Lua script（在 Redis 內單執行緒不可分割地執行）同時完成「檢查上限 + 記錄冪等/保留狀態 + 僅在允許時保留額度」。**不存在**「先 `INCR` 再比對、超額才 `DECR` 回退」這種以多個獨立指令拼湊而被視為原子的作法。

1. **唯一保留契約 `quota_reserve`（單一原子 Lua script）**
   輸入：`userId`、`month_key = YYYY-MM`（伺服器 UTC 決定）、`scan_request_id`、`limit = 100`。在同一次 script 執行內依序判斷並回傳，全程原子：
   - **(a) 冪等回放**：若 `reservation:{scan_request_id}` 已存在，直接回傳其既有結果（`RESERVED`＋當時 remaining，或 `DENIED`），**不再變更計數**。這是重試的唯一正確路徑。
   - **(b) 超額判定**：否則讀取 `user:{userId}:scans:{month_key}` 目前值；若 `current >= limit`，寫入 `reservation:{scan_request_id} = denied` 後回傳 `DENIED`——**此路徑完全不對計數器做 `INCR`，因此不需要、也不會有任何 `DECR` 回退**。
   - **(c) 允許才保留**：否則對計數器 `INCR`（此 `INCR` 只在確認未達上限後於同一 script 內發生），寫入 `reservation:{scan_request_id} = reserved`（含 remaining），回傳 `RESERVED` 與 remaining。
   計數器 Key 首次建立時設定過期為當月最後一刻（承 §3.1）；`reservation:{scan_request_id}` 設短 TTL（如 24h）供重試去重。

2. **保留 → 落定 / 退額 (reserve → commit / refund)**
   `quota_reserve` 回 `RESERVED` 後才呼叫 Vision 辨識，依結果對**同一 `scan_request_id`** 做一次狀態轉移，每個 id 僅能單向轉移一次（`reserved → committed` 或 `reserved → refunded`）：
   - **成功 → `quota_commit`**：將 `reservation` 由 `reserved` 標記為 `committed`；額度已於保留時計入，**不再變更計數**。
   - **系統性失敗（Vision 例外／逾時，非使用者原因）→ `quota_refund`**：另一支原子 Lua script，且**僅當狀態為 `reserved` 時**才 `DECR` 計數並標記 `refunded`。此 `DECR` 是狀態機守護下的補償退額（reserved→refunded 僅一次），**不是** (c) 保留判定的一部分，也不會被描述為保留契約的原子回退；重試命中 `refunded` 直接回放，不重複 `DECR`。

3. **Redis 逾時 / 不可用 → Fail-closed**
   - `quota_reserve` 執行逾時或 Redis 不可用時，後端**拒絕該次掃描（回 503），不放行辨識**，確保無法原子計數時不被繞過上限。
   - App 收到 503 以同一 `scan_request_id` 有限次退避重試（靠契約 (a) 去重）；仍失敗則提示網路問題，不在本地放行掃描、不本地遞減配額。

4. **辨識失敗 (Recognition failure) 的計額原則**
   - 系統性/服務端失敗（Vision 例外、逾時）→ 走 `quota_refund` 退額，不計入 100 次。
   - 使用者端可辨識但無結果（非卡牌影像、信心度過低）→ 視為一次有效掃描，走 `quota_commit` 計額；UI 告知「已使用 1 次額度但未辨識到卡牌」，避免爭議。

5. **月度重置邊界**：跨月時以伺服器 UTC 時間決定 `month_key`，重置僅換 Key，不影響進行中的 `scan_request_id` 狀態機。

---

## 💳 4. 訂閱狀態生命週期與金流整合設計

未來預計整合 Apple App Store IAP 與 Google Play Billing 訂閱。本節僅為**架構規劃**，現階段不實作金流；所有第三方服務選型皆為**待評估選項**，尚未核准或定案。

### 4.1 Entitlement 以 internal user 為主體 (Identity Model)

金流的真理來源**必須是 HoloHunter 後端的 internal user**，而非任一 Store 帳號。`subscriber` 權限 (entitlement) 掛在 internal user 上，Store 交易只是「賦予/續期」該 entitlement 的來源事件。

**Identity mapping（一對多）**：一個 internal user 可綁定多個 provider identity。

| 欄位 | 說明 |
| :--- | :--- |
| `internal_user_id` | 主鍵，entitlement 的唯一主體 |
| `provider` | `apple` / `google` /（未來）`web` |
| `provider_subject` | Apple `sub`、Google `sub`、Web 帳號 id — provider 內唯一 |
| `store_app_account_token` | iOS `appAccountToken` / Android `obfuscatedAccountId`，購買時綁定，供 webhook 反查 internal user |
| `linked_at` | 綁定時間，供 collision 稽核 |

唯一性約束：`(provider, provider_subject)` 唯一；一組 provider identity 僅能對應一個 internal user。

**Restore purchase**：重裝或換機時，App 呼叫 StoreKit / Play Billing 的 restore 取得既有交易；後端以 `provider + provider_subject`（及 `store_app_account_token`）反查 internal user 並重新賦予 entitlement，**不重複計費**。若查無對應 internal user（例如換帳號後 restore），依 collision 規則處理。

**換帳號 / Collision 處理**：
- **同一 Store 帳號登入到不同 internal user**：偵測到 `(provider, provider_subject)` 已綁定其他 internal user 時，**不自動轉移** entitlement，改標記為待審核 collision，避免訂閱被無聲搬移。
- **同一 internal user 綁定第二個同類 provider**：拒絕（每種 provider 至多一個 identity），或引導先解除舊綁定。
- **Store 端 family sharing / 同帳號多裝置**：以 internal user 為準去重，多裝置共享同一 entitlement，不各自累加。

### 4.2 金流整合架構（待評估，非既定方案）

雙平台收據驗證 (Receipt Validation) 有兩種待評估路徑，**尚未擇定**，導入前需另立議題評估成本、資料落地與合規：

- **選項 A（待評估）— RevenueCat 等第三方中介**：由 SDK 統一處理跨平台收據驗證與 webhook。優點是省開發成本；待評估點為第三方相依、費用與用戶資料經第三方之隱私合規。
- **選項 B（待評估）— 自建收據驗證**：後端直接呼叫 Apple App Store Server API 與 Google Play Developer API 驗證，不引入第三方。優點是資料自持，成本為維運複雜度較高。

**Web 訂閱 / Stripe**：屬另行評估範疇，現階段不納入設計；Web 端若要收費須另立議題評估 Stripe 或其他方案，並注意與 App Store / Google Play 規範的分潤與導流限制。

不論最終採 A 或 B，後端收到通知後一律映射回 internal user 再更新 entitlement（承 4.1）：

```
[ App (iOS/Android) ]
         │ (原生 SDK 發起訂閱購買，帶 appAccountToken / obfuscatedAccountId)
         ▼
[ StoreKit / Google Play Billing ] ──► (交易成功發送收據)
         │
         ▼
[ 收據驗證層：選項 A 第三方 或 選項 B 自建（待評估） ] ──► (驗證並發送 webhook)
         │
         ▼
[ HoloHunter Backend ] ──► (以 appAccountToken/provider_subject 反查 internal user，更新其 entitlement)
```

### 4.3 訂閱狀態變更事件處理
後端接收以下事件，並以 internal user 為主體即時更新 entitlement：
- **`INITIAL_PURCHASE`**：對應 internal user 賦予 `subscriber` entitlement，解除掃描限制。
- **`RENEWAL`**：維持 entitlement，更新到期日。
- **`CANCELLATION / EXPIRATION`**：到期後移除 `subscriber` entitlement，回落 `free_user` 並套用當月 100 次限額邏輯。
- 所有事件以 provider 通知 id 做冪等處理，重複投遞只更新狀態一次。

---

## 🎨 5. UI/UX 頁面與組件設計規範

UI 設計需要遵循精緻的 HoloHunter 暗色系與高質感漸層美學。

### 5.1 Onboarding 歡迎首頁設計
- **視覺呈現**：
  - 頂部為高解析度卡牌輪播，中間展示 App 三大特色（相機即時掃描、每日市價追蹤、價格趨勢看漲/看跌預測）。
  - 使用毛玻璃效果的背景框，配上藍紫漸層的主按鈕。
- **登入選項**：
  - `[G] Continue with Google` (淺色玻璃按鈕)
  - `[] Continue with Apple` (黑色精緻按鈕)
  - `以訪客身份探索` (下方的文字連結，維持低調設計)

### 5.2 掃描剩餘配額進度條 (ScanScreen)
- **元件放置**：位於掃描框的下方，作為提示工具。
- **視覺設計**：
  - 一條細膩的進度條，當配額充足時顯示**靛藍色**（Holo 風格），剩餘小於 20% 時轉為**橙黃色**。
  - 文字描述：`本月掃描額度：78 / 100`。
  - 右方附帶一個 `[ ⚡ 升級無限版 ]` 的亮色漸層微縮按鈕。

### 5.3 達上限阻擋彈窗 (Limit Block Modal)
- 當 API 回傳 429 或本地判定配額為 0，使用者點擊掃描按鈕時觸發。
- **UI 內容**：
  - 頂部使用太空火箭或金屬鎖頭的微動畫 icon。
  - 標題：`您的免費掃描額度已達上限`。
  - 內文：`您本月的 100 次免費卡片掃描額度已用盡。升級訂閱以享受無限次相機掃描，並解鎖專業的卡牌價格預測與市場走勢分析。`
  - 主按鈕：`NT$90 / 月 解鎖無限版` (亮麗的漸層炫彩按鈕)。
  - 次按鈕：`下個月再說` (返回查卡首頁)。

### 5.4 Premium 資訊鎖 (Premium Lock Overlay)
- 當 guest 或 free_user 進入 `CardDetailScreen.tsx` 時，下方的「趨勢預測與歷史折線圖」區塊會被遮罩。
- **遮罩樣式**：
  - 套用 CSS `backdrop-filter: blur(12px)` 的毛玻璃濾鏡。
  - 遮罩層正中央顯示金色鎖頭 icon `🔒`。
  - 提示字樣：`【訂閱者專屬】解鎖未來 30 天價格走勢預測與社群新聞情緒指標`。
  - 提供 `[ 立即訂閱解鎖 ]` 的按鈕。

---

## 👤 6. GDPR/隱私權合規與帳號刪除數據清理 (Data Scrubbing)

符合歐盟 GDPR 與 App Store 隱私權規範，必須在設定頁面提供「刪除帳號」功能，並在用戶發起後徹底清除相關隱私。

### 6.1 數據清理原則
1. **個人隱私數據 (Fully Scrubbed)**：
   - 徹底刪除 `User` 表中的帳號連結、Email、姓名。
   - 刪除該用戶名下的卡牌收藏清單 (`Favorites`)、卡牌追蹤警示 (`Watchlist`)。
   - 刪除其每月卡牌掃描的紀錄檔與照片快取。
2. **掃描配額計數器 (Quota Counter — Deleted)**：
   - 刪除該用戶所有 Redis 配額 Key（`user:{userId}:scans:{YYYY-MM}`，含歷史月份）與 `scan_request_id` 狀態機紀錄。
   - 由於 quota 以 internal user 為 key，帳號刪除後即無殘留；同一人日後重新註冊為新 internal user，配額從 0 起算。
3. **訂閱 Entitlement 與 Provider Mapping (Unlinked / Deleted)**：
   - 刪除 §4.1 的 identity mapping 列（`provider` / `provider_subject` / `store_app_account_token`），解除 internal user 與 Apple / Google / Web identity 的連結。
   - 刪除掛在該 internal user 的 `subscriber` entitlement 與到期狀態。
   - **注意**：帳號刪除不等於取消 Store 訂閱；UI 需明確提示用戶「刪除帳號不會自動停止 App Store / Google Play 的扣款，請另至商店取消訂閱」，避免持續計費爭議。
   - 未來若採第三方中介（§4.2 選項 A），亦需同步發出刪除/解除連結請求，移除中介端對該用戶的對應。
4. **交易憑證 (Anonymized & Retained)**：
   - 為配合會計與稅務稽核，Store 購置發票或收據流水帳依法**保留**、不可刪除。
   - **處置方式**：將交易記錄匿名化，移除所有可追蹤欄位與 provider identity，並將 `user_id` 指向共用虛擬匿名 ID（如 `deleted-user-placeholder-000`），僅保留交易金額、時間與國家資訊，且無法反查回原 internal user。

---

## 🧪 7. QA 測試計劃 (QA Test Cases)

為三種主要角色編寫的功能驗證測試方案如下：

### 測試案例 1：訪客身分驗證 (Guest Path)
- **前提條件**：剛下載 App，未登入 Google/Apple。
- **步驟**：
  1. 點擊 "以訪客身份探索" 進入主頁。
  2. 嘗試點擊導航欄上的「掃描卡牌」。
- **預期結果**：
  - App 應正確引導，不可開啟相機，彈出 Onboarding 登入畫面。
  - 在卡片搜尋頁面可以看見基本卡價，但點入卡片詳情頁時，價格趨勢區塊需顯示「鎖定」遮罩。

### 測試案例 2：免費登入用戶配額極限測試 (Free User Quota Gate)
- **前提條件**：已登入 Apple 帳號，未訂閱。
- **步驟**：
  1. 點擊「掃描卡牌」，進行第一次掃描。
  2. 確認進度條顯示 `本月掃描額度：99 / 100`。
  3. （測試專用後端後門）修改後端 Redis 計數器將該帳號掃描次數設定為 `99`。
  4. 回到 App 再次掃描一張卡牌。
  5. 辨識成功後，確認配額顯示變為 `0 / 100`。
  6. 嘗試進行第 101 次掃描。
- **預期結果**：
  - 第 101 次點擊掃描時，App 立刻彈出「額度已達上限」的 Block Modal。
  - 後端 API 應對此請求返回 429 狀態碼。

### 測試案例 3：訂閱解鎖測試 (Subscriber Full Unlock)
- **前提條件**：已登入 Google 帳號，並在設定中點擊模擬購買「月費訂閱」成功。
- **步驟**：
  1. 確認 ScanScreen 上的配額計數器進度條消失，顯示為「♾️ 無限配額」。
  2. 連續進行 5 次卡牌掃描，確認皆能正常回傳結果。
  3. 進入任意卡片詳情頁（例如 `hBP04-001`）。
- **預期結果**：
  - 卡牌詳情頁的「價格趨勢分析」與「歷史走勢折線圖」完整解鎖顯示，無任何模糊遮罩。
  - 可正常使用所有 Premium 功能。
