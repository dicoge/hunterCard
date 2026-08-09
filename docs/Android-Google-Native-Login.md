# Android 原生 Google 登入（Credential Manager / Google Sign-In）

對應 issue **DIC-665**。本文件記錄 Android 原生 Google 登入的實作、設定與 QA 驗收；與 `docs/Auth-Google-Login-Design.md`（整體設計、交付 D/F）互補。

## 為什麼改走原生（而非瀏覽器 PKCE）

main 先前的 Android Google 登入是靠 `src/services/authService.ts` 落入 `obtainWebIdToken()` 的 `expo-auth-session` + Custom Tabs PKCE 流程 —— 能運作，但 UX 較差（跳出瀏覽器分頁）、且沒有 standalone Android 真機證據。產品優先序為 **HoloHunter Android / Google Play Internal first**，因此改採 Google 官方目前支援的 Android 原生登入（`@react-native-google-signin/google-signin`，Credential Manager 為底），直接在 App 內完成，回傳可被後端驗證的 `idToken`。

**server-authoritative 不變**：client 只負責取得 provider `idToken`，身份解析（login-or-create、identities、collision）與 session 全部在後端 `POST /api/auth/login` → `api/_lib/verify-token.ts` 完成。client 端從不自行判定登入成功。

## 平台分流（明確、可測試）

`src/services/authStrategy.ts` 以純函式決定登入 surface，`authService.ts` 據此 dispatch：

| 平台 | Google surface | 實作 |
|------|----------------|------|
| iOS | `native-ios` | `obtainGoogleNativeIdToken`（iOS OAuth client + reversed-client-id，PKCE） |
| Android | `native-android` | `obtainGoogleNativeIdTokenAndroid`（Credential Manager） |
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

## 建置需求（原生模組）

- `@react-native-google-signin/google-signin` 是原生模組：**不能用 Expo Go**，需 dev-client 或 EAS build；加套件後必須**重新 build**（JS OTA 不會帶入原生設定）。
- library 在 Android 端透過 autolinking 納入，Credential Manager 不需額外 URL scheme。**未加該套件的 Expo config plugin**：其 plugin 主要作用是替 iOS 註冊 GoogleSignin URL scheme，而本專案 iOS 走 `expo-auth-session`，不使用該原生 library；為避免更動 / 退化既有 iOS 設定，暫不引入 plugin。日後若要讓 iOS 也改用原生 library，再加 plugin 並帶入 `iosUrlScheme`（見 `Auth-Google-Login-Design.md` 交付 E）。
- import 為 **lazy dynamic import**，且只在 Android 分支呼叫，故不進入 web / iOS bundle。

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
