# HoloHunter 專案完整手冊

> hololive OFFICIAL CARD GAME (hOCG) 卡牌查價 App  
> 技術棧：Expo + React Native Web + TypeScript + Vercel Edge Functions  
> 上線網址：https://holocard-hunter.vercel.app

---

## 📋 專案概述

### 核心功能
- **卡牌搜尋**：支援卡號、成員名稱（日文）、系列代碼、顏色搜尋
- **卡牌詳情**：顯示完整卡牌資訊、官方圖片、外部連結
- **價格查詢**：整合遊々亭 (yuyu-tei.jp) 實際售價
- **系列瀏覽**：首頁提供所有系列的快速搜尋按鈕
- **PWA 支援**：可安裝到主畫面，離線基本功能

### 資料來源
| 來源 | 用途 | 更新頻率 |
|------|------|----------|
| 官方卡牌資料 (GitHub) | 卡牌基本資訊、圖片 | 靜態，手動更新 |
| 遊々亭 (yuyu-tei.jp) | 實際售價 | 每日 5:00 AM JST |

---

## 🏗️ 技術架構

### 前端
```
card-hunter/
├── src/
│   ├── screens/
│   │   ├── HomeScreen.tsx          # 首頁 - 系列按鈕、顏色篩選
│   │   ├── SearchScreen.tsx        # 搜尋輸入頁
│   │   ├── SearchResultsScreen.tsx # 搜尋結果列表
│   │   ├── CardDetailScreen.tsx    # 卡牌詳情頁
│   │   ├── ScanScreen.tsx          # 掃描功能（尚未實作）
│   │   ├── FavoritesScreen.tsx     # 收藏功能（尚未實作）
│   │   └── SettingsScreen.tsx      # 設定頁
│   ├── navigation/
│   │   └── AppNavigator.tsx        # React Navigation 路由設定
│   ├── constants/
│   │   └── index.ts                # 主題顏色、字體大小
│   └── types/
│       └── index.ts                # TypeScript 介面定義
├── public/
│   └── manifest.json               # PWA manifest
├── app.json                        # Expo 設定
└── vercel.json                     # Vercel 部署設定
```

### 後端 API
```
api/
└── search.ts                       # Edge Function - 卡牌搜尋 API
```

### 資料與腳本
```
data/
├── official/                       # 官方卡牌資料 (32個系列, 3000+張卡)
│   ├── hBP01.json ~ hBP07.json    # Booster Packs
│   ├── hSD01.json ~ hSD19.json    # Starter Decks
│   ├── hPR.json, hY.json, ...     # 特殊/PR卡
│   └── all-cards.json             # 合併檔案（精簡版）
└── yuyu-prices/
    └── yuyu-prices.json           # 遊々亭價格（每日更新）

scripts/
├── scrape-official-*.js           # 官方卡牌爬蟲（已執行過）
├── scrape-yuyu-prices.js          # 遊々亭價格爬蟲（每日執行）
└── debug-yuyu.js                  # 除錯腳本
```

---

## 🔧 关键技术細節

### 1. 搜尋 API (`api/search.ts`)

#### API 端點
```
GET /api/search?q={關鍵字}
```

#### 回應格式
```json
{
  "query": "hBP04-001",
  "total": 1,
  "results": [
    {
      "id": "hBP04-001",
      "name": "博衣こより",
      "cardNumber": "hBP04-001",
      "type": "Oshi",
      "grade": "buzz",
      "rarity": "SR",
      "colors": ["blue"],
      "colorNames": ["藍色"],
      "series": ["hBP04"],
      "seriesNames": ["キュリアスユニバース"],
      "yuyuPrice": 99800,
      "yuyuPriceName": "博衣こより(パラレル/サイン)",
      "imageUrl": "https://...",
      "officialUrl": "https://..."
    }
  ]
}
```

#### 搜尋邏輯
```typescript
// 支援的搜尋類型
- 卡號：hBP04-001
- 成員名稱：星街すいせい、博衣こより
- 系列代碼：hBP04、hSD01
- 顏色：白色、藍色、青色、綠色、紅色、紫色、黃色
```

#### 顏色映射
```typescript
const COLOR_MAP = {
  white: '白色', blue: ['藍色', '青色'], green: '綠色',
  red: '紅色', purple: '紫色', yellow: '黃色', colorless: '無色'
};
// 說明：blue 對應兩個中文名稱是因為日文「青色」= 中文「藍色」
// 搜尋時會同時匹配「藍色」和「青色」關鍵字
```

#### 稀有度與價格映射
```typescript
// 官方稀有度（原始）→ 顯示稀有度（UI 用）
// 注意：這是 UI 顯示用映射，實際卡牌資料保留原始稀有度
OSR/OUR → SR（金色）, UR → R（藍色）, SR → U（綠色）,
RR/R/U/C → C（灰色）, N/SY → N（棕色）

// 遊々亭價格（實際）
從 yuyu-prices.json 讀取，優先顯示
若無實際價格，則顯示預估價格
```

### 2. 卡牌圖片 URL 規則

官方圖片 URL 格式：
```
https://hololive-official-cardgame.com/wp-content/images/cardlist/{series}/{cardNumber}_{version}.png
```

#### 系列代碼格式
- Booster Packs: `hBP01` ~ `hBP07`
- Starter Decks: `hSD01` ~ `hSD19`
- 特殊/PR: `hPR`, `hY`, `ent07`, `hCS01`, `hPC01`, `hSD2025summer`

#### 系列代碼格式
- Booster Packs: `hBP01` ~ `hBP07`
- Starter Decks: `hSD01` ~ `hSD19`
- 特殊/PR: `hPR`, `hY`, `ent07`, `hCS01`, `hPC01`, `hSD2025summer`

#### 版本後綴對應
- `OSR`/`OUR` → `_OSR.png`（主推卡特殊版）
- `UR` → `_UR.png`
- `SR` → `_SR.png`
- `RR` → `_RR.png`
- `R` → `_R.png`
- `U` → `_U.png`
- `C` → `_C.png`
- `N` → `_N.png`

### 3. 導航結構

```
Root Stack Navigator
├── MainTabs (Bottom Tab Navigator)
│   ├── Home (首頁)
│   ├── Scan (掃描)
│   ├── Search (搜尋)
│   ├── Favorites (收藏)
│   └── Settings (設定)
├── CardDetail (卡牌詳情)
└── SearchResults (搜尋結果)
```

**重要**：CardDetail 和 SearchResults 必須在 Stack 層級，不能放在 Tabs 內，否則無法從 Tabs 正確導航。

---

## 🗓️ 每日自動化流程

### GitHub Actions Workflow
```yaml
# .github/workflows/scrape-yuyu-prices.yml
- 觸發：每天早上 5:00 AM JST (20:00 UTC)
- 或手動觸發
- 執行爬蟲 → 更新價格 JSON → 自動 commit & push
```

### 爬蟲執行步驟
1. 安裝 Node.js 依賴（puppeteer）
2. 安裝系統依賴（libgbm, libnss3 等）
3. 執行 `scrape-yuyu-prices.js`
   - 遍歷所有系列頁面
   - 使用 Puppeteer 提取 `.card-product` 元素
   - 解析卡號、價格、卡牌名稱
4. 儲存為 `data/yuyu-prices/yuyu-prices.json`
5. Git commit 並推送

---

## 📊 資料統計

| 類別 | 數量 |
|------|------|
| 總卡牌數 | 3,000+ |
| Booster Packs | 7 個系列 (hBP01-hBP07) |
| Starter Decks | 19 個系列 (hSD01-hSD19) |
| 特殊/PR | 6 個系列 (hPR, hY, ent07, hCS01, hPC01, hSD2025summer) |
| 有遊々亭價格 | ~1,569 張 |

## 📝 卡牌資料結構

### `data/official/*.json` 欄位定義
| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | string | 內部 ID（數字） |
| `expansion` | string | 系列代碼（如 hBP04） |
| `cardNumber` | string | 卡號（如 hBP04-001） |
| `name` | string | 日文名稱 |
| `rarity` | string | 官方稀有度（OSR, UR, SR, RR, R, U, C, N） |
| `cardType` | string | 卡牌類型（推し, メンバー, サポート, エナジー, バズ, エール） |
| `color` | string | 顏色（white, blue, green, red, purple, yellow, colorless） |
| `imageUrl` | string | 官方圖片 URL |
| `life` | string | 生命值 |

### `data/yuyu-prices/yuyu-prices.json` 欄位定義
| 欄位 | 類型 | 說明 |
|------|------|------|
| `lastUpdated` | string | 最後更新時間（ISO 8601） |
| `totalCards` | number | 有價格的卡牌總數 |
| `seriesWithPrices` | number | 有價格的系列數 |
| `prices` | object | 價格資料（key 為卡號） |

`prices` 子欄位：
| 欄位 | 類型 | 說明 |
|------|------|------|
| `sellPrice` | number | 遊々亭售價（日元） |
| `name` | string | 卡牌 variant 名稱 |
| `timestamp` | string | 爬取時間 |

## 📱 PWA 離線功能

### 可離線使用
- 已載入的卡牌圖片（瀏覽器 cache）
- 基本 UI 介面

### 需連線使用
- 卡牌搜尋（需要 API）
- 價格查詢（需要 yuyu-prices.json）
- 卡牌詳情（需要 API 資料）

---

## 🚀 部署流程

### 1. 本地開發
```bash
cd card-hunter
npm install
npx expo start --web
```

### 2. 部署到 Vercel
```bash
# 自動部署（push 到 main 分支時）
git push origin main

# 或手動部署
vercel --prod
```

### 3. 環境變數
- `VERCEL_TOKEN`：Vercel API token（部署用）
- GitHub token：CI/CD 用

---

## 🔑 Tokens 與憑證

存放位置：`TOOLS.md`（本地工作區）

| 服務 | 用途 |
|------|------|
| Vercel | 部署到 Vercel |
| GitHub | CI/CD 自動執行 |

**注意**：GitHub token 需要 `repo` + `workflow` 權限。

⚠️ **重要**：Tokens 僅存放在本地 `TOOLS.md`，不應 commit 到 Git。

---

## 🛠️ 維護指南

### 新增系列卡牌
1. 執行爬蟲腳本抓取官方資料：
   ```bash
   node scripts/scrape-official-puppeteer.js
   ```
2. 將新系列 JSON 加入 `data/official/`
3. 更新 `api/search.ts` 的 `OFFICIAL_FILES` 列表
4. Commit 並推送

### 更新遊々亭價格
- 自動：每天 5:00 AM JST
- 手動：GitHub Actions → "Scrape Yuyu Prices" → Run workflow

### 前端功能開發
1. 在 `src/screens/` 建立新畫面
2. 在 `src/navigation/AppNavigator.tsx` 註冊路由
3. 更新 `src/types/index.ts` 的類型定義
4. 測試並部署

---

## 🐛 已知問題與解決方案

### 1. 圖片 403 Forbidden
**問題**：官方網站對某些版本圖片返回 403  
**解決**：正確映射稀有度到圖片版本後綴

### 2. 搜尋結果為空
**問題**：hBP01-hBP03 和 hSD01-hSD07 搜尋不到  
**原因**：`OFFICIAL_FILES` 缺少這些系列  
**解決**：將所有系列加入列表

### 3. GitHub Actions 失敗
**問題**：Puppeteer 缺少系統依賴  
**解决**：在 workflow 中安裝 `libgbm1`, `libnss3` 等

### 4. 導航失敗
**問題**：點擊卡牌無法進入詳情頁  
**原因**：路由結構錯誤，CardDetail 在 Tabs 內  
**解決**：將 CardDetail 移到 Stack 層級

---

## 📱 PWA 安裝

### iOS Safari
1. 開啟 https://holocard-hunter.vercel.app
2. 點擊分享按鈕
3. 選擇「加到主畫面」

### Android Chrome
1. 開啟網站
2. 點擊選單（三點）
3. 選擇「安裝應用程式」

---

## 🔄 未來規劃

### 短期
- [ ] 收藏功能（localStorage）
- [ ] 掃描卡牌功能（相機 + OCR）
- [ ] 價格走勢圖表

### 中期
- [ ] React Native 原生 App（iOS/Android）
- [ ] 離線模式
- [ ] 多語言支援（EN/JP/ZH）

### 長期
- [ ] 卡牌交換/交易媒合
- [ ] 牌組建構工具
- [ ] 對戰模擬器

---

## 📞 聯絡與貢獻

- **Repo**: https://github.com/dicoge/hunterCard
- **Live**: https://holocard-hunter.vercel.app
- **Telegram**: @dicoge

---

*最後更新：2026-04-23*
