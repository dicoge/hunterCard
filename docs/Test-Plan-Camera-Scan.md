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
| `duplicate_count` | ✅ | 一次 physical scan 新增的 session record 數；正常為 1 |

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
