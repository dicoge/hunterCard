# Android「Sign in with Apple」可行性評估（DIC-665）

對應 issue DIC-665：Android 以 Google 登入為第一優先；Apple 登入在 Android 僅**評估可行性**，非首要。本文件為評估結論與（若日後要做的）落地路徑，並不在本階段實作。

## TL;DR — 結論

- **技術上可行**：Android 沒有原生 Sign in with Apple SDK，但可透過 **Apple Web OAuth（Sign in with Apple, web flow）** 搭配系統 **Custom Tabs**（`expo-web-browser`）在 Android 上完成。
- **成本 / 風險偏高**：需要一套只為 Android/Web 服務的 Apple **Services ID + domain verification + `.p8` client secret + 後端 code 交換**，等同把「Web Apple 登入」的整組後端基礎設施先建起來。
- **建議：本階段暫不實作**。Android 先只出 Google（已於 `googleAuth.ts` 接線）。Apple-on-Android 待 **Web Apple 登入（DIC-663）** 的 Services ID / 代管商 / 後端 code 交換就緒後「順帶啟用」，屆時 Android 直接重用同一 web flow，邊際成本才低。
- **過渡替代流程（見下）**：Android 使用者若需綁定 Apple，引導其至 Web 或 iOS 完成。**注意：帳號綁定（linking）、跨 provider 合併、跨平台身份同步、watchlist 同步目前皆尚未實作**（`authService.ts` 的 `linkProvider`/`unlinkProvider` 為 fail-closed，watchlist / 推播 token 以裝置為界、無 user-id 綁定）；「以 internal user id 跨平台一致歸戶」是身份模型的**設計目標**，需這些後端端點就緒後才成立。

## 為什麼 Android 不能像 iOS 那樣做

| 面向 | iOS | Android |
|------|-----|---------|
| 原生 SDK | `expo-apple-authentication`（AuthenticationServices） | **無**官方原生 Apple SDK |
| 流程 | 系統原生彈窗，直接回 `identityToken` + `authorizationCode` | 只能走 **web OAuth**（瀏覽器 redirect） |
| client_id | App 的 **App ID**（bundle id） | 需另建 **Services ID**（web 類型 identifier） |
| redirect | app 直接取得 credential，無需 web redirect | 需 **HTTPS return URL**（自訂 scheme 不被 Apple 接受），故需後端 callback |
| client secret | 不需要 | 需以 **`.p8` 私鑰**簽 client secret JWT（後端） |

關鍵限制：**Apple 的 web OAuth `redirect_uri` 只接受 `https://`，不接受自訂 app scheme**。因此不能像 Google 那樣用 `com.googleusercontent.apps.*:/oauthredirect` 直接回跳 App；必須有一個後端 `https` callback（例如 `POST /api/auth/apple/callback`）先接住 `form_post` 回應，再把結果導回 App（deep link 或短效 code）。

## 技術落地路徑（若日後實作）

1. **Apple Developer**
   - 建 **Services ID**（例如 `com.dicoge.holohunter.web`），開啟 "Sign in with Apple"，關聯 primary App ID `com.dicoge.holohunter`。
   - **Domains and Subdomains**：登記正式站網域，並把 `apple-developer-domain-association.txt` 放在 `/.well-known/` 完成 domain verification。
   - **Return URLs**：填後端 callback（如 `https://holocard-hunter.vercel.app/api/auth/apple/callback`）。
   - 建一把開啟 Sign in with Apple 的 **Key（.p8）**，記 Key ID + Team ID。**`.p8` 為機密**，放 Vercel env，永不進 repo。
2. **後端**（Vercel serverless）
   - `GET /api/auth/apple/start`：以 Services ID + `response_mode=form_post` + `scope=name email` 組 Apple authorize URL。
   - `POST /api/auth/apple/callback`：接 `form_post` 的 `code` / `id_token`；用 `.p8` 簽 client secret 向 Apple token endpoint 換 token；**驗證 `id_token`**（Apple 公鑰、issuer、audience=Services ID、nonce）；取 `sub` 正規化進 `users` + `identities`；再以 deep link（`holohunter://...`）帶短效自家 session 導回 App。
3. **Android 前端**
   - 以 `expo-web-browser` 開 `openAuthSessionAsync(startUrl, 'holohunter://apple-callback')`（Custom Tab），等後端 callback 完成後回跳。
   - 映射成同一個 `AuthSession`（`provider: 'apple'`、`user.id = sub`、`identityToken = id_token`），與 iOS / Google 共用 store 與歸戶邏輯。

> 注意：Android 上 Apple 只能拿到後端驗證後的結果，**id_token 一律由後端驗證**（前端不可信任解碼後的 payload 當身份來源）——與現有架構「不以 email 為身份、以 `sub` 為 identity key」一致。

## Apple 審核 / 品牌 / 合規注意

- **無 iOS 4.8 強制對應問題**：App Store Guideline 4.8 只約束 **iOS** App「有第三方登入就須提供 Sign in with Apple」；**Google Play 無此對等要求**，故 Android 缺 Apple 不會被 Play 拒。這也是可安全延後的主因。
- **Sign in with Apple 品牌規範**：若做，按鈕文案 / 樣式 / 配色需遵循 Apple Human Interface Guidelines 的 Sign in with Apple 規範（Android 上需自繪符合規範的按鈕，無原生按鈕元件）。
- **client secret 輪替**：`.p8` 簽出的 client secret JWT 最長效期 6 個月，需要排程輪替；屬額外維運負擔。
- **private relay email**：與 iOS 相同，Apple 可能回 relay email；不得用於未授權用途，且不可作唯一身份依據。

## 過渡替代流程（本階段採用）

在 Android 尚未提供 Apple 登入前：

1. Android 只顯示 **Google 登入**（`isGoogleAuthConfigured()` gating；Apple 按鈕不出現在 Android）。
2. 已登入使用者若要綁定 Apple：**帳號綁定尚未實作**（`linkProvider` 為 fail-closed，設定頁無綁定入口）。日後端點就緒後的設計是：於設定頁標示「請於 Web 或 iOS 版完成 Apple 綁定」，綁定成功後因歸屬同一 internal user id，Android 端登入自動反映——此為**目標行為，非現況**。
3. 身份模型設計上，收藏 / 設定 / watchlist / 推播 token 應以 internal user id 為 owner 以跨平台一致；**但目前 watchlist / 推播 token 仍以裝置（Expo push token 字串）為界、未綁 internal user id，跨平台同步尚未實作**（見 `docs/AUTH_SETUP.md` 刪除章節的相同揭露）。

## 何時重新評估

當 **DIC-663（Web Apple 登入）** 落地、Services ID + domain verification + 後端 code 交換 / `id_token` 驗證已上線時，Android 端只需加一段 `expo-web-browser` 導引即可重用整組後端，邊際成本大幅下降——屆時再把 Apple-on-Android 從「評估」轉為「實作」。
