# hunterCard 架構審查報告

**專案**：hunterCard - Hololive 卡牌價格查詢 app  
**審查日期**：2025-05-02  
**審查者**：Software Architect  
**專案版本**：v1.0.0

---

## 1. 執行摘要

hunterCard 是一個基於 Expo + React Native 的 Hololive 卡牌價格查詢應用。專案已實現基礎搜尋功能和相機掃描界面，但架構存在多個需要改進的問題，主要集中在**缺乏狀態管理**、**數據層抽象不足**、以及**組件職責過於肥大**。

**整體評估**：⭐⭐⭐☆☆ (3/5)  
**適合當前階段**：是，但需要重構以支援後續擴展

---

## 2. 專案現況

### 2.1 技術棧

| 類別 | 技術 | 版本 |
|------|------|------|
| 框架 | Expo | ~54.0.33 |
| React Native | 0.81.5 | - |
| 語言 | TypeScript | ~5.9.2 |
| 導航 | React Navigation | 7.x |
| 狀態管理 | useState (本地) | - |
| API | Vercel Edge Functions | - |

### 2.2 目錄結構

```
hunterCard/
├── src/
│   ├── components/      # CardItem.tsx (1 component)
│   ├── constants/        # COLORS, 配置常量
│   ├── data/             # hololive-cards.json
│   ├── hooks/            # useHoloSearch.ts (空實現)
│   ├── navigation/      # AppNavigator.tsx
│   ├── screens/          # 7 個頁面
│   ├── services/        # cardRecognition.ts
│   ├── types/           # 類型定義
│   └── utils/           # 空目錄
├── api/                 # Vercel API routes (3 files)
├── data/                # 數據文件
│   ├── official/        # 官方卡牌數據
│   └── yuyu-prices/    # 價格數據
└── docs/               # 文檔
```

### 2.3 已實現功能

- ✅ 首頁快速搜尋 (系列/顏色)
- ✅ 卡牌搜尋功能
- ✅ 相機掃描界面
- ✅ 卡牌詳情頁面
- ✅ 價格資訊顯示 (yuyu-tei)
- ✅ 外部連結 (Carousell, 官網)
- ⚠️ 收藏功能 (界面有但未實現)

---

## 3. 識別的問題與風險

### 3.1 高優先級問題 🔴

#### 3.1.1 缺乏全局狀態管理
**問題**：整個應用沒有全局狀態管理機制
- `useHoloSearch.ts` 是空殼 hook
- 收藏的卡片無法跨頁面保存
- 搜索歷史、設置等都無法持久化

**風險**：無法實現收藏、搜尋歷史、用戶偏好等核心功能

#### 3.1.2 數據加載效率低
**問題**：`api/search.ts` 每次搜索都 fetch 所有卡片 JSON
- 同時 fetch 超過 30+ 個 JSON 文件
- 沒有客戶端緩存
- 每次 API 調用都重新下載整個數據集

**風險**：網絡請求過多，響應時間長，離線無法使用

#### 3.1.3 OCR/相機掃描是模擬實現
**問題**：`ScanScreen.tsx` 的 `handleScan` 只是 timeout 模擬
```typescript
// ScanScreen.tsx:122-129
// 模擬 OCR 識別過程（實際需要使用 ML Kit 或 Vision Framework）
setTimeout(() => {
  setIsScanning(false);
  setScanComplete(true);
  // 這裡需要实际的图像识别
  // 暂时使用演示数据，展示功能流程
```

**風險**：用戶期望的相機掃描功能無法使用

#### 3.1.4 類型定義重複與不一致
**問題**：存在兩套類型定義
- `src/types/index.ts` - 通用 Card, SearchResult
- `src/types/hololive.ts` - HoloCard, Series, Member

且 `SearchResultsScreen.tsx` 使用了自己的 inline 類型 `CardResult`

**風險**：維護困難，容易出現類型不匹配的 bug

---

### 3.2 中優先級問題 🟡

#### 3.2.1 組件過於肥大
**問題**：
- `ScanScreen.tsx` - 936 行代碼
- `CardDetailScreen.tsx` - 307 行代碼
- `HomeScreen.tsx` - 240 行代碼

所有 UI 邏輯都在 screen 組件內，沒有組件化

**風險**：代碼難以維護和測試，無法重用 UI 邏輯

#### 3.2.2 缺少錯誤邊界與載入狀態
**問題**：部分 API 調用缺少完善的錯誤處理
```typescript
// SearchResultsScreen.tsx:39-46
const res = await fetch(`https://holocard-hunter.vercel.app/api/search?q=...`);
if (!res.ok) {
  const body = await res.json().catch(() => null);
  setError(body?.error || `HTTP ${res.status}`);
}
```
- API URL 硬編碼
- 沒有重試機制
- 沒有離線 fallback

**風險**：網絡不佳時用戶體驗差

#### 3.2.3 不符合 React Native 規範
**問題**：`SearchResultsScreen.tsx` 使用 HTML `<img>` 標籤
```typescript
// SearchResultsScreen.tsx:110-117
<img
  src={card.imageUrl}
  alt={card.name}
  style={{ width: 80, height: 112, ... }}
/>
```
在 React Native 中應該使用 `<Image />` 組件

**風險**：可能導致渲染問題或性能問題

#### 3.2.4 缺少工具函數庫
**問題**：`utils/` 目錄為空
- 沒有日期格式化
- 沒有貨幣格式化
- 沒有常用驗證函數

**風險**：重複代碼，假設邏輯散落各處

---

### 3.3 低優先級問題 🟢

#### 3.3.1 API 與服務職責不清
**問題**：
- `api/search.ts` 是 Vercel Edge Function
- `src/services/cardRecognition.ts` 是客戶端識別服務
- 兩者功能有重疊，數據格式不一致

#### 3.3.2 常量配置分散
**問題**：
- `COLORS` 在 `constants/index.ts`
- 其他配置如 `BOOSTER_PACKS`, `STARTER_DECKS` 在 `HomeScreen.tsx` 內
- `SERIES_NAMES`, `GRADE_RARITY` 在 `api/search.ts`

**風險**：新增系列需要修改多處代碼

#### 3.3.3 沒有代碼分割
**問題**：所有頁面在啟動時都會被打包
- 沒有使用 React.lazy()
- 沒有 dynamic import

**風險**：首屏加載時間長，影響用戶體驗

---

## 4. 改進建議

### 4.1 立即建議 (本月)

#### 4.1.1 實現全局狀態管理
**方案**：使用 React Context API 或 Zustand

```typescript
// 例如使用 Zustand
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppState {
  favorites: Card[];
  searchHistory: string[];
  settings: AppSettings;
  addFavorite: (card: Card) => void;
  removeFavorite: (cardId: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      favorites: [],
      searchHistory: [],
      settings: DEFAULT_SETTINGS,
      addFavorite: (card) => set((state) => ({
        favorites: [...state.favorites, card]
      })),
      removeFavorite: (cardId) => set((state) => ({
        favorites: state.favorites.filter(c => c.id !== cardId)
      })),
    }),
    { name: 'huntercard-storage' }
  )
);
```

#### 4.1.2 實現收藏功能
- 使用 AsyncStorage 持久化收藏
- 實現「收藏」按鈕與收藏頁面
- 添加「已收藏」狀態顯示

#### 4.1.3 改進搜索 API
- 添加客戶端緩存 (如 react-query 或自己的 LRUCache)
- 添加離線 fallback 到本地 JSON
- 統一 API 端點

---

### 4.2 短期建議 (1-3 個月)

#### 4.2.1 重構代碼結構
**建議的組件化**：
```
src/
├── components/
│   ├── common/           # 按鈕、卡片、加載等通用組件
│   │   ├── Button.tsx
│   │   ├── Card.tsx
│   │   ├── Loading.tsx
│   │   └── EmptyState.tsx
│   ├── card/
│   │   ├── CardListItem.tsx
│   │   ├── CardImage.tsx
│   │   ├── CardBadge.tsx
│   │   └── PriceDisplay.tsx
│   └── search/
│       ├── SearchBar.tsx
│       └── FilterBar.tsx
├── screens/
│   ├── HomeScreen.tsx    # 只做導航和布局
│   ├── SearchScreen.tsx
│   ├── ScanScreen.tsx
│   └── ...
├── hooks/
│   ├── useSearch.ts      # 實現搜索邏輯
│   ├── useFavorites.ts   # 實現收藏邏輯
│   └── useCards.ts      # 數據獲取
├── services/
│   ├── api/              # API 封裝
│   │   └── client.ts
│   ├── storage/          # 持久化
│   │   └── favorites.ts
│   └── ocr/             # OCR 服務 (未來)
└── utils/
    ├── format.ts         # 格式化
    ├── validation.ts     # 驗證
    └── constants.ts      # 常量集中管理
```

#### 4.2.2 實現 OCR 識別
**選項**：
1. **Expo ML Kit** - 但可能需要 detach
2. **Apple Vision Framework** (iOS) - 原生 OCR
3. **Google Cloud Vision API** - 雲端 OCR
4. **本地 ML 模型** - 如 TensorFlow Lite

**建議**：先用 Apple Vision Framework 實現 iOS OCR，用戶體驗最好

#### 4.2.3 添加錯誤邊界
```typescript
// components/common/ErrorBoundary.tsx
import React from 'react';

export class ErrorBoundary extends React.Component {
  componentDidCatch(error, errorInfo) {
    console.error('Error caught:', error, errorInfo);
  }
  
  render() {
    return this.props.children;
  }
}
```

---

### 4.3 長期建議 (3-6 個月)

#### 4.3.1 數據層優化
- 實現本地 SQLite/Firebase 離線數據庫
- 實現增量更新機制
- 添加搜索索引優化

#### 4.3.2 性能優化
- 使用 React.lazy() 實現代碼分割
- 實現虛擬列表 (FlatList with getItemLayout)
- 圖片緩存與預加載

#### 4.3.3 擴展功能
- 卡牌價格提醒
- 市場趨勢圖表
- 用戶評論/評分
- 多語言支持

---

## 5. 下階段開發可行性評估

### 5.1 當前階段評估

| 功能 | 可行性 | 風險 | 備註 |
|------|--------|------|------|
| 搜尋功能 | ✅ 高 | 低 | 基礎功能完善 |
| 相機掃描 | ⚠️ 中 | 中 | 需實現真實 OCR |
| 收藏功能 | ⚠️ 中 | 低 | 需實現狀態管理 |
| 價格顯示 | ✅ 高 | 低 | API 已實現 |
| 離線使用 | ❌ 低 | 高 | 需重構數據層 |

### 5.2 推薦開發順序

1. **Phase 1**: 實現 Zustand 狀態管理 + 收藏功能 (1-2 週)
2. **Phase 2**: 實現 OCR 識別 (2-4 週)
3. **Phase 3**: 代碼重構 + 組件化 (2-3 週)
4. **Phase 4**: 離線數據支持 (2-3 週)
5. **Phase 5**: 性能優化 + 測試 (1-2 週)

### 5.3 總體建議

**立即行動**：
- 添加 Zustand 實現全局狀態
- 完成收藏功能實現

**近期優化**：
- OCR 識別實現
- 代碼重構為小型組件

**中期目標**：
- 離線支持
- 性能優化

---

## 6. 附錄

### A. 關鍵文件行數

| 文件 | 行數 | 評估 |
|------|------|------|
| ScanScreen.tsx | 936 | ❌ 過大 |
| CardDetailScreen.tsx | 307 | ⚠️ 偏大 |
| api/search.ts | 233 | ⚠️ 複雜 |
| HomeScreen.tsx | 240 | ⚠️ 偏大 |

### B. 類型文件衝突

- `src/types/index.ts` 定義 `Card`, `SearchResult`
- `src/types/hololive.ts` 定義 `HoloCard`, `Series`, `Member`
- `SearchResultsScreen.tsx` 內聯定義 `CardResult`

### C. 缺失的功能模組

- [ ] 全局狀態管理
- [ ] OCR 識別
- [ ] 收藏持久化
- [ ] 錯誤邊界
- [ ] 離線支持
- [ ] 單元測試

---

**報告完成**

*Generated by Software Architect - 2025-05-02*