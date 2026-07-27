# HoloHunter 登入設計：Google Sign-In（iOS + Android + Web）

對應 issue DIC-649。本文件為設計與實作計畫，涵蓋 Google Cloud Console 設定、iOS / Android 原生設定、Expo/EAS build 注意事項、共用使用者資料模型，以及分階段實作步驟。

## 產品決策（來自 issue，作為硬性約束）

- **不做 Email/Password**。只支援第三方帳號登入。
- 支援登入方式：**Google**（全平台）+ **Sign in with Apple**（iOS 必備）。
- iOS 上一旦提供 Google 登入，就**必須同時提供 Sign in with Apple**（App Store Guideline 4.8，否則審核被拒）。
- Web 版也要支援 Google 登入，且與 mobile **共用同一套使用者資料模型**。
- **不提交 client secret 進 repo**。
- 上架版必須具備：**登出、刪除帳號、隱私權政策 / 資料刪除說明**。

## 現況（repo 盤點）

- Expo SDK ~54，React Native 0.81，`newArchEnabled: true`。
- 已安裝 `expo-dev-client` → 可用原生模組，**不受 Expo Go 限制**。
- 狀態管理：Zustand + `persist`，storage 走平台分流（native = AsyncStorage，web = localStorage）。
- 後端：Vercel serverless functions（`api/`）+ Vercel KV。
- `bundleIdentifier` / Android `package` 皆為 `com.dicoge.holohunter`。
- EAS 已設定（projectId `ca0d046f-...`）。
- **目前沒有任何 auth、使用者概念或 web Google login** → 三端都要新建。

## 技術選型

| 平台 | 方案 | 套件 |
|------|------|------|
| iOS / Android | 原生 Google Sign-In SDK（拿 `idToken`） | `@react-native-google-signin/google-signin` + config plugin |
| iOS | Sign in with Apple | `expo-apple-authentication` |
| Web | Google Identity Services（GIS） | `@react-native-google-signin` 的 web 支援，或直接用 GIS button + `expo-auth-session` fallback |
| 後端驗證 | 驗證 Google `idToken` 的簽章與 audience | `google-auth-library`（Node，在 `api/` 內） |

選 `@react-native-google-signin/google-signin` 而非純 `expo-auth-session` 的原因：
- 原生 SDK 提供原生登入 UI／帳號選擇器，UX 較好，且直接回傳可被後端驗證的 `idToken`。
- 已有 `expo-dev-client`，原生模組沒有障礙。
- 有官方 Expo config plugin，`app.json` 一次設定完 iOS URL scheme 與 Android。

> 若日後想避免任何原生模組（例如要在 Expo Go 跑），退路是 `expo-auth-session` 的 PKCE 流程；但 UX 較差，且本專案已用 dev client，不建議。

## 交付 1：Google Cloud Console 要建立的 OAuth client

在同一個 GCP 專案的「APIs & Services → Credentials」建立 **三個** OAuth 2.0 Client ID：

1. **Web application client**
   - 用途：(a) Web 版登入；(b) 作為 mobile 的 `webClientId`／`serverClientId`，讓原生 SDK 回傳可被後端驗證的 `idToken`。
   - Authorized JavaScript origins：正式站網域 + `http://localhost:8081`（Expo web dev）。
   - Authorized redirect URIs：Web 若走 GIS popup/one-tap 可不需要；若走 redirect 流程再補。
   - **此 client 會有 client secret**。App 端**不需要也不可放** secret；只有在後端需要 `serverAuthCode` 換 refresh token（offline access）時，secret 放 **Vercel 環境變數**，永不進 repo。

2. **iOS client**
   - Bundle ID：`com.dicoge.holohunter`。
   - 產生後取得 **iOS client ID** 與其對應的 **reversed client ID**（URL scheme）。

3. **Android client**
   - Package name：`com.dicoge.holohunter`。
   - 需填入 **SHA-1 憑證指紋**（見交付 3）。

> 註：所有 client ID 皆為公開值（非 secret），可放進程式碼／`app.json`。真正的秘密只有 Web client 的 client secret 與（若用）service account 金鑰。

## 交付 2：iOS URL scheme / reversed client id / bundle id

- **Bundle ID**：`com.dicoge.holohunter`（已存在於 `app.json` → `ios.bundleIdentifier`）。
- **Reversed client ID / URL scheme**：iOS client ID 形如
  `1234567890-abcdef.apps.googleusercontent.com`
  反轉後為
  `com.googleusercontent.apps.1234567890-abcdef`
  這個字串就是要註冊的 **URL scheme**，Google SDK 靠它接收登入回呼。

在 `app.json` 用 config plugin 設定（build 時自動寫進 `Info.plist` 的 `CFBundleURLSchemes`）：

```jsonc
"plugins": [
  // ...既有 plugins...
  [
    "@react-native-google-signin/google-signin",
    {
      // 直接填 reversed client id，或用 GoogleService-Info.plist 也可
      "iosUrlScheme": "com.googleusercontent.apps.1234567890-abcdef"
    }
  ]
]
```

- 同時要提供 **Sign in with Apple**（iOS 硬性需求）：
  ```jsonc
  "ios": {
    "bundleIdentifier": "com.dicoge.holohunter",
    "usesAppleSignIn": true
  }
  ```
  並在 Apple Developer 的 App ID 開啟 "Sign in with Apple" capability（EAS 會用此 App ID 產 provisioning profile）。

## 交付 3：Android package name + SHA-1 / SHA-256 指紋需求

- **Package name**：`com.dicoge.holohunter`（已存在於 `app.json` → `android.package`）。
- **SHA-1 / SHA-256 指紋**：Android OAuth client 的驗證是「package name + 簽章憑證指紋」的組合，所以**每一把會簽 app 的 keystore 都要把 SHA-1 加進 Android client**。實務上通常有 **三把**：

  1. **EAS 開發 / 內部 build keystore**（`eas build` 自動管理的上傳 keystore）
     取得：`eas credentials`（選 Android → 該 profile）會列出 keystore 的 SHA-1 / SHA-256。
  2. **本機 dev build keystore**（若跑 `expo run:android` 用 debug keystore）
     取得：`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`
  3. **Google Play App Signing 憑證**（上架後 Play 會用自己的金鑰重新簽章）
     取得：Play Console → 該 app → Test and release → App integrity → App signing key certificate 的 SHA-1／SHA-256。
     **這把最容易被漏掉**：正式版從 Play 下載安裝後，執行期的簽章是 Play 的金鑰，若沒把 Play 的 SHA-1 加進 Android client，正式版 Google 登入會失敗（開發版卻正常）。

- SHA-256 目前 Google Android client 主要驗 SHA-1，但建議一併登錄 SHA-256（未來相容 + 部分功能需要）。

## 交付 4：Expo / EAS build 注意事項

- **不能用 Expo Go**：`@react-native-google-signin` 與 `expo-apple-authentication` 是原生模組，必須 **dev client**（已裝 `expo-dev-client`）或正式 build。
- 加 plugin 後要 **重新 prebuild / 重新 build**（`eas build --profile development` 或 `preview`），JS OTA 更新不會帶入原生設定。
- **Android SHA-1 要對到當前 build 用的 keystore**：dev build 的 SHA-1 ≠ production keystore SHA-1 ≠ Play App Signing SHA-1，三者都要在 Google Console 登錄，否則「某個環境能登入、另一個不能」。
- **iOS**：`usesAppleSignIn: true` 需要對應的 Apple 付費開發者帳號與 App ID capability；EAS build 時要有可用的 credentials。
- **不提交 secret**：`app.json` 只放公開 client ID／reversed client ID。Web client secret、Google service account 金鑰（`eas.json` submit 段的 `google-service-account.json`）都走 EAS secrets / Vercel env / gitignore，不進 repo。
- 若採用 `GoogleService-Info.plist` / `google-services.json`（Firebase 風格）也可，但本設計走「純 client ID」路線就不需要這兩個檔，減少要管理的機密檔。

## 交付 5：共用使用者資料模型（mobile 與 web 共用）

核心原則：**前端（iOS/Android/Web）只負責拿到 provider 的 `idToken`，把 token 交給後端；後端統一驗證並產生自家 session。** 三端因此天然共用同一個使用者模型。

### 後端使用者物件（存 Vercel KV）

```ts
// api/lib/user.ts
export type AuthProvider = 'google' | 'apple';

export interface User {
  id: string;              // 自家 UUID（primary key）
  provider: AuthProvider;  // 'google' | 'apple'
  providerSub: string;     // provider 的穩定 subject（Google/Apple 的 `sub`）
  email: string | null;    // Apple 可能只有第一次給、且可為 relay
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  createdAt: string;       // ISO
  updatedAt: string;
}
```

KV 索引（Vercel KV）：
- `user:{id}` → `User`
- `identity:{provider}:{sub}` → `userId`（登入時用 provider+sub 找回既有 user，找不到才建新的）
- `email:{email}` →（可選）用來偵測同一 email 跨 provider

「共用」的意義：Web 和 mobile 打**同一支後端 API**（`POST /api/auth/session`），送 `{ provider, idToken }`，後端驗完簽章＋audience 後，用 `identity:{provider}:{sub}` upsert 出同一個 `User`。使用者用 Google 在 web 登入、在手機也用 Google 登入 → 同一個 `providerSub` → **同一個帳號**。

### 登入流程（token 驗證）

1. 前端拿到 Google `idToken`（native SDK 或 web GIS 回傳）。
2. `POST /api/auth/session { provider:'google', idToken }`。
3. 後端用 `google-auth-library` 的 `OAuth2Client.verifyIdToken`：
   - 驗簽章。
   - `audience` 必須是我方的 client ID（iOS / Android / Web 三個都要放進允許清單，因為不同平台發出的 idToken 的 `aud` 不同）。
4. 從 payload 取 `sub` / `email` / `name` / `picture` → upsert `User`。
5. 後端簽發自家 session（建議短效 JWT + refresh，或 KV-backed session token），回給前端。
6. 前端把 session token 存起來（native = SecureStore 建議，web = httpOnly cookie 較安全）。

Apple 流程相同，只是 `provider:'apple'`，後端改驗 Apple 的公鑰與 `aud`。

### 前端狀態（沿用 Zustand 風格）

新增 `src/store/authStore.ts`（與現有 `settingsStore` 相同的 persist 模式）：

```ts
interface AuthState {
  user: User | null;
  sessionToken: string | null;      // native 建議改存 expo-secure-store
  status: 'idle' | 'authenticating' | 'authenticated';
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;  // iOS only
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;    // 上架必備
}
```

## 交付 6：實作計畫（分階段）

**Stage 1 — 後端使用者模型 + token 驗證（可先獨立完成）**
- `api/lib/user.ts`：KV CRUD + `identity:` 索引。
- `api/auth/session.ts`：`verifyIdToken`（Google + Apple audience 清單），upsert user，簽 session。
- `api/auth/delete.ts`：刪帳號（刪 `user:`、`identity:`、關聯的 watchlist 等資料）。
- 用假 idToken / 單元測試驗證 upsert 與索引邏輯。

**Stage 2 — 加原生模組與設定（需要 GCP client ID）**
- `npx expo install @react-native-google-signin/google-signin expo-apple-authentication expo-secure-store`。
- `app.json` 加 plugin（`iosUrlScheme`）、`ios.usesAppleSignIn`。
- 在 GCP 建 Web / iOS / Android 三個 client；把三個 client ID 放進前端設定（公開值），把三個平台的 SHA-1 登錄 Android client。
- `eas build --profile development` 產 dev client。

**Stage 3 — 前端登入 UI 與狀態**
- `authStore`（Zustand + secure storage）。
- `LoginScreen`：Google 按鈕（全平台）+ Apple 按鈕（`Platform.OS === 'ios'` 才顯示）。
- 導覽：未登入導向 Login；`SettingsScreen` 加「登出」「刪除帳號」。

**Stage 4 — Web Google 登入**
- Web 用 GIS button（或 `@react-native-google-signin` web 支援）拿 idToken，打同一支 `/api/auth/session`。
- 確認 web 與 mobile 落到同一 `User`。

**Stage 5 — 上架合規**
- 隱私權政策頁 + 資料刪除說明（App Store / Play 皆要求，且刪帳號要能在 app 內完成）。
- iOS 送審確認 Google + Apple 兩顆按鈕都在（4.8 合規）。

## 待使用者提供 / 需外部帳號的項目（我無法自行產生）

- GCP OAuth 三組 client ID（需你在 Console 建立）。
- iOS reversed client ID（建 iOS client 後才有）。
- Android 三把 keystore 的 SHA-1（dev / production / Play App Signing）。
- Apple Developer App ID 開啟 Sign in with Apple。
- Vercel env：Web client secret（僅在需要 offline refresh token 時）、session 簽章金鑰。

這些一旦到位，Stage 2–4 的程式碼即可接上實際 client ID 完成端到端登入。
