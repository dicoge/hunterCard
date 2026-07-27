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

- [ ] `app.json` 的 `expo.version`（使用者可見版本，例如 `1.0.0`）已更新。
- [ ] **build number / versionCode 已處理**（見 [0.1 版本與 build number 管理](#01-版本與-build-number-管理)）。每次重送商店都必須遞增，否則會被 duplicate build 退件。
- [ ] 若已送過商店，不再改 `ios.bundleIdentifier` / `android.package`。
- [ ] App icon、splash、名稱與**所有權限用途文案**（相機、麥克風、相簿、推播）已確認（見 [0.2 權限與隱私盤點](#02-權限與隱私盤點)）。
- [ ] 確認 App 內文字不宣稱官方授權。
- [ ] 準備 Apple Developer Program 帳號。
- [ ] 準備 Google Play Console developer account。
- [ ] 本機可執行：`npx eas --version`，且符合 `eas.json` 要求 `>= 15.0.0`。
- [ ] 已登入 Expo/EAS：`npx eas login`。

### 0.1 版本與 build number 管理

> ⚠️ 這是最常見的第二次送審 blocker。`expo.version` 只是「使用者可見版本字串」（marketing version），商店真正用來判斷「這是不是新 build」的是 **iOS `buildNumber`** 與 **Android `versionCode`**。目前 `app.json` **沒有**設定 `ios.buildNumber` 與 `android.versionCode`，`eas.json` 也**沒有** `appVersionSource` / `autoIncrement`。若不處理，第二次送同一版本會被：
>
> - App Store Connect：`The bundle version must be higher than the previously uploaded version`
> - Play Console：`Version code N has already been used`
>
> 退件。以下二選一，建議用方案 A。

**兩個版本欄位的差異：**

| 欄位 | 位置 | 用途 | 是否每次遞增 |
| --- | --- | --- | --- |
| `expo.version` | `app.json` | 使用者可見版本（如 `1.0.1`），iOS 對應 CFBundleShortVersionString、Android 對應 versionName | 有意義的版本變更時 |
| iOS `buildNumber` | `app.json` `ios.buildNumber` 或 EAS remote | 同一 version 下的 build 序號 | **每次送 App Store 都要更高** |
| Android `versionCode` | `app.json` `android.versionCode` 或 EAS remote | Play 判斷新舊 build 的整數 | **每次送 Play 都要更大** |

#### 方案 A（建議）：EAS 遠端版本 + autoIncrement

讓 EAS 在雲端保存並自動遞增 build number / versionCode，本機不用手動改。

1. 在 `eas.json` 的 `cli` 加上 `appVersionSource`：

    ```json
    {
      "cli": {
        "version": ">= 15.0.0",
        "appVersionSource": "remote",
        "promptToConfigurePushNotifications": false
      }
    }
    ```

2. 在 `build.production` 兩個平台開 `autoIncrement`：

    ```json
    {
      "production": {
        "distribution": "store",
        "autoIncrement": true,
        "ios": { "resourceClass": "m-medium" },
        "android": { "buildType": "app-bundle" }
      }
    }
    ```

3. 首次可用 `npx eas build:version:set` 或直接 build，讓 EAS 建立初始版本；之後每次 `production` build，EAS 會自動把 buildNumber / versionCode +1。
4. 查目前遠端版本：`npx eas build:version:get --platform ios` / `--platform android`。

> 注意：改用 `appVersionSource: "remote"` 後，`app.json` 裡的 `ios.buildNumber` / `android.versionCode` 就不再是真實來源，以 EAS 遠端值為準。

#### 方案 B：在 app.json 手動維護

若不想用遠端版本，就在 `app.json` 明確寫死並每次手動遞增：

```json
{
  "expo": {
    "version": "1.0.0",
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "com.dicoge.holohunter",
      "buildNumber": "1"
    },
    "android": {
      "package": "com.dicoge.holohunter",
      "versionCode": 1
    }
  }
}
```

- 每次要送商店前：iOS `buildNumber` 字串 +1（`"1"` → `"2"`），Android `versionCode` 整數 +1（`1` → `2`）。
- 用此方案時，`eas.json` 不要開 `autoIncrement`，且維持預設的 `appVersionSource: "local"`（不設等同 local）。

### 0.2 權限與隱私盤點

> ⚠️ 送審前必讀。實際權限面比「只有相機」大，隱私問卷（App Privacy / Data safety）漏填會被退件或事後被商店標記不一致。以下依 `app.json` 與相依套件盤點目前的權限來源。
>
> **重要：`expo-image-picker` 目前有實際使用**（`src/screens/ScanScreen.tsx` 呼叫 `ImagePicker.launchImageLibraryAsync()`），且它會自動帶入 native 權限，是最容易被低估的來源。以「本機 `npx expo prebuild` 產生的 merged AndroidManifest.xml / Info.plist」為最終真相，下表為預期值。

| 權限 / 能力 | 來源 | iOS | Android | 送審需交代 |
| --- | --- | --- | --- | --- |
| 相機 Camera | `expo-camera`、`expo-ocr-kit`、`expo-image-picker` | `NSCameraUsageDescription` | `android.permission.CAMERA` | 掃描 / OCR 卡牌用途 |
| 麥克風 Microphone | **`expo-camera` 與 `expo-image-picker` 皆預設帶入**；`app.json` Android 已列 `android.permission.RECORD_AUDIO` | `NSMicrophoneUsageDescription` | `android.permission.RECORD_AUDIO` | **App 若不用錄音，兩個套件都要各自關閉，見下方** |
| 相簿 / 照片 Photo library | `expo-image-picker`（實際使用中） | `NSPhotoLibraryUsageDescription`、`NSPhotoLibraryAddUsageDescription` | 套件 manifest 預設宣告 `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`（舊 API level），Android 13+ 走系統 photo picker | 從相簿選卡牌圖片辨識；storage 權限需以 merged manifest 確認 |
| 推播 Push notification | `expo-notifications` plugin | Push Notifications capability（APNs） | `android.permission.POST_NOTIFICATIONS`（Android 13+） | App 是否真的送推播；若未使用建議移除 plugin |

**送審前要做的決定（每一項都要有明確答案）：**

- [ ] **麥克風**：HoloHunter 只掃圖/OCR，通常不需要錄音。麥克風權限**同時來自 `expo-camera` 與 `expo-image-picker`**，只關其中一個沒有用——兩個套件都要各自關閉，且建議在 Android 用 `blockedPermissions` 兜底，確保 merged manifest 不殘留 `RECORD_AUDIO`：

    ```jsonc
    // app.json → expo.plugins
    [
      "expo-camera",
      {
        "cameraPermission": "允許 HoloHunter 存取相機以掃描卡牌",
        "microphonePermission": false,
        "recordAudioAndroid": false
      }
    ],
    [
      "expo-image-picker",
      {
        "photosPermission": "允許 HoloHunter 存取相簿以選取卡牌圖片進行辨識",
        "cameraPermission": "允許 HoloHunter 存取相機以掃描卡牌",
        "microphonePermission": false
      }
    ]
    ```

    ```jsonc
    // app.json → expo.android，兜底阻擋（以 merged manifest 為準）
    "android": {
      "package": "com.dicoge.holohunter",
      "blockedPermissions": ["android.permission.RECORD_AUDIO"],
      "permissions": ["android.permission.CAMERA"]
    }
    ```

    改完務必以 `npx expo prebuild --clean` 產生的 `android/app/src/main/AndroidManifest.xml` 與 iOS `Info.plist` 實際確認 `RECORD_AUDIO` / `NSMicrophoneUsageDescription` 已消失。保留麥克風權限但問卷不申報，是常見退件原因；要嘛用、要嘛從**所有**來源拔掉。
- [ ] **推播**：確認 `expo-notifications` 目前還在用（`App.tsx` 啟動時註冊 push token，用於監看清單價格提醒）。若保留，App Privacy / Data safety 的 Identifiers / Device IDs 要如實申報 push token 的收集、用途、第三方傳輸（Expo Push Service）與保留政策。若已無推播功能，建議從 `plugins` 移除以縮小權限面與問卷範圍。
- [ ] **相簿**：`expo-image-picker` **目前已在 `ScanScreen.tsx` 實際使用**，屬保留權限。需在 iOS 提供 `NSPhotoLibraryUsageDescription`（用上方 plugin 的 `photosPermission`），並確認 Android storage 權限（`READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE`）在 merged manifest 的實際結果，於 Data safety 說明圖片僅在本機/伺服器辨識後如何處理。
- [ ] **以 merged manifest / Info.plist 為最終真相**：改任何權限後跑 `npx expo prebuild --clean`，用產生的原生檔核對，不要只看 `app.json`。
- [ ] **每個保留的權限**都要能對應到 App 內實際功能，並在下方問卷段落如實填寫。

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

### Build number / versionCode 重複

- Blocker：第二次送同一版本被退件（iOS `The bundle version must be higher...`；Play `Version code N has already been used`）。
- 處理：見 [0.1 版本與 build number 管理](#01-版本與-build-number-管理)。建議在 `eas.json` 開 `appVersionSource: "remote"` + `autoIncrement`，或每次手動遞增 `ios.buildNumber` / `android.versionCode`。`expo.version` 沒改不代表 build number 有遞增，兩者是不同欄位。

### Privacy questionnaire / Data safety

- Blocker：App Store Connect（App Privacy）或 Play Console（Data safety）問卷與實際權限不一致而被退件或事後標記。
- 處理：先照 [0.2 權限與隱私盤點](#02-權限與隱私盤點) 盤點。HoloHunter 的權限面**不只相機**：`app.json` 目前含 Android `RECORD_AUDIO`（麥克風）、`expo-notifications`（推播）、`expo-image-picker`（相簿）。每一個保留的權限都必須在問卷如實申報；不用的（尤其麥克風）建議先移除再送審。保留權限卻不申報，是最常見的退件與下架風險。
- **⚠️ 權限盤點 ≠ 資料收集盤點。**商店問卷不僅問「你用什麼權限」，更問「你收集什麼資料、傳去哪裡、是否與第三方分享」。
- **⚠️ Web vs Native 資料流不同，商店問卷只填 native store binary 的行為。**HoloHunter 的 Web 版會 POST 影像到 `/api/recognize-card` 再轉送 OpenRouter Gemini Vision，但 iOS/Android native binary **不走這條路**——native 用本機 OCR（`expo-ocr-kit` / Tesseract），不傳送影像到任何伺服器。以下依 native binary 實際程式碼盤點：
  - **Expo push token**（`App.tsx` → `initPushNotifications()`，僅 native，Web 跳過）：`registerForPushNotifications()` 向 Expo Push Service 取得 token → `uploadDeviceToken()` POST `/api/push/register` → 寫入 `data/push-tokens.json`（GitHub repo `main` branch）。持久裝置識別碼（Device ID），用於監看清單價格提醒推播。
  - **Watchlist**：目前僅 Zustand 本機儲存（`src/stores/watchlistStore.ts`，persist to localStorage/AsyncStorage），App binary **沒有**呼叫 `/api/push/watchlist`。商店問卷不需申報 server-side `data/push-watchlist.json`（該檔案由外部腳本/管理機制維護，非 App binary 觸發）。
  - **相機 / 相簿**：native 僅本機 OCR 處理，**不上傳影像**到任何伺服器。相機拍攝的照片也不會寫入系統相簿（僅在記憶體中暫存用於 OCR）。**商店的「collection / 收集」指資料離開裝置（off-device transmission）**——manifest 權限宣告不代表收集。Native binary 完全不傳送影像 off-device，Photos/Videos / User Content 在兩平台問卷的 collection 一律答 No。
  - **刪除現狀**：後端**沒有** unregister/delete endpoint。App 移除或關閉通知權限不會刪除 GitHub 中的 token。推播 token 持久保存於 GitHub repo，直至營運方人工刪除。Google deletion request 不可答 Yes（無實作機制），應填 No 或提供 contact email 讓使用者聯絡請求手動刪除。

### 相機 / 麥克風 / 推播 / 相簿權限用途

- Blocker：商店審查認為權限用途不清楚，或申報與實際不符。
- 處理：
  - 相機：描述為「掃描卡牌文字 / 圖像以搜尋卡牌資訊」，不要寫成官方驗證或官方資料服務。**⚠️ Web 版會上傳影像到後端/AI，但 native binary（iOS/Android）僅本機 OCR，不上傳影像**——商店問卷只填 native 行為。
  - 麥克風：若不錄音就依 [0.2](#02-權限與隱私盤點) 關閉 `expo-camera` 的麥克風並移除 `RECORD_AUDIO`；否則需說明錄音用途。
  - 推播：`expo-notifications` 目前實際使用中（價格提醒/watchlist 功能）。App 啟動時（僅 native）取得 Expo push token，上傳後端保存於 `data/push-tokens.json`（無帳號機制）。發送推播時，token 與通知內容傳輸至 Expo Push API（`exp.host`）發送。Watchlist 目前僅 Zustand 本機儲存，App binary 未呼叫 `/api/push/watchlist`；外部 server-side `data/push-watchlist.json` 不是 App binary 產生的資料。商店問卷僅申報實際 App binary 的行為（Identifiers / Device ID）。**若無推播功能，建議移除 `expo-notifications` plugin 並從此處移除說明。**
  - 相簿：說明僅用於使用者主動挑選卡牌圖片做辨識。**Native binary 僅本機處理圖片，不上傳到任何伺服器。**

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

### iOS 相機 / 麥克風 usage description（若走 bare / 手動維護 Info.plist 時可貼）

```text
NSCameraUsageDescription = 允許 HoloHunter 存取相機以掃描 / 辨識卡牌
NSMicrophoneUsageDescription = HoloHunter 使用相機模組，若不需錄音請於設定關閉麥克風權限
NSPhotoLibraryUsageDescription = 允許 HoloHunter 存取相簿以選取卡牌圖片進行辨識
```

> 正常走 Expo prebuild 時，這些字串由 `expo-camera` / `expo-image-picker` plugin 產生（`expo-image-picker` 預設也會加 `NSMicrophoneUsageDescription`），不需手改；此區塊僅供 eject / 檢查用。若已依 0.2 關閉麥克風，prebuild 後應確認 `NSMicrophoneUsageDescription` 不再出現於 Info.plist。

### App Store App Privacy 問卷（依 native binary 行為的建議答案）

> ⚠️ 下方只填 iOS native binary 的實際資料流。Web 版會 POST 影像到 `/api/recognize-card` 再轉送 OpenRouter Gemini Vision，但 native binary 不走這條路——native 用本機 OCR（`expo-ocr-kit` / Tesseract），不上傳影像。
>
> Apple App Privacy 沒有獨立的「shared with third parties」勾選項，而是按 data type 填寫 collected / purpose / linked to user / tracking。

```text
先確認以下每一項是否仍成立，再照實勾選：

- Contact Info：無帳號/註冊 → No

- Identifiers → Device ID：
  - Expo push token（ExpoPushToken[...]）→ Collected = Yes
  - Purpose：App functionality（push notification / 監看清單價格提醒）
  - ⚠️ Linked to user：Apple 的 linked 定義包含透過 device 連結。此 token 是持久裝置識別碼，應填 Linked to user identity (via device)。
  - 用於追蹤：No
  - 推播 token 會經 Expo Push Service（exp.host）處理通知遞送；Apple App Privacy 在 device ID 這欄不需要獨立 third-party sharing toggle（透過 purpose/linked/tracking framework 表達）。

- Usage Data：無帳號、無 analytics/crash SDK → No
  - ⚠️ Watchlist（監看清單）目前僅 Zustand 本機儲存（localStorage/AsyncStorage），App binary 未呼叫 `/api/push/watchlist`。外部 `data/push-watchlist.json` 非 App binary 觸發產生，不需在商店問卷申報。

- Camera：App 使用相機掃描/辨識卡牌，僅本機 OCR 處理，不上傳影像 → 於功能說明勾選相機用途。資料收集：No（僅即時本機處理，不持久保存也不傳輸）。

- Microphone：若已關閉 → No；若仍保留權限 → 需按實際用途填寫。

- User Content（Photos / Videos）→ No（Not Collected）
  - expo-image-picker 可從相簿選圖進行本機 OCR 辨識，但 native binary 不上傳影像到任何伺服器。App Store 的 collection 指資料離開裝置（off-device transmission），本機處理不構成 collection。相機拍攝的照片也不寫入系統相簿（僅記憶體暫存用於 OCR）。

- Push notifications：已涵蓋於上方 Identifiers → Device ID。

Tracking：HoloHunter 不做跨 App/網站廣告追蹤 → App Tracking Transparency 選 No / 不追蹤（若確實無追蹤 SDK）。
```

### Google Play Data safety 問卷（依 native binary 行為的建議答案）

> ⚠️ 下方只填 Android native binary 的實際資料流。Web 版會 POST 影像到 `/api/recognize-card` 再轉送 OpenRouter Gemini Vision，但 native binary 不走這條路——native 用本機 OCR（`expo-ocr-kit` / Tesseract），不上傳影像。
>
> Play Data safety 的「Data shared with third parties」需依 service-provider 合約例外判斷：若資料傳輸對象僅作為服務提供者（代表開發者處理資料），且合約禁止他用，可答 No。

```text
先跑 `npx expo prebuild --clean`，以 merged AndroidManifest.xml 的實際權限清單為準再填問卷。

Data collection / sharing：

- ⚠️ Native binary 實際 off-device 資料流僅一種：
  Expo push token → 取得後上傳後端並持久保存於 data/push-tokens.json（GitHub repo `main` branch），用於監看清單價格提醒推播。
  無帳號、無 analytics、無影像上傳、watchlist 僅 Zustand 本機儲存（未呼叫 /api/push/watchlist）。

- Location：No
- Personal info：無帳號/註冊機制 → No
- Financial info：No
- Health and fitness：No
- Messages：No
- Photos/Videos → No（Not Collected）
  - expo-image-picker 可從相簿選圖進行本機 OCR 辨識，但 native binary 不上傳影像到任何伺服器。
  - ⚠️ Play Console 可能因 merged manifest 的 `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` 自動列出 Photos/Videos 資料類型，但 manifest 權限宣告 ≠ collection。Play 的 collection 指資料離開裝置（off-device transmission），本機處理不構成 collection。直接勾選 No、Data shared = No，不需勾選 Ephemeral processing（該選項僅在 Collected = Yes 時才需要填）。
- Audio：若已關閉且 merged manifest 無 RECORD_AUDIO → No；若殘留 → 必須說明
- Files：No

- Device or other IDs：
  - Expo push token（ExpoPushToken[...]）→ Collected = Yes
  - Purpose：App functionality（push notifications / 監看清單價格提醒）
  - ⚠️ Data shared with third parties：推播透過 Expo Push Service（exp.host）發送，token 與通知內容傳輸至 `exp.host`。若 Expo Push Service 符合 service-provider 合約例外（代表開發者處理資料、不用於自身目的），可答 No；若無法確認合約關係，應答 Yes 並註明傳輸至「Expo Push Service for notification delivery」。
  - ⚠️ Deletion：後端無 unregister/delete endpoint。App 移除或關閉通知權限不會刪除 GitHub 中的 token。資料持久保存於 GitHub repo，直至營運方人工刪除。Deletion request 應如實填 No 或提供 contact email 讓使用者聯絡請求手動刪除。若要答 Yes，需先實作 `/api/push/unregister` 端點。

- App activity → App interactions：
  - ⚠️ Watchlist 目前僅 Zustand 本機儲存，App binary 未呼叫 `/api/push/watchlist`。外部 server-side `data/push-watchlist.json` 非 App binary 觸發，不需申報。
  - 若無其他 analytics / crash SDK → No。

Permissions（Play Console 會自動列出 merged manifest 權限，需能對應功能）：
- CAMERA → 掃描/辨識卡牌（本機處理）
- READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE（可能來自 expo-image-picker）→ 以 merged manifest 為準；用於相簿選圖，Android 13+ 多改走系統 photo picker 免權限
- RECORD_AUDIO → 若未使用，需同時關 expo-camera 與 expo-image-picker 的 microphonePermission 並加 android.blockedPermissions；改完用 merged manifest 確認已消失
- POST_NOTIFICATIONS（Android 13+，來自 expo-notifications）→ 用於監看清單價格提醒推播。需保留此權限，並在 Data safety 對應申報 Device IDs。
```

---

## 6. 建議實際執行順序

1. 先確認 Apple Team ID、Google Play package name、keystore 策略。
2. **決定版本策略與權限面**：依 [0.1](#01-版本與-build-number-管理) 選 remote autoIncrement 或手動 build number；依 [0.2](#02-權限與隱私盤點) 決定麥克風 / 推播 / 相簿是否保留，並更新 `app.json` / `eas.json`。
3. 跑 Android production AAB build，因 Closed testing 通常比 iOS 外部 TestFlight 審查資料更繁瑣但 build 驗證直接。
4. 跑 iOS production build。
5. 先開 Internal / Closed testing，不直接正式上架。
6. 真機驗證後再補商店素材與隱私問卷（用第 5 節的問卷建議答案對照實際權限）。
7. 若要自動提交，再補齊 `eas.json` 的 iOS `appleId` / `ascAppId` 與 Android `google-service-account.json`。
8. 第二次以後每次送商店，確認 build number / versionCode 已遞增（remote autoIncrement 會自動處理）。
