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
| 後端權威登入端點（驗 id_token → 一次性消費 token → 找/建 user → 簽 session） | `api/auth/login.ts`、`api/_lib/{google-auth,user-store,session,login-handler}.ts` |
| 反重放：已驗證 id_token 一次性消費（token 指紋 SET NX） | `api/_lib/replay-guard.ts` |
| 統一 auth service 進入點 + 帳號刪除 API 呼叫 | `src/services/auth/index.ts` |
| provider 登入分派 + 帳號綁定/解綁 fail-closed（未實作 client-side 綁定/解綁） | `src/services/authService.ts` |
| Session store（zustand + persist） | `src/store/authStore.ts` |
| 登入畫面 + Apple 原生按鈕 | `src/screens/AuthScreen.tsx` |
| 登入 gate（iOS 強制登入） | `src/navigation/AppNavigator.tsx` |
| 登出 / 刪除帳號 UI | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/_lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/_lib/apple-token-store.ts` |
| 登入時換取並保存 refresh_token | `api/auth/apple/register.ts` |
| 已驗證帳號刪除（Bearer access token → 刪 identity/user；Apple 撤銷 fail-closed） | `api/auth/delete-account.ts`、`api/_lib/delete-handler.ts` |
| App 設定 capability / plugin | `app.json` |

App 行為：iOS 未登入時顯示 `AuthScreen`（強制登入）。**Android 的原生 Google 登入已接線**（`signInWithGoogle` → 後端 `POST /api/auth/login` → 換 app session），惟需備妥 OAuth client / SHA-1 憑證與環境變數（見下方「Google 登入設定」）才能於裝置上實際登入。目前 `REQUIRE_AUTH`（`AppNavigator.tsx`）尚未於全平台強制登入，故 Web/Android 仍可訪客進入；全平台強制登入待 Web Google（DIC-663）就緒後開啟。

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

Apple 撤銷環境變數未設定完整、或撤銷未確認成功時 `api/auth/delete-account` 會回非 2xx（含 501），App 端**fail-closed**：不清除本機 session、顯示「刪除尚未完成」並維持登入狀態。（Google-only 帳號的刪除不依賴這些 Apple 變數，見下。）

## 帳號刪除策略（已採用）

### 已驗證、伺服器權威的刪除（Bearer access token）

刪除端點 `POST /api/auth/delete-account` **不再信任 client 傳來的 `userId`**（先前版本信任 `body.userId`，可被冒用刪別人帳號）。改為：

1. client 送 `Authorization: Bearer <access_token>`（不帶 body）。後端 `api/_lib/session.ts` **驗簽 + 驗型別（access）**解出 internal `userId`。缺 / 無效 token → 401。`AUTH_SESSION_SECRET` 未設定 → 501 `SESSION_NOT_CONFIGURED`。
2. 後端讀出權威 user，依 linked provider 決定撤銷需求（見 `api/_lib/delete-handler.ts`）：
   - **google**：無 provider 端撤銷需求，直接刪資料。
   - **apple**：以**可重試的 saga** 進行——(1) 撤銷 Apple 授權（App Store 5.1.1(v)，**只撤銷、不刪保存的 refresh token**；撤銷對 Apple 為 idempotent，可安全重試）；撤銷未成功 → fail-closed（不刪、回非 2xx）。(2) 撤銷成功才刪 user 狀態。(3) user 狀態刪除成功**之後**才刪保存的 refresh token（best-effort）。刻意排最後：若 user 刪除失敗，保存的 token 不被清掉，重試時仍能取出重新撤銷＋重刪，帳號不會被永久卡住（stranded）。
3. 刪除後端權威狀態：該 user 的每個 `auth:identity:{provider}:{subject}` 與 `auth:user:{internalId}` 以**單一原子 Redis `DEL`**（`api/_lib/user-store.ts` 的 `deleteUser`，`kv.del(...identityKeys, userKey)`）一起移除。Redis 單執行緒、多鍵 `DEL` 為單一原子指令，故不會出現「身份鍵已刪、user 未刪」的中途失敗而在下次登入分裂帳號；`DEL` 失敗時所有鍵維持原狀（回 500），重跑刪除即可補完（idempotent、可安全重試）。刪除後同一 Google 帳號再登入會被視為**新使用者**（辨識入口 `(google, sub)` 已移除）。
4. client 端 `src/services/authService.ts` 的 `deleteAccount(user, tokens)` 唯有收到 **2xx** 才清本機 session；任一步失敗都 throw，store `deleteUserAccount` 據此**維持登入狀態**、不清 session。

> 推播 token（`push:tokens` 等鍵）目前以**裝置 Expo push token 字串**為鍵，尚無 user-id 綁定，故帳號刪除**不**級聯刪除推播訂閱（這是誠實揭露，不是遺漏）；需在推播訂閱綁定 internal user id 後才能於刪除時一併清除（後續工作）。

### Apple 撤銷（login-time register → stored refresh_token → revoke）

1. **登入當下**：client 拿到 fresh `authorizationCode`，立即 POST `/api/auth/apple/register`（best-effort）。後端用它換 `refresh_token`，以 `userId` 為 key 保存於**伺服器端持久化儲存**（見 `api/_lib/apple-token-store.ts`）。
2. **刪除時**：`delete-handler` 對 apple-linked 使用者呼叫撤銷（取出保存的 `refresh_token` 呼叫 `/auth/revoke`，**只撤銷、不刪 token**），撤銷成功後才原子刪 user 資料，最後才刪保存的 `refresh_token`（saga step 3，見上方刪除策略）。

原因：`authorizationCode` 為**單次使用且短效**，刪除當下通常已失效，必須在登入當下換成長效 `refresh_token`。client 端也**絕不持久化** `authorizationCode`（`authStore` partialize 會剝除）。

### ⚠️ 目前限制（Apple 撤銷仍為 non-shipping foundation）

`api/_lib/apple-token-store.ts` 目前為**介面樁（seam）**，尚未接後端持久化儲存（refresh_token 是機密，**不可**存入 repo / git-backed storage，需接 Vercel KV / DB 並加密）。因此：

- `/api/auth/apple/register` 在 token store 未實作時回 501 `token_store_not_implemented`（登入不受影響）。
- 對 **apple-linked** 使用者刪除時取不到保存的 refresh_token → 回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不刪資料）。**Google-only 帳號的刪除為 shipping 路徑，不受此限制。**
- 上架前必須完成（Apple）：實作 `apple-token-store`（真正持久化 + 加密）。Settings 頁已標示此限制。

## Google 登入設定（DIC-665，Android 第一優先）

### 架構：native SDK 取 id_token → 後端權威驗證（含 iat 新鮮度）→ 一次性消費 token → 後端簽 session

登入流程由**後端權威**決定身份與 session，client 不再自行 mint 內部 user。反重放採用**與所選 SDK 實際可執行**的合約（不是 token 內嵌 nonce，原因見下方 ⚠️）：

1. **client（native）**：用 **`@react-native-google-signin/google-signin`** 的 **legacy（classic）Google Sign-In**（免費版；**不是** Android Credential Manager，Credential Manager 屬付費 Universal Sign In）的 `GoogleSignin.signIn()`（**不傳 nonce**）取得 Google **`id_token`**。Android 用哪個 OAuth client 是由 **package name + SHA-1 憑證指紋**在 Google Cloud Console 的註冊決定，**不是**由程式指定 Android client id；`configure()` 只帶 **Web client ID** 作 `webClientId`（故 id_token 的 `aud` 一律為 Web client，即後端唯一接受的 audience）。取消彈窗以 `GOOGLE_CANCEL_CODE` 靜默處理，不顯示錯誤。登出以原生 `GoogleSignin.signOut()` 清除快取的 Google 帳號 session（見 `src/services/authService.ts`），**不**把 app 的 session JWT 送往 Google 撤銷端點。
2. **後端** `POST /api/auth/login`（`api/auth/login.ts` → `api/_lib/login-handler.ts`），送 `{ provider:'google', id_token }`：
   - `api/_lib/google-auth.ts` 以 Google JWKS（`https://www.googleapis.com/oauth2/v3/certs`）**驗簽 RS256、驗 `iss` / `aud`（須為伺服器 Web client ID）/ `exp`（含 clock skew）/ `iat`（必要，且不得早於 `MAX_ID_TOKEN_AGE_SEC`=5 分鐘的**新鮮度視窗**）**，取 `sub` 作身份鍵。**不信任** `userinfo.sub`，不接受 null id_token。
   - **一次性消費 id_token（反重放）**：`api/_lib/replay-guard.ts` 以 token 的 SHA-256 指紋為鍵（`auth:used_idtoken:{fp}`）在 KV `SET NX`，TTL 綁 token 剩餘壽命。首次佔用成功才放行；同一 token 再次交換（重放）→ 401 `TOKEN_REPLAYED`，**不建立 user、不簽 session**。
   - `api/_lib/user-store.ts` 以 `(google, sub)` login-or-create（`auth:identity:google:{sub}` NX 佔用 → `auth:user:{internalId}`），internal id 由後端 `crypto.randomUUID()` 產生。身份鍵為 `sub`，**非 email**：email 變更不改歸戶、不同 sub 相同 email 不合併。
   - `api/_lib/session.ts` 以 `AUTH_SESSION_SECRET` 簽 HS256 access（1h）/ refresh（30d）token 回 client。
   - **fail-closed**：`AUTH_SESSION_SECRET` 未設定 → 501 `SESSION_NOT_CONFIGURED`；未設定伺服器 Web client audience → 501 `AUTH_NOT_CONFIGURED`；缺/空 id_token → 400 `MISSING_ID_TOKEN`；驗簽 / iss / aud / exp / iat 新鮮度不符 → 401 `INVALID_TOKEN`；同一 token 重放 → 401 `TOKEN_REPLAYED`（皆不建立 user、不簽 session）。
3. client 收到 `{ user, session:{access_token, refresh_token, expires_in}, is_new_user }` 後，以後端回傳的 `user.internalId` 建立本機 session（`src/store/authStore.ts` / `src/services/authService.ts`）。**不再**產生亂數 internal id、不再信任 localStorage 身份。

> ⚠️ **為何不用 token 內嵌 nonce（誠實揭露）**：真正的 challenge–response nonce 需把 server 發的 nonce 寫進 Google id_token 的 `nonce` claim，這要求原生登入層支援傳入 nonce（Android Credential Manager `setNonce` / One Tap `signIn({ nonce })`）。目前安裝的 **classic** `@react-native-google-signin/google-signin@16.1.4` 的 `GoogleSignin.signIn()` **不接受也不透傳 nonce**（該能力屬付費授權的 **Universal Sign In**）——先前用 TypeScript 型別假裝支援是錯的：後端若要求 token 帶 nonce，會讓**每一次真實裝置登入都 fail-closed 被拒**。因此改用可端到端執行的合約：**嚴格 iat 新鮮度 + 已驗證 id_token 的一次性消費**。限制：這防的是**同一 token 被重放使用**，不等同 nonce 的 channel-binding（無法防禦即時 MITM 搶先第一次使用）；新鮮度視窗把可被重放的時間壓到很短。要達到完整 nonce 綁定需換成支援 nonce 的原生層（後續工作）。

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

- **帳號綁定（linking）/ 解綁（unlinking）/ 跨 provider 合併 / 跨平台身份同步**：**未實作**。`src/services/authService.ts` 的 `linkProvider` 與 `unlinkProvider` 皆為 **fail-closed**（丟出「尚未開放」錯誤），沒有任何 UI 進入點。兩者都必須 server-authoritative（驗 provider token、以 `(provider, sub)` 更新伺服器端身份、保證至少保留一個登入方式、處理唯一性 / 競態），在後端端點就緒前不提供 client-side 綁定 / 解綁，避免以未驗證身份改寫本機而被信任（先前 `unlinkProvider` 直接改寫 localStorage 會與後端身份儲存不一致）。SettingsScreen 僅顯示 `linkedProviders[0]`，不做綁定 / 解綁 / 同步。
- **Web Google 登入**（DIC-663）：`isGoogleAuthConfigured()` 於 web 回 `false`；Web 端與 `AppNavigator.tsx` 的 `REQUIRE_AUTH` 全平台強制登入待該卡處理。
- **Android 上的 Apple 登入**：見 `docs/Android-Apple-Login-Feasibility.md`（可行性評估，本階段不實作）。
- **完整 nonce channel-binding**：目前反重放為 iat 新鮮度 + id_token 一次性消費（見上方 ⚠️）。要達到 nonce 綁定需換成支援傳入 nonce 的原生層（Universal Sign In / Credential Manager `setNonce`），屬後續工作。

## Android Google 驗證 checklist

- [ ] EAS 以 dev/preview profile 重新建置（`@react-native-google-signin` 為原生模組，無法在 Expo Go 測試）。
- [ ] Android OAuth client 已登錄「當前 build 對應 keystore」的 SHA-1（dev / EAS / Play App Signing）。
- [ ] `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`（或退回 Web client）已設定；`isGoogleAuthConfigured()` 回 `true`、按鈕可用。
- [ ] **新 user**：Google 帳號選擇器出現 → 授權 → 建立新 internal user → 進入 App。
- [ ] **returning user**：同一 Google 帳號再次登入 → 對應同一 internal user（比對 `sub`，非 email）。
- [ ] provider email 變更 / 與其他 provider 不同 email → 不造成錯誤帳號關聯（身份鍵為 `sub`）。
- [ ] 同一 id_token 重放交換第二次 → 後端回 401 `TOKEN_REPLAYED`（不建立 user、不簽 session）。
- [ ] 取消 Google 彈窗（`GOOGLE_CANCEL_CODE`）不顯示錯誤、停留登入頁。
- [ ] **刪除帳號（Google，成功路徑）**：確認對話框 → 帶 access token 呼叫 `/api/auth/delete-account` → 後端 2xx → 清本機 session → 回登入頁；再以同一 Google 帳號登入被視為**新 user**（`auth:identity:google:{sub}` 已移除）。
- [ ] **刪除帳號（fail-closed）**：後端回非 2xx（無效 token / 未設定）→ 顯示失敗、**維持登入**、session 未清除。
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
