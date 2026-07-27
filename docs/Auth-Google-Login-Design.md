# HoloHunter 登入設計：Google + Apple 共通帳號（iOS / Android / Web）

對應 issue DIC-649。本文件為設計與實作計畫，涵蓋 Google Cloud Console / Apple Developer 設定、iOS / Android 原生設定、Expo/EAS build 注意事項、**共通帳號（一個 internal user 綁定多個 provider）** 的資料模型與流程，以及依六大工作流拆分的實作計畫。

## 產品決策（來自 issue，作為硬性約束）

- **不做 Email/Password**。只支援第三方帳號登入：**Google + Apple**。
- iOS 上一旦提供 Google 登入，就**必須同時提供 Sign in with Apple**（App Store Guideline 4.8）。
- **共通帳號**：同一個 HoloHunter 使用者可同時綁定 Google + Apple；用其中一個登入後可再綁另一個，綁定後收藏 / 設定 / watchlist / 推播 token 全歸同一個 internal user id。
- **不可用 email 當唯一身份依據**（Apple private relay 會隱藏 email，且不同 provider 的 email 可能不一致）。
- **不提交 client secret / 私鑰進 repo**。
- 上架版必須具備：**登出、刪除帳號、隱私權政策 / 資料刪除說明**。

### 各平台登入方式矩陣

| 平台 | Google | Apple | 備註 |
|------|--------|-------|------|
| Web | ✅ | ✅（可行則做） | Apple web 需 Services ID + domain verification |
| iOS | ✅ | ✅（必備） | 兩顆按鈕都要在，否則 4.8 被拒 |
| Android | ✅ | ⚪ 可評估、非首要 | Apple 在 Android 需 web-based OAuth，優先度低 |

## 現況（repo 盤點）

- Expo SDK ~54，React Native 0.81，`newArchEnabled: true`。
- 已安裝 `expo-dev-client` → 可用原生模組，**不受 Expo Go 限制**。
- 狀態管理：Zustand + `persist`，storage 平台分流（native = AsyncStorage，web = localStorage）。
- 後端：Vercel serverless functions（`api/`）+ Vercel KV。
- `bundleIdentifier` / Android `package` 皆為 `com.dicoge.holohunter`。EAS 已設定。
- **目前沒有任何 auth、使用者概念或 web login** → 三端都要新建。

## 技術選型

| 平台 | 方案 | 套件 |
|------|------|------|
| iOS / Android Google | 原生 Google SDK（拿 `idToken`） | `@react-native-google-signin/google-signin` + config plugin |
| iOS Apple | 原生 Sign in with Apple | `expo-apple-authentication` |
| Web Google | Google Identity Services | GIS button（或 google-signin web） |
| Web Apple | 受管代管 OAuth | Firebase Auth 或 Supabase Auth（Apple web provider） |
| 後端驗證 | 驗 idToken 簽章 + audience | `google-auth-library`；Apple 驗 Apple 公鑰 |

選原生 Google SDK 而非純 `expo-auth-session`：UX 較好、直接回傳可被後端驗證的 `idToken`，且已有 `expo-dev-client`，原生模組無障礙。

---

## 交付 A：共通帳號資料模型（users + identities）

核心原則：**internal user id 是身份主鍵，provider 帳號是掛在其下的 identity；email 只是快照、絕不當身份依據。** 前端（iOS/Android/Web）只負責拿 provider 的 `idToken` 交給後端，後端統一驗證並映射到內部使用者。

### 邏輯 schema

```ts
// users：內部使用者（身份主鍵）
interface User {
  id: string;              // 內部 UUID（PK，所有使用者資料的 owner）
  displayName: string | null;
  photoUrl: string | null;
  primaryEmail: string | null;  // 僅顯示用，非身份依據，可為 null
  createdAt: string;
  updatedAt: string;
}

// identities（linked_auth_providers）：一個 user 可掛多個 identity
interface Identity {
  provider: 'google' | 'apple';
  providerSub: string;     // provider 的穩定 subject（Google/Apple 的 `sub`）
  userId: string;          // -> User.id
  emailAtLink: string | null;   // 綁定當下的 email 快照（可能是 relay，可能之後拿不到）
  isPrivateRelay: boolean;      // Apple private relay email
  linkedAt: string;
  // 約束：UNIQUE(provider, providerSub)；同一 user 每個 provider 至多一組 identity
}
```

### Vercel KV 索引

- `user:{id}` → `User`
- `identity:{provider}:{sub}` → `userId`（登入 / 綁定時用來找回既有帳號）
- `user:{id}:identities` → `Identity[]`（該 user 綁了哪些 provider；用來擋「解除綁定後至少保留一個」）

「共通」的落地：所有使用者資料（watchlist、settings、favorites、push token）一律以 `userId` 為 owner key（例如 `watchlist:{userId}`）。綁定 / 合併時只要重新指向同一個 `userId`，資料自然歸戶。

---

## 交付 B：登入 / 綁定 / 解除綁定 / 刪帳號流程

### 1. 登入（`POST /api/auth/session`）
1. 前端拿 provider `idToken`（native SDK 或 web）。
2. 後端驗 idToken 簽章 + audience（Google 三個 client ID 都要在允許 audience；Apple 驗 Apple 公鑰與 Services ID / bundle id）。
3. 取 `sub` 查 `identity:{provider}:{sub}`：
   - **命中** → 回該 `userId` 的 session。
   - **未命中** → 建新 `User` + 新 `Identity` → 回 session。
4. 後端簽自家 session（短效 JWT + refresh，或 KV-backed token）。前端存放：native 用 `expo-secure-store`，web 用 httpOnly cookie。

### 2. 綁定第二個 provider（`POST /api/auth/link`，需已登入）
1. 帶現有 session + 第二個 provider 的 `idToken`。
2. 驗 idToken，查 `identity:{provider}:{sub}`：
   - **未命中** → 直接把該 identity 掛到目前 `userId`（前提：目前 user 尚未綁該 provider）。完成。
   - **命中且指向同一 user** → 已綁定，no-op。
   - **命中且指向不同 user** → **provider collision**，進入交付 C 的處理。

### 3. 解除綁定（`DELETE /api/auth/link`）
- 先數 `user:{id}:identities`；若移除後 **< 1** → 拒絕（`至少保留一個登入方式`）。
- 通過則刪 `identity:{provider}:{sub}` 並從 `user:{id}:identities` 移除。

### 4. 刪除帳號（`DELETE /api/auth/account`，上架必備、須可在 app 內完成）
級聯刪除：該 user 的所有 `identity:{provider}:{sub}`、`user:{id}:identities`、`user:{id}`，以及所有以 `userId` 為 owner 的資料（`watchlist:{userId}`、server 端 settings、favorites），並 **unregister 推播 token**。

---

## 交付 C：Provider collision（兩個獨立帳號的安全處理）

情境：使用者先用 Google 建了帳號 A（有 watchlist），又用 Apple 另外建了帳號 B（有別的資料），事後想把 Apple 綁到 A → Apple identity 已指向 B。

**分層策略（v1 保守、v2 再自動化）：**

1. **預設：拒絕（reject）** — 回明確錯誤：「此 Apple 帳號已綁定另一個 HoloHunter 帳號」。因為跨帳號自動合併會動到不可逆的使用者資料，預設不自動做。
2. **明確合併（merge，使用者主動確認）** — 選一個保留帳號（surviving user），把另一帳號的資料（watchlist / settings / favorites / push token）**遷移**到 surviving，重新指向所有 identity 的 `userId`，再刪除被清空的帳號。要求：
   - 兩邊都要重新驗證（re-auth）確認擁有權。
   - 遷移需 **idempotent + 可稽核**（記錄 merge 事件），衝突資料（同一 key 兩份）要有合併規則（union / 較新者優先）。
3. **轉移單一 identity（transfer）** — 把某 identity 從 A 搬到 B；等同「A 解除綁定 + B 綁定」，且必須確保 A 移除後仍 **保有 ≥1 登入方式**，否則 A 變孤兒。

> 建議：**v1 出貨 = 拒絕 + 引導式手動合併（客服 / 明確確認流程）**；全自動 merge 列為 v2，須配完整資料遷移與雙重確認。

---

## 交付 D：Google Cloud Console OAuth client

建 **三個** OAuth 2.0 Client ID（同一 GCP 專案）：

1. **Web client** — (a) Web Google 登入；(b) 當 mobile 的 `webClientId`/`serverClientId` 讓後端能驗 idToken。會有 **client secret**（App 端不需要也不可放；僅在後端需 offline refresh token 時放 Vercel env）。
2. **iOS client** — Bundle ID `com.dicoge.holohunter`；產生後取得 iOS client ID 與 reversed client ID（URL scheme）。
3. **Android client** — Package `com.dicoge.holohunter` + **SHA-1 指紋**（見交付 F）。

> 所有 client ID 皆公開值，可入 repo；真正機密只有 Web client secret 與 service account 金鑰。

## 交付 E：iOS — URL scheme / reversed client id / bundle id + Apple

- **Bundle ID**：`com.dicoge.holohunter`（已在 `app.json`）。
- **Reversed client ID / URL scheme**：iOS client ID `1234...-abc.apps.googleusercontent.com` 反轉為 `com.googleusercontent.apps.1234...-abc`，即要註冊的 URL scheme。
- config plugin（build 時寫進 `Info.plist`）：

```jsonc
"plugins": [
  // ...既有 plugins...
  [
    "@react-native-google-signin/google-signin",
    { "iosUrlScheme": "com.googleusercontent.apps.1234567890-abcdef" }
  ]
]
```

- Sign in with Apple（iOS 必備）：
```jsonc
"ios": { "bundleIdentifier": "com.dicoge.holohunter", "usesAppleSignIn": true }
```
並在 Apple Developer 的 **App ID** 開啟 "Sign in with Apple" capability。

## 交付 F：Android — package + SHA-1 / SHA-256

- **Package**：`com.dicoge.holohunter`（已在 `app.json`）。
- Android OAuth client 驗「package + 簽章憑證指紋」，**每一把會簽 app 的 keystore 都要把 SHA-1 加進 Android client**，通常三把：
  1. **EAS build keystore** — `eas credentials`（Android → 該 profile）列出 SHA-1/SHA-256。
  2. **本機 debug keystore** — `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`。
  3. **Google Play App Signing 憑證** — Play Console → App integrity → App signing key certificate 的 SHA-1/SHA-256。**最常被漏**：正式版由 Play 重新簽章，漏了會導致「開發版能登入、上架版登入失敗」。
- 建議 SHA-1 + SHA-256 都登錄。

## 交付 G：Web Apple 登入（Firebase / Supabase）Apple Developer 設定

若 Web Apple 走 Firebase Auth 或 Supabase Auth 的 Apple provider，Apple Developer 需要：

- **Services ID**（與 iOS App ID 不同的一個 identifier，類型為 "Services IDs"），例如 `com.dicoge.holohunter.web` —— 這是 web OAuth 的 `client_id`。
- 在該 Services ID 開啟 "Sign in with Apple"，並關聯 **primary App ID**（`com.dicoge.holohunter`）。
- **Return URLs / redirect URI**（代管商的 callback）：
  - Firebase：`https://<project>.firebaseapp.com/__/auth/handler`
  - Supabase：`https://<project-ref>.supabase.co/auth/v1/callback`
- **Domains and Subdomains（domain verification）**：登記正式站網域；Apple 要求把 `apple-developer-domain-association.txt` 放在網域的 `/.well-known/` 下做網域驗證。
- **Sign in with Apple 私鑰（.p8）+ Key ID + Team ID**：建一把開啟 Sign in with Apple 的 Key；`.p8` 由 Firebase/Supabase 用來簽 client secret（一個有效期最長 6 個月的 JWT）。**這是機密 → 放 Firebase/Supabase 或 Vercel env，永不進 repo。**
- 即使用代管商，最終仍要把 Apple identity **正規化進我方 users + identities**（我方 internal user id 為 source of truth）。

## 交付 H：Expo / EAS build 注意事項

- **不能用 Expo Go**：原生模組（google-signin、apple-authentication）需 dev client（已裝 `expo-dev-client`）或正式 build。
- 加 plugin 後要 **重新 build**；JS OTA 不會帶入原生設定。
- **Android SHA-1 要對到當前 build 的 keystore**：dev / production / Play App Signing 三者都要登錄。
- **iOS**：`usesAppleSignIn: true` 需 Apple 付費開發者帳號與 App ID capability。
- **不提交機密**：`app.json` 只放公開 client ID / reversed client ID；Web client secret、Apple `.p8`、`google-service-account.json` 走 EAS secrets / Vercel env / gitignore。

---

## 實作計畫：六大工作流（對應 issue 指定的任務拆分）

各工作流建議開為 DIC-649 的 sub-issue（見本 issue 留言的拆分）。依賴關係：**工作流 1（架構）為地基**，2/3/4 完成架構後可並行，5/6 收尾。

### 1. AUTH 架構（後端 users + identities，Stage 1，地基）
- KV schema：`user:`、`identity:`、`user:{id}:identities`。
- `api/auth/session.ts`（login/upsert，Google + Apple audience 清單）。
- `api/auth/link.ts`（綁定）、`DELETE`（解除，擋「至少保留一個」）。
- collision 策略：reject（v1）+ merge/transfer 介面（v2）。
- `api/auth/account.ts`（刪帳號級聯）。
- session 簽發 / 驗證。
- 用假 idToken 做單元測試（upsert、索引、link、unlink 邊界、collision）。

### 2. Web Google + Apple 登入（Stage 2）
- Web Google：GIS 拿 idToken → `/api/auth/session`。
- Web Apple：Firebase/Supabase（Services ID + redirect + domain verification）→ 正規化進我方模型。
- 登入後可綁另一 provider（呼叫 `/api/auth/link`）。

### 3. iOS：Apple + Google 登入（Stage 2）
- `expo-apple-authentication` + `@react-native-google-signin`。
- LoginScreen 兩顆按鈕（Apple + Google，4.8 合規）。
- 綁定 UI（登入後於設定綁另一個）。

### 4. Mobile Google 登入（iOS + Android，Stage 2）
- `@react-native-google-signin` plugin 設定；Android 登錄三把 keystore SHA-1。
- Android 首要只做 Google；Apple 於 Android（web-based）列為後續評估。

### 5. QA / 測試（Stage 3）
- 矩陣：各平台登入、綁定、解除綁定（擋 <1）、collision（reject / merge）、刪帳號級聯、跨平台同帳號歸戶、Apple private relay email（首次拿到、後續拿不到）。

### 6. 隱私權政策 / 資料刪除說明（Stage 3）
- 隱私權政策頁；app 內可完成刪帳號；App Store / Play 上架所需的資料刪除說明與登入方式揭露。

## 待使用者提供 / 需外部帳號（我無法自行產生）

- GCP OAuth 三組 client ID + iOS reversed client id。
- Android 三把 keystore 的 SHA-1（dev / production / Play App Signing）。
- Apple Developer：App ID 開啟 Sign in with Apple；**Web Apple 另需 Services ID、redirect URI、domain verification、`.p8` + Key ID + Team ID**。
- 代管商選擇（Firebase 或 Supabase）供 Web Apple。
- Vercel env：session 簽章金鑰、（需要時）Web client secret、Apple `.p8`。
