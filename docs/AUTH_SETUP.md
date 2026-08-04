# HoloHunter 登入設定（Sign in with Apple）

本文件說明 iOS「Sign in with Apple」的設定步驟、需要在 Apple Developer 後台配置的項目、環境變數，以及 TestFlight 驗證 checklist。

## 產品決策

- 只支援 **Apple ID** 與 **Google** 登入，**不提供**自家 Email/密碼。
- Web 版支援 Google 登入。
- iOS 若提供 Google 登入，依 App Store 審查規範 4.8 **必須**同時提供 Sign in with Apple。
- 上架版必須包含：登出、刪除帳號、隱私權政策/資料刪除說明。
- 不提交任何 Apple private key / secrets 進 repo。

## 這個 PR 已包含什麼

| 項目 | 位置 |
| --- | --- |
| Apple 登入原生流程 | `src/services/auth/appleAuth.ts` |
| Google 原生登入 + 後端換 session（已接線） | `src/services/auth/googleAuth.ts` |
| 後端權威登入端點（消費 nonce → 驗 id_token → 找/建 user → 簽 session） | `api/auth/login.ts`、`api/_lib/{google-auth,user-store,session,login-handler,nonce-store}.ts` |
| server-bound 一次性 nonce 挑戰端點（防重放） | `api/auth/nonce.ts`、`api/_lib/nonce-store.ts` |
| 統一 auth service 進入點 + 帳號刪除 API 呼叫 | `src/services/auth/index.ts` |
| provider 登入分派 + 帳號綁定 fail-closed（未實作 client-side 綁定） | `src/services/authService.ts` |
| Session store（zustand + persist） | `src/store/authStore.ts` |
| 登入畫面 + Apple 原生按鈕 | `src/screens/AuthScreen.tsx` |
| 登入 gate（iOS 強制登入） | `src/navigation/AppNavigator.tsx` |
| 登出 / 刪除帳號 UI | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/_lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/_lib/apple-token-store.ts` |
| 登入時換取並保存 refresh_token | `api/auth/apple/register.ts` |
| 帳號刪除 + Apple token 撤銷後端（用保存的 refresh_token, fail-closed） | `api/auth/delete-account.ts` |
| App 設定 capability / plugin | `app.json` |

App 行為：iOS 未登入時顯示 `AuthScreen`（強制登入）；Web/Android 因 Google 尚未接線，暫以訪客模式進入（旗標 `REQUIRE_AUTH` 於 `AppNavigator.tsx`）。

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

1. **登入當下**：client 拿到 fresh `authorizationCode`，立即 POST `/api/auth/apple/register`（`src/services/auth/index.ts` 的 `registerAppleSession`，best-effort）。後端用它向 `/auth/token` 換 `refresh_token`，以 `userId` 為 key 保存於**伺服器端持久化儲存**（見 `api/_lib/apple-token-store.ts`）。
2. **刪除時**：POST `/api/auth/delete-account`，**只帶 `{ provider, userId }`**（不帶 authorizationCode）。後端取出保存的 `refresh_token` 呼叫 `/auth/revoke`，成功後刪除該 user 的資料與 refresh_token。

原因：`authorizationCode` 為**單次使用且短效**，刪除當下通常已失效，因此不可保存它當作日後刪除憑證——必須在登入當下換成長效 `refresh_token`。client 端也**絕不持久化** `authorizationCode`（`authStore` partialize 會剝除）。

### fail-closed 行為

- 後端無法確認撤銷成功（未設定 / 未實作 / 撤銷失敗 / 網路錯誤）→ 回非 2xx。
- client 只有在後端回 `{ ok: true }` 時才清除本機 session（`deleteAccount()` 回 `'deleted'`）；否則回 `'failed'`，維持登入並提示「尚未完成」。避免讓使用者誤以為已刪除但 Apple 授權 / 伺服器資料仍存在。

### ⚠️ 目前限制（non-shipping foundation）

`api/_lib/apple-token-store.ts` 目前為**介面樁（seam）**，尚未接後端持久化儲存（refresh_token 是機密，**不可**存入 repo / git-backed storage，需接 Vercel KV / DB 並加密）。因此：

- `/api/auth/apple/register` 在 token store 未實作時回 501 `token_store_not_implemented`（登入不受影響）。
- `/api/auth/delete-account` 取不到保存的 refresh_token → 回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不是成功）。
- 上架前必須完成：實作 `apple-token-store`（真正持久化 + 加密）、於刪除時級聯刪除 / 匿名化使用者資料。Settings 頁已標示此限制。

## Google 登入設定（DIC-665，Android 第一優先）

### 架構：server nonce → native SDK 取 id_token → 後端權威驗證（含 nonce）→ 後端簽 session

登入流程改由**後端權威**決定身份與 session，client 不再自行 mint 內部 user；且以 server-bound 一次性 nonce **強制**防重放：

1. **client 先取 nonce**：`src/services/auth/googleAuth.ts` 先 `POST /api/auth/nonce` 取一枚 server-bound 一次性 nonce（`api/auth/nonce.ts` → `api/_lib/nonce-store.ts`，存 Vercel KV `auth:nonce:{nonce}`，TTL 300s）。取不到 → fail-closed 不登入。
2. **client（native）**：用 **`@react-native-google-signin/google-signin`**（Android Credential Manager / iOS 原生）取得 Google **`id_token`**，並把上一步的 nonce 傳入 `signIn({ nonce })` 使其寫入 id_token 的 `nonce` claim。以 **Web client ID** 當 `webClientId`（故 id_token 的 `aud` 為 Web client）。取消彈窗以 `GOOGLE_CANCEL_CODE` 靜默處理，不顯示錯誤。
3. **後端** `POST /api/auth/login`（`api/auth/login.ts` → `api/_lib/login-handler.ts`），送 `{ provider:'google', id_token, nonce }`：
   - **原子消費 nonce**：`api/_lib/nonce-store.ts` 以 KV GETDEL 一次性消費該 nonce。缺 nonce → 400 `MISSING_NONCE`；不存在 / 已消費 / 過期 / 偽造 → 401 `NONCE_REPLAYED`，**不再往下驗 token**。
   - `api/_lib/google-auth.ts` 以 Google JWKS（`https://www.googleapis.com/oauth2/v3/certs`）**驗簽 RS256、驗 `iss` / `aud`（須為伺服器 Web client ID）/ `exp`（含 clock skew）/ `nonce`（須與已消費的 nonce 完全相等，token 無 nonce claim 亦拒絕）**，取 `sub` 作身份鍵。**不信任** `userinfo.sub`，不接受 null id_token。
   - `api/_lib/user-store.ts` 以 `(google, sub)` login-or-create（`auth:identity:google:{sub}` NX 佔用 → `auth:user:{internalId}`），internal id 由後端 `crypto.randomUUID()` 產生。身份鍵為 `sub`，**非 email**：email 變更不改歸戶、不同 sub 相同 email 不合併。
   - `api/_lib/session.ts` 以 `AUTH_SESSION_SECRET` 簽 HS256 access（1h）/ refresh（30d）token 回 client。
   - **fail-closed**：`AUTH_SESSION_SECRET` 未設定 → 501 `SESSION_NOT_CONFIGURED`；未設定伺服器 Web client audience → 501 `AUTH_NOT_CONFIGURED`；缺/空 id_token → 400 `MISSING_ID_TOKEN`；缺/空 nonce → 400 `MISSING_NONCE`；nonce 重放 → 401 `NONCE_REPLAYED`；驗簽 / nonce 不符 → 401 `INVALID_TOKEN`（皆不建立 user、不簽 session）。
4. client 收到 `{ user, session:{access_token, refresh_token, expires_in}, is_new_user }` 後，以後端回傳的 `user.internalId` 建立本機 session（`src/store/authStore.ts` / `src/services/authService.ts`）。**不再**產生亂數 internal id、不再信任 localStorage 身份。

> ⚠️ **nonce 原生嵌入相依（實機限制）**：後端的 nonce 比對為**強制**且 fail-closed。要讓 Google 把 nonce 寫進 id_token 的 `nonce` claim，原生登入層必須支援傳入 nonce（Android Credential Manager `setNonce` / One Tap `signIn({ nonce })`）。目前安裝的 **free tier** `@react-native-google-signin/google-signin@16.1.4` 的 `GoogleSignin.signIn` **尚未暴露 nonce 參數**（該能力屬付費授權的 **Universal Sign In**）。client 端已把 nonce 傳入並送後端，一旦改用支援 nonce 的原生路徑即可端到端運作；在此之前後端會正確地 fail-closed 拒絕無 nonce 的 token（實機登入需先補上支援 nonce 的原生層）。

### 需在外部後台設定的憑證與環境變數

1. **Google Cloud Console**（同一 GCP 專案，client ID 皆為公開值、可入 repo）：
   - **Web client** — Web 登入 + 作為 native `webClientId` 與後端驗 `id_token` 的 audience。
   - **iOS client** — Bundle ID `com.dicoge.holohunter`。
   - **Android client** — Package `com.dicoge.holohunter` + **每一把會簽 app 的 keystore SHA-1**（native SDK 依 SHA-1 綁定 client）：
     - EAS build keystore：`eas credentials`（Android → 對應 profile）。
     - 本機 debug：`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`。
     - **Google Play App Signing 憑證**（Play Console → App integrity）—最常漏，漏了會「開發版能登入、上架版失敗」。建議 SHA-1 + SHA-256 都登。
2. 環境變數（見 `.env.example`）：`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`（native `webClientId` + **後端唯一** audience，必要）、`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`、`EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`（後兩者供原生 SDK 平台設定用）。**後端 audience 只接受伺服器 Web client ID**——native SDK 以 `webClientId` 設定，其 id_token 的 `aud` 一律是 Web client；刻意**不**接受 iOS / Android client ID 當替代 audience（那些 client 沒有 client secret，接受它們會擴大可被接受的 token 來源）。未設定 Web client ID 時後端 fail-closed（501 `AUTH_NOT_CONFIGURED`）。備妥 Web client ID 後 `isGoogleAuthConfigured()` 於 native 回 `true`。
3. **後端密鑰**：`AUTH_SESSION_SECRET`（Vercel，勿提交）簽發 app session；未設定則 `/api/auth/login` fail-closed（見上）。使用者 / 身份儲存沿用既有 Vercel KV（`KV_REST_API_*`）。
4. **native SDK 設定**：`app.json` plugins 已加入 `@react-native-google-signin/google-signin`（config plugin）。因是原生模組，**需 dev client / EAS build**（已裝 `expo-dev-client`），**無法**在 Expo Go 測試；`app.json` 的 Android `package` / iOS `bundleIdentifier` 已就緒（`com.dicoge.holohunter`）。
5. **不需**自訂 redirect scheme：native SDK 走系統帳號選擇器直接回 `id_token`，沒有 browser redirect / reversed-client-id URI 需登記。

### 尚未實作（後續設計，非本次 shipping 行為）

- **帳號綁定（account linking）/ 跨 provider 合併 / 跨平台身份同步**：**未實作**。`src/services/authService.ts` 的 `linkProvider` 為 **fail-closed**（丟出「尚未開放」錯誤），沒有任何 UI 進入點。綁定必須 server-authoritative（驗第二 provider token、以 `(provider, sub)` 更新伺服器端身份、處理唯一性 / 競態），在後端端點就緒前不提供 client-side 綁定，避免以未驗證身份寫入本機而被信任。SettingsScreen 僅顯示 `linkedProviders[0]`，不做綁定 / 同步。
- **Web Google 登入**（DIC-663）：`isGoogleAuthConfigured()` 於 web 回 `false`；Web 端與 `AppNavigator.tsx` 的 `REQUIRE_AUTH` 全平台強制登入待該卡處理。
- **Android 上的 Apple 登入**：見 `docs/Android-Apple-Login-Feasibility.md`（可行性評估，本階段不實作）。
- **nonce 原生嵌入**：後端 nonce 驗證已強制上線，但 free tier Google Sign-In 尚無法把 nonce 寫入 id_token（見上方 ⚠️ 說明）；實機端到端登入需先補上支援 nonce 的原生層（Universal Sign In / Credential Manager `setNonce`）。

## Android Google 驗證 checklist

- [ ] EAS 以 dev/preview profile 重新建置（`@react-native-google-signin` 為原生模組，無法在 Expo Go 測試）。
- [ ] Android OAuth client 已登錄「當前 build 對應 keystore」的 SHA-1（dev / EAS / Play App Signing）。
- [ ] `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`（或退回 Web client）已設定；`isGoogleAuthConfigured()` 回 `true`、按鈕可用。
- [ ] **新 user**：Google 帳號選擇器出現 → 授權 → 建立新 internal user → 進入 App。
- [ ] **returning user**：同一 Google 帳號再次登入 → 對應同一 internal user（比對 `sub`，非 email）。
- [ ] provider email 變更 / 與其他 provider 不同 email → 不造成錯誤帳號關聯（身份鍵為 `sub`）。
- [ ] 推播 token 綁定 internal user id，而非 provider email。
- [ ] 取消 Google 彈窗（`GOOGLE_CANCEL_CODE`）不顯示錯誤、停留登入頁。
- [ ] Android Apple 登入：見 `docs/Android-Apple-Login-Feasibility.md`（本階段不實作）。

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
