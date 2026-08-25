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
| `preview` | 直接安裝測試（ad-hoc，**preview environment**） | internal distribution build | APK | （選）Play `internal` track，`draft` |
| `production` | 正式測試軌道 | store build → **TestFlight** | AAB | iOS TestFlight／Android Play `internal` track |
| `production-apk` | **正式內容側載 APK**（DIC-1193） | 不適用（Android only） | release 簽章 APK | 無（APK 不進商店） |

`submit.production.ios` 與 `submit.production.android` 的欄位結構已補齊，目前是 placeholder（見下方「blocked-on-user」）。

`production-apk` 以 `extends: production` 定義，因此 environment／env／版本策略與正式 AAB **完全同源**，只有容器不同（APK 而非 AAB）、distribution 改為 `internal` 以便直接下載安裝。這份對齊由 `npm run test:release-apk-pipeline` 在 CI 上把關；改動 profile 而讓兩者漂移會直接讓 CI 失敗。

### ⚠️ 三種 Android 產物不可混用

| 來源 | 簽章 | 內容 | 可否交給測試員 |
| --- | --- | --- | --- |
| `Build Android APK (DEBUG-ONLY)` workflow（`assembleDebug`） | **debug keystore** | debug 變體 | ❌ 絕對不可，artifact 名為 `holohunter-DEBUG-ONLY-apk` 並附 `DEBUG-ONLY.txt` |
| EAS `preview` profile | EAS release 簽章 | **preview environment** | ⚠️ 只能當 pipeline 煙霧測試，不是正式內容 |
| EAS `production-apk` profile | EAS release 簽章 | production environment | ✅ 這是唯一的「正式內容測試 APK」 |

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
4. build 進度看 EAS 網站（`preview` / `production` 用 `--no-wait` 觸發後立即返回；`production-apk` 例外，會等到產物出來並驗簽，見方式 A-2）。

### 方式 A-2：正式內容側載 APK（`production-apk`，DIC-1193）

Actions → **EAS Build (Test Tracks)** → Run workflow：`platform=android`、`profile=production-apk`、`submit=false`。

workflow 對這個 profile 是 fail-closed 的，任一條不成立就直接失敗、不會產出可交付的 APK：

1. **來源 ref**：只接受 `main`，或 `v*` tag 且該 commit 必須是 `origin/main` 的祖先（側分支切出來的 tag 會被擋）。
2. **平台／submit**：`platform` 必須是 `android`；`submit=true` 會被拒（APK 不進 Play，商店軌道請用 `production` 的 AAB）。
3. **等待產物**：這個 profile 不用 `--no-wait`——簽章與 SHA-256 必須在同一個 run 內驗完。
4. **簽章驗證**：`apksigner verify --verbose --print-certs`；輸出若含 `CN=Android Debug` 立即失敗。
5. **Provenance**：`build-provenance.json` 記錄 full commit SHA、ref、version／versionCode、EAS build id、APK SHA-256、簽章 DN 與憑證 SHA-256，同時寫進 job summary。任一欄位讀不到（EAS JSON schema 變動、apksigner 輸出格式漂移）就 fail，不會產出「欄位空白」的交付紀錄。

產出的 artifact `holohunter-production-apk` 內含 APK、`build-provenance.json`、`apksigner-verify.txt`（保留 14 天）；EAS build 頁面本身是長期來源。交付時附上 **EAS build 連結 + APK SHA-256 + commit SHA**，讓收件人能自行比對。

### 方式 B：本機 EAS CLI

```bash
cd hunterCard
npx eas login
# 直接安裝測試包
npx eas build --platform ios --profile preview
npx eas build --platform android --profile preview
# 正式測試軌道
npx eas build --platform all --profile production
# 正式內容側載 APK（DIC-1193）
npx eas build --platform android --profile production-apk
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

## 出「正式內容 APK」前的 Gate（DIC-1193）

CI 只能保證產物是 release 簽章、內容來自 production environment；「這包值不值得給人裝」仍是人為判斷。觸發 `production-apk` 前逐項確認：

1. 所有列為正式內容 blocker 的修正都已合併進 `main`（例：DIC-1192 正式版手機搜尋間距）。
2. `main` 的 CI 是綠的，且要出的 commit 就是當下最新 `main`——**不得從舊 SHA 補出「正式包」**。
3. 正式內容清單／隱藏項（Store MVP flags）已與正式站對齊。

安裝後的驗收（QA）：

- `apksigner verify --verbose --print-certs` PASS 且**不是** Android debug 憑證（CI 已擋，交付時重驗一次）。
- 全新安裝、冷啟動、Google／guest 登入（依 Android 目前支援）、搜尋 `hBP04`、收藏／同步 smoke。
- 不出現 TEST banner；不連 staging URL／KV／Sandbox payment。
- feature flag 行為與正式站一致。

交付內容固定三件：**APK 檔**、**EAS build 連結**、**APK SHA-256**（加上 commit SHA / versionCode）。

### Play Internal Testing 的誠實回報

`production` AAB 送 Play 需要 `GOOGLE_SERVICE_ACCOUNT_JSON`。secret 未設時 workflow 會在 submit 步驟 fail 並印出 blocker——此時**只能說「AAB 已產出、尚未上架」並附 blocker**，不得描述成已進 Internal Testing。真的上架後才附 tester opt-in URL。

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
3. Actions 跑 `preview` build（`platform=android`, `submit=false`）驗證 build pipeline OK——**preview 是 pipeline 煙霧測試，不是正式內容包**；要發給測試員直接安裝的正式內容 APK 走 `production-apk`（方式 A-2）。
4. 建 Play service account → 填 `GOOGLE_SERVICE_ACCOUNT_JSON` secret。
5. Actions 跑 `production` build（`platform=android`, `submit=true`）→ 進 Play internal。
6. 依「測試員怎麼加（Android）」邀人，於「版本紀錄」處確認 build 出現。

**後續：iOS / TestFlight（等 iOS 帳號就緒，晚點）**

7. 完成 DIC-637（Apple Developer Program），在 App Store Connect 建立 App。
8. 填 `eas.json` iOS submit 欄位。
9. Actions 跑 `production` build（`platform=ios`, `submit=true`）→ 進 TestFlight，邀 iOS 測試員。
