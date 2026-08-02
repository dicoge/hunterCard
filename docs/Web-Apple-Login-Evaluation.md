# Web Apple 登入可行性評估與設定清單（DIC-663）

本文件記錄 HoloHunter **Web 版 Sign in with Apple** 的可行性判斷、目前不啟用的原因、
啟用所需的 Apple Developer 後台設定，以及兩條可行的實作路徑。對應共通帳號架構
`docs/AUTH-Architecture.md`（internal user id 為身份主鍵，email 絕不當唯一身份）。

## 結論（TL;DR）

- **Web Google 登入：已實作並啟用**（`src/services/authService.ts` 的 `signInWithProvider('google')`，
  expo-auth-session PKCE + `oauth2/v3/userinfo`，登入畫面 `src/screens/LoginScreen.tsx`）。
- **Web Apple 登入：技術上可行，但目前刻意不啟用**，以旗標 `APPLE_LOGIN_ENABLED = false`
  （`src/services/authService.ts`）關閉。原因見下節。
- 綁定第二 provider 的 UI 已就緒（`src/screens/SettingsScreen.tsx` 的「登入方式綁定」），
  Google 綁定即刻可用；Apple 綁定按鈕顯示「即將推出」，待後端驗證上線後翻旗標即開通，
  無需再改 UI。

## 為什麼 Web Apple 目前不啟用

1. **前端無法安全驗證 Apple ID token。** Apple 回傳的 `id_token` 需驗簽章（Apple 公鑰）、
   `iss`、`aud`、`exp` 與 `nonce`。純前端只能 base64 解 payload（見 `authService.ts` 的
   `parseAppleIdToken` 註解），把未驗證的 payload 當身份來源會被偽造 token 冒充，屬安全漏洞。
2. **尚無 Apple web 的伺服器驗證端點。** 目前 `api/` 只有 Apple 的
   `register`（換 refresh_token）與 `delete-account`（撤銷）流程，沒有「驗證 web 登入 id_token
   並映射 internal user」的端點。
3. **Web 目前為 localStorage PoC，非 AUTH-Architecture 的伺服器 DB。** 使用者存在瀏覽器
   `localStorage`（`holohunter-users`），provider identity key 為 Apple `sub` / Google `sub`。
   在接上真正後端與 token 驗證前，先不開放 Apple web 以免產生無法驗證的身份。
4. **產品優先序。** 依 issue，Web 必備的是 Google；Apple web 為「可行則做」。先交付 Google，
   Apple web 待驗證端點就緒再開。

> Apple private relay / hide-my-email 的處理不是關閉原因：identity key 一律用 Apple `sub`，
> email 只是快照，不參與身份判斷或自動合併，架構本身已相容 private relay。

## Apple Developer 後台設定清單（啟用 Web Apple 所需）

以下為在 Apple Developer 後台一次性設定的項目。**任何 `.p8` 私鑰 / client secret 絕不提交進 repo**，
只放 Vercel 環境變數。

| 項目 | 內容 | 備註 |
| --- | --- | --- |
| **Services ID** | 於 Identifiers → **Services IDs** 新建一個（例：`com.dicoge.holohunter.web`） | Web Apple 的 `client_id`，與 native 的 App ID `com.dicoge.holohunter` **不同**；對應前端 `EXPO_PUBLIC_APPLE_SERVICE_ID` |
| **Primary App ID** | 將 Services ID 綁到既有 App ID `com.dicoge.holohunter` | Services ID 需歸屬一個已啟用 Sign in with Apple 的 App ID |
| **Return URLs（redirect URI）** | `https://holocard-hunter.vercel.app/api/auth/apple/callback`（自建流程）或 broker 提供的 callback（Firebase/Supabase） | 必須是 **https**、完整絕對網址；Apple 不接受 localhost，本機測試需用 ngrok/正式網域 |
| **Domains and Subdomains** | `holocard-hunter.vercel.app`（及未來自訂網域） | 需與 Return URL 同網域 |
| **Domain verification / association file** | 下載 Apple 提供的 `apple-developer-domain-association.txt`，放到 `https://<domain>/.well-known/apple-developer-domain-association.txt` | 建議放 `public/.well-known/`；Apple 會抓取驗證網域所有權 |
| **Sign in with Apple Key（.p8）** | Keys → 新建 Sign in with Apple 私鑰，記下 **Key ID**，下載 `.p8`（只能下載一次） | 對應 `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`；`.p8` **不進 repo** |
| **Team ID** | 帳號右上角 | 對應 `APPLE_TEAM_ID` |
| **Client secret** | 由 Team ID + Key ID + `.p8` 以 ES256 動態簽 JWT（**有效上限 6 個月**） | 已有產生器 `api/lib/apple-auth.ts` 的 `buildAppleClientSecret`（目前簽 5 分鐘效期供 token/revoke 用）；web 登入驗證可沿用同一組金鑰 |

### Web domain 對應限制

- Services ID 的 Return URL 與 Domains 必須同網域；Vercel preview 的動態子網域無法逐一登記，
  建議只在**正式網域**開放 Apple web 登入，preview 環境維持 Google-only。
- `apple-developer-domain-association.txt` 需能被 Apple 伺服器公開存取（勿被 auth middleware 擋掉）。

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

### 路徑 A：自建伺服器驗證（沿用現有 `api/lib/apple-auth.ts`）

1. 前端以 `response_mode=form_post` 走 Apple authorize（`authService.ts` 已具雛形），拿到 `code` + `id_token`。
2. 新增 `api/auth/apple/callback` 或 `api/auth/apple/verify`：以 Apple 公鑰（`https://appleid.apple.com/auth/keys`）
   驗 `id_token` 簽章 / `iss` / `aud`（= Services ID）/ `exp` / `nonce`，通過後取 `sub` 當 provider identity key。
3. 映射到共通 internal user（login-or-create / link），沿用 `AUTH-Architecture.md` 定義的
   partial-unique conflict 與 collision 流程。
4. 沿用既有 `register`（存 refresh_token）與 `delete-account`（撤銷）。
5. 前端把 `APPLE_LOGIN_ENABLED` 翻為 `true`。

- 優點：不引入第三方 Auth 供應商，與現有 Apple 後端一致。
- 成本：需自行實作 id_token 驗簽與公鑰快取（可用 `jose` / `apple-signin-auth`）。

### 路徑 B：Firebase / Supabase Auth broker

1. 在 Firebase Auth 或 Supabase Auth 設定 Apple provider（填入 Services ID / Team ID / Key ID / `.p8`）。
2. broker 的 callback 網址即 Apple Return URL；broker 負責驗 id_token。
3. 前端拿 broker 發的 session/JWT，後端驗 broker JWT 後映射 internal user。
4. 需在隱私權政策補充第三方處理者（processor）說明（見 DIC-667 privacy 任務）。

- 優點：驗證與金鑰輪替託管，省事。
- 成本：多一個供應商依賴與資料處理者；需與現有 localStorage / 自建後端整合策略對齊。

**建議**：因 repo 已有 `api/lib/apple-auth.ts`（client secret / token / revoke）且不希望新增供應商依賴，
啟用時優先走**路徑 A**，只補一支 id_token 驗簽端點即可。

## 啟用檢核（Definition of Done）

- [ ] Apple 後台：Services ID、Return URL、Domains、domain association file、`.p8` 金鑰、Team/Key ID 皆已設定。
- [ ] `public/.well-known/apple-developer-domain-association.txt` 可公開存取且通過 Apple 驗證。
- [ ] 伺服器端 id_token 驗簽端點上線（路徑 A）或 broker 設定完成（路徑 B）。
- [ ] `EXPO_PUBLIC_APPLE_SERVICE_ID` 與 `APPLE_*` 環境變數於 Vercel 設定完成。
- [ ] `APPLE_LOGIN_ENABLED` 翻為 `true`，Web Apple 登入 / 綁定端到端驗證：新 user / returning user、
      Google→Apple 綁定、private relay email 不造成錯誤合併。
- [ ] 隱私權政策若採 broker，補充第三方處理者說明。
