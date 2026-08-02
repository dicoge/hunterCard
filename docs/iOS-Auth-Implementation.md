## iOS Apple 登入 + Google 登入與帳號綁定（DIC-664）

> 對齊 `docs/AUTH-Architecture.md`（DIC-662）：internal user id 為身份主體、email 永不作唯一身份、
> 一個 user 可綁 Google + Apple、解綁需保留至少一個登入方式。

### 背景：修正前 iOS 完全無法登入

App 的登入主流程走 `src/store/authStore.ts` → `src/services/authService.ts`（共通帳號模型
`HoloUser`，收藏 / 設定 / watchlist / 推播 token 全歸 `HoloUser.internalId`）。修正前該 service
是 **web-only**：

- `loadLocalUsers` / `saveLocalUsers` 直接用 `localStorage` → React Native 無此 API，iOS Google
  登入會在寫入本機使用者表時 crash。
- Apple 登入被 `APPLE_LOGIN_ENABLED = false` 全域關閉（web 無法安全驗 Apple ID token）。

另有一組原生 Apple 模組（`src/services/auth/*` + `AuthScreen.tsx` + `src/stores/authStore.ts`），
但未接進導覽（`AppNavigator` 只註冊 `LoginScreen`），等於孤兒程式。本次不改用那套，而是把
**主流程 service 補成跨平台**，讓 Web（DIC-663）與 iOS 共用同一份帳號模型與綁定 / 解綁邏輯。

### 本次實作

#### 1. Apple 登入 — iOS 走原生 Sign in with Apple

`signInWithProvider('apple')` 與 `linkProvider(user,'apple')` 在 `Platform.OS === 'ios'` 且
`isAppleAuthAvailable()` 為真時，改走原生 `expo-apple-authentication`（沿用既有
`src/services/auth/appleAuth.ts`），拿到 OS 提供的可信 `credential.user`（Apple `sub`）當
`providerId`，映射成共通模型的 `ProviderUserInfo`。

- **不需 client 端解 JWT**：原生流程直接回傳可信 subject，`APPLE_LOGIN_ENABLED` 只再管 **web**
  Apple（維持關閉），iOS 不受其限制。
- **App Store 合規**：`app.json` 已設 `usesAppleSignIn: true` 且掛 `expo-apple-authentication`
  plugin、bundle id `com.dicoge.holohunter`，符合「提供第三方登入即需提供 Sign in with Apple」。
- **使用者取消**：原生取消（`ERR_REQUEST_CANCELED`）被包成帶 `APPLE_CANCEL_CODE` 的錯誤，
  `authStore.loginWithApple` 靜默結束，不顯示錯誤、不彈 alert。

#### 2. Apple private relay / hide email / returning user

- 唯一身份鍵是 `(provider, providerId=sub)`，**email 不參與比對**，故隱藏信箱 / private relay
  (`@privaterelay.appleid.com`) / 跨 provider email 不一致都不會建立錯誤關聯或誤合併。
- Apple 只在**首次**授權回傳 name / email；**returning user** 兩者為 null。
  `findOrCreateHoloUser` 只在 provider 真的回傳值時才覆寫既有 name / email / photo，避免把首次
  登入保存的資料清成空值。首次無名字時 displayName 退回 `'Apple 使用者'`。

#### 3. Google 登入 — iOS 用 iOS OAuth client

Google 沿用跨平台的 `expo-auth-session` PKCE（web 與 native 皆可）：

- iOS 用 `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`；其餘平台用
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`（對齊 AUTH-Architecture §6.1「各平台 aud 對應不同 client id」）。
- iOS OAuth client 的導回 URI 必須是 reversed client id 自訂 scheme，
  由 `com.googleusercontent.apps.XXXX:/oauthredirect` 自動組出。

#### 4. 帳號綁定 / 解綁（共通 internal user id）

- **Apple ↔ Google 雙向綁定**：以任一 provider 登入後，`linkNewProvider(otherProvider)` 走上述
  對應流程取得第二 provider 的 identity，`(provider, providerId)` collision 會被擋
  （提示先從另一帳號解綁）。綁定沿用同一 `internalId`，資料不搬家。
- **解綁保留最後一個**：`unlinkProvider` 在 `linkedProviders.length <= 1` 時拋錯，對應驗收
  「解除綁定最後一個 provider 時被阻擋」。

#### 5. 跨平台本機使用者表

`loadLocalUsers` / `saveLocalUsers` 改用 `platformStorage`（web = localStorage、native =
AsyncStorage），key `holohunter-users`。這是本 PoC 模擬 server 端 identity store 的本機表；
正式後端（AUTH-Architecture §3 Postgres）上線後應以 `POST /api/auth/login|link` 取代。

#### 6. Apple credential state / revoked / re-auth

`authStore.verifyAppleCredential` 於 App 啟動（rehydrate 後，`App.tsx`）檢查 iOS Apple 使用者的
`getCredentialStateAsync(sub)`；若使用者已在「設定 → Apple ID → 以 Apple 登入」撤銷授權，強制登出
要求重新驗證。非 iOS / 非 Apple 使用者一律 no-op。

#### 7. 刪除帳號（App Store 5.1.1(v)）

- 入口已存在於 `SettingsScreen`（刪除帳號）。
- `deleteAccount` 在 iOS + Apple 使用者時，**best-effort** 呼叫
  `POST /api/auth/delete-account` 撤銷 Apple 授權；登入當下亦以 `registerAppleSession` 把 fresh
  `authorizationCode` 送後端換 refresh_token 供日後撤銷。
- **已知限制**：後端 refresh_token 儲存目前是 foundation stub（`api/lib/apple-token-store.ts`），
  撤銷端點會回 `501 apple_deletion_not_implemented`。為確保「App 內可刪除帳號」這條硬性規範可運作，
  刪除採 best-effort 撤銷 + 一律完成本機資料刪除；後端撤銷實作為後續工作
  （AUTH-Architecture §5.4 purge、`api/auth/delete-account.ts` TODO）。

### 環境變數

於 Vercel / `.env`（勿提交，見 `.env.example`）：

| 變數 | 用途 |
| --- | --- |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | iOS Google OAuth client（reversed-scheme 導回） |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | web / fallback Google client |
| `APPLE_TEAM_ID` / `APPLE_CLIENT_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | 後端 Apple 撤銷（Vercel，未上線） |

`APPLE_CLIENT_ID` native 為 bundle id `com.dicoge.holohunter`（後端驗 token 的 `aud` 白名單需涵蓋）。

### 驗收對照（DIC-664）

| 驗收項 | 覆蓋方式 |
| --- | --- |
| Apple login 新 / returning user | 原生流程；returning 保留首次 name/email |
| Google login 新 / returning user | iOS OAuth client；`findOrCreateHoloUser` 命中既有 `sub` |
| Apple → Google、Google → Apple 綁定 | `linkNewProvider` 走各平台流程，同一 `internalId` |
| 解除綁定最後一個 provider 被阻擋 | `unlinkProvider` 於 `<= 1` 拋錯 |
| Apple private relay / hide email 正確處理 | 身份鍵不含 email；空值不覆寫 |
| credential state / revoked / re-auth | 啟動 `verifyAppleCredential` |
| 刪除帳號入口與資料刪除 | `SettingsScreen` + `deleteAccount`（後端撤銷 best-effort，見已知限制） |

### 驗證

- `npx tsc --noEmit` 通過。
- `npm run build`（Expo web export）成功。
- 原生 iOS 端到端（Apple / Google 登入、綁定、撤銷後強制登出）需在 iOS 模擬器 / TestFlight +
  真實 Google iOS client / Apple sandbox 帳號驗證（見 DIC-666 QA）。

### CR DIC-855（第一輪 FAIL）回應

第二輪針對 code review 的 client 端可修正項目做了聚焦修正：

- **#3 iOS Google fail-closed**：`googleClientId()` 在 iOS 缺 `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`
  時直接拋錯，**不**再靜默退回 web client（web client 的 aud / 導回 URI 與原生流程不符）。
  新增 `app.config.js` 動態 config，把 reversed-client-id scheme 注入 iOS `CFBundleURLTypes`。
- **#5 Apple 憑證素材保存 + fail-safe**：綁定（linking）與登入一致，皆保存 fresh
  `authorizationCode`（`registerAppleSession`），否則綁進來的 Apple 帳號日後無法撤銷。
  憑證狀態改為 `getAppleCredentialStatus()` 回 `authorized|revoked|unknown|not_applicable`，
  查詢失敗回 `unknown`（**不再**於 catch 回 true 佯稱已授權）；只有 `revoked` 才強制登出。
- **#2 刪除誠實回報**：`deleteAccount` 回 `{ localDataDeleted, serverRevoked, reason }`。本機資料
  一定刪除，但 501 / stub / local-only **不**被當成「Apple 授權已撤銷」；未確認時 store 記錄
  `account_deletion_partial`，UI 不得宣稱已完全刪除。
- **#6 Expo SDK 54 對齊**：`expo install` 修正 `expo-auth-session`（57→~7.0.11）、`expo-crypto`、
  `expo-web-browser` 的 major 版本不符；移除 config 非法欄位 `privacyPolicyUrl`/`supportUrl`
  （移入 `extra`）；單一 config 來源（`app.base.json` + `app.config.js`）。`npx expo-doctor` 18/18 通過。
- **#7 針對性測試**：抽出 platform-free 身份邏輯 `src/services/auth/identityStore.ts`（僅
  import type，可獨立測試），新增 `scripts/test-identity-store.mjs`（`npm run test:identity-store`）
  覆蓋 新建 / private-relay 空值不覆寫 / email 非身份鍵 / 綁定 / collision / already-linked /
  解綁保留最後一個 共 7 案，全數通過。

**仍屬後端範圍（無法於本 client repo 滿足，需 DIC-662 後端實作）**：#1 server-authoritative
one-account-across-devices、#4 DB transaction/lock 下的原子性、以及 #2 真正 fail-closed 的
伺服器刪除 + Apple 授權撤銷。本機 `holohunter-users` 表為 PoC 替身；`api/auth/*` 目前是 501 stub。

### 後續（非本任務範圍）

- 以真正的後端 `POST /api/auth/login|link`（AUTH-Architecture §5/§6）取代本機 `holohunter-users` 表，
  提供跨裝置單一帳號、transaction/lock 原子性（CR #1/#4）。
- 後端 Apple refresh_token 儲存 + 撤銷實作，讓刪除帳號可真正 fail-closed（CR #2）。
- 依 Apple HIG 於 iOS 改用官方 `AppleAuthentication.AppleAuthenticationButton`（目前為自訂按鈕，
  功能等效；HIG polish item，位於 `LoginScreen.tsx`，與未合併的 PR #70 相同檔案，待其合併後再改）。
