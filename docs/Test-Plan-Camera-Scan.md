# HoloHunter 相機掃描 QA Benchmark 與測試計畫

**專案名稱**：HoloHunter - Hololive 卡牌價格查詢 app
**功能名稱**：相機掃描 / 卡牌識別 / 掃描紀錄
**文件版本**：2.0.0
**測試類型**：準確率 benchmark、回歸測試、功能測試、效能測試、可用性測試
**QA Owner**：Mac-OpenClaw
**更新日期**：2026-07-27

---

## 1. 現況與風險摘要

相機掃描已不是「未來實作」：目前 pipeline 包含相機取圖、前端辨識服務、Vercel API `api/recognize-card.ts`、OpenRouter Gemini Vision 呼叫、資料庫匹配與掃描 session 紀錄。

已知使用者回報：

1. 同一張卡掃一次，session 內可能紀錄兩張相同卡。
2. 實測辨識正確率約 70%，低於可接受門檻。
3. 相同拍照方式，把圖片貼給 chat 模式 Gemini 可正確識別，因此目前 HoloHunter pipeline 需要 benchmark 化並找出差距。
4. 目前 API 端使用 OpenRouter 的 `google/gemini-3.1-flash-image`；若準確率或穩定度不足，建議評估改為直接 Gemini API 或更穩定的 vision endpoint，而不是硬編 fallback。

---

## 2. QA 目標與通過標準

| 指標 | 目標 | 阻擋等級 | 說明 |
|---|---:|---|---|
| Top-1 準確率 | ≥ 90% | Release blocker | 第一順位輸出需完全符合 expected cardNumber + rarity + series |
| Top-3 準確率 | ≥ 98% | Release blocker | 前三候選中任一筆完全符合 expected cardNumber + rarity + series |
| 重複記錄率 | 0% | Release blocker | 一次 physical scan 不可新增 2 筆以上 session cards |
| 低信心錯配 | 0 P0 / 可追蹤 P1 | Release blocker if user-visible | confidence < 0.75 時不得直接自動入庫；需要求重掃或顯示候選 |
| 同名不同版本混淆 | 0 P0 / 可追蹤 P1 | Release blocker if top-1 wrong | 同名卡需以 cardNumber、rarity、series、HP/level 等特徵解歧 |
| API 失敗處理 | 100% 有明確錯誤 | P1 | timeout、API key、provider 5xx、空回覆需可診斷 |

---

## 3. Benchmark 測試集規格

正式 benchmark 至少 50 張，建議 100 張；每張卡需保留原始圖片、expected label、拍攝條件與 pipeline 輸出。

### 3.1 卡牌覆蓋

| 維度 | 最低數量 | 要求 |
|---|---:|---|
| 稀有度 C / U / R | 各 ≥ 8 | 基礎卡、文字密集與圖面接近者都要有 |
| 稀有度 SR | ≥ 8 | 需含亮面或高反光情境 |
| 稀有度 SEC / OUR | 合計 ≥ 6 | 高價與特殊版面需納入 |
| 稀有度 P | ≥ 6 | promo / event / PR 系列需納入 |
| 多系列 | ≥ 5 系列 | 至少含 hBP、hSD、hPR/Promo 類型 |
| 同名不同版本 | ≥ 10 組 | 同角色、同名或近似名，不同 rarity / series / cardNumber |
| 實體卡 | ≥ 30 張 | 真實使用情境優先 |
| 手機螢幕拍攝 | ≥ 15 張 | 使用者常用另一台手機顯示圖片再掃描 |
| 圖片/列印測試 | ≥ 10 張 | 可快速回歸，但不可取代實體卡 |

### 3.2 拍攝條件覆蓋

每張卡至少一種條件；正式 benchmark 應整體覆蓋：

- 正常光線、低光、強反光、背光。
- 0° 正拍、10-20° 傾斜、30° 以上大角度。
- 卡牌佔掃描框 60%、80%、100%。
- 手震 / 模糊、局部遮擋、背景雜訊。
- iPhone 實機、Android 實機、Web camera（若支援）。
- 實體卡與手機螢幕拍攝各自分層統計。

### 3.3 命名與資料夾建議

```text
docs/fixtures/scan-benchmark/
  images/
    hBP04-005_C_hBP04_good-light_001.jpg
    hBP04-005_C_hBP04_low-light_002.jpg
  labels.jsonl
  latest-results.jsonl
```

### 3.4 掃描功能測試 (Scan Function)

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| SF-001 | 開始掃描 | 1. 點擊「掃描」按鈕 | 顯示「識別中...」狀態 | P0 |
| SF-002 | 掃描按鈕disabled | 1. 掃描進行中<br>2. 嘗試再次點擊 | 按鈕呈現 disabled 狀態，無法點擊 | P0 |
| SF-003 | 掃描完成提示 | 1. 等待掃描完成（2秒） | 顯示掃描完成 Alert | P0 |
| SF-004 | 掃描動畫停止 | 1. 掃描完成後<br>2. 點擊 Alert 確定 | 掃描動畫停止，狀態重置 | P1 |
| SF-005 | 掃描期間返回 | 1. 開始掃描<br>2. 立即返回上一頁 | 掃描中斷，無錯誤 | P2 |

### 3.5 識別功能測試（整合測試） (Recognition Integration)

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| RI-001 | 成功識別卡牌 | 1. 掃描有效卡牌圖像<br>2. 完成掃描 | 顯示卡牌資訊頁面（未來実装） | P0 |
| RI-002 | 識別失敗處理 | 1. 掃描無效圖像<br>2. 完成掃描 | 顯示「無法識別」提示（未來実装） | P1 |
| RI-003 | 卡牌價格顯示 | 1. 成功識別後 | 顯示價格資訊（未來実装） | P0 |
| RI-004 | 無庫存提示 | 1. 識別的卡牌無庫存 | 顯示無庫存提示（未來実装） | P1 |

### 3.5b 掃描去重測試 (Scan De-duplication — DIC-700)

背景：使用者實測「掃一張卡會紀錄兩張」。自動掃描在同一張卡穩定停留於畫面時，冷卻時間（3 秒）過後會再次觸發，導致重複 `addCard`。修正方式為在 `scanSessionStore.addCard` 集中做短時間去重（同 `cardNumber/series/rarity` 於 `SCAN_DEDUP_WINDOW_MS`＝8 秒內只記一次），並在每次掃描結束（成功或失敗）都 `resetAutoScan()`。

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| DD-001 | 單張卡只記一筆 | 1. 將同一張卡穩定放在掃描框內<br>2. 讓自動掃描連續觸發數次（>10 秒） | 清單只新增 **1** 筆 | P0 |
| DD-002 | 手動掃描不重複 | 1. 對同一張卡快速連按掃描 | 清單只新增 1 筆 | P0 |
| DD-003 | 連續不同卡可多筆 | 1. 依序掃 A、B、C 三張不同卡 | 清單新增 3 筆 | P0 |
| DD-004 | 明確再加入一張 | 1. 掃 A 後，於上方 toast 點「＋ 再加入一張」 | 清單新增第 2 筆 A | P1 |
| DD-005 | 移開後再掃同卡 | 1. 掃 A → 移開卡片 >8 秒 → 再掃 A | 清單新增第 2 筆 A | P1 |
| DD-006 | 失敗後狀態一致 | 1. 掃描失敗（API error / 空 OCR）<br>2. 觀察是否可立即重掃 | `isScanning`/`isProcessingOCR` 重置、自動掃描 buffer 已清空，可重試 | P1 |

**自動化驗證**：純邏輯（`src/utils/scanDedup.ts`）以獨立 Node 腳本驗證，無需啟動 app 或安裝相依：

```
npm run test:scan-dedup
# 或
node --experimental-strip-types scripts/verify-scan-dedup.mjs
```

涵蓋：bug 重現（自動掃描重複觸發只記一筆）、連續不同卡皆記錄、視窗過後同卡可再記、`force`（再加入一張）繞過去重。

### 3.5c 低信心辨識與候選確認測試 (Confidence Tiers & Candidate Confirmation) — DIC-704

信心度分層門檻：高信心 ≥ 0.85（自動加入）、中信心 0.55–0.84（候選確認）、低信心 < 0.55（引導重拍/手動）。

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| CC-001 | 高信心自動加入 | 1. 掃描卡號清晰可讀的卡牌（信心 ≥ 0.85） | 自動加入清單並顯示浮動結果卡 | P0 |
| CC-002 | 中信心顯示候選 | 1. 掃描僅角色名匹配、卡號模糊的卡牌（0.55–0.84） | 顯示底部候選選擇器，列出 top 3–5 候選，**不自動加入** | P0 |
| CC-003 | 候選點選確認加入 | 1. 於候選選擇器點選正確卡牌 | 該卡加入清單並顯示結果卡，選擇器關閉 | P0 |
| CC-004 | 低信心引導 | 1. 掃描模糊/反光導致信心 < 0.55 | 顯示「無法確定是哪張卡」標題 + 引導詞（靠近卡號/避免反光/保持平整）+ 弱候選 | P0 |
| CC-005 | 候選選擇器重新掃描 | 1. 於選擇器點「重新掃描」 | 關閉選擇器並重新觸發掃描 | P1 |
| CC-006 | 候選選擇器手動搜尋 | 1. 於選擇器點「手動搜尋」 | 關閉選擇器並開啟手動搜尋 Modal | P1 |
| CC-007 | 候選信心度視覺 | 1. 觀察候選列 | 每列顯示信心度進度條與百分比，最佳匹配高亮並標「最相符」 | P1 |
| CC-008 | 完全無候選 | 1. API 回傳無 card 且無候選 | 顯示錯誤提示含引導詞與「手動搜尋」按鈕，不顯示空選擇器 | P1 |
| CC-009 | 重複掃描防護 | 1. 掃描並加入一張卡<br>2. 再次掃描同一張卡 | 彈出「已在清單中」提示，**不重複加入** | P0 |
| CC-010 | 候選確認也防重複 | 1. 清單已有某卡<br>2. 從候選選擇器選同一卡 | 彈出「已在清單中」提示，不重複加入 | P1 |
| CC-011 | 額度扣點單一入口 | 1. 走查所有加入路徑 | 卡牌僅透過 `commitCard` 加入（掃描額度扣點未來只掛此處，錯誤重試不扣點） | P2 |

### 3.6 效能測試 (Performance)

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| PF-001 | 相機開啟速度 | 1. 進入 ScanScreen<br>2. 測量時間 | 相機預覽在 2 秒內顯示 | P1 |
| PF-002 | 掃描響應時間 | 1. 點擊掃描按鈕<br>2. 測量時間 | 2秒內顯示結果提示 | P1 |
| PF-003 | 記憶體使用 | 1. 操作 ScanScreen 5分鐘 | 記憶體不超過 300MB | P2 |
| PF-004 | 動畫流暢度 | 1. 觀察掃描動畫 | 60 FPS 流暢播放 | P1 |

### 3.7 相容性測試 (Compatibility)

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| CO-001 | 不同 iOS 版本 | 1. 在 iOS 15/16/17 測試 | 功能正常運作 | P1 |
| CO-002 | 不同螢幕尺寸 | 1. 在 iPhone SE/14/Pro Max 測試 | UI 正確顯示 | P1 |
| CO-003 | 旋轉螢幕 | 1. 旋轉裝置 | 支援縦向，橫向顯示正確 | P2 |

### 3.8 錯誤處理測試 (Error Handling)

| 測試編號 | 測試案例 | 測試步驟 | 預期結果 | 優先級 |
|----------|----------|----------|----------|--------|
| EH-001 | 相機硬體不可用 | 1. 模擬無相機設備 | 顯示適當錯誤訊息 | P1 |
| EH-002 | 相機被其他應用占用 | 1. 同時開啟其他相機 app<br>2. 進入 ScanScreen | 顯示錯誤或降級處理 | P1 |
| EH-003 | 權限被撤銷 | 1. 在 ScanScreen 時<br>2. 從設定撤銷相機權限 | 檢測到權限變更並提示 | P1 |

---

## 4. 潛在問題與風險

### 4.1 高風險項目
| 風險 ID | 風險描述 | 影響程度 | 緩解措施 |
|---------|----------|----------|----------|
| R-001 | 相機權限被系統永久拒絕 | 高 | 提供明確的設定入口，引導使用者手動開啟 |
| R-002 | 低光環境下識別率下降 | 高 | 提供手電筒功能優化 |
| R-003 | 卡牌圖像辨識演算法準確度不足 | 高 | 需建構 ML 模型並持續訓練優化 |
| R-004 | 相機在特定裝置上相容性問題 | 中 | 進行多裝置測試，建立裝置矩陣 |

### 4.2 中風險項目
| 風險 ID | 風險描述 | 影響程度 | 緩解措施 |
|---------|----------|----------|----------|
| R-005 | 動畫效能造成耗電 | 中 | 優化動畫實作，適時停止動畫 |
| R-006 | 網路離線時無法查詢價格 | 中 | 快取最近查詢的價格，離線提示 |
| R-007 | 掃描時間過長影響體驗 | 中 | 顯示進度指示，優化識別速度 |

### 4.3 已識別的潛在問題
1. **掃描功能尚未完全實作**：目前掃描後顯示「卡牌識別功能正在開發中」提示，需完成後端識別邏輯
2. **沒有圖像辨識演算法**：需要導入 OCR 或 ML 模型來識別卡牌
3. **沒有價格 API 串接**：需要串接卡牌價格資料來源
4. **閃光燈狀態視覺回饋需優化**：目前有基本視覺回饋（圖標變化+標籤文字），但按鈕active狀態樣式可更明顯

---

## 5. 品質標準

### 5.1 功能品質標準
| 項目 | 品質標準 | 目標值 |
|------|----------|--------|
| 權限請求成功率 | 使用者首次使用時成功授予權限 | ≥ 90% |
| 相機開啟成功率 | 授權後相機正常開啟 | ≥ 99% |
| 掃描按鈕可用性 | 使用者能夠順利點擊並觸發掃描 | 100% |
| 動畫流暢度 | 掃描線動畫幀率 | ≥ 30 FPS |

### 5.2 效能品質標準
| 項目 | 品質標準 | 目標值 |
|------|----------|--------|
| 相機啟動時間 | 從權限授予到畫面顯示 | ≤ 2 秒 |
| 掃描回應時間 | 點擊掃描到顯示結果 | ≤ 3 秒 |
| 記憶體佔用 | 正常使用下的記憶體 | ≤ 300 MB |
| APK/App Bundle 大小 | 應用程式大小增加 | ≤ 50 MB |

### 5.3 使用者體驗品質標準
| 項目 | 品質標準 | 目標值 |
|------|----------|--------|
| 首次使用引導 | 權限請求說明清晰度 | 易於理解 |
| 掃描引導 | 掃描框提示清楚 | 使用者知道如何操作 |
| 錯誤訊息 | 錯誤訊息清楚且有建設性 | 使用者知道如何解決 |

---

## 6. 測試資料需求

### 6.1 測試卡牌樣本
需要準備以下卡牌樣本進行識別測試：
- 不同稀有度： C, U, R, SR, UC, CP
- 不同系列： 至少 3 個不同系列
- 不同成員： 至少 5 位不同 Hololive 成員
- 正面/反面： 卡牌正面為主
- 品質狀態： 全新、近新、有損傷

### 6.2 測試環境需求
- iOS 模擬器 (iPhone 14, iPhone 14 Pro Max)
- 實機測試裝置
- 測試用假卡牌圖片 (可用列印或螢幕顯示)

---

## 7. 測試里程碑

| 階段 | 工作項目 | 預估時間 |
|------|----------|----------|
| Phase 1 | 權限管理與相機基礎功能測試 | 1 天 |
| Phase 2 | UI 與動畫測試 | 0.5 天 |
| Phase 3 | 掃描功能邏輯測試 | 0.5 天 |
| Phase 4 | 整合測試（配合後端） | 1 天 |
| Phase 5 | 效能與相容性測試 | 0.5 天 |
| Phase 6 | 問題回歸測試 | 0.5 天 |

---

## 8. 附件

### 8.1 相關檔案
- ScanScreen.tsx - 掃描功能主要實作
- src/types/hololive.ts - 卡牌資料結構
- src/types/index.ts - ScanResult 類型定義
- package.json - 專案依賴

### 8.2 測試記錄模板
```

圖片檔名建議格式：

```text
<cardNumber>_<rarity>_<series>_<condition>_<sequence>.jpg
```

---

## 4. 測試紀錄格式

每筆 benchmark record 使用 JSONL / JSON / CSV 皆可；`scripts/scan-benchmark.mjs` 會讀取下列欄位。

| 欄位 | 必填 | 說明 |
|---|---|---|
| `image_id` | ✅ | 圖片唯一 ID，需可回查原始圖 |
| `expected_cardNumber` | ✅ | 正確卡號，例如 `hBP04-005` |
| `expected_rarity` | ✅ | 正確稀有度，例如 `C`, `U`, `R`, `SR`, `SEC`, `OUR`, `P` |
| `expected_series` | ✅ | 正確系列，例如 `hBP04`, `hSD01`, `hPR` |
| `model_output` | 建議 | 原始 API / Gemini / app 輸出；可為 object 或 string |
| `top_matches` | 建議 | 候選陣列，至少保存前三名 `{ cardNumber, rarity, series, confidence }` |
| `matched_cardNumber` | 建議 | 實際入庫/顯示的 top-1 cardNumber |
| `matched_rarity` | 建議 | 實際 top-1 rarity |
| `matched_series` | 建議 | 實際 top-1 series |
| `confidence` | 建議 | top-1 confidence，0-1 |
| `pass` | 選填 | 人工覆核 pass/fail；自動統計仍以 expected vs matched 計算 |
| `failure_reason` | 失敗必填 | 例如 `number OCR miss`, `same name wrong rarity`, `low confidence accepted`, `duplicate record` |
| `duplicate_count` | ✅ | 一次 physical scan 新增的 session record 數；正常為 1。**必填、不可省略**：`scripts/scan-benchmark.mjs` 不會替缺欄位補預設值，缺少此欄位會直接 validation fail，避免沒記錄 session insert 數的資料被誤判為「無重複」而遮蔽「掃一張記錄兩張」regression |

範例：

```json
{"image_id":"hBP04-005_C_hBP04_good-light_001","expected_cardNumber":"hBP04-005","expected_rarity":"C","expected_series":"hBP04","top_matches":[{"cardNumber":"hBP04-005","rarity":"C","series":"hBP04","confidence":0.94}],"duplicate_count":1}
```

---

## 5. Benchmark 執行方式

已新增本地 benchmark runner：

```bash
node scripts/scan-benchmark.mjs --input docs/fixtures/scan-benchmark-sample.jsonl
node scripts/scan-benchmark.mjs --input docs/fixtures/scan-benchmark-sample.jsonl --output reports/scan-benchmark.md
node scripts/scan-benchmark.mjs --input docs/fixtures/scan-benchmark-sample.jsonl --json
```

正式流程：

1. 收集 50-100 張 benchmark 圖片與 labels。
2. 逐張經由目前 app/API pipeline 掃描，保存 raw output 與 top candidates。
3. 將結果整理成 JSONL / JSON / CSV。
4. 執行 `node scripts/scan-benchmark.mjs --input <results>`。
5. 若任一 release blocker 未達標，禁止標記掃描準確率完成，需修 pipeline 後重跑完整集。

`docs/fixtures/scan-benchmark-sample.jsonl` 是格式 fixture，不代表正式準確率。

---

## 6. 回歸測試案例

| ID | 情境 | 步驟 | 預期結果 | 指標 |
|---|---|---|---|---|
| REG-001 | 一張卡紀錄兩張 | 開新 scan session → 掃同一張卡一次 → 檢查 session cards | 僅新增 1 筆；`duplicate_count = 1` | 重複記錄率 0% |
| REG-002 | 低信心錯配 | 使用低光/模糊圖讓 top-1 confidence < 0.75 且候選接近 | 不可直接加入錯卡；需提示重掃或候選確認 | 低信心錯配 0 |
| REG-003 | 同名不同 rarity 混淆 | 掃同名但不同 rarity / series 的卡 | top-1 必須符合 cardNumber + rarity + series | top-1 準確 |
| REG-004 | 同 cardNumber 多 series | 掃不同系列復刻/版本 | 不可只用 cardNumber 導致 series 錯配 | 版本解歧準確 |
| REG-005 | 手機螢幕拍攝 | 在另一支手機顯示卡圖後掃描 | 不因螢幕摩爾紋或反光降到 top-3 以外 | top-3 準確 |
| REG-006 | API 空回覆 / timeout | 模擬 provider 502、timeout、空 choices | UI 顯示可理解錯誤，不新增 session card | 無錯誤入庫 |

---

## 7. 功能測試 Checklist

### 7.1 相機與權限

- [ ] 首次開啟 ScanScreen 會請求相機權限。
- [ ] 同意權限後顯示後鏡頭 preview。
- [ ] 拒絕權限後顯示設定入口與明確說明。
- [ ] 從系統設定回 app 後權限狀態會更新。
- [ ] 閃光燈切換有視覺回饋且不影響 scan state。
- [ ] 前/後鏡頭切換後 auto-scan frame history 會重置。

### 7.2 掃描 UX

- [ ] 掃描框、提示文字、掃描線動畫正常。
- [ ] 掃描中按鈕 disabled，避免連點觸發多次。
- [ ] 掃描中離開頁面不會在 unmounted component 更新 state。
- [ ] 成功結果顯示 cardNumber、rarity、series、名稱與價格。
- [ ] 失敗結果提供「重掃」或「手動搜尋」路徑。
- [ ] 低信心結果不可靜默加入 session。

### 7.3 Session 紀錄

- [ ] 一次成功掃描只會呼叫一次 `addCard`。
- [ ] 同一 physical scan 不會因 auto-scan + manual scan 同時觸發而重複入庫。
- [ ] 總價值與卡牌數量正確更新。
- [ ] 刪除卡牌後 totalValue / cardCount 正確重算。
- [ ] 新 session / clear session 後不殘留上一輪資料。

### 7.4 API / Recognition

- [ ] `api/recognize-card.ts` 對 missing image 回 400。
- [ ] missing API key 回 500 且不暴露 secret。
- [ ] provider non-2xx 回可診斷錯誤。
- [ ] Gemini raw output 會完整保存到 benchmark record。
- [ ] name match 與 card number match 的 tie-breaker 不會偏向錯 rarity / series。
- [ ] OpenRouter model / 直接 Gemini API 方案需在 benchmark 中分開標記，避免混淆。

---

## 8. 失敗分類與修正方向

| 分類 | 常見原因 | 建議修正方向 |
|---|---|---|
| `number OCR miss` | 底部卡號太小、模糊、反光 | crop bottom edge、提高解析度、要求 Gemini 專注卡號、保存多 frame |
| `same name wrong rarity` | 只用角色/名稱 matching | 強制 rarity/series/cardNumber tie-breaker；低信心進候選確認 |
| `same number wrong series` | database compound key 被壓成單一 cardNumber | candidate 需保留 `series`；expected match 必須比對 series |
| `low confidence accepted` | UI 沒有 confidence gate | confidence < 0.75 要重掃或人工選擇 |
| `duplicate record` | manual + auto trigger 競態、連點、重試回呼 | scan lock / request id / idempotency key；session store 不應重複記同一 scan event |
| `provider drift` | OpenRouter routing/model 行為變動 | 固定 model/version，評估直接 Gemini API，benchmark 分 provider 統計 |

---

## 9. Release Gate

掃描準確率相關變更進入部署前，需附上 benchmark report，至少包含：

- 測試圖片數量與分布（rarity、series、條件）。
- top-1 / top-3 / duplicate record rate。
- 失敗清單與分類。
- 對比前一版的差異。
- 若 API provider 或 model 有改動，需標明 provider、model、日期。

通過條件：

```text
top-1 >= 90%
top-3 >= 98%
duplicate record rate = 0%
沒有 P0 regression case fail
```
