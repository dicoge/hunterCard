# HoloHunter — 測試軌道發佈（TestFlight + Play Internal testing）

> HoloHunter 是**非官方**（fan-made / unofficial）hololive OFFICIAL CARD GAME 查價工具。所有商店 / 測試說明文字不可寫成官方授權 App。

> 🚦 **目前優先序（2026-07-30 使用者指示）：先 Android（Play Internal testing），iOS / TestFlight 標為後續。**
> Play Console 帳號**已註冊**；Android 軌道可先推進、不被 iOS 阻塞。iOS 相關步驟（TestFlight、Apple Developer Program、iOS submit 欄位）維持文件備用，等 iOS 帳號就緒（晚點）再啟動。凡標 **[iOS · 後續]** 的段落現階段可略過。

這份文件是「怎麼把測試包發給測試員 + 在哪看版本紀錄」的**操作速查**。
每個步驟的完整說明、blocker 排解、可直接貼上的商店文案在
[`docs/release-testflight-google-play-closed-testing.md`](./release-testflight-google-play-closed-testing.md)（DIC-644 手冊），本文件只在需要時連過去，不重覆。

---

## 名詞對照（重要）

| 需求 | iOS | Android |
| --- | --- | --- |
| 「像 TestFlight 一樣裝測試包」 | **TestFlight**（App Store Connect） | **Google Play 內部測試 Internal testing** |
| 沒有官方 TestFlight 的平台 | — | Android 沒有官方 TestFlight，Internal testing 是對等物 |
| 版本紀錄在哪看 | App Store Connect → TestFlight → Builds | Play Console → 測試 → 內部測試 → Releases |

兩條軌道都建，使用者兩邊都能裝測試包 + 看 build 歷史。

---

## 專案設定（已確認）

- Expo slug：`holohunter`／owner：`dicoge`
- EAS projectId：`ca0d046f-cb70-4a42-b36c-2d7f7e01482d`
- iOS bundle id / Android package：`com.dicoge.holohunter`
- 版本策略：`eas.json` 已設 `appVersionSource: "remote"` + `preview`/`production` 皆 `autoIncrement: true`
  → build number / versionCode 由 EAS 雲端自動遞增，**不需手動改** `app.json`，避免重複 build 被退件（最常見的第二次送審 blocker）。

### `eas.json` build / submit profile 對應

| Profile | 用途 | iOS 產出 | Android 產出 | submit 目的地 |
| --- | --- | --- | --- | --- |
| `preview` | 直接安裝測試（ad-hoc） | internal distribution build | APK | （選）Play `internal` track，`draft` |
| `production` | 正式測試軌道 | store build → **TestFlight** | AAB | iOS TestFlight／Android Play `internal` track |

`submit.production.ios` 與 `submit.production.android` 的欄位結構已補齊，目前是 placeholder（見下方「blocked-on-user」）。

---

## 出測試包的兩種方式

### 方式 A：GitHub Actions 手動觸發（推薦，不需本機環境）

工作流程：`.github/workflows/eas-build.yml`（`workflow_dispatch` only，不會在 push 時自動跑）。

1. 先確認 `main` 的 **CI** workflow 是綠的。
2. GitHub → Actions → **EAS Build (Test Tracks)** → Run workflow，選：
   - `platform`：`ios` / `android` / `all`
   - `profile`：`preview`（直接安裝）或 `production`（TestFlight / Play internal）
   - `submit`：`true` 時 build 完自動送商店（需先備妥憑證，見下）
3. 需要的 repo secret：
   - `EXPO_TOKEN`（**必填**）：Expo dashboard → Account → Access Tokens。沒設會 fail-fast。
   - `GOOGLE_SERVICE_ACCOUNT_JSON`（Android `submit=true` 才需要）：Play service account 的 JSON 全文。workflow 在送出時寫成 `./google-service-account.json`（git-ignored），跑完 `always()` 刪除。**不進 git**。
4. build 進度看 EAS 網站（workflow 用 `--no-wait` 觸發後立即返回）。

### 方式 B：本機 EAS CLI

```bash
cd hunterCard
npx eas login
# 直接安裝測試包
npx eas build --platform ios --profile preview
npx eas build --platform android --profile preview
# 正式測試軌道
npx eas build --platform all --profile production
# 送商店
npx eas submit --platform ios --profile production --latest       # -> TestFlight
npx eas submit --platform android --profile production --latest    # -> Play internal
```

---

## 測試員怎麼加

### iOS（TestFlight）
1. App Store Connect → HoloHunter → TestFlight。
2. **Internal Testing**：把 Apple ID 加進 App Store Connect 使用者（≤100 人，需在團隊內），加到 Internal group，免審即可裝。
3. **External Testing**：建 group、加測試員 email、填 Test Information、送 Beta App Review（首個 external build 需審）。
4. 測試員裝 App Store 的 **TestFlight** App，用受邀 Apple ID 登入即可看到 HoloHunter。

### Android（Play Internal testing）
1. Play Console → HoloHunter → 測試 → 內部測試。
2. 建立 / 選 tester email 清單（Google 帳號），或用 email list。
3. 上傳 AAB 後建 release、複製 **opt-in URL** 給測試員。
4. 測試員在該裝置的 Play 帳號點 opt-in URL → 接受 → Play 商店即可下載測試版。

> 需要使用者回報的名單：測試用 **Apple ID**（iOS）與 **Gmail**（Android）——見下方 blocked-on-user。

---

## 在哪看版本紀錄

- **iOS**：App Store Connect → TestFlight → iOS Builds（每個 build 顯示 version + build number + 上傳時間 + 狀態）。CLI：`npx eas build:list --platform ios --limit 5`。
- **Android**：Play Console → 測試 → 內部測試 → Releases（每個 release 顯示 versionCode / versionName）。CLI：`npx eas build:list --platform android --limit 5`。

---

## 🚧 Blocked-on-user（帳號 / 憑證就緒前無法完成）

這些是 agent **不能代辦**的項目，需使用者處理後回報。**優先序：Android 先行，[iOS · 後續] 標記者不阻塞 Android。**

**Android（現在推進）**

| 項目 | 對應 | 狀態 |
| --- | --- | --- |
| Google Play Console（$25） | DIC-638 | ✅ 已註冊（2026-07-30） |
| Play Console 已建立 App（package `com.dicoge.holohunter`，**上架後不可改**） | Android | ⛔ 需建立 |
| Play service account JSON → repo secret `GOOGLE_SERVICE_ACCOUNT_JSON` | Android submit | ⛔ 需在 Play Console 建 service account 並授權 |
| repo secret `EXPO_TOKEN` | EAS build workflow | ⛔ 需在 Expo 產生並填入 GitHub secrets |
| 測試用 Gmail 名單 | 測試員邀請 | ⛔ 待使用者提供 |

**[iOS · 後續]（等 iOS 帳號就緒再啟動，晚點）**

| 項目 | 對應 | 狀態 |
| --- | --- | --- |
| Apple Developer Program 帳號 | DIC-637 | 🕓 後續（iOS 晚點） |
| `eas.json` `submit.production.ios`：`appleId` / `ascAppId` / `appleTeamId` | iOS submit | 🕓 後續，欄位結構已備好，待填實際值 |
| App Store Connect 已建立 App record（bundle id `com.dicoge.holohunter`） | iOS | 🕓 後續 |
| 測試用 Apple ID 名單 | iOS 測試員邀請 | 🕓 後續 |

完成後請回報：Account 就緒、App 是否已建立、測試員名單 → 交由 follow-up QA 在有 build 後驗證。

---

## 憑證 / secret 安全

- **不把任何 secret 寫進 git。** `.gitignore` 已排除 `/google-service-account.json`、`*.jks` / `*.p8` / `*.p12` / `*.key` / `*.mobileprovision`、`.env*`。
- iOS 簽章憑證（distribution cert / provisioning profile）交給 **EAS 託管**（`eas credentials`），本機與 CI 都不需持有 `.p12`。
- Android upload key 同樣可交 EAS 託管；若自管 keystore，放本機 / CI secret，**絕不 commit**。
- CI 的 service account JSON 只在 submit 步驟由 secret materialise 成檔案，跑完即刪。

---

## 一次跑通的建議順序

**現在：Android（Play Console 已註冊）**

1. Play Console 建立 App（package `com.dicoge.holohunter`，固定不可改）。
2. 填 `EXPO_TOKEN` secret。
3. Actions 跑 `preview` build（`platform=android`, `submit=false`）驗證 build pipeline OK，先發 APK 給少數測試員直接安裝。
4. 建 Play service account → 填 `GOOGLE_SERVICE_ACCOUNT_JSON` secret。
5. Actions 跑 `production` build（`platform=android`, `submit=true`）→ 進 Play internal。
6. 依「測試員怎麼加（Android）」邀人，於「版本紀錄」處確認 build 出現。

**後續：iOS / TestFlight（等 iOS 帳號就緒，晚點）**

7. 完成 DIC-637（Apple Developer Program），在 App Store Connect 建立 App。
8. 填 `eas.json` iOS submit 欄位。
9. Actions 跑 `production` build（`platform=ios`, `submit=true`）→ 進 TestFlight，邀 iOS 測試員。
