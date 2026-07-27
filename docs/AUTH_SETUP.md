# HoloHunter 登入設定（Sign in with Apple）

本文件說明 iOS「Sign in with Apple」的設定步驟、需要在 Apple Developer 後台配置的項目、環境變數，以及 TestFlight 驗證 checklist。

## 產品決策

- 只支援 **Apple ID** 與 **Google** 登入，**不提供**自家 Email/密碼。
- Web 版支援 Google 登入。
- iOS 若提供 Google 登入，依 App Store 審查規範 4.8 **必須**同時提供 Sign in with Apple。
- 上架版必須包含：登出、刪除帳號、隱私權政策/資料刪除說明。
- 不提交任何 Apple private key / secrets 進 repo。

## 這個 PR 已包含什麼

| 項目 | 位置 |
| --- | --- |
| Apple 登入原生流程 | `src/services/auth/appleAuth.ts` |
| Google 登入介面（尚未接線） | `src/services/auth/googleAuth.ts` |
| 統一 auth service + 帳號刪除 API 呼叫 | `src/services/auth/index.ts` |
| Session store（zustand + persist） | `src/stores/authStore.ts` |
| 登入畫面 + Apple 原生按鈕 | `src/screens/AuthScreen.tsx` |
| 登入 gate（iOS 強制登入） | `src/navigation/AppNavigator.tsx` |
| 登出 / 刪除帳號 UI | `src/screens/SettingsScreen.tsx` |
| 帳號刪除 + Apple token 撤銷後端 | `api/auth/delete-account.ts` |
| App 設定 capability / plugin | `app.json` |

App 行為：iOS 未登入時顯示 `AuthScreen`（強制登入）；Web/Android 因 Google 尚未接線，暫以訪客模式進入（旗標 `REQUIRE_AUTH` 於 `AppNavigator.tsx`）。

## App 設定（已完成於 `app.json`）

```json
"ios": { "usesAppleSignIn": true },
"plugins": [ "expo-apple-authentication" ]
```

套件：`expo-apple-authentication`（已加入 `package.json`）。修改 native capability 後需重新以 EAS 建置 dev/preview build（Sign in with Apple 是原生功能，Expo Go 無法測試）。

## Apple Developer 後台需要設定的項目

1. **Identifiers → App IDs**：找到 `com.dicoge.holohunter`，勾選 **Sign In with Apple** capability。
2. **重新產生 Provisioning Profile**（或讓 EAS 自動管理 credentials）。
3. 若 Web 版也要 Apple 登入（可選）：另建一個 **Services ID**，設定 Return URLs（Domain + redirect）。
4. **Keys → 建立 "Sign in with Apple" 私鑰（.p8）**：
   - 記下 **Key ID**。
   - 下載 `.p8` 檔（只能下載一次，妥善保存，**勿提交進 repo**）。
5. 記下 **Team ID**（右上角帳號資訊）。

### 後端環境變數（設定於 Vercel，勿提交）

| 變數 | 說明 |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_CLIENT_ID` | Services ID（web）或 app bundle id `com.dicoge.holohunter`（native） |
| `APPLE_KEY_ID` | 上述 .p8 私鑰的 Key ID |
| `APPLE_PRIVATE_KEY` | .p8 內容（含 BEGIN/END，換行以 `\n` 表示） |

未設定完整變數時 `api/auth/delete-account` 會回傳 501，App 端仍會清除本機 session 並提示使用者。

## 帳號刪除的完整流程（後續強化）

目前 `api/auth/delete-account.ts` 會以當前 `authorizationCode` 換取 refresh token 再撤銷。更穩健的作法（建議後續 PR）：

1. **登入時**把 `authorizationCode` 傳到後端 → `/auth/token` 換 `refresh_token` → 以 `userId` 為 key 保存於後端儲存。
2. **刪除時**用保存的 `refresh_token` 呼叫 `/auth/revoke`，並刪除該使用者的所有資料。

原因：`authorizationCode` 為單次使用且短效，刪除當下不一定還有效。

## Google 登入後續（尚未接線）

1. `npx expo install expo-auth-session expo-web-browser`
2. Google Cloud Console 建立 iOS / Web / Android OAuth client ID。
3. 於 `src/services/auth/googleAuth.ts` 用 `Google.useIdTokenAuthRequest` 換 `id_token`，映射成 `AuthSession`（`isGoogleAuthConfigured()` 回傳 `true`）。
4. Web 的登入 gate（`AppNavigator.tsx` 的 `REQUIRE_AUTH`）改為全平台強制登入。

## iOS / TestFlight 驗證 checklist

- [ ] EAS 以 dev/preview profile 重新建置（Sign in with Apple 無法在 Expo Go 測試）。
- [ ] App ID 已啟用 Sign in with Apple capability，profile 已更新。
- [ ] 首次登入：Apple 彈窗出現，可選擇分享/隱藏 email；成功後進入 App。
- [ ] 首次登入拿到的姓名/email 有保存；**再次登入**（Apple 不再回傳姓名/email）名稱不會消失。
- [ ] 取消 Apple 彈窗不會顯示錯誤、停留在登入頁。
- [ ] 設定頁顯示「以 Apple 登入」與帳號資訊。
- [ ] **登出**後回到登入頁，重開 App 仍為登入頁。
- [ ] **刪除帳號**：確認對話框 → 本機 session 清除 → 回到登入頁；若後端已設定環境變數，於 Apple ID 設定中該 App 授權消失。
- [ ] 「隱私權政策與資料刪除說明」連結可開啟。
- [ ] 在 App Store Connect 填寫隱私權政策 URL 與資料刪除說明。
- [ ] 送審前確認：有 Google 登入的畫面同時提供 Sign in with Apple（規範 4.8）。
