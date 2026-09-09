/**
 * add-zh-names.js — 為 database.json 中的卡片添加中文名稱 (nameZh)
 *
 * 從 data/character-names-zh.json 讀取日文→中文翻譯對照表，
 * 比對每張卡片的 name 欄位，若找到匹配則寫入 nameZh 欄位。
 * 若無匹配，保留既有 nameZh 或 fail closed；不呼叫未授權翻譯供應商。
 * 未匹配會讓 pipeline exit non-zero，避免空翻譯被提交。
 *
 * DIC-1185 FinOps repair: 移除 OpenRouter 自動翻譯後援。OpenRouter 為硬性
 * denylist，任何情況下都不可對 openrouter.ai 發出請求，包含環境中殘留的
 * OPENROUTER_API_KEY。
 *
 * 用法: node scripts/add-zh-names.js [database路徑]
 * 預設: data/database.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'database.json');
const TRANSLATION_PATH = path.join(DATA_DIR, 'character-names-zh.json');

/**
 * 讀取翻譯檔，過濾掉含有替換字元 (U+FFFD) 的損壞條目
 */
function loadTranslationMap(filepath) {
  if (!fs.existsSync(filepath)) {
    console.error(`[add-zh-names] ❌ 翻譯檔不存在: ${filepath}`);
    return {};
  }

  const raw = fs.readFileSync(filepath, 'utf-8');
  const translations = JSON.parse(raw);
  const clean = {};
  let filteredCount = 0;

  for (const [jp, zh] of Object.entries(translations)) {
    // 過濾包含 U+FFFD (replacement character) 的損壞條目
    if (jp.includes('\uFFFD') || zh.includes('\uFFFD')) {
      filteredCount++;
      continue;
    }
    clean[jp] = zh;
  }

  if (filteredCount > 0) {
    console.log(`[add-zh-names] ⚠️ 過濾了 ${filteredCount} 個損壞的翻譯條目 (含 U+FFFD)`);
  }

  console.log(`[add-zh-names] ✅ 載入 ${Object.keys(clean).length} 筆翻譯對照`);
  return clean;
}

function decodeHtml(input = '') {
  return String(input)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * 為資料庫中的每張卡片添加 nameZh 欄位
 * @param {string} dbPath - database.json 路徑（可選，預設 data/database.json）
 */
export async function addZhNames(dbPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    console.error(`[add-zh-names] ❌ 資料庫不存在: ${dbPath}`);
    return;
  }

  console.log(`[add-zh-names] 開始為卡片添加中文名稱...`);

  // 載入翻譯對照表
  const translationMap = loadTranslationMap(TRANSLATION_PATH);
  if (Object.keys(translationMap).length === 0) {
    console.error(`[add-zh-names] ❌ 翻譯對照表為空，中止`);
    return;
  }

  // 讀取資料庫
  const dbRaw = fs.readFileSync(dbPath, 'utf-8');
  const database = JSON.parse(dbRaw);

  if (!database.cards || typeof database.cards !== 'object') {
    console.error(`[add-zh-names] ❌ 資料庫格式錯誤：缺少 cards 物件`);
    return;
  }

  const cardIds = Object.keys(database.cards);
  console.log(`[add-zh-names] 📝 處理 ${cardIds.length} 張卡片...`);

  let matchCount = 0;
  let missCount = 0;
  const missing = [];

  for (const cardId of cardIds) {
    const card = database.cards[cardId];
    const cardName = card.name || '';
    const candidates = [...new Set([cardName, decodeHtml(cardName)].filter(Boolean))];

    const matchedKey = candidates.find((name) => translationMap[name] !== undefined);
    if (matchedKey !== undefined) {
      card.nameZh = translationMap[matchedKey];
      matchCount++;
    } else if (card.nameZh && String(card.nameZh).trim()) {
      matchCount++;
    } else {
      card.nameZh = '';
      missCount++;
      missing.push({ id: cardId, name: cardName });
    }
  }

  // 寫回資料庫
  fs.writeFileSync(dbPath, `${JSON.stringify(database, null, 2)}\n`, 'utf-8');

  console.log(`[add-zh-names] ✅ 完成！`);
  console.log(`[add-zh-names]   靜態匹配: ${matchCount} 張卡片`);
  console.log(`[add-zh-names]   未匹配: ${missCount} 張卡片`);
  console.log(`[add-zh-names]   輸出: ${dbPath}`);
  if (missing.length > 0) {
    const sample = missing.slice(0, 10).map((m) => `${m.id}:${m.name}`).join('\n  ');
    throw new Error(`[add-zh-names] missing Traditional-Chinese names (${missing.length}). Add controlled entries to data/character-names-zh.json; sample:\n  ${sample}`);
  }
}

// 獨立執行
if (process.argv[1]?.includes('add-zh-names')) {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;
  await addZhNames(dbPath);
}
