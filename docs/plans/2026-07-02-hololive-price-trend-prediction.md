# hololive 卡價趨勢預測系統 Implementation Plan

> **For Hermes:** 使用 subagent-driven-development 逐項執行此計畫。

**目標：** 在 HoloHunter 中建立完整的 hololive 卡牌價格趨勢預測系統，整合每日爬取的歷史價格、新聞情緒、YT 訂閱數，在每張卡片上顯示價格預測。

**架構：**

```
┌─────────────────────┐
│   Daily Cron Jobs   │
│  ┌────────────────┐ │
│  │ scrape-prices  │ │── 儲存歷史價格 → data/price-history/{cardId}.json
│  │ scrape-news    │ │── 新聞情緒分析 → data/news-sentiment/{date}.json
│  │ yt-subscribers │ │── YT 訂閱數追蹤 → data/yt-subscribers/{date}.json
│  └────────────────┘ │
├─────────────────────┤
│   Analysis Engine   │
│  ┌────────────────┐ │
│  │ trend-analysis │ │── 讀取三種資料 → 計算趨勢預測
│  └────────────────┘ │
├─────────────────────┤
│   Frontend Display  │
│  ┌────────────────┐ │
│  │ PriceTrendBadge │ │── 卡片列表中顯示趨勢指示
│  │ TrendDetail    │ │── 卡片詳情中顯示完整趨勢
│  │ TrendsScreen   │ │── 全域趨勢總覽頁面
│  └────────────────┘ │
└─────────────────────┘
```

**技術棧：**
- Node.js (Puppeteer/cheerio) for scraping
- 檔案系統儲存 (data/ 目錄 JSON) — 與現有 scraping pipeline 一致
- Zustand store for frontend state (與現有 pattern 一致)
- React Native components (Expo/web)

---

## Phase 1: 歷史價格資料庫

### Task 1: 建立價格歷史記錄格式與儲存服務

**Objective:** 定義價格歷史的資料結構，建立儲存/讀取服務

**新增檔案：**
- `src/services/priceHistory.ts`

**資料格式：**
```typescript
// 每張卡片的價格歷史
interface PriceRecord {
  date: string;          // YYYY-MM-DD
  price: number;         // 日圓（最低價）
  source: string;        // 'yuyu-tei'
  currency: string;      // 'JPY'
  cardId: string;        // database key (e.g. "hBD24-007_ent07")
}

// 單張卡片的完整歷史
interface CardPriceHistory {
  cardId: string;
  cardNumber: string;
  name: string;
  nameZh?: string;
  records: PriceRecord[];  // 按日期排序（舊→新）
  lastUpdated: string;     // ISO datetime
}

// 全域價格歷史索引
interface PriceHistoryIndex {
  lastUpdated: string;
  totalCards: number;
  totalRecords: number;
  cardIds: string[];       // 有歷史資料的卡片 ID
}
```

**任務內容：**
1. 建立 `src/services/priceHistory.ts`，包含：
   - `savePriceRecord(cardId: string, record: PriceRecord): Promise<void>` — 追加單筆記錄
   - `getCardPriceHistory(cardId: string): Promise<CardPriceHistory | null>` — 讀取單卡歷史
   - `getPriceHistoryIndex(): Promise<PriceHistoryIndex>` — 讀取索引
   - `getAllCardIdsWithHistory(): Promise<string[]>` — 取得所有有歷史的卡ID
   - 檔案儲存在 `public/data/price-history/` 目錄（建構時複製用）和 `data/price-history/`（cron 寫入用）
   - **注意：** 前端 fetch 用 `public/data/` 路徑，後端 cron 用 `data/` 路徑

2. 儲存邏輯：
   - 每張卡片一個 JSON 檔案：`data/price-history/{cardId}.json`
   - 索引檔案：`data/price-history/index.json`
   - 寫入時去重（同一天同一來源不重複記錄）
   - 每日價格取當天最低價記錄

3. **不需要測試** — 此為資料服務，團隊開發時一併驗證

---

### Task 2: 修改每日爬蟲，爬完價格後同時存入歷史

**Objective:** 在現有 `scrape-yuyu-prices.js` 完成後，新增一個步驟將當日價格存入歷史

**修改檔案：**
- `scripts/build-database.js` (指示爬完後呼叫 priceHistory 服務)

**作法：**
在 `build-database.js` 流程中（爬完 yuyu-tei 價格後），加入一個後處理步驟：

```javascript
// 在 build-database.js 的 yuyu-tei price scrape 區塊後加入
async function savePriceHistory(db) {
  const records = [];
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  for (const [cardId, card] of Object.entries(db.cards || {})) {
    if (card.sellPrice != null && card.sellPrice > 0) {
      records.push({
        date: now,
        price: card.sellPrice,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId,
      });
    }
  }
  
  // 對每張卡片寫入 history file
  const historyDir = path.join(__dirname, '../data/price-history');
  fs.mkdirSync(historyDir, { recursive: true });
  
  const index = { lastUpdated: new Date().toISOString(), totalCards: 0, totalRecords: records.length, cardIds: [] };
  const cardGroups: Record<string, any[]> = {};
  
  for (const r of records) {
    if (!cardGroups[r.cardId]) cardGroups[r.cardId] = [];
    cardGroups[r.cardId].push(r);
  }
  
  for (const [cardId, newRecords] of Object.entries(cardGroups)) {
    const filePath = path.join(historyDir, `${cardId}.json`);
    let existing: CardPriceHistory;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      existing = { cardId, cardNumber: '', name: '', records: [] };
    }
    
    // 去重：避免同一天同一來源重複
    const existingDates = new Set(existing.records.map(r => r.date));
    for (const nr of newRecords) {
      if (!existingDates.has(nr.date)) {
        existing.records.push(nr);
      }
    }
    existing.records.sort((a, b) => a.date.localeCompare(b.date));
    existing.lastUpdated = new Date().toISOString();
    
    // 從 db 補 cardNumber/name
    const cardInfo = db.cards[cardId];
    if (cardInfo) {
      existing.cardNumber = cardInfo.cardNumber || '';
      existing.name = cardInfo.name || '';
      existing.nameZh = cardInfo.nameZh || '';
    }
    
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    index.cardIds.push(cardId);
  }
  
  index.totalCards = index.cardIds.length;
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify(index, null, 2));
  
  console.log(`[price-history] Saved ${records.length} records for ${index.totalCards} cards`);
}
```

**注意事項：**
- 此功能在 `local-scrape-and-push.sh` 中已包含 `node build-database.js`，修改後自動生效
- 新檔案 `data/price-history/*.json` 需要在 `git add` 命令中加入：
  ```
  git add data/price-history/*.json data/price-history/index.json
  ```

---

### Task 3: 修改 git push 腳本，包含 history 檔案

**Objective:** 讓 `local-scrape-and-push.sh` 能 commit + push price-history 檔案

**修改檔案：**
- `scripts/local-scrape-and-push.sh`

**修改點：**
在第 43 行的 `git add` 命令中加入 price-history 目錄：

```bash
git add data/database.json data/images/ data/official/cardList_*.json data/series-names.json data/price-history/*.json data/price-history/index.json
```

---

## Phase 2: YT 訂閱數追蹤

### Task 4: 建立 YT 訂閱數爬蟲

**Objective:** 每天爬取 hololive 成員的 YouTube 訂閱數，儲存歷史

**新增檔案：**
- `scripts/scrape-yt-subscribers.js`
- `data/yt-subscribers/` (爬完自動建立)
- `data/yt-subscribers/index.json`

**成員清單（hololive 主要成員，持續更新）：**
hololive 各期生的 YouTube channel ID 或 handle，可以從 hololive 官網或 HoloFan API 取得。

**策略：**
1. 使用 YouTube Data API v3（需要 API key，權衡用量限制）
2. 或使用 Social Blade / Playboard 等第三方網站爬蟲
3. **建議：** 先用 YouTube Data API v3（每天 10,000 units 免費，每次查詢 1 unit，足以查 50+ 成員）

**資料格式：**
```json
// data/yt-subscribers/2026-07-02.json
{
  "date": "2026-07-02",
  "lastUpdated": "2026-07-02T12:00:00Z",
  "members": {
    "ときのそら": { "channelId": "UCp6993wxpyDPHUpEvwD4i-Q", "subscribers": 1200000 },
    "白上フブキ": { "channelId": "UCdn5BQ06XqgXoAxI7qw5Lg", "subscribers": 2100000 },
    ...
  }
}
```

**儲存邏輯：**
- 每日一個檔案，以日期命名
- 索引檔案記錄所有日期清單
- 覆蓋模式（當天的直接覆蓋）

**執行方式：**
- 在 `local-scrape-and-push.sh` 中加入此步驟（價格爬完後執行）
- 或獨立 cron：每天 06:00 執行

---

### Task 5: 從官網 API 取得成員清單

**Objective:** 建立 hololive 成員 YouTube 頻道對照表，供爬蟲使用

**新增檔案：**
- `data/yt-members.json`

**內容：**
從 hololive 官網或 HoloFan 資料庫取得所有 hololive/holostars 成員的 YouTube channel ID 中英文名稱。

**格式：**
```json
{
  "members": [
    {
      "name": "Tokino Sora",
      "nameJp": "ときのそら",
      "nameZh": "時乃空",
      "channelId": "UCp6993wxpyDPHUpEvwD4i-Q",
      "generation": "0期生",
      "group": "hololive"
    },
    ...
  ]
}
```

**通用成員：** 可從 yuyu-tei 爬到的卡片資料庫中提取 member 名稱，或者從 hololive 官網取得完整名單。

---

## Phase 3: 新聞情緒分析

### Task 6: 建立新聞爬蟲 + 情緒分類服務

**Objective:** 每天收集 hololive/hololive 卡牌相關新聞，分類正向/負向

**新增檔案：**
- `scripts/scrape-news-sentiment.js`
- `data/news-sentiment/{date}.json`

**新聞來源：**
1. Google News RSS for "hololive card" / "hololive 卡牌" / "hololive official card game"
2. hololive 官方 X/Twitter
3. hololive 官方網站新聞區
4. 遊々亭新卡上架通知

**情緒分類（無須 LLM，用 keyword-based）：**

```javascript
const POSITIVE_WORDS = ['新卡', '人氣', '上漲', '熱銷', '完售', '再販', '大好評', '新系列', '合作', '限定', '升值'];
const NEGATIVE_WORDS = ['暴跌', '滯銷', '跌價', '供過於求', '炒賣', '爭議', '退坑', '停產', '瑕疵', '災情'];
```

**資料格式：**
```json
// data/news-sentiment/2026-07-02.json
{
  "date": "2026-07-02",
  "lastUpdated": "2026-07-02T12:00:00Z",
  "articles": [
    {
      "title": "hololive 新系列發售決定",
      "source": "hololive Official",
      "url": "https://...",
      "sentiment": "positive",
      "score": 0.8,
      "keywords": ["新系列", "人氣"],
      "publishedAt": "2026-07-02T10:00:00Z"
    }
  ],
  "summary": {
    "totalArticles": 5,
    "positive": 3,
    "negative": 1,
    "neutral": 1,
    "positiveScore": 0.6,
    "negativeScore": 0.2
  }
}
```

**執行方式：**
- 在 `local-scrape-and-push.sh` 中加入此步驟
- 或獨立 cron：每天 07:00

---

## Phase 4: 趨勢預測引擎

### Task 7: 建立趨勢分析引擎

**Objective:** 讀取歷史價格 + YT 訂閱數 + 新聞情緒，計算價格趨勢預測

**新增檔案：**
- `scripts/trend-analysis.js`
- `data/trends/{cardId}.json`（快取分析結果）
- `data/trends/index.json`

**分析邏輯：**

```javascript
function analyzeTrend(priceHistory, ytHistory, newsHistory) {
  // 1. 價格趨勢 (60% 權重)
  const priceTrend = calculatePriceTrend(priceHistory);
  //    - 最近 7 天 vs 前 7 天：漲/跌/平
  //    - 最近 30 天斜率
  //    - 波動率（標準差 / 平均）
  
  // 2. YT 訂閱趨勢 (20% 權重)
  const ytTrend = calculateYTSubscriberTrend(ytHistory);
  //    - 該成員近 7 天 vs 前 7 天訂閱增長率
  //    - 快速增長 → 卡片可能升值
  
  // 3. 新聞情緒 (20% 權重)
  const newsSentiment = calculateNewsSentiment(newsHistory);
  //    - 近 7 天新聞平均情緒分數
  //    - 正向事件多 → 利好
  
  // 4. 綜合預測
  const compositeScore = priceTrend * 0.6 + ytTrend * 0.2 + newsSentiment * 0.2;
  
  return {
    trend: compositeScore > 0.15 ? 'up' : (compositeScore < -0.15 ? 'down' : 'stable'),
    score: compositeScore,
    confidence: calculateConfidence(priceHistory.length), // 資料越多信心越高
    components: { priceTrend, ytTrend, newsSentiment },
    lastUpdated: new Date().toISOString(),
  };
}
```

**輸出格式：**
```typescript
interface TrendPrediction {
  cardId: string;
  cardNumber: string;
  name: string;
  nameZh?: string;
  trend: 'up' | 'down' | 'stable';
  score: number;           // -1.0 ~ 1.0
  confidence: number;      // 0.0 ~ 1.0 (資料量)
  components: {
    priceTrend: number;
    ytTrend: number;
    newsSentiment: number;
  };
  lastUpdated: string;
}
```

**執行方式：**
- 在每日爬蟲完成後自動執行
- 或獨立 cron：每天 08:00（所有資料都到位後）

---

## Phase 5: 前端顯示

### Task 8: 新增 PriceTrendBadge 元件

**Objective:** 在卡片列表和卡片詳情中顯示趨勢指示器

**新增檔案：**
- `src/components/PriceTrendBadge.tsx`

**元件功能：**
```
┌──────────────┐
│  📈 看漲 80% │   ← 上漲趨勢（綠色）
│  📉 看跌 40% │   ← 下跌趨勢（紅色）
│  ➡️ 平穩     │   ← 平穩（灰色）
│  📊 資料不足 │   ← 尚無預測資料（淡色）
└──────────────┘
```

**Props 設計：**
```typescript
interface PriceTrendBadgeProps {
  trend: 'up' | 'down' | 'stable' | null;
  score: number | null;      // -1 ~ 1
  confidence: number | null; // 0 ~ 1
  compact?: boolean;         // 是否精簡模式（列表用）
}
```

**樣式指南：**
- 上漲趨勢：`#10b981`（綠色），icon 📈
- 下跌趨勢：`#ef4444`（紅色），icon 📉
- 平穩：`#6b7280`（灰色），icon ➡️
- 資料不足：`#a0aec0`（淡色），icon 📊

---

### Task 9: 修改 CardItem 加入趨勢標記

**Objective:** 在卡片列表的每張卡片上顯示趨勢預測

**修改檔案：**
- `src/components/CardItem.tsx`

**修改點：**
1. 在 `CardItemProps` 中加入 `trend?: TrendPrediction | null`
2. 在價格區塊上方或卡片資訊尾部加入 `<PriceTrendBadge>`
3. 僅在 `showPrices` 為 true 時顯示

---

### Task 10: 修改 CardDetailScreen 加入趨勢詳情區

**Objective:** 在卡片詳情頁顯示完整的趨勢分析

**修改檔案：**
- `src/screens/CardDetailScreen.tsx`

**修改點：**
在「價格區塊」下方或旁邊加入「趨勢預測」區塊：
1. 顯示趨勢方向（看漲/看跌/平穩）
2. 信心度（百分比）
3. 各項因子貢獻（價格趨勢60%、YT訂閱20%、新聞情緒20%）
4. 歷史價格迷你圖表（可選，用簡單的 SVG/Canvas 折線）
5. 分數條（-1.0 ~ 1.0 的進度條）

---

### Task 11: 新增商店頁面 TrendStore

**Objective:** 建立前端趨勢資料的 Zustand store

**新增檔案：**
- `src/store/trendStore.ts`

**Store 設計：**
```typescript
interface TrendStore {
  trends: Record<string, TrendPrediction>;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  fetchTrends: () => Promise<void>;
  getTrendForCard: (cardId: string) => TrendPrediction | null;
  getTrendSummary: () => { up: number; down: number; stable: number; };
}
```

**API 路徑：**
- 前端從 `/data/trends/{cardId}.json` 載入（延遲載入，只在需要時 fetch）
- 或一次載入 `/data/trends/index.json` 取得所有趨勢摘要

---

### Task 12: (可選) 新增 TrendsScreen 趨勢總覽頁

**Objective:** 新增一個頁面顯示所有卡片的趨勢排名

**新增檔案：**
- `src/screens/TrendsScreen.tsx`
- 修改 `src/navigation/AppNavigator.tsx` 加入此頁面

**功能：**
1. 🔥 **熱門看漲卡片** — 趨勢分數最高 TOP 20
2. ❄️ **冷門看跌卡片** — 趨勢分數最低 TOP 20
3. 📊 **市場概況** — 看漲/看跌/平穩的統計圖
4. 🗓️ **趨勢變化** — 趨勢方向最近變動的通知

**導航加入：**
在 Drawer Navigator 中加入一個 `Trends` 頁面，icon 📈

---

## 執行順序

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
  Task 1     Task 4     Task 6     Task 7     Task 8
  Task 2     Task 5                            Task 9
  Task 3                                       Task 10
                                                Task 11
                                                Task 12 (opt)
```

**建議先做 Phase 1 (Tasks 1-3)**，因為每日價格爬蟲已在運行，越早開始累積歷史資料越好。Phase 5 的前端顯示可以等後端資料到位後再進行。

---

## 驗證方式

1. **手動驗證：** 執行 `node scripts/build-database.js` 後檢查 `data/price-history/` 目錄是否正確產生
2. **前端驗證：** `npm run build` → `npx serve dist/` 打開瀏覽器檢查卡片詳情頁
3. **E2E：** 完整跑一次每日 pipeline → 檢查 Vercel 站點是否正確顯示

---

## 注意事項 / 已知陷阱

1. **不要破壞現有功能：** 所有修改都必須確保爬蟲、價格顯示、掃描功能不受影響
2. **檔案大小控管：** price-history 會隨時間增長，建議每張卡片獨立檔案避免單一 JSON 過大
3. **YT API Key：** 需要使用 YouTube Data API v3，需申請 API key 並設定環境變數
4. **情緒分類準確性：** keyword-based 分類有限，後續可用更進階的 NLP 改善
5. **權重調整：** 趨勢預測的 60/20/20 權重是初始建議，可依實際表現調整