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
| Google 登入介面（尚未接線） | `src/services/auth/googleAuth.ts` |
| 統一 auth service + 帳號刪除 API 呼叫 | `src/services/auth/index.ts` |
| Session store（zustand + persist） | `src/stores/authStore.ts` |
| 登入畫面 + Apple 原生按鈕 | `src/screens/AuthScreen.tsx` |
| 登入 gate（iOS 強制登入） | `src/navigation/AppNavigator.tsx` |
| 登出 / 刪除帳號 UI | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/lib/apple-token-store.ts` |
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

## Google 登入設定（DIC-665，Android 第一優先）

`src/services/auth/googleAuth.ts` 已用 **expo-auth-session（Authorization Code + PKCE）** 接線，回傳與 Apple 相同形狀的 `AuthSession`：`user.id` = Google `sub`、`identityToken` = Google `id_token`。Android / iOS 走系統 Custom Tabs / Safari（非 WebView，符合 Google 對 embedded webview 的封鎖）。

只差「外部憑證」即可運作——**程式碼本身不需再改**：

1. **Google Cloud Console**（同一 GCP 專案，皆為公開值、可入 repo）：
   - **Web client** — Web 登入 + 作為 mobile 後端驗證 `id_token` 的 audience。
   - **iOS client** — Bundle ID `com.dicoge.holohunter`。
   - **Android client** — Package `com.dicoge.holohunter` + **每一把會簽 app 的 keystore SHA-1**：
     - EAS build keystore：`eas credentials`（Android → 對應 profile）。
     - 本機 debug：`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`。
     - **Google Play App Signing 憑證**（Play Console → App integrity）—最常漏，漏了會「開發版能登入、上架版失敗」。建議 SHA-1 + SHA-256 都登。
2. 設定環境變數（見 `.env.example`）：`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`、`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`、`EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`。缺該平台專用值時退回 Web client。備妥後 `isGoogleAuthConfigured()` 於該平台回 `true`。
3. **Redirect URI**：native 使用「反轉 client id」自訂 scheme `com.googleusercontent.apps.<id>:/oauthredirect`（Google installed-app client 允許的 redirect，程式自動由 client ID 推導）。此 scheme **無需**額外註冊進 `app.json`——expo-auth-session 於流程期間自行處理；Web 則用網站 origin 作 redirect（需在 Web client 授權 redirect 清單登記）。
4. **需 dev client / 正式 build**（已裝 `expo-dev-client`）：原生瀏覽器流程無法在 Expo Go 測試；`app.json` 的 Android `package` 與 iOS `bundleIdentifier` 已就緒（`com.dicoge.holohunter`）。
5. Web 的登入 gate（`AppNavigator.tsx` 的 `REQUIRE_AUTH`）如需全平台強制登入再一併調整（Web Google 屬 DIC-663）。

> 備選方案（未採用）：`@react-native-google-signin/google-signin` 原生 SDK（見 `docs/Auth-Google-Login-Design.md` 交付 D/E/F）UX 較佳且直接回 `idToken`，但需新增原生模組 + config plugin + 重新 build。本次選 expo-auth-session：已安裝、純 JS/TS 可靜態驗證、不動原生建置。若 Android 瀏覽器 redirect 於實機遇到 `redirect_uri_mismatch`，再評估切換原生 SDK。

## Android Google 驗證 checklist

- [ ] EAS 以 dev/preview profile 重新建置（原生瀏覽器流程無法在 Expo Go 測試）。
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
