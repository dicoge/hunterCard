# HoloHunter 登入設定（Sign in with Apple）

本文件說明 iOS「Sign in with Apple」的設定步驟、需要在 Apple Developer 後台配置的項目、環境變數，以及 TestFlight 驗證 checklist。

## 上架 / Production 必填環境變數 checklist（DIC-824）

實機/Production 出現 `Missing client ID for google` 代表對應平台的 env 沒設。**Public client id 走平台 env，不進 git；Apple secrets 只設在 Vercel。** 依平台分別確認：

### Web（Vercel Project → Settings → Environment Variables）

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | ✅ | Web 版 Google 登入必需；缺 → 登入按鈕自動 disable + 顯示「Google 登入尚未開放」。 |
| `EXPO_PUBLIC_GOOGLE_CLIENT_ID` | 選填 | 上一項的 fallback（authService 先讀 WEB，再讀這個）。 |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` / `PUSH_NOTIFY_SECRET` | 既有 | 推播後端（DIC-390），與登入無關但屬同一 Vercel env。 |
| `APPLE_TEAM_ID` / `APPLE_CLIENT_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | Apple 上線前 | `/api/auth/apple/*` 與帳號刪除撤銷所需；未設時後端 fail-closed 回 501。**只設在 Vercel，勿提交。** |

設完 env 後 **需重新 deploy** 才會生效（`EXPO_PUBLIC_*` 於 build 時 inline 進 bundle）。

### iOS / Android（EAS → `eas secret` / `eas.json` build env）

`authService` 依 `Platform.OS` 選 client id（`src/services/googleClientConfig.ts`）：iOS 用 iOS client id、Android 用 Android client id、web 用 web client id；native 缺專屬 id 時才 fallback 到 generic/web。**原生必須用該平台的 client id**——Google 的 web client 只接受 https redirect，把 web id 丟給原生 build 會導致 redirect 失敗（這正是實機「有 env 仍登不了」的原因）。

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | ✅ (iOS) | 原生 iOS OAuth client；redirect 用 reversed-client-id 自訂 scheme（`nativeGoogleRedirectUri`）。缺 → iOS Google 按鈕 disable。 |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | ✅ (Android) | 原生 Android OAuth client。 |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | fallback | native 缺專屬 id 時的最後備援（僅供 dev，不保證原生 OAuth 可完成）。 |

設定：`eas secret:create --scope project --name EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID --value ...`，或放進 `eas.json` 各 profile 的 `env`。改 env 後需重新 EAS build。

> ⚠️ 原生 redirect scheme（reversed client id，例如 `com.googleusercontent.apps.1234-abc`）也要加進 iOS `CFBundleURLSchemes` / app config，實機 OAuth 才會 callback 回 App。設定後需以 EAS dev/preview build 做一次實機 OAuth smoke（Expo Go 無法測原生 redirect）。

### Apple 目前狀態（與後端能力一致）

- Client 端 Apple 登入 **停用**（`APPLE_LOGIN_ENABLED = false`，`src/services/authService.ts`）：client 無法安全驗證 Apple ID token 的簽章/issuer/audience/expiry/nonce。
- 後端 `/api/auth/apple/register` 在 Apple env 或 token store 未就緒時回 **501**（`api/lib/apple-token-store.ts` 仍為 seam）。
- 因此登入頁 **不再放會失敗的 Apple 主按鈕**：改為 disabled + 「即將開放」pill，不會點了才 alert。要重新開放，需先讓後端 ID-token 驗證上線，再把 `APPLE_LOGIN_ENABLED` 設為 `true`。

### 缺 env 時的 UI 行為（本 issue 修正）

- **Google 缺 client id**：按鈕 disable + 灰字「Google 登入尚未開放，請稍後再試」；**不再**顯示紅字 raw env 變數名。Dev（`__DEV__`）保留可點 + 原始 `Missing client ID ... EXPO_PUBLIC_...` 訊息以利除錯。
- **Apple 未就緒**：顯示「即將開放」狀態，而非點擊後才 alert。

## 產品決策

- 只支援 **Apple ID** 與 **Google** 登入，**不提供**自家 Email/密碼。
- Web 版支援 Google 登入。
- iOS 若提供 Google 登入，依 App Store 審查規範 4.8 **必須**同時提供 Sign in with Apple。
- 上架版必須包含：登出、刪除帳號、隱私權政策/資料刪除說明。
- 不提交任何 Apple private key / secrets 進 repo。

## 這個 PR 已包含什麼

| 項目 | 位置 |
| --- | --- |
| Auth service（Google/Apple 流程、可登旗標、缺 env 訊息） | `src/services/authService.ts` |
| Google OAuth client id 依平台選擇（純函式，可單元測試） | `src/services/googleClientConfig.ts` |
| Session store（zustand + persist） | `src/store/authStore.ts` |
| 登入畫面（Google 按鈕依 env 停用、Apple「即將開放」） | `src/screens/LoginScreen.tsx` |
| 登入 gate | `src/navigation/AppNavigator.tsx` |
| 設定頁登入入口 + 登出 / 刪除帳號 UI | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/lib/apple-token-store.ts` |
| 登入時換取並保存 refresh_token | `api/auth/apple/register.ts` |
| 帳號刪除 + Apple token 撤銷後端（用保存的 refresh_token, fail-closed） | `api/auth/delete-account.ts` |
| Google client 選擇單元測試 | `scripts/verify-google-client-selection.mjs`（CI 於 Node 22 執行） |
| App 設定 capability / plugin | `app.json` |

App 行為：所有平台在 `hasHydrated` 後，未登入且非訪客時顯示 `LoginScreen`；登入或選擇訪客後進入主畫面（見 `AppNavigator.tsx` 的 `isAuthenticated || isGuest` 判斷，無平台專屬強制登入旗標）。Google 按鈕在對應平台的 client id 缺少時停用並顯示提示；Apple 目前以「即將開放」呈現（`APPLE_LOGIN_ENABLED = false`，後端 `/api/auth/apple/register` 尚回 501）。

## App 設定（已完成於 `app.json`）

```json
"ios": { "usesAppleSignIn": true },
"plugins": [ "expo-apple-authentication" ]
```

套件：`expo-apple-authentication`（已加入 `package.json`）。修改 native capability 後需重新以 EAS 建置 dev/preview build（Sign in with Apple 是原生功能，Expo Go 無法測試）。

## Apple Developer 後台需要設定的項目

1. **Identifiers → App IDs**：找到 `com.dicoge.holohunter`，勾選 **Sign In with Apple** capability。
2. **重新產生 Provisioning Profile**（或讓 EAS 自動管理 credentials）。
3. 若 Web 版也要 Apple 登入（可選）：另建一個 **Services ID**，設定 Return URLs（Domain + redirect）。
4. **Keys → 建立 "Sign in with Apple" 私鑰（.p8）**：
   - 記下 **Key ID**。
   - 下載 `.p8` 檔（只能下載一次，妥善保存，**勿提交進 repo**）。
5. 記下 **Team ID**（右上角帳號資訊）。

### 後端環境變數（設定於 Vercel，勿提交）

| 變數 | 說明 |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_CLIENT_ID` | Services ID（web）或 app bundle id `com.dicoge.holohunter`（native） |
| `APPLE_KEY_ID` | 上述 .p8 私鑰的 Key ID |
| `APPLE_PRIVATE_KEY` | .p8 內容（含 BEGIN/END，換行以 `\n` 表示） |

未設定完整變數或撤銷未確認成功時 `api/auth/delete-account` 會回非 2xx（含 501），App 端**fail-closed**：不清除本機 session、顯示「刪除尚未完成」並維持登入狀態。

## 帳號刪除 / Apple 撤銷策略（已採用）

### 正確流程（login-time register → stored refresh_token → revoke）

1. **登入當下**：client 拿到 fresh `authorizationCode`，立即 POST `/api/auth/apple/register`（`src/services/auth/index.ts` 的 `registerAppleSession`，best-effort）。後端用它向 `/auth/token` 換 `refresh_token`，以 `userId` 為 key 保存於**伺服器端持久化儲存**（見 `api/lib/apple-token-store.ts`）。
2. **刪除時**：POST `/api/auth/delete-account`，**只帶 `{ provider, userId }`**（不帶 authorizationCode）。後端取出保存的 `refresh_token` 呼叫 `/auth/revoke`，成功後刪除該 user 的資料與 refresh_token。

原因：`authorizationCode` 為**單次使用且短效**，刪除當下通常已失效，因此不可保存它當作日後刪除憑證——必須在登入當下換成長效 `refresh_token`。client 端也**絕不持久化** `authorizationCode`（`authStore` partialize 會剝除）。

### fail-closed 行為

- 後端無法確認撤銷成功（未設定 / 未實作 / 撤銷失敗 / 網路錯誤）→ 回非 2xx。
- client 只有在後端回 `{ ok: true }` 時才清除本機 session（`deleteAccount()` 回 `'deleted'`）；否則回 `'failed'`，維持登入並提示「尚未完成」。避免讓使用者誤以為已刪除但 Apple 授權 / 伺服器資料仍存在。

### ⚠️ 目前限制（non-shipping foundation）

`api/lib/apple-token-store.ts` 目前為**介面樁（seam）**，尚未接後端持久化儲存（refresh_token 是機密，**不可**存入 repo / git-backed storage，需接 Vercel KV / DB 並加密）。因此：

- `/api/auth/apple/register` 在 token store 未實作時回 501 `token_store_not_implemented`（登入不受影響）。
- `/api/auth/delete-account` 取不到保存的 refresh_token → 回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不是成功）。
- 上架前必須完成：實作 `apple-token-store`（真正持久化 + 加密）、於刪除時級聯刪除 / 匿名化使用者資料。Settings 頁已標示此限制。

## Google 登入後續（尚未接線）

1. `npx expo install expo-auth-session expo-web-browser`
2. Google Cloud Console 建立 iOS / Web / Android OAuth client ID。
3. 於 `src/services/auth/googleAuth.ts` 用 `Google.useIdTokenAuthRequest` 換 `id_token`，映射成 `AuthSession`（`isGoogleAuthConfigured()` 回傳 `true`）。
4. Web 的登入 gate（`AppNavigator.tsx` 的 `REQUIRE_AUTH`）改為全平台強制登入。

## iOS / TestFlight 驗證 checklist

- [ ] EAS 以 dev/preview profile 重新建置（Sign in with Apple 無法在 Expo Go 測試）。
- [ ] App ID 已啟用 Sign in with Apple capability，profile 已更新。
- [ ] 首次登入：Apple 彈窗出現，可選擇分享/隱藏 email；成功後進入 App。
- [ ] 首次登入拿到的姓名/email 有保存；**再次登入**（Apple 不再回傳姓名/email）名稱不會消失。
- [ ] 取消 Apple 彈窗不會顯示錯誤、停留在登入頁。
- [ ] 設定頁顯示「以 Apple 登入」與帳號資訊。
- [ ] **登出**後回到登入頁，重開 App 仍為登入頁。
- [ ] **刪除帳號（成功路徑，後端撤銷已上線）**：確認對話框 → 後端撤銷成功 → 顯示「帳號已刪除」→ 本機 session 清除 → 回到登入頁；於 Apple ID 設定中該 App 授權消失。
- [ ] **刪除帳號（fail-closed，後端未設定 / 未實作）**：顯示「刪除尚未完成」→ **仍為登入狀態**、session 未清除，不誤示為已刪除。
- [ ] 「隱私權政策與資料刪除說明」連結可開啟。
- [ ] 在 App Store Connect 填寫隱私權政策 URL 與資料刪除說明。
- [ ] 送審前確認：有 Google 登入的畫面同時提供 Sign in with Apple（規範 4.8）。
