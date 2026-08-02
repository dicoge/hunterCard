# HoloHunter 登入設定（Sign in with Apple）

本文件說明 iOS「Sign in with Apple」的設定步驟、需要在 Apple Developer 後台配置的項目、環境變數，以及 TestFlight 驗證 checklist。

> **注意（DIC-663 更新）**：本文件保留早期 iOS 原生 Apple 流程（`src/services/auth/` + `src/stores/authStore.ts`）的 checklist 供 native 上架參考。目前**實際運行**的登入路徑是 `src/services/authService.ts` + `src/store/authStore.ts`，且為**伺服器權威**：前端取得 provider `id_token` 後 POST 至 `/api/auth/*`，由伺服器 `api/_lib/verify-token.ts` 驗簽、`api/_lib/identity-store.ts`（Vercel KV）以 internal user id 歸屬身份、`api/_lib/session.ts` 發 HMAC session。身份**不存於瀏覽器 localStorage**。**Web Google 登入已接線並啟用**（`signInWithProvider('google')`，server-authoritative）；Web Apple 的驗證端點已就緒但以旗標關閉，設定清單見 `docs/Web-Apple-Login-Evaluation.md`。下方「Google 登入後續」段落僅適用於已停用的舊 `services/auth/googleAuth.ts` 佔位檔，非目前路徑。

## 產品決策

- 只支援 **Apple ID** 與 **Google** 登入，**不提供**自家 Email/密碼。
- Web 版支援 Google 登入。
- iOS 若提供 Google 登入，依 App Store 審查規範 4.8 **必須**同時提供 Sign in with Apple。
- 上架版必須包含：登出、刪除帳號、隱私權政策/資料刪除說明。
- 不提交任何 Apple private key / secrets 進 repo。

## 目前實際路徑包含什麼（DIC-663，server-authoritative）

| 項目 | 位置 |
| --- | --- |
| 伺服器身份存放（KV：唯一 claim、per-user lock、login/link/unlink/delete + 錯誤碼） | `api/_lib/identity-store.ts` |
| provider `id_token` 伺服器驗簽（Google RS256 / Apple ES256，JWKS 快取） | `api/_lib/verify-token.ts` |
| HMAC session 簽發 + KV session 記錄 / 撤銷（登出、解綁撤銷其他 session、刪除撤銷全部） | `api/_lib/session.ts` |
| 共用端點輔助（json、錯誤碼→HTTP、旗標、backend 可用性、session 解析） | `api/_lib/auth-endpoint.ts` |
| 登入 / 綁定 / 解綁 / 登出 / 刪除端點（單一 dynamic route，session 授權，fail-closed） | `api/auth/[action].ts` |
| 前端 auth service（PKCE 取 id_token → 呼叫端點，fail-closed） | `src/services/authService.ts` |
| Session store（zustand + persist，存 session token 非 provider token） | `src/store/authStore.ts` |
| 登入畫面（Apple 按鈕受旗標 disabled / 「即將推出」） | `src/screens/LoginScreen.tsx` |
| 登出 / 綁定 / 刪除帳號 UI（旗標一致、fail-closed 文案） | `src/screens/SettingsScreen.tsx` |
| Apple 伺服器端輔助（client secret / token 交換 / 撤銷） | `api/_lib/apple-auth.ts` |
| refresh_token 儲存介面樁（seam，尚未接持久化） | `api/_lib/apple-token-store.ts` |
| 後端身份存放迴歸測試（mock KV） | `scripts/test-auth-backend.cjs`（`npm run test:auth-backend`） |
| App 設定 capability / plugin | `app.json` |

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
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`（Vercel KV / Upstash） | 身份存放（`api/_lib/identity-store.ts`）與 session 所需 | 端點回 501 `store_not_configured` |
| `AUTH_SESSION_SECRET` | HMAC session 簽發 / 驗證（`api/_lib/session.ts`）密鑰 | 端點回 501，無法發 / 驗 session |
| `GOOGLE_WEB_CLIENT_ID`（或 `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `GOOGLE_CLIENT_ID`） | Google `id_token` 驗簽的 `aud` | Google 登入回 `store_not_configured` |
| `APPLE_WEB_LOGIN_ENABLED` | 設為 `'true'` 才允許 `/api/auth/login` 驗 `provider=apple`（配合前端 `APPLE_LOGIN_ENABLED`） | Apple web 登入被擋（fail-closed） |

### Apple 後端環境變數（撤銷 / 驗簽用，設定於 Vercel，勿提交）

| 變數 | 說明 |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_CLIENT_ID` | Services ID（web）或 app bundle id `com.dicoge.holohunter`（native），亦為 Apple `id_token` 驗簽的 `aud` |
| `APPLE_KEY_ID` | 上述 .p8 私鑰的 Key ID |
| `APPLE_PRIVATE_KEY` | .p8 內容（含 BEGIN/END，換行以 `\n` 表示） |
| `EXPO_PUBLIC_APPLE_SERVICE_ID` | Web authorize 用的 Services ID（= web `client_id`），亦納入 Apple 驗簽 `aud` |

Apple 撤銷是刪除的**前置條件**且在任何身份寫入**之前**執行：未設定完整變數或撤銷未確認成功時 `api/auth/delete-account` 會在**尚未刪除任何資料**前回 501/502，App 端**fail-closed**、顯示「刪除尚未完成」並維持登入狀態。若撤銷通過、identity 已刪除，但**之後**的清理步驟失敗而回 5xx，則結果為**不確定**（帳號可能已刪）：後端**刻意不撤銷呼叫方自己的 session token**，App 端因此保有有效 token 可**重試**（重試會走 already-deleted 分支收斂為 `deleted: true`），文案改提示「無法確認、請稍後再試」而非誤示「未刪除」。

## 帳號刪除 / Apple 撤銷策略（目標設計，尚未完整上線）

### 目標流程（login-time register → stored refresh_token → revoke）

1. **登入當下**：client 取得 fresh `authorizationCode`，帶**本次 session 的 Bearer**立即 POST `/api/auth/apple/register`（best-effort）。後端用它向 `/auth/token` 換 `refresh_token`，以**由 session 推導的** `userId` 為 key 保存於伺服器端持久化儲存（見 `api/_lib/apple-token-store.ts`）。`register.ts` 現在**不信任** request body 的 userId，改由 Bearer session 解出。⚠️ **尚未接線**：Web 前端（`src/services/authService.ts`）目前只取 `id_token`、未取 authorizationCode、也未呼叫此端點，故實務上 refresh_token 仍未被保存。
2. **刪除時**：POST `/api/auth/delete-account`（由 `api/auth/[action].ts` 的 `handleDeleteAccount` 處理），**以 Bearer session 授權**，由 session 解出 internal user id，**不信任** client 傳來的 userId。若帳號含 Apple 身份，後端取出保存的 `refresh_token` 呼叫 `/auth/revoke`，成功後才由 `identity-store` 級聯刪除該 internal user 及其所有 provider 身份索引，並撤銷該 user 的所有 session。

原因：`authorizationCode` 為**單次使用且短效**，刪除當下通常已失效，因此不可保存它當作日後刪除憑證——必須在登入當下換成長效 `refresh_token`。client 端也**絕不持久化** `authorizationCode`（`authStore` partialize 會剝除）。

### fail-closed 行為

- **Apple 撤銷未確認成功前不動任何資料**：撤銷是刪除的前置條件且在 `identity-store` 級聯刪除**之前**執行，因此未設定 / 未實作 / 撤銷失敗 / 網路錯誤 → 回 501/502，此時**確實未刪除**任何伺服器資料。
- **撤銷通過後才刪除，且順序為 identity 先刪、session 清理在後**：一旦進入級聯刪除，identity 便已 durable committed。若之後的清理步驟失敗而回 5xx，帳號其實**已刪**，結果為不確定（indeterminate）而非「未刪」——舊文案「非 2xx 一律不刪任何資料」在此情境並不成立，故不再如此保證。
- **呼叫方自己的 session token 在刪除流程中刻意不被撤銷**（`revokeOtherUserSessions` 只撤其他裝置），使不確定結果可**重試收斂**：client 保有有效 token、重試會走 already-deleted 分支回 `deleted: true`。
- client 只有在後端回 `{ deleted: true }` 時才清除本機 session。非成功時 `deleteAccount()` throw：對 501/502 提示「刪除尚未完成」，對 5xx / 網路中斷提示「無法確認、你的登入仍有效、請稍後再試」，兩者皆維持登入，不誤示為已刪除。

### ⚠️ 目前限制（non-shipping foundation）

`api/_lib/apple-token-store.ts` 目前為**介面樁（seam）**，尚未接後端持久化儲存（refresh_token 是機密，**不可**存入 repo / git-backed storage，需接 Vercel KV / DB 並加密）。因此：

- `/api/auth/apple/register` 在 token store 未實作時回 501 `token_store_not_implemented`（登入不受影響）。
- `/api/auth/delete-account` 取不到保存的 refresh_token → 回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不是成功）。
- Web 前端亦尚未把 authorizationCode 送到 `register`（見上「目標流程」步驟 1 的 ⚠️），即使 token store 就緒也還需補此段前端串接。
- 上架前必須完成：實作 `apple-token-store`（真正持久化 + 加密）、Web 前端補 authorizationCode + register 串接、於刪除時級聯刪除 / 匿名化使用者資料。Settings 頁已標示此限制。

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
- [ ] **刪除帳號（成功路徑，需先完成 token store + 前端 register 串接後才可測）**：確認對話框 → 後端撤銷成功 → 顯示「帳號已刪除」→ 本機 session 清除 → 回到登入頁；於 Apple ID 設定中該 App 授權消失。
- [ ] **刪除帳號（fail-closed，Apple 撤銷未設定 / 未實作 → 501/502）**：顯示「刪除尚未完成」→ **仍為登入狀態**、session 未清除，不誤示為已刪除（此時後端確實未刪任何資料）。
- [ ] **刪除帳號（不確定結果，撤銷通過但後續清理 5xx / 網路中斷）**：顯示「無法確認、請稍後再試」→ **仍為登入狀態**（token 刻意保留）；**重試**後收斂為「帳號已刪除」→ session 清除、回登入頁，不會卡在死 token 401。
- [ ] 「隱私權政策與資料刪除說明」連結可開啟。
- [ ] 在 App Store Connect 填寫隱私權政策 URL 與資料刪除說明。
- [ ] 送審前確認：有 Google 登入的畫面同時提供 Sign in with Apple（規範 4.8）。
