# Android 上 Apple 登入 —— 可行性評估（非第一優先）

對應 issue **DIC-665** 的「Android Apple 評估」交付物。結論先行：**Android 上暫不實作 Apple 登入**，以文件化替代流程，理由如下。與 `docs/Web-Apple-Login-Evaluation.md`（Web Apple）互補。

## 背景

Apple 沒有 Android 原生 SDK。Android 上要做 Sign in with Apple，只能走 **Web-based OAuth**（Apple 的 `https://appleid.apple.com/auth/authorize`），在 App 內以 Custom Tabs / WebView 或系統瀏覽器開啟，登入後由 redirect 帶回授權結果。這與 iOS 的 OS 原生 Sign in with Apple 是完全不同的整合路徑。

DIC-665 的硬需求是 **Android Google 登入**；Apple 在 Android 明列為「需評估但非第一優先」。

## 技術可行性

| 面向 | 評估 |
|------|------|
| 授權流程 | 可行：Custom Tabs 開 Apple Web OAuth，`response_mode=form_post`，redirect 回帶 `id_token`。與現有 `obtainWebIdToken('apple')` 的 web 路徑同源。 |
| 後端驗證 | 可行且已具備：`api/_lib/verify-token.ts` 已能驗 Apple `id_token`（RS256 + issuer + audience + nonce + exp）。Android web-issued token 的 `aud` 會是 **Services ID**，與 Web Apple 相同，因此可共用 `appleWebAudiences()`（受 `APPLE_WEB_LOGIN_ENABLED` gate）。 |
| 身份歸戶 | 可行：拿到 Apple `sub` 後走同一 `loginOrCreate` / `linkIdentity`，歸同一 internal user id，與平台無關。 |

也就是說：**若要做，主要是前端在 Android 觸發 web-Apple 流程 + 沿用既有後端**，不需要新後端。

## 主要限制 / 風險（為何非第一優先）

1. **需要 Web Apple 的整套設定才成立**：Services ID、redirect URI、**domain verification**（`/.well-known/apple-developer-domain-association.txt`）、`.p8` + Key ID + Team ID（機密）。這些正是 `Web-Apple-Login-Evaluation.md` 尚未落地的前置；在 Web Apple 未開通前，Android Apple 無法獨立成立。
2. **redirect URI / custom scheme 在 Android 的相容性**：Apple 對 redirect URI 要求 https（web）或需經 domain 導回 App 的 App Links；純 custom scheme 支援度不如 Google，容易在真機出現「登入完卡在瀏覽器」的邊界。
3. **品牌 / 審核**：Google Play 無 Apple 的「必須提供 Sign in with Apple」條款（那是 App Store Guideline 4.8，僅約束 iOS）。Android 上沒有 Apple 按鈕**不會**造成 Play 審核問題，因此投入產出比低。
4. **UX 落差**：Android 使用者幾乎都有 Google 帳號；Apple 在 Android 使用率低，維護 domain verification / `.p8` 輪替（最長 6 個月）成本高。

## 決策與替代流程

- **暫不於 Android 實作 Apple 登入**（fail-closed）。`authStrategy.appleLoginSurface('android', …)` 對 Android **一律回傳 `disabled`**，**與 `APPLE_WEB_ENABLED` 無關**（DIC-920 blocker 3）：即使日後 Web Apple 開通、`APPLE_WEB_LOGIN_ENABLED=true`，Android 仍不暴露 web-Apple 入口，直到 App Links / redirect 有真機證據。Android 不顯示 Apple 按鈕（不呈現不可用的入口）。此行為由 `scripts/test-auth-strategy.cjs` 的 `testAndroidAppleAlwaysDisabled` 鎖定。
- **替代流程（已綁定使用者）**：已用 Google 登入的使用者若同時擁有 Apple identity，可**到 iOS 或 Web（Web Apple 開通後）完成 Apple 綁定**，之後在 Android 以 Google 登入即進入同一 internal user id —— 收藏 / 設定 / watchlist / 推播 token 皆歸戶，功能不受影響。
- **開通條件**：`APPLE_WEB_LOGIN_ENABLED=true` **本身不足以**開通 Android Apple —— `appleLoginSurface` 的 Android 分支目前是**無條件 `disabled`**（DIC-920 blocker 3）。要開通須：(1) `Web-Apple-Login-Evaluation.md` 所需的 Services ID / domain verification / `.p8` 落地；(2) 明確改寫該 Android 分支（移除 hard-disable）並接到既有 web-Apple 流程（前端 Custom Tabs + 沿用後端驗證）；(3) **在 Android 真機驗收 App Links / redirect 回帶**後才可上線。在 (3) 之前，Android 一律不顯示 Apple 入口。

## 驗收對照（DIC-665）

- Android Google 登入：**本 PR 實作**（見 `Android-Google-Native-Login.md`）。
- Android Apple 登入：**文件化暫不實作與替代流程**（本文件）——符合「若風險高，文件化暫不實作與替代流程」。
