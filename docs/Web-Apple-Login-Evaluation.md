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
- **Web Apple 登入：驗證端點已就緒，但目前刻意不啟用。** 由**兩道旗標**共同關閉：前端
  `APPLE_LOGIN_ENABLED = false`（`src/services/authService.ts`）、伺服器
  `APPLE_WEB_LOGIN_ENABLED`（未設為 `'true'` 時 `/api/auth/login` 對 `provider=apple` 回非 2xx）。
  剩餘前置條件是 Apple Developer 後台設定與翻旗標，而非缺少伺服器驗證端點。原因見下節。
- 綁定第二 provider 的 UI 已就緒（`src/screens/SettingsScreen.tsx` 的「登入方式綁定」），
  Google 綁定即刻可用；Apple 綁定按鈕顯示「即將推出」，待兩道旗標開啟後即開通，無需再改 UI。

## 為什麼 Web Apple 目前不啟用

1. **伺服器驗證端點已存在，但 Apple 尚缺後台前置設定。** `/api/auth/login` 與
   `api/_lib/verify-token.ts` 已支援 `provider=apple`（以 Apple 公鑰
   `https://appleid.apple.com/auth/keys` 驗 ES256 簽章 / `iss` / `aud` = Services ID / `exp` / `nonce`）。
   但要真正驗證，必須先在 Apple Developer 後台建立 Web 用 **Services ID**（當 `aud`）、
   設定 Return URL / Domains / domain association、`.p8` 金鑰，並於 Vercel 設好
   `EXPO_PUBLIC_APPLE_SERVICE_ID` 等變數（見下方清單）。在這些就緒前不開放，以免產生無法驗證的身份。
2. **需同時翻兩道旗標。** 前端 `APPLE_LOGIN_ENABLED` 與伺服器 `APPLE_WEB_LOGIN_ENABLED`
   皆需開啟；任一未開，Apple web 登入即被 fail-closed 擋下（前端按鈕 disabled、伺服器回非 2xx）。
3. **產品優先序。** 依 issue，Web 必備的是 Google；Apple web 為「可行則做」。先交付 Google
   （已上線且伺服器權威），Apple web 待 Apple 後台設定就緒再翻旗標開通。

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
| **Return URLs（redirect URI）** | `https://holocard-hunter.vercel.app/api/auth/apple/callback`（自建流程）或 broker 提供的 callback（Firebase/Supabase） | 必須是 **https**、完整絕對網址；Apple 不接受 localhost，本機測試需用 ngrok/正式網域 |
| **Domains and Subdomains** | `holocard-hunter.vercel.app`（及未來自訂網域） | 需與 Return URL 同網域 |
| **Domain verification / association file** | 下載 Apple 提供的 `apple-developer-domain-association.txt`，放到 `https://<domain>/.well-known/apple-developer-domain-association.txt` | 建議放 `public/.well-known/`；Apple 會抓取驗證網域所有權 |
| **Sign in with Apple Key（.p8）** | Keys → 新建 Sign in with Apple 私鑰，記下 **Key ID**，下載 `.p8`（只能下載一次） | 對應 `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`；`.p8` **不進 repo** |
| **Team ID** | 帳號右上角 | 對應 `APPLE_TEAM_ID` |
| **Client secret** | 由 Team ID + Key ID + `.p8` 以 ES256 動態簽 JWT（**有效上限 6 個月**） | 已有產生器 `api/_lib/apple-auth.ts` 的 `buildAppleClientSecret`（目前簽 5 分鐘效期供 token/revoke 用）；web 登入驗證可沿用同一組金鑰 |

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

### 路徑 A：自建伺服器驗證（**已實作於 `api/_lib/verify-token.ts` + `/api/auth/login`**）

驗簽與 login-or-create 端點**已存在**，Apple web 只差 Apple 後台設定與翻旗標：

1. 前端走 Apple authorize，拿到 `id_token`（`authService.ts` 已具雛形）。
2. `api/_lib/verify-token.ts` 的 `verifyAppleIdToken` 以 Apple 公鑰（`https://appleid.apple.com/auth/keys`）
   驗 `id_token` ES256 簽章 / `iss` / `aud`（= Services ID）/ `exp` / `nonce`，通過後取 `sub` 當 provider identity key
   —— 此段**已完成**，並已納入 `scripts/test-auth-backend.cjs` 的身份存放層迴歸測試。
3. `/api/auth/login` 映射到共通 internal user（`api/_lib/identity-store.ts` 的 `loginOrCreate` / `link`），
   沿用唯一約束（`(provider, subject)` 原子 claim）與 collision（`IDENTITY_ALREADY_LINKED` + merge_token）流程。
4. 沿用既有 `register`（存 refresh_token）與 `delete-account`（級聯刪除 + 撤銷，fail-closed）。
5. **待辦**：完成 Apple 後台設定（Services ID / Return URL / `.p8` / domain association），於 Vercel 設好
   `EXPO_PUBLIC_APPLE_SERVICE_ID` 等變數，最後把 `APPLE_LOGIN_ENABLED`（前端）與 `APPLE_WEB_LOGIN_ENABLED`（伺服器）翻為開啟。

- 優點：不引入第三方 Auth 供應商，與現有 Apple 後端一致；驗簽以 Node 內建 `crypto`（無額外相依）。
- 現況：id_token 驗簽 + 公鑰快取（JWKS，10 分鐘快取）已在 `verify-token.ts` 完成。

### 路徑 B：Firebase / Supabase Auth broker

1. 在 Firebase Auth 或 Supabase Auth 設定 Apple provider（填入 Services ID / Team ID / Key ID / `.p8`）。
2. broker 的 callback 網址即 Apple Return URL；broker 負責驗 id_token。
3. 前端拿 broker 發的 session/JWT，後端驗 broker JWT 後映射 internal user。
4. 需在隱私權政策補充第三方處理者（processor）說明（見 DIC-667 privacy 任務）。

- 優點：驗證與金鑰輪替託管，省事。
- 成本：多一個供應商依賴與資料處理者；需與現有 localStorage / 自建後端整合策略對齊。

**建議**：因 repo 已有 `api/_lib/apple-auth.ts`（client secret / token / revoke）且不希望新增供應商依賴，
啟用時優先走**路徑 A**，只補一支 id_token 驗簽端點即可。

## 啟用檢核（Definition of Done）

- [x] 伺服器端 id_token 驗簽端點（路徑 A）：`api/_lib/verify-token.ts` + `/api/auth/login` 已支援 `provider=apple`。
- [ ] Apple 後台：Services ID、Return URL、Domains、domain association file、`.p8` 金鑰、Team/Key ID 皆已設定。
- [ ] `public/.well-known/apple-developer-domain-association.txt` 可公開存取且通過 Apple 驗證。
- [ ] `EXPO_PUBLIC_APPLE_SERVICE_ID` 與 `APPLE_*` 環境變數於 Vercel 設定完成。
- [ ] 翻兩道旗標：前端 `APPLE_LOGIN_ENABLED = true` 與伺服器 `APPLE_WEB_LOGIN_ENABLED = 'true'`。
- [ ] Web Apple 登入 / 綁定端到端驗證：新 user / returning user、Google→Apple 綁定、
      private relay email 不造成錯誤合併（後端邏輯已由 `scripts/test-auth-backend.cjs` 覆蓋，仍需真機端到端驗證）。
- [ ] 隱私權政策若採 broker，補充第三方處理者說明。
