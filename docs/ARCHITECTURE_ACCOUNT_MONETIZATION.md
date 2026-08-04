# HoloHunter 帳號 / 權限 / 營利 架構設計

本文件承接 `docs/AUTH_SETUP.md`（Sign in with Apple 基礎，PR #51），設計「共通帳號 + 角色權限 + 掃描 quota + 訂閱 premium」的**擴充架構**。

> 現階段目標：**先把登入之後的擴充架構設計清楚並落成任務**，不一定立刻實作金流。IAP/Stripe 屬後續。
> 限制：不使用 Copilot、不使用 OpenRouter；iOS/Android 訂閱須符合 App Store / Google Play 規範。

---

## 1. 共通帳號 / 身份模型（Identity）

### 1.1 原則
- **internal user id 是唯一身份**，不是 email。
- Email 可能被 Apple Private Relay 隱藏，或不同 provider 不一致 → **email 不可當唯一鍵**。
- 一個 HoloHunter 使用者可綁定多個 OAuth provider（Google + Apple）。

### 1.2 資料模型（後端）
```
users
  id            uuid  (internal user id, PK)
  display_name  text?
  created_at    timestamptz
  deleted_at    timestamptz?          -- 軟刪除 / 匿名化用

auth_identities                       -- linked_auth_providers
  id            uuid PK
  user_id       uuid FK -> users.id
  provider      text   ('google' | 'apple')
  subject       text   -- provider 的穩定 id（Apple: sub/user；Google: sub）
  email         text?  -- 僅供顯示，非鍵
  created_at    timestamptz
  UNIQUE(provider, subject)           -- 同一 provider 帳號只能綁一個 user
```
使用者資料（收藏 / 設定 / watchlist / push token）一律以 `user_id` 為外鍵，登入時以 `(provider, subject)` 查 `auth_identities` → 得到 `user_id`。

### 1.3 綁定 / 衝突 / 解綁
- **綁定 (link)**：已登入使用者用「加綁」流程再走一次另一個 provider OAuth，成功後寫入一筆 `auth_identities`（同 `user_id`）。
- **Provider collision**：若欲綁定的 `(provider, subject)` 已屬於**另一個** user：
  - 預設**拒絕**並提示（避免誤合併造成資料外洩）。
  - 提供明確的「合併帳號」流程：需兩邊都能通過驗證（重新登入兩個 provider）才可合併，合併方向與保留資料需二次確認。
  - 合併為高風險操作，先設計流程與確認 UI，不做自動合併。
- **解綁 (unlink)**：可移除一筆 identity，但**至少保留一個**登入方式（後端與 UI 皆需擋）。
- 客戶端目前 `AuthSession`（單一 provider）→ 後續改為以 `user_id` 為主、`linkedProviders: AuthProvider[]` 表示已綁定清單。

### 1.4 各平台 provider 策略
| 平台 | Google | Apple |
| --- | --- | --- |
| iOS | ✅ | ✅（已實作 PR #51；有 Google 就必須有 Apple，規範 4.8） |
| Android | ✅（優先） | 可評估、非第一優先 |
| Web | ✅ | 盡量提供（見 1.5） |

### 1.5 Web Apple 登入（採 Firebase / Supabase 時）
Web 的 Sign in with Apple 走 OAuth redirect，需在 Apple Developer 設定：
- **Services ID**（有別於 app 的 App ID），作為 Web 的 client_id。
- **Return / Redirect URI**：指向 Firebase/Supabase 的 callback（例如 `https://<project>.firebaseapp.com/__/auth/handler`）。
- **Domain verification**：於 Apple 後台登記網域並上傳 `apple-developer-domain-association.txt`。
- 對應的 Sign in with Apple **私鑰 (.p8)** 設定於 Firebase/Supabase provider（勿進 repo）。

---

## 2. 權限模型（RBAC）：guest / free_user / subscriber

### 2.1 角色與能力矩陣
| 能力 | guest | free_user | subscriber |
| --- | --- | --- | --- |
| 看規則教學 / 查卡片 | ✅ | ✅ | ✅ |
| 卡片掃描 | ❌ | ✅（每月上限 100） | ✅（無上限） |
| 價格預測 / 趨勢預測 / 進階市場數據 | ❌ | ❌ | ✅ |

- `guest` = 未登入；`free_user` = 已登入未訂閱；`subscriber` = 已登入且訂閱有效。
- **判定來源以後端為準**（entitlement）：訂閱狀態、quota 都不能只信客戶端。
- 客戶端提供 `useEntitlements()` 之類的 selector：`{ role, canScan, scanRemaining, canViewPremium }`，值來自後端同步 + 本機快取（快取僅供 UX，不作為授權依據）。

---

## 3. 掃描 Quota（free_user 每月 100）

- **每月重置 100**，以 UTC 或使用者時區的月界重置（建議記 `period = YYYY-MM`）。
- **Server-authoritative**：掃描前（或掃描結果落地時）呼叫後端 `POST /api/scan/consume`，由後端原子遞增並回傳剩餘數；達上限回 429 + `scanRemaining: 0`。
- **防竄改**：
  - 不把「剩餘數」存在可被使用者改的本機值當授權依據；本機只快取顯示。
  - 計數綁 `user_id`（登入才可掃描，guest 無 quota 因為不能掃）。
  - 後端記 `scan_usage(user_id, period, count)`，UNIQUE(user_id, period)。
- 客戶端：`scanQuotaStore`（快取 remaining + period）＋ 掃描流程在成功辨識後呼叫 consume；離線時樂觀顯示，連線後對帳。

---

## 4. 訂閱（Subscription）

> 設計優先，先不接金流。以下為架構與規範注意。

- **iOS / Android**：一律用平台 IAP subscription（Apple StoreKit / Google Play Billing）。**不可**用外部金流繞過（Apple 3.1.1 / Play Billing 政策）。
  - 後端做 **receipt / purchase token 驗證**（App Store Server API、Play Developer API），並存 `subscriptions(user_id, platform, product_id, status, expires_at, latest_token)`。
  - 處理續訂 / 取消 / 退款的 server 通知（App Store Server Notifications、Play RTDN）。
- **Web**：若要付費，另評估 **Stripe**；也可先不做（Web 僅 free/guest 能力，premium 只在 App 內購買後跨端同步）。
- **entitlement 來源**：`subscriptions.status == active && expires_at > now` → `subscriber`。

---

## 5. Premium Gate（價格預測 / 趨勢預測）

- 受管內容目前對應模組：`src/store/trendStore.ts`、`src/services/priceHistory.ts`、`src/components/PriceTrend.tsx` / `PriceTrendBadge.tsx`。
- Gate 策略：
  - **資料層**：premium 預測資料的 API 需帶 entitlement 檢查，後端對非 subscriber 不回傳（避免只靠前端隱藏）。
  - **UI 層**：非 subscriber 顯示 `PremiumLock`（模糊 / 鎖 icon + 升級 CTA），而非直接隱藏，兼顧轉換。

---

## 6. 首頁 / Onboarding Flow

- App 入口提供三個動作：**登入**、**註冊**（實際同 OAuth，無自家帳密）、**訪客進入**。
- 訪客進入 → 直接進 App，但掃描 / premium 觸發時導向登入 / 升級。
- iOS 目前為強制登入 gate（PR #51 的 `REQUIRE_AUTH`）；導入訪客模式後改為「可訪客進入，但 gate 在功能點」。

---

## 7. UI 元件

- **掃描剩餘數**：掃描頁 / 設定頁顯示「本月剩餘 N / 100」。
- **達上限提示**：掃描被擋時的 modal + 升級 CTA。
- **升級訂閱 CTA**：訪客/free 觸發 premium 或超 quota 時。
- **PremiumLock**：premium 內容覆蓋層。
- **帳號綁定 UI**：設定頁顯示已綁 provider、加綁 / 解綁（保留≥1）。

---

## 8. 隱私權政策 / 商店文案（需同步揭露）

- 揭露：**有帳號**（OAuth 身份）、**有訂閱**（購買紀錄）、**有使用量 / quota 紀錄**（scan_usage）。
- **刪除帳號**需級聯刪除 / 匿名化：
  - `users` + `auth_identities`（provider link）
  - 使用者資料（收藏 / 設定 / watchlist / push token）
  - `scan_usage` / quota
  - `subscriptions` mapping（保留法遵/財務必要的交易紀錄時需**匿名化**，切斷與 user_id 的關聯）
  - Apple 授權撤銷：採 **login-time register → 後端保存 refresh_token → 刪除時 revoke**（`api/auth/apple/register.ts` + `api/auth/delete-account.ts`）。不使用短效 authorizationCode 當刪除憑證。撤銷未確認成功時 **fail-closed**，不清本機 session、不誤示為已刪除。refresh_token 持久化（`api/_lib/apple-token-store.ts`）目前為 seam，上架前需接加密儲存並級聯刪除使用者資料。
- App Store Connect / Play Console 的資料安全表單需與實際收集一致。

---

## 9. 客戶端擴充架構（如何疊在現有 auth 上）

- `AuthSession` → 以 `user_id` 為核心，新增 `linkedProviders`、`role`、`entitlements`。
- 新增 store：`entitlementStore`（role/訂閱/quota 快取，來源為後端）、`scanQuotaStore`。
- `useEntitlements()` selector 供 UI 判斷 `canScan / scanRemaining / canViewPremium`。
- 授權判斷一律「**後端為準、前端只做 UX**」。

---

## 10. QA 測試矩陣（guest / free_user / subscriber）

| 案例 | guest | free_user | subscriber |
| --- | --- | --- | --- |
| 看規則 / 查卡 | 可 | 可 | 可 |
| 掃描（未達上限） | 擋→導登入 | 可，剩餘數 -1 | 可，無上限 |
| 掃描（達 100） | N/A | 擋→升級 CTA | 可 |
| Premium 預測 | 擋→升級 | 擋→升級 | 可 |
| 月界重置 | N/A | 重置為 100 | N/A |
| 綁定第二 provider | N/A | 可，歸同 user_id | 可 |
| 解綁到剩 1 個 | N/A | 擋 | 擋 |
| 刪除帳號 | N/A | 級聯刪除 | 級聯刪除 + 訂閱匿名化 |
| 本機竄改 quota | N/A | 後端仍擋 | N/A |

---

## 11. 分階段實作計畫

對應在 DIC-648 下建立的 backlog 子議題（預設不自動啟動，供排序後再推進）：

- **Stage 1 基礎**：身份模型（users + auth_identities）、權限模型 guest/free/subscriber + entitlement service。
- **Stage 2 登入擴充**：Web Google + Web Apple、Mobile Google、帳號綁定/解綁/collision merge、首頁 Onboarding flow。
- **Stage 3 營利（設計優先）**：掃描 quota、訂閱整合（IAP / Stripe 評估）、Premium gate + UI。
- **Stage 4 合規 & QA**：隱私權政策 / 商店文案 + 刪除帳號級聯、guest/free/subscriber QA 矩陣。
