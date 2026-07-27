# HoloHunter TestFlight / Google Play Closed Testing 發佈流程

> HoloHunter 是非官方 hololive OFFICIAL CARD GAME 輔助查價工具。商店資料不可寫成官方授權 App；建議用「fan-made / unofficial companion tool」表述。

## 目前專案設定確認

- Expo app name：`HoloHunter`
- Expo slug：`holohunter`
- Expo owner：`dicoge`
- EAS projectId：`ca0d046f-cb70-4a42-b36c-2d7f7e01482d`
- iOS bundle id：`com.dicoge.holohunter`
- Android package name：`com.dicoge.holohunter`
- Store build profile：`production`
  - iOS：store distribution
  - Android：`app-bundle`，輸出 AAB

## 0. 發佈前檢查

- [ ] `app.json` 的 `expo.version` 已更新。
- [ ] 若已送過商店，不再改 `ios.bundleIdentifier` / `android.package`。
- [ ] App icon、splash、名稱、相機權限文案已確認。
- [ ] 確認 App 內文字不宣稱官方授權。
- [ ] 準備 Apple Developer Program 帳號。
- [ ] 準備 Google Play Console developer account。
- [ ] 本機可執行：`npx eas --version`，且符合 `eas.json` 要求 `>= 15.0.0`。
- [ ] 已登入 Expo/EAS：`npx eas login`。

---

## 1. iOS：EAS Build → App Store Connect → TestFlight

### 1.1 Apple / App Store Connect 準備

需要使用者先提供或完成：

- [ ] Apple Developer Program 已開通。
- [ ] Apple ID：可登入 App Store Connect。
- [ ] Apple Team ID。
- [ ] Bundle ID：建議沿用 `com.dicoge.holohunter`。
- [ ] App Store Connect App record 已建立，或同意讓 EAS submit 建立/連接。
- [ ] App 名稱：`HoloHunter`，若被佔用需準備替代名稱。
- [ ] SKU：例如 `holohunter-ios`。
- [ ] 隱私權政策 URL。
- [ ] Support URL / Marketing URL（可用同一個專案頁或網站）。
- [ ] 測試者 email 清單或 TestFlight group 名稱。

### 1.2 建立 iOS production build

```bash
cd hunterCard
npm install
npx eas login
npx eas build --platform ios --profile production
```

首次執行時 EAS 會詢問 Apple 憑證：

- 建議選擇 EAS managed credentials。
- 需要登入 Apple 帳號。
- 若問 Team，選正確 Apple Team ID。
- 若問 Bundle Identifier，確認是 `com.dicoge.holohunter`。

### 1.3 上傳到 App Store Connect

可用 EAS Submit：

```bash
cd hunterCard
npx eas submit --platform ios --profile production --latest
```

目前 `eas.json` 的 iOS submit 欄位仍是 placeholder：

```json
{
  "appleId": "YOUR_APPLE_ID@example.com",
  "ascAppId": "YOUR_ASC_APP_ID"
}
```

正式 submit 前需改成實際 Apple ID / App Store Connect App ID，或在互動式 submit 時輸入。

也可從 EAS build 頁下載 `.ipa`，用 Transporter 手動上傳。

### 1.4 App Store Connect / TestFlight 設定

- [ ] App Store Connect → My Apps → HoloHunter。
- [ ] 等 build 處理完成，通常狀態會從 Processing 變成可選。
- [ ] 填寫 Export Compliance。
  - 若沒有加密或只用標準 HTTPS，通常選擇不使用特殊加密。
- [ ] 填寫 Test Information。
  - What to Test：貼上本文件下方文案。
  - Beta App Description：貼上本文件下方文案。
  - Feedback Email：填可收信地址。
  - Privacy Policy URL：填實際 URL。
- [ ] Internal Testing：加入內部測試者。
- [ ] External Testing：建立 group、加入測試者、送 Beta App Review。

### 1.5 iOS 驗證 build 成功

- [ ] EAS build 頁顯示 `Finished` / `Completed`，且 artifact 可下載。
- [ ] `npx eas build:list --platform ios --limit 5` 可看到成功的 production build。
- [ ] App Store Connect 的 TestFlight build 不再是 Processing。
- [ ] 內部測試者可在 TestFlight 安裝。
- [ ] 真機驗證：啟動、搜尋、卡牌詳情、相機權限彈窗、掃描頁不崩潰。

---

## 2. Android：EAS Build AAB → Play Console → Closed testing

### 2.1 Google Play Console 準備

需要使用者先提供或完成：

- [ ] Google Play Developer account 已開通。
- [ ] Play Console app 已建立。
- [ ] App name：`HoloHunter`，若被佔用需準備替代名稱。
- [ ] Package name：確認使用 `com.dicoge.holohunter`。
- [ ] App category：Tools / Reference / Entertainment 擇一，建議避免宣稱官方。
- [ ] Developer contact email。
- [ ] Privacy Policy URL。
- [ ] Closed testing tester email list 或 Google Group。
- [ ] Google Play App Signing 啟用策略。
- [ ] 若要 EAS submit，自備 Google service account JSON，路徑對應 `./google-service-account.json`。

### 2.2 建立 Android AAB production build

```bash
cd hunterCard
npm install
npx eas login
npx eas build --platform android --profile production
```

此 profile 已在 `eas.json` 設定：

```json
{
  "android": {
    "buildType": "app-bundle"
  }
}
```

首次 Android build 會處理 keystore：

- 建議選 EAS managed keystore。
- 若已有正式 keystore，必須確認未來都能保存並使用同一份。
- 已上架過同 package name 的 app 不能任意換 signing key，除非走 Play App Signing 的 key upgrade 流程。

### 2.3 上傳 AAB 到 Play Console

手動方式：

- [ ] EAS build 完成後下載 `.aab`。
- [ ] Play Console → app → Testing → Closed testing。
- [ ] 建立 closed testing track。
- [ ] Create new release。
- [ ] 上傳 `.aab`。
- [ ] 填 release notes。
- [ ] Review release → Start rollout to Closed testing。

EAS Submit 方式：

```bash
cd hunterCard
npx eas submit --platform android --profile production --latest
```

目前 `eas.json` 設定：

```json
{
  "serviceAccountKeyPath": "./google-service-account.json",
  "track": "internal"
}
```

若目標是 closed testing，需在 Play Console / EAS submit 設定中確認 track 對應實際測試軌。沒有 service account JSON 時，先用手動上傳最穩。

### 2.4 Play Console Closed testing 必填項目

- [ ] App access：是否需要登入；若不需要選全部功能免登入。
- [ ] Ads：是否含廣告。
- [ ] Content rating questionnaire。
- [ ] Target audience and content。
- [ ] Data safety questionnaire。
- [ ] Privacy policy。
- [ ] Store listing：名稱、簡介、完整描述、截圖、icon、feature graphic。
- [ ] Closed testing tester list。
- [ ] Countries / regions。

### 2.5 Android 驗證 build 成功

- [ ] EAS build 頁顯示 `Finished` / `Completed`，artifact 是 `.aab`。
- [ ] `npx eas build:list --platform android --limit 5` 可看到成功的 production build。
- [ ] Play Console release 頁沒有阻擋錯誤。
- [ ] Closed testing track 顯示 release 已 rollout 或 waiting for review。
- [ ] 測試者透過測試連結可加入並安裝。
- [ ] 真機驗證：啟動、搜尋、卡牌詳情、相機權限彈窗、掃描頁不崩潰。

---

## 3. 使用者需提供 / 完成的帳號資訊清單

### Apple

- [ ] Apple Developer Program membership。
- [ ] Apple ID / App Store Connect 權限。
- [ ] Apple Team ID。
- [ ] App Store Connect App ID（建立 App 後取得）。
- [ ] Bundle ID 是否確認使用 `com.dicoge.holohunter`。
- [ ] 隱私權政策 URL。
- [ ] Support URL。
- [ ] TestFlight 測試者 email / group。
- [ ] App Store Connect 付款 / 稅務 / 合約狀態是否無 blocker。

### Google

- [ ] Google Play Developer account。
- [ ] Package name 是否確認使用 `com.dicoge.holohunter`。
- [ ] Google Play App Signing 選項。
- [ ] Android keystore 策略：EAS managed 或既有 keystore。
- [ ] Closed testing tester email list / Google Group。
- [ ] Privacy Policy URL。
- [ ] Developer contact email。
- [ ] 若使用 EAS submit：service account JSON。

### 共用商店素材

- [ ] App display name。
- [ ] Short description。
- [ ] Full description。
- [ ] Screenshots：iPhone、Android phone；若支援 iPad，補 iPad 截圖。
- [ ] App icon / feature graphic。
- [ ] 隱私權政策內容。
- [ ] 測試帳號（若 App 未來需要登入）。

---

## 4. 常見 blocker 與處理方式

### Apple Team ID

- Blocker：EAS 無法建立 provisioning profile / certificate，或選到錯 team。
- 處理：請使用者提供 Team ID，並確認 Apple ID 在該 team 有 App Manager 或 Admin 權限。

### Android keystore

- Blocker：keystore 遺失或與 Play Console 既有 app 不匹配。
- 處理：首次上架前決定使用 EAS managed keystore；若已有 Play Console app，先確認 signing key。不要隨意清掉或重建 keystore。

### Package name immutable

- Blocker：Android `applicationId` / package name 一旦在 Play Console 建立後不可修改。
- 處理：上傳第一版前再次確認 `com.dicoge.holohunter`。若要改，只能建立新 Play app。

### iOS bundle identifier

- Blocker：Bundle ID 與 App Store Connect record 不一致。
- 處理：維持 `com.dicoge.holohunter`，並確認 App Store Connect 使用同一個 Bundle ID。

### Privacy questionnaire / Data safety

- Blocker：App Store Connect 或 Play Console 不允許送審。
- 處理：先盤點資料收集。HoloHunter 目前至少有相機權限；若沒有帳號系統、廣告 SDK、分析 SDK，資料收集聲明可較簡化，但仍需確認 API / push notification / 儲存行為。

### 相機權限

- Blocker：商店審查認為權限用途不清楚。
- 處理：描述為「掃描卡牌文字 / 圖像以搜尋卡牌資訊」，不要寫成官方驗證或官方資料服務。

---

## 5. 可直接貼上的文案

### 非官方聲明

```text
HoloHunter is an unofficial companion tool for hololive OFFICIAL CARD GAME players. It is not affiliated with, endorsed by, or sponsored by COVER Corporation or the official hololive OFFICIAL CARD GAME project.
```

繁中版本：

```text
HoloHunter 是為 hololive OFFICIAL CARD GAME 玩家製作的非官方輔助工具，並非 COVER Corporation 或 hololive OFFICIAL CARD GAME 官方授權、背書或贊助的 App。
```

### TestFlight Beta App Description

```text
HoloHunter is an unofficial companion app for hololive OFFICIAL CARD GAME players. It helps testers search cards, view card details, and check reference market prices. This beta focuses on verifying search accuracy, card detail display, camera permission behavior, and general stability on real devices.
```

### TestFlight What to Test

```text
Please test:
- Launch the app and browse the home screen.
- Search by card number, member name, series code, and color.
- Open card detail pages and verify card images / price information load correctly.
- Open the scan feature and confirm camera permission behavior.
- Report crashes, missing card data, incorrect prices, layout issues, or confusing wording.

Note: HoloHunter is an unofficial companion tool and is not affiliated with or endorsed by the official hololive OFFICIAL CARD GAME project.
```

### Google Play Short description

```text
Unofficial hololive OCG card search and price reference companion.
```

### Google Play Full description

```text
HoloHunter is an unofficial companion tool for hololive OFFICIAL CARD GAME players.

Main features:
- Search cards by card number, member name, series, and color.
- View card details and images.
- Check reference market price information.
- Use camera-assisted scanning features where available.

This app is intended as a fan-made utility for card lookup and price reference. It is not affiliated with, endorsed by, or sponsored by COVER Corporation or the official hololive OFFICIAL CARD GAME project.
```

### Closed testing release notes

```text
Initial closed testing release.

Please verify card search, card detail pages, price display, camera permission behavior, and general app stability on real devices.
```

---

## 6. 建議實際執行順序

1. 先確認 Apple Team ID、Google Play package name、keystore 策略。
2. 跑 Android production AAB build，因 Closed testing 通常比 iOS 外部 TestFlight 審查資料更繁瑣但 build 驗證直接。
3. 跑 iOS production build。
4. 先開 Internal / Closed testing，不直接正式上架。
5. 真機驗證後再補商店素材與隱私問卷。
6. 若要自動提交，再補齊 `eas.json` 的 iOS `appleId` / `ascAppId` 與 Android `google-service-account.json`。
