# Web Apple 登入可行性評估與設定清單（DIC-663）

本文件記錄 HoloHunter **Web 版 Sign in with Apple** 的可行性判斷、目前不啟用的原因、
啟用所需的 Apple Developer 後台設定，以及兩條可行的實作路徑。對應共通帳號架構
`docs/AUTH-Architecture.md`（internal user id 為身份主鍵，email 絕不當唯一身份）。

## 結論（TL;DR）

- **Web Google 登入：已實作並啟用，且為伺服器權威（server-authoritative）。**
  前端（`src/services/authService.ts` 的 `signInWithProvider('google')`）以 expo-auth-session PKCE
  取得 Google `id_token` 後，POST 至 `/api/auth/login`；伺服器 `api/_lib/verify-token.ts` 以 Google
  公鑰（`oauth2/v3/certs`）驗簽章 / `iss` / `aud` / `exp` / `nonce`，通過後由
  `api/_lib/identity-store.ts`（Vercel KV）以 internal user id 建立 / 對應身份並發 HMAC session。
  身份**不再存於瀏覽器 localStorage**，也**不再**用前端 `oauth2/v3/userinfo` 當身份來源。
- **Web Apple 登入：id_token 驗簽端點已就緒，但整體流程尚未完成，刻意不啟用。**
  由**兩道旗標**關閉：前端 `APPLE_LOGIN_ENABLED = false`（`src/services/authService.ts`，寫死）、
  伺服器 `APPLE_WEB_LOGIN_ENABLED`（未設為 `'true'` 時 `/api/auth/login` 對 `provider=apple` 回非 2xx）。
  **翻旗標並不足以啟用 Apple**——除了 Apple Developer 後台設定，還有下列**尚未完成的程式碼工作**
  （見「為什麼不啟用」）：refresh_token 儲存層仍是樁（stub）、Web 前端流程尚未取得
  authorizationCode 也未呼叫 `/api/auth/apple/register`。在這些補齊前，即使翻旗標，Apple 使用者
  可登入卻**無法刪除帳號**（撤銷失敗，fail-closed 回 501），違反 App Store 5.1.1(v)。
- 綁定第二 provider 的 UI 已就緒（`src/screens/SettingsScreen.tsx` 的「登入方式綁定」），
  Google 綁定即刻可用；Apple 綁定按鈕顯示「即將推出」，待上述程式碼與後台工作完成、翻旗標後才開通
  （按鈕本身無需再改，但服務層仍有前述 authorizationCode / register 串接工作）。

## 為什麼 Web Apple 目前不啟用

**已完成的部分（僅驗簽端點）：** `/api/auth/login` 與 `api/_lib/verify-token.ts` 已支援
`provider=apple`（以 Apple 公鑰 `https://appleid.apple.com/auth/keys` 驗 ES256 簽章 /
`iss` / `aud` = Services ID / `exp` / `nonce`）。這代表「拿到 Apple id_token 後能被伺服器驗證」
這一段已就緒，且已納入 `scripts/test-auth-backend.cjs` 迴歸。

**尚未完成、必須補齊的程式碼工作（不是翻旗標就能解決）：**

1. **refresh_token 儲存層仍是樁（stub）。** `api/_lib/apple-token-store.ts` 的三個函式尚未接
   後端持久化：`persistAppleRefreshToken` 直接丟 `TokenStoreNotImplementedError`（呼叫端回 501）、
   `getStoredAppleRefreshToken` 回 `null`。因此帳號刪除端（`api/auth/[action].ts` 的
   `handleDeleteAccount`）對 Apple 使用者取不到 refresh_token → **fail-closed 回 501，無法完成刪除**。
   App Store 5.1.1(v) 要求可撤銷 Apple 授權，故此為**上線前必補**。實作需接真正的伺服器端加密儲存
   （Vercel KV / DB），refresh_token 絕不可進 repo。
2. **Web 前端流程尚未取得 authorizationCode，也未呼叫 register。** `src/services/authService.ts`
   的 `obtainProviderIdToken` 目前只回 `id_token`，不回 fresh authorizationCode，`signInWithProvider`
   也不呼叫 `/api/auth/apple/register`。因此即使 (1) 的儲存層就緒，登入當下仍**沒有 refresh_token
   被保存**，刪除時一樣無憑證可撤銷。需在 Apple authorize 成功後取出 authorizationCode，並帶著本次
   session 的 Bearer token POST 至 `/api/auth/apple/register`（該端點現在以 session 推導 userId，不再信任
   request body）。
3. **Apple Developer 後台前置設定尚未完成。** 需建立 Web 用 **Services ID**（當 `aud`）、
   設定 Return URL / Domains / domain association、`.p8` 金鑰，並於 Vercel 設好
   `EXPO_PUBLIC_APPLE_SERVICE_ID` 等變數（見下方清單）。
4. **最後才翻兩道旗標。** 上述 (1)(2)(3) 全部完成並端到端驗證後，才把前端 `APPLE_LOGIN_ENABLED`
   與伺服器 `APPLE_WEB_LOGIN_ENABLED` 開啟。任一前置未完成就翻旗標，會讓 Apple 使用者陷入
   「能登入卻不能刪帳號」的違規狀態。
5. **產品優先序。** 依 issue，Web 必備的是 Google（已上線且伺服器權威）；Apple web 為「可行則做」，
   待上述程式碼與後台工作完成再開通。

> Apple private relay / hide-my-email 的處理不是關閉原因：identity key 一律用 Apple `sub`
> （`api/_lib/identity-store.ts` 以 `(provider, subject)` 為唯一鍵），email 只是快照，
> 不參與身份判斷或自動合併，架構本身已相容 private relay。

## Apple Developer 後台設定清單（啟用 Web Apple 所需）

以下為在 Apple Developer 後台一次性設定的項目。**任何 `.p8` 私鑰 / client secret 絕不提交進 repo**，
只放 Vercel 環境變數。

| 項目 | 內容 | 備註 |
| --- | --- | --- |
| **Services ID** | 於 Identifiers → **Services IDs** 新建一個（例：`com.dicoge.holohunter.web`） | Web Apple 的 `client_id`，與 native 的 App ID `com.dicoge.holohunter` **不同**；對應前端 `EXPO_PUBLIC_APPLE_SERVICE_ID` |
| **Primary App ID** | 將 Services ID 綁到既有 App ID `com.dicoge.holohunter` | Services ID 需歸屬一個已啟用 Sign in with Apple 的 App ID |
| **Return URLs（redirect URI）** | 前端由 **`AuthSession.makeRedirectUri()`**（`src/services/authService.ts`）在執行期產生，指向 App 自身的 Web 來源（正式站約為 `https://holocard-hunter.vercel.app` 及其 expo-auth-session 回跳路徑），**本 repo 沒有 `/api/auth/apple/callback` 這支端點**。**啟用前先在執行環境 log 出 `makeRedirectUri()` 的實際字串，並將該完整字串逐字登記**到 Services ID 的 Return URLs。若改走 broker（路徑 B），則登記 broker 提供的 callback。 | 必須是 **https**、完整絕對網址；Apple 不接受 localhost，本機測試需用 ngrok/正式網域 |
| **Domains and Subdomains** | `holocard-hunter.vercel.app`（及未來自訂網域） | 需與 Return URL 同網域 |
| **Domain verification / association file** | **本 App 採用的 expo-auth-session OAuth 重導流程不需要** `apple-developer-domain-association.txt`。該檔僅在使用 Apple **AppleID JS SDK**（網頁上的原生「Sign in with Apple」按鈕）時才需要，而本 App 不使用該 SDK。 | 只有改用 AppleID JS 按鈕時才回頭補此檔；OAuth authorize/redirect 流程不需要 |
| **Sign in with Apple Key（.p8）** | Keys → 新建 Sign in with Apple 私鑰，記下 **Key ID**，下載 `.p8`（只能下載一次） | 對應 `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`；`.p8` **不進 repo** |
| **Team ID** | 帳號右上角 | 對應 `APPLE_TEAM_ID` |
| **Client secret** | 由 Team ID + Key ID + `.p8` 以 ES256 動態簽 JWT（**有效上限 6 個月**） | 已有產生器 `api/_lib/apple-auth.ts` 的 `buildAppleClientSecret`（目前簽 5 分鐘效期供 token/revoke 用）；web 登入驗證可沿用同一組金鑰 |

### Web domain 對應限制

- Services ID 的 Return URL（= `AuthSession.makeRedirectUri()` 產出的字串）與 Domains 必須同網域；
  Vercel preview 的動態子網域無法逐一登記，建議只在**正式網域**開放 Apple web 登入，preview 環境維持 Google-only。
- 本 OAuth 重導流程**不需要** `apple-developer-domain-association.txt`；僅在改採 AppleID JS 按鈕時才需要該檔並使其可被 Apple 公開存取。

### Client secret 輪替方式

- Apple client secret 是動態 JWT，**單一 `.p8` 金鑰最長可簽 6 個月效期**；本專案 `buildAppleClientSecret`
  每次呼叫即時簽發短效（5 分鐘）JWT，因此無「過期的 secret」問題，只需維護 `.p8` 金鑰本身。
- 金鑰輪替：於 Apple 後台新建一把新的 Sign in with Apple Key → 更新 Vercel 的 `APPLE_KEY_ID`
  / `APPLE_PRIVATE_KEY` → 部署 → 確認新登入正常後，於 Apple 後台撤銷舊 Key。
- 撤銷舊 `.p8` 前務必完成上線驗證，避免登入 / 撤銷中斷。

### 環境變數（Vercel，勿提交）

| 變數 | 說明 |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_CLIENT_ID` | **Web 用 Services ID**（例 `com.dicoge.holohunter.web`）；native 用 App ID |
| `APPLE_KEY_ID` | Sign in with Apple `.p8` 的 Key ID |
| `APPLE_PRIVATE_KEY` | `.p8` 內容（含 BEGIN/END，換行以 `\n` 表示） |
| `EXPO_PUBLIC_APPLE_SERVICE_ID` | 前端 authorize 用的 Services ID（= web `client_id`） |

## 兩條實作路徑（擇一）

### 路徑 A：自建伺服器驗證（驗簽端點已實作，其餘尚待補齊）

驗簽與 login-or-create 端點已存在，但 Apple web 端到端仍缺數項程式碼工作（見上節）：

1. 前端走 Apple authorize，拿到 `id_token`（`authService.ts` 已具雛形）。**尚待補**：同時取出 fresh
   authorizationCode，並帶 session Bearer 呼叫 `/api/auth/apple/register` 保存 refresh_token。
2. `api/_lib/verify-token.ts` 的 `verifyAppleIdToken` 以 Apple 公鑰（`https://appleid.apple.com/auth/keys`）
   驗 `id_token` ES256 簽章 / `iss` / `aud`（= Services ID）/ `exp` / `nonce`，通過後取 `sub` 當 provider identity key
   —— 此段**已完成**，並已納入 `scripts/test-auth-backend.cjs` 的身份存放層迴歸測試。
3. `/api/auth/login` 映射到共通 internal user（`api/_lib/identity-store.ts` 的 `loginOrCreate` / `link`），
   沿用唯一約束（`(provider, subject)` 原子 claim）與 collision（`IDENTITY_ALREADY_LINKED`）流程。
4. `register`（`api/auth/apple/register.ts`）現在以 session 推導 userId、不信任 request body；
   但其底層 `api/_lib/apple-token-store.ts` **仍是樁**，`delete-account` 對 Apple 使用者因此 fail-closed。
   **尚待補**：實作真正的伺服器端加密 refresh_token 儲存。
5. **待辦（依序）**：(a) 實作 token store；(b) 前端補 authorizationCode + register 呼叫；
   (c) 完成 Apple 後台設定（Services ID / Primary App ID / Domains / Return URL = `makeRedirectUri()` 實際字串 / Team ID / Key ID / `.p8`）並於 Vercel 設好
   `EXPO_PUBLIC_APPLE_SERVICE_ID` 等變數；(d) 端到端驗證 login / 綁定 / **刪除撤銷**；
   (e) 最後才把 `APPLE_LOGIN_ENABLED`（前端）與 `APPLE_WEB_LOGIN_ENABLED`（伺服器）翻為開啟。

- 優點：不引入第三方 Auth 供應商，與現有 Apple 後端一致；驗簽以 Node 內建 `crypto`（無額外相依）。
- 現況：id_token 驗簽 + 公鑰快取（JWKS，10 分鐘快取）已在 `verify-token.ts` 完成；refresh_token
  儲存與前端 register 串接尚未完成。

### 路徑 B：Firebase / Supabase Auth broker

1. 在 Firebase Auth 或 Supabase Auth 設定 Apple provider（填入 Services ID / Team ID / Key ID / `.p8`）。
2. broker 的 callback 網址即 Apple Return URL；broker 負責驗 id_token。
3. 前端拿 broker 發的 session/JWT，後端驗 broker JWT 後映射 internal user。
4. 需在隱私權政策補充第三方處理者（processor）說明（見 DIC-667 privacy 任務）。

- 優點：驗證與金鑰輪替託管，省事。
- 成本：多一個供應商依賴與資料處理者；需與現有 localStorage / 自建後端整合策略對齊。

**建議**：因 repo 已有 `api/_lib/apple-auth.ts`（client secret / token / revoke）且不希望新增供應商依賴，
啟用時優先走**路徑 A**。但**「只補一支 id_token 驗簽端點」的說法是錯的**——驗簽端點其實**已經完成**，
真正卡住的是下列尚未完成的工作，啟用前全部必補（詳見「為什麼不啟用」與本路徑 1./4./5.）：
1. **實作 `api/_lib/apple-token-store.ts` 的伺服器端加密 refresh_token 儲存**（目前為樁，Apple 刪帳號 fail-closed 回 501）；
2. **前端 `authService.ts` 於 Apple authorize 後取出 fresh authorizationCode，並帶 session Bearer 呼叫
   `/api/auth/apple/register`**（目前只取 id_token、未串接 register，因此登入當下不會保存 refresh_token）；
3. **Apple 後台前置設定**：Web 用 Services ID、Primary App ID 關聯、Domains、Return URL（= `makeRedirectUri()` 實際字串）、Team ID / Key ID / `.p8` 金鑰，
   並於 Vercel 設好 `EXPO_PUBLIC_APPLE_SERVICE_ID` 等環境變數；
4. **端到端（E2E）驗證** login / 綁定 / **刪除撤銷** 全流程；
5. 上述全部完成後，**最後**才翻前端 `APPLE_LOGIN_ENABLED` 與伺服器 `APPLE_WEB_LOGIN_ENABLED` 兩道旗標。

## 啟用檢核（Definition of Done）

> ⚠️ 只有第一項完成；其餘皆為未完成的**程式碼或設定**工作。翻旗標是最後一步，不是唯一一步。

- [x] 伺服器端 id_token 驗簽端點（路徑 A）：`api/_lib/verify-token.ts` + `/api/auth/login` 已支援 `provider=apple`。
- [ ] **程式碼**：實作 `api/_lib/apple-token-store.ts` 的真正伺服器端加密 refresh_token 儲存
      （目前為樁 → Apple 帳號刪除 fail-closed 回 501）。
- [ ] **程式碼**：Web 前端 `authService.ts` 於 Apple authorize 後取出 fresh authorizationCode，
      並帶 session Bearer 呼叫 `/api/auth/apple/register`（目前只取 id_token、未呼叫 register）。
- [ ] Apple 後台：Services ID、Primary App ID 關聯、Domains、Return URL（= 前端 `AuthSession.makeRedirectUri()` 執行期實際字串，逐字登記）、Team ID、Key ID、`.p8` 金鑰皆已設定。
- [ ] `EXPO_PUBLIC_APPLE_SERVICE_ID` 與 `APPLE_*` 環境變數於 Vercel 設定完成。
- [ ] Web Apple 登入 / 綁定 / **刪除撤銷**端到端驗證：新 user / returning user、Google→Apple 綁定、
      刪除帳號能真正撤銷 Apple 授權、private relay email 不造成錯誤合併
      （後端身份邏輯已由 `scripts/test-auth-backend.cjs` 覆蓋，仍需真機端到端驗證）。
- [ ] **最後**才翻兩道旗標：前端 `APPLE_LOGIN_ENABLED = true` 與伺服器 `APPLE_WEB_LOGIN_ENABLED = 'true'`。
- [ ] 隱私權政策若採 broker，補充第三方處理者說明。
