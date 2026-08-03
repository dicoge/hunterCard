# HoloHunter 登入設定（Sign in with Apple）

本文件說明 iOS「Sign in with Apple」的設定步驟、需要在 Apple Developer 後台配置的項目、環境變數，以及 TestFlight 驗證 checklist。

> **注意（DIC-663 更新）**：本文件保留早期 iOS 原生 Apple 流程（`src/services/auth/` + `src/stores/authStore.ts`）的 checklist 供 native 上架參考。目前**實際運行**的登入路徑是 `src/services/authService.ts` + `src/store/authStore.ts`，且為**伺服器權威**：前端取得 provider `id_token` 後 POST 至 `/api/auth/*`，由伺服器 `api/lib/verify-token.ts` 驗簽、`api/lib/identity-store.ts`（Vercel KV）以 internal user id 歸屬身份、`api/lib/session.ts` 發 HMAC session。身份**不存於瀏覽器 localStorage**。**Web Google 登入已接線並啟用**（`signInWithProvider('google')`，server-authoritative）；Web Apple 的驗證端點已就緒但以旗標關閉，設定清單見 `docs/Web-Apple-Login-Evaluation.md`。下方「Google 登入後續」段落僅適用於已停用的舊 `services/auth/googleAuth.ts` 佔位檔，非目前路徑。

## 產品決策

- 只支援 **Apple ID** 與 **Google** 登入，**不提供**自家 Email/密碼。
- Web 版支援 Google 登入。
- iOS 若提供 Google 登入，依 App Store 審查規範 4.8 **必須**同時提供 Sign in with Apple。
- 上架版必須包含：登出、刪除帳號、隱私權政策/資料刪除說明。
- 不提交任何 Apple private key / secrets 進 repo。

## 目前實際路徑包含什麼（DIC-663，server-authoritative）

| 項目 | 位置 |
| --- | --- |
| 伺服器身份存放（KV：唯一 claim、per-user lock、login/link/unlink/delete + 錯誤碼） | `api/lib/identity-store.ts` |
| provider `id_token` 伺服器驗簽（Google RS256 / Apple ES256，JWKS 快取） | `api/lib/verify-token.ts` |
| HMAC session 簽發 / 驗證 | `api/lib/session.ts` |
| 共用端點輔助（json、錯誤碼→HTTP、旗標、backend 可用性、session 解析） | `api/lib/auth-endpoint.ts` |
| 登入端點（verify → loginOrCreate → session） | `api/auth/login.ts` |
| 綁定 / 解綁端點（session 授權） | `api/auth/link.ts`, `api/auth/unlink.ts` |
| 帳號刪除（session-based 級聯刪除 + Apple 撤銷，fail-closed） | `api/auth/delete-account.ts` |
| 前端 auth service（PKCE 取 id_token → 呼叫端點，fail-closed） | `src/services/authService.ts` |
| Session store（zustand + persist，存 session token 非 provider token） | `src/store/authStore.ts` |
| 登入畫面（iOS 顯示原生 Apple 按鈕；Web 未啟用時**隱藏**Apple 按鈕，不留假入口） | `src/screens/LoginScreen.tsx` |
| 登出 / 綁定 / 刪除帳號 UI（旗標一致、fail-closed 文案） | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/lib/apple-token-store.ts` |
| 後端身份存放迴歸測試（mock KV） | `scripts/test-auth-backend.cjs`（`npm run test:auth-backend`） |
| App 設定 capability / plugin（原 `app.json`，DIC-866 改為靜態 base + 動態 config） | `app.base.json` + `app.config.js` |
| 前端 iOS 原生登入單元測試（audience 驗簽） | `scripts/test-verify-token.cjs`（`npm run test:verify-token`） |

行為：登入 / 綁定 / 解綁 / 刪除皆須伺服器回 2xx 才視為成功；後端未設定（KV 或 `AUTH_SESSION_SECRET` 缺）時端點回 501，前端 fail-closed 不誤示成功。native 原生 Apple 流程（`src/services/auth/`）為早期實作，checklist 見文末。

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

### 伺服器權威登入前置（server prerequisites，設定於 Vercel，勿提交）

目前登入路徑需下列後端變數；缺任一，`/api/auth/*` 會 fail-closed 回 501，前端不誤示成功：

| 變數 | 說明 | 缺少時 |
| --- | --- | --- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Vercel KV / Upstash） | 身份存放（`api/lib/identity-store.ts`）與 session 所需 | 端點回 501 `store_not_configured` |
| `AUTH_SESSION_SECRET` | HMAC session 簽發 / 驗證（`api/lib/session.ts`）密鑰 | 端點回 501，無法發 / 驗 session |
| `GOOGLE_WEB_CLIENT_ID`（或 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `GOOGLE_CLIENT_ID`） | **Web** Google `id_token` 驗簽的 `aud` | Web Google 登入回 `store_not_configured` |
| `APPLE_WEB_LOGIN_ENABLED` | 設為 `'true'` 才允許 **Web** Apple（Services ID `aud`）通過 `/api/auth/login`。**不影響原生 iOS Apple**（bundle id `aud` 一律接受） | Web Apple 被擋（fail-closed）；iOS 不受影響 |

### 原生 iOS 登入（DIC-866）所需

DIC-866 起，iOS 走**原生**登入（`expo-apple-authentication` + Google iOS OAuth client），並沿用同一套伺服器權威驗簽。原生 token 的 `aud` 與 web 不同，後端 `api/lib/verify-token.ts` 現同時接受：

| 變數 | 說明 | 缺少時 |
| --- | --- | --- |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`（EAS/build 端；後端可另設 `GOOGLE_IOS_CLIENT_ID`） | 原生 iOS Google `id_token` 的 `aud`（iOS OAuth client id）。其 reversed-client-id 會由 `app.config.js` 注入 iOS `CFBundleURLTypes` 當 redirect scheme | iOS Google 前端報 `client_id_missing`；後端驗簽 `aud` 不符 |
| （無需 Services ID）原生 Apple `aud` = app bundle id `com.dicoge.holohunter` | 已內建為預設 native audience，**不需** Apple Developer Services ID / .p8 即可登入。可用 `APPLE_NATIVE_CLIENT_ID` / `EXPO_PUBLIC_APPLE_BUNDLE_ID` 覆寫 | — |

因此**原生 iOS Apple 登入只需** KV + `AUTH_SESSION_SECRET`（App ID 的 Sign in with Apple capability 已於 `app.base.json` `usesAppleSignIn:true` 設好）。iOS Google 另需上表的 iOS client id。Web Apple 仍為選配，需另設 Services ID 相關變數並開 `APPLE_WEB_LOGIN_ENABLED`。

### Apple 後端環境變數（撤銷 / 驗簽用，設定於 Vercel，勿提交）

| 變數 | 說明 |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_CLIENT_ID` | Services ID（web）或 app bundle id `com.dicoge.holohunter`（native），亦為 Apple `id_token` 驗簽的 `aud` |
| `APPLE_KEY_ID` | 上述 .p8 私鑰的 Key ID |
| `APPLE_PRIVATE_KEY` | .p8 內容（含 BEGIN/END，換行以 `\n` 表示） |
| `EXPO_PUBLIC_APPLE_SERVICE_ID` | Web authorize 用的 Services ID（= web `client_id`），亦納入 Apple 驗簽 `aud` |

未設定完整變數或撤銷未確認成功時 `api/auth/delete-account` 會回非 2xx（含 501），App 端**fail-closed**：不清除本機 session、顯示「刪除尚未完成」並維持登入狀態。

## 帳號刪除 / Apple 撤銷策略（已採用）

### 正確流程（login-time register → stored refresh_token → revoke）

1. **登入當下**：client 拿到 fresh `authorizationCode`，立即 POST `/api/auth/apple/register`（`src/services/auth/index.ts` 的 `registerAppleSession`，best-effort）。後端用它向 `/auth/token` 換 `refresh_token`，以 `userId` 為 key 保存於**伺服器端持久化儲存**（見 `api/lib/apple-token-store.ts`）。
2. **刪除時**：POST `/api/auth/delete-account`，**以 Bearer session 授權**（`api/auth/delete-account.ts` 由 session 解出 internal user id，**不信任** client 傳來的 userId）。若帳號含 Apple 身份，後端取出保存的 `refresh_token` 呼叫 `/auth/revoke`，成功後才由 `identity-store` 級聯刪除該 internal user 及其所有 provider 身份索引。

原因：`authorizationCode` 為**單次使用且短效**，刪除當下通常已失效，因此不可保存它當作日後刪除憑證——必須在登入當下換成長效 `refresh_token`。client 端也**絕不持久化** `authorizationCode`（`authStore` partialize 會剝除）。

### fail-closed 行為

- 後端無法確認撤銷成功（未設定 / 未實作 / 撤銷失敗 / 網路錯誤）→ 回非 2xx，且**不刪除**任何伺服器資料。
- client 只有在後端回 `{ deleted: true }` 時才清除本機 session；否則維持登入並提示「尚未完成」（`deleteAccount()` 於非成功時 throw）。避免讓使用者誤以為已刪除但 Apple 授權 / 伺服器資料仍存在。

### ⚠️ 目前限制（non-shipping foundation）

`api/lib/apple-token-store.ts` 目前為**介面樁（seam）**，尚未接後端持久化儲存（refresh_token 是機密，**不可**存入 repo / git-backed storage，需接 Vercel KV / DB 並加密）。因此：

- `/api/auth/apple/register` 在 token store 未實作時回 501 `token_store_not_implemented`（登入不受影響）。
- `/api/auth/delete-account` 取不到保存的 refresh_token → 回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不是成功）。
- 上架前必須完成：實作 `apple-token-store`（真正持久化 + 加密）、於刪除時級聯刪除 / 匿名化使用者資料。Settings 頁已標示此限制。

## Google 登入（現況）

Web Google 登入**已接線並啟用**，且為 server-authoritative：前端 `src/services/authService.ts`
以 expo-auth-session PKCE 取得 `id_token`，POST 至 `/api/auth/login`，伺服器驗簽後由 KV 身份存放層歸屬 internal user。
啟用只需在 Vercel 設好上方「伺服器權威登入前置」的 KV / `AUTH_SESSION_SECRET` / `GOOGLE_WEB_CLIENT_ID`。

> 下列步驟為**已停用的舊 native 佔位檔** `src/services/auth/googleAuth.ts` 的接線說明，**非目前路徑**，僅保留參考：
>
> 1. `npx expo install expo-auth-session expo-web-browser`
> 2. Google Cloud Console 建立 iOS / Web / Android OAuth client ID。
> 3. 於 `src/services/auth/googleAuth.ts` 用 `Google.useIdTokenAuthRequest` 換 `id_token`。
> 4. Web 的登入 gate（`AppNavigator.tsx` 的 `REQUIRE_AUTH`）改為全平台強制登入。

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
