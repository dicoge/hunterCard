# Android 原生 Google 登入（classic play-services-auth Google Sign-In）

對應 issue **DIC-665**。本文件記錄 Android 原生 Google 登入的實作、設定與 QA 驗收；與 `docs/Auth-Google-Login-Design.md`（整體設計、交付 D/F）互補。

## 為什麼改走原生（而非瀏覽器 PKCE）

main 先前的 Android Google 登入是靠 `src/services/authService.ts` 落入 `obtainWebIdToken()` 的 `expo-auth-session` + Custom Tabs PKCE 流程 —— 能運作，但 UX 較差（跳出瀏覽器分頁）、且沒有 standalone Android 真機證據。產品優先序為 **HoloHunter Android / Google Play Internal first**，因此改採 `@react-native-google-signin/google-signin`（v16）的 **classic `GoogleSignin`（play-services-auth 為底）** 原生登入，直接在 App 內完成，回傳可被後端驗證的 `idToken`。

> **契約澄清（DIC-920 CR）**：此路徑是 **classic play-services-auth**，**不是 Credential Manager**。本套件 v16 只匯出 classic `GoogleSignin`，其 `signIn()` **無法帶入 OIDC nonce**，因此 Android ID token 沒有 client 端 nonce 綁定。防重放改由**後端單次使用**保證（見下方「Replay 防護」）。日後若要遷移到真正的 Credential Manager + nonce，需升級套件並改寫 adapter，再以真機驗收。

**server-authoritative 不變**：client 只負責取得 provider `idToken`，身份解析（login-or-create、identities、collision）與 session 全部在後端 `POST /api/auth/login` → `api/_lib/verify-token.ts` 完成。client 端從不自行判定登入成功。

## 平台分流（明確、可測試）

`src/services/authStrategy.ts` 以純函式決定登入 surface，`authService.ts` 據此 dispatch：

| 平台 | Google surface | 實作 |
|------|----------------|------|
| iOS | `native-ios` | `obtainGoogleNativeIdToken`（iOS OAuth client + reversed-client-id，PKCE） |
| Android | `native-android` | `obtainGoogleNativeIdTokenAndroid`（classic play-services-auth `GoogleSignin`） |
| Web | `web` | `obtainWebIdToken`（瀏覽器 PKCE） |

iOS / Web 路徑**完全未改動**，不退化。`scripts/test-auth-strategy.cjs` 鎖定「Android 不得回落到 `web`」這個回歸點。

## Client id 的角色（皆為公開值，非 secret）

| Env | 角色 |
|-----|------|
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | **Web/server client**。作為 Android 原生登入的 `webClientId` 傳給 library，使回傳 `idToken` 的 `aud` = Web client —— 正是後端驗證的 audience。後端要能接受 Android/web 登入就必須設定它。 |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | iOS 原生 client（reversed-client-id URL scheme）。 |
| `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | 專屬 Android OAuth client（package + SHA-1）。**只在 Google Console 授權原生流程用，不會在 runtime 傳給 App**（library 用上面的 Web client id）。後端額外把它列入接受的 audience 作 defense-in-depth。 |

Client ID 已由 PM 存於 GitHub secrets（Google Cloud project `holohunter-505007`、OAuth branding、Web client、第一位 test user 均已於 2026-08-09 完成）。程式碼**不硬編任何 client id 或 secret**，一律讀 env。

後端接受的 Google audience 清單見 `api/_lib/verify-token.ts` 的 `googleAudiences()`；`scripts/test-verify-token.cjs` 以真 RS256 簽章驗證 Web-client 與 Android-client aud 皆被接受、錯誤 aud 被拒。

## 取消 / 錯誤 / fail-closed

`obtainGoogleNativeIdTokenAndroid` 對每種結果都給明確、fail-closed 的處理：

- **使用者取消**：v13+ 回傳 `{ type: 'cancelled' }`（舊版丟出 `SIGN_IN_CANCELLED` / `12501` / `-5`）→ 皆轉成 `已取消登入`，不視為成功。
- **Play 服務不可用/需更新**：`hasPlayServices` 失敗 → `此裝置的 Google Play 服務不可用或需更新`。
- **未拿到 idToken**：→ `Google 未回傳 id_token`，不進入登入狀態。
- **Web client id 未設定**：→ `client_id_missing`（500），因為沒有可被後端驗證的 audience。

只有在後端 `/api/auth/login` 回 2xx 時，`authStore` 才會標記為已登入。

### 診斷代碼（DIC-1318）

`v21 Closed Test` 真機回報「Google 帳號登入無法完成」時，先前的 handler 把每一種非取消的 `signIn()` 失敗都收斂成同一個 `google_failed` banner，Play App Signing SHA-1 未授權（release 特有症狀）與網路瞬斷在畫面上長得一樣。現在每一種 SDK 狀態都會保留為一個獨立、可截圖回報的 machine code，`friendlyAuthErrorMessage` 也各給不同文案。回歸鎖在 `scripts/test-google-native-android.cjs` + `scripts/test-auth-error-map.cjs`。

| SDK code（v16 classic） | AuthError.code | 使用者文案（節錄） | 常見成因 |
|-------------------------|----------------|--------------------|----------|
| `DEVELOPER_ERROR` / `10` | `google_developer_error` | 「Google 登入失敗（google_developer_error）：此版本簽章可能未在登入服務授權。」 | **本卡最可能的成因**：Play App Signing 憑證 SHA-1 尚未登入 Google Cloud Console 的 Android OAuth client（下節「SHA-1 / Play App Signing」）；package name 與 client 不符；或 client 被停用。 |
| `NETWORK_ERROR` | `network_error` | 「網路連線異常，請檢查網路後再試。」 | 網路瞬斷 / Play services 不可及。 |
| `IN_PROGRESS` | `google_in_progress` | 「目前已有 Google 登入進行中，請稍候或關閉重試。」 | UI 連點兩下、或前一次 `signIn()` 未結束就再次點擊。 |
| `INTERNAL_ERROR` / `8` | `google_internal_error` | 「Google 登入服務暫時異常（google_internal_error），請稍後再試。」 | Google Play services 內部錯誤，通常重試即可。 |
| `SIGN_IN_REQUIRED` / `4` | `google_sign_in_required` | 「Google 登入尚未就緒，請再點一次登入按鈕。」 | 帳號未就緒 / 需要互動流程。 |
| `PLAY_SERVICES_NOT_AVAILABLE` | `play_services_unavailable` | 「此裝置的 Google Play 服務不可用或需更新，無法使用 Google 登入。」 | Play services 缺失或版本過舊。 |
| 其他（未列舉） | `google_failed` | 「Google 登入失敗，請再試一次。」 | 通用 fallback，維持先前行為。 |

使用者截圖回報時看到 `google_developer_error`，優先檢查 **Play App Signing SHA-1** 是否已登入 `com.dicoge.holohunter` 的 Android OAuth client；`google_internal_error` 幾乎都是重試即可解決；`network_error` 交給使用者自行檢查網路。

**機密安全**：AuthError.code 是編譯期字串常量，`authErrorMessages.ts` 只 whitelist 這些 code 對應到固定文案，`friendlyAuthErrorMessage` 從不回顯 raw provider message，因此帳號 email / id_token 不會流到畫面。`scripts/test-auth-error-map.cjs::testNeverEchoesRawMessage` 鎖這條線。

## 建置時注入 Web client id（DIC-920 blocker 1）

runtime 的 `client_id_missing` 之所以會發生，是因為 build 沒把 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`（`EXPO_PUBLIC_*` 於打包時 inline）帶進 App。修正：

- **EAS profiles**（`eas.json`）：`development` / `preview` / `production` 皆加上 `"environment"`，讓 EAS 載入該環境的**公開** env var（含 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`，此為公開 OAuth client id，非 secret）。PM 需在對應 EAS environment 設定此公開值。
- **Android CI build**（`.github/workflows/build-android.yml`）：prebuild 與 gradle 步驟從 GitHub secret 注入 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`，並設 `ASSERT_GOOGLE_WEB_CLIENT=1`。
- **build-time fail-closed 斷言**（`app.config.js`）：Android build（`EAS_BUILD_PLATFORM=android` 或 `ASSERT_GOOGLE_WEB_CLIENT=1`）若缺此值即 **build 失敗**，把「靜默的 runtime 登入失敗」變成「明顯的 build 失敗」。iOS / web export / 本機 `expo start` 不受影響。
- **後端 audience 對齊**：`api/_lib/verify-token.ts` 的 `googleAudiences()` 已包含 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` 與 `GOOGLE_WEB_CLIENT_ID`，故 aud=Web client 的 Android token 直接被接受（後端另需在 Vercel 專案 env 設定同一 Web client id）。

## 建置需求（原生模組）

- `@react-native-google-signin/google-signin` 是原生模組：**不能用 Expo Go**，需 dev-client 或 EAS build；加套件後必須**重新 build**（JS OTA 不會帶入原生設定）。
- library 在 Android 端透過 autolinking 納入，classic Google Sign-In 不需額外 URL scheme。**未加該套件的 Expo config plugin**：其 plugin 主要作用是替 iOS 註冊 GoogleSignin URL scheme，而本專案 iOS 走 `expo-auth-session`，不使用該原生 library；為避免更動 / 退化既有 iOS 設定，暫不引入 plugin。日後若要讓 iOS 也改用原生 library，再加 plugin 並帶入 `iosUrlScheme`（見 `Auth-Google-Login-Design.md` 交付 E）。
- import 為 **lazy dynamic import**，且只在 Android 分支（`obtainGoogleNativeIdTokenAndroid` / `signOutNativeGoogle`）呼叫。**準確說法（DIC-920 CR 修正）**：這是 *runtime* 保證 —— iOS / web 執行路徑永遠不會 `import()` 該原生模組，因此不會在 iOS/web 上載入或崩潰；套件本身沒有 web 實作。但這**不等於**「bundler 一定會把它從 web export 中完全 tree-shake 掉」；先前文件宣稱「web export 不含 native package」並不精確，已更正。真正的保證是「iOS/web 不執行、不依賴該模組」，而非「打包器保證剔除」。

## Replay 防護（classic 路徑無 nonce 的補償）

classic `GoogleSignin.signIn()` 無法帶入 OIDC nonce，故 Android ID token 缺少 client 端一次性綁定。後端以**單次使用**補上（`api/_lib/token-replay.ts`）：`verifyProviderToken` 在**簽章 / claims 驗證通過後**，以 `SHA-256(idToken)` 為 key 呼叫 KV `SET NX EX`，TTL 綁定 token 的 `exp`。同一 token 第二次提交回 `TOKEN_REPLAYED`（401）。

- **對 happy path 透明**：每次合法登入 / 綁定都會取得**全新** token（新 `iat`/`exp`），單次使用只會擋真正的重放，不影響正常登入或重試。
- **fail-fast**：偽造 / 過期 token 在簽章或 claims 驗證階段就被拒，**不會**寫入 replay marker，也不觸碰 KV。
- **並發安全**：`SET NX` 是原子操作，同一 token 兩個並發請求只有一個成功。
- 涵蓋全 provider（Google web/iOS/Android + Apple），不只 Android。

## 登出 / 換帳號（清除原生 SDK 狀態）

classic `GoogleSignin` 會快取上次登入的帳號。若登出時不清，returning user 無法選第二個 Gmail（第二帳號流程會卡在同一帳號）。因此 `authStore.logout()` 與帳號刪除成功後都會呼叫 `signOutNativeGoogle()`：

- Android-only、lazy import，best-effort：server session 才是權威，SDK 清除失敗（模組不存在 / 無快取帳號）**永不**讓登出報錯。
- iOS / web 為 no-op，且不 import 原生模組。
- 覆蓋測試：`scripts/test-google-signout.cjs`。

## SHA-1 / Play App Signing（最常被漏）

Android OAuth client 以「package + 簽章憑證 SHA-1」授權。package = `com.dicoge.holohunter`。**每一把會簽 app 的 keystore 的 SHA-1 都要登進 Android client**：

1. **Play App Signing 憑證** —— 首次上傳 AAB 後，Play Console → App integrity → App signing key certificate 取得 SHA-1，於 Google Console 的 Android client 補登。**漏掉會導致「開發版能登入、上架版登入失敗」。**
2. EAS build keystore（`eas credentials`）。
3. 本機 debug keystore（若要在 debug build 上測）。

preview / direct APK 若用不同憑證，另建一個 Android client 對應其 SHA-1。

## 驗收（真機證據，QA 用）

依 DIC-665，需在 **Play internal Android 真機**完成並附證據；在此之前本卡維持 `in_review`：

- [ ] 新使用者首次 Google 登入（建立 internal user）。
- [ ] 取消登入（不進入登入狀態、文案正確）。
- [ ] returning user 重登（回到同一 internal user id）。
- [ ] 重開 App / session 復原（`/api/auth/me` 驗證通過）。
- [ ] 登出。
- [ ] 第二個 Gmail 帳號登入 → 對應到不同 internal user（不因 email 誤關聯）。
- [ ] Guest 模式 regression（未登入功能不受影響）。
- [ ] Web / iOS Google 登入 regression（未退化）。
