/**
 * 價格歷史記錄服務
 * Price History Service
 *
 * 儲存與讀取每日價格歷史資料
 * 檔案儲存在 data/price-history/ 目錄
 * 每張卡片一個 JSON 檔案，以 cardId 命名
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── 類型定義 ──

export interface PriceRecord {
  date: string;          // YYYY-MM-DD
  price: number;         // 日圓（最低價）
  source: string;        // 'yuyu-tei'
  currency: string;      // 'JPY'
  cardId: string;        // database key (e.g. 'hBD24-007_ent07')
}

export interface CardPriceHistory {
  cardId: string;
  cardNumber: string;
  name: string;
  nameZh?: string;
  records: PriceRecord[];  // 按日期排序（舊→新）
  lastUpdated: string;     // ISO datetime
}

export interface PriceHistoryIndex {
  lastUpdated: string;
  totalCards: number;
  totalRecords: number;
  cardIds: string[];
}

// ── 路徑設定 ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const HISTORY_DIR = path.join(PROJECT_ROOT, 'data', 'price-history');
const INDEX_FILE = path.join(HISTORY_DIR, 'index.json');

function ensureDir() {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// ── 核心 API ──

/**
 * 儲存單筆價格記錄
 * 去重：同一天同一來源不重複
 */
export async function savePriceRecord(cardId: string, record: PriceRecord): Promise<void> {
  ensureDir();
  const filePath = path.join(HISTORY_DIR, `${sanitizeId(cardId)}.json`);

  let history: CardPriceHistory;
  try {
    history = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    history = {
      cardId,
      cardNumber: '',
      name: '',
      records: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  // 去重檢查
  const isDuplicate = history.records.some(
    r => r.date === record.date && r.source === record.source
  );

  if (!isDuplicate) {
    history.records.push(record);
    history.records.sort((a, b) => a.date.localeCompare(b.date));
    history.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
  }

  // 更新索引
  await updateIndexForCard(cardId);
}

/**
 * 批次儲存多筆記錄（爬蟲完成後用）
 * 優化：一次讀取所有受影響的卡片，批量寫入
 */
export async function savePriceRecordsBatch(
  records: PriceRecord[],
  dbCards?: Record<string, any>
): Promise<void> {
  ensureDir();

  // 按 cardId 分組
  const grouped: Record<string, PriceRecord[]> = {};
  for (const record of records) {
    if (!grouped[record.cardId]) grouped[record.cardId] = [];
    grouped[record.cardId].push(record);
  }

  const updatedCardIds: string[] = [];

  for (const [cardId, newRecords] of Object.entries(grouped)) {
    const filePath = path.join(HISTORY_DIR, `${sanitizeId(cardId)}.json`);

    let history: CardPriceHistory;
    try {
      history = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      history = {
        cardId,
        cardNumber: '',
        name: '',
        records: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    // 去重：避免同一天同一來源重複
    const existingKeys = new Set(history.records.map(r => `${r.date}|${r.source}`));
    let addedCount = 0;

    for (const nr of newRecords) {
      const key = `${nr.date}|${nr.source}`;
      if (!existingKeys.has(key)) {
        history.records.push(nr);
        existingKeys.add(key);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      history.records.sort((a, b) => a.date.localeCompare(b.date));
      history.lastUpdated = new Date().toISOString();

      // 從 dbCards 補充 cardNumber/name 資訊
      if (dbCards && dbCards[cardId]) {
        const info = dbCards[cardId];
        history.cardNumber = info.cardNumber || '';
        history.name = info.name || '';
        history.nameZh = info.nameZh || '';
      }

      fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
      updatedCardIds.push(cardId);
    }
  }

  // 更新索引
  if (updatedCardIds.length > 0) {
    await rebuildIndex();
    console.log(`[price-history] Saved ${records.length} records for ${updatedCardIds.length} cards (${records.length} total)`);
  } else {
    console.log(`[price-history] No new records to save (all ${records.length} records were duplicates)`);
  }
}

/**
 * 讀取單張卡片的價格歷史
 */
export async function getCardPriceHistory(cardId: string): Promise<CardPriceHistory | null> {
  const filePath = path.join(HISTORY_DIR, `${sanitizeId(cardId)}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 讀取價格歷史索引
 */
export async function getPriceHistoryIndex(): Promise<PriceHistoryIndex | null> {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 取得所有有歷史資料的卡片 ID
 */
export async function getAllCardIdsWithHistory(): Promise<string[]> {
  const index = await getPriceHistoryIndex();
  return index?.cardIds || [];
}

// ── 輔助函式 ──

function sanitizeId(id: string): string {
  // cardId 可能包含特殊字元，確保檔名安全
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function updateIndexForCard(cardId: string): Promise<void> {
  let index: PriceHistoryIndex;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    index = { lastUpdated: new Date().toISOString(), totalCards: 0, totalRecords: 0, cardIds: [] };
  }

  const safeId = sanitizeId(cardId);
  if (!index.cardIds.includes(safeId)) {
    index.cardIds.push(safeId);
  }

  // 重新計算總記錄數（簡化計算，只更新 metadata）
  index.totalCards = index.cardIds.length;
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

async function rebuildIndex(): Promise<void> {
  let totalRecords = 0;
  const cardIds: string[] = [];

  try {
    const files = fs.readdirSync(HISTORY_DIR);
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      const cardId = file.replace('.json', '');
      cardIds.push(cardId);

      try {
        const history = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, file), 'utf-8'));
        totalRecords += history.records?.length || 0;
      } catch {
        // skip corrupted files
      }
    }
  } catch {
    // directory doesn't exist yet
  }

  const index: PriceHistoryIndex = {
    lastUpdated: new Date().toISOString(),
    totalCards: cardIds.length,
    totalRecords,
    cardIds,
  };

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`[price-history] Index rebuilt: ${cardIds.length} cards, ${totalRecords} records`);
}
