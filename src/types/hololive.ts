// hololive 卡牌專用類型定義

export type Rarity = 'C' | 'U' | 'R' | 'SR' | 'UC' | 'CP';

export interface HoloCard {
  id: string;
  cardNumber: string;
  member: string;           // 中文名稱
  memberJp: string;         // 日文名稱
  series: string;           // 系列名稱（中文）
  seriesCode: string;       // 系列代碼
  rarity: Rarity;
  imageUrl?: string;
  description?: string;
  releaseDate?: string;
  category: 'hololive' | 'holostars' | 'inukomis' | 'other';
  prices?: PriceInfo[];
  priceHistory?: Record<string, number>;
  isFavorite?: boolean;
}

export interface PriceInfo {
  source: string;           // 來源網站名稱
  price: number;            // 價格
  currency: string;         // 幣別
  condition: '全新' | '近新' | '良好' | '普通';
  url: string;              // 購買連結
  lastUpdated: string;      // 最後更新時間
  inStock: boolean;         // 是否有庫存
}

export interface Series {
  code: string;
  name: string;
  releaseDate: string;
  count: number;
}

export interface Member {
  name: string;
  nameJp: string;
  generation: string;
  description: string;
}

export interface SearchQuery {
  cardNumber?: string;      // 精確卡號查詢
  memberName?: string;      // 成員名稱查詢
  seriesCode?: string;      // 系列查詢
  rarity?: Rarity;          // 稀有度篩選
  keyword?: string;         // 關鍵字查詢
}

export interface SearchResult {
  cards: HoloCard[];
  totalFound: number;
  query: SearchQuery;
  sources: string[];        // 資料來源
  hasPrices: boolean;       // 是否包含價格資訊
}
