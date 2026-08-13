/**
 * add-zh-names.js — 為 database.json 中的卡片添加中文名稱 (nameZh)
 *
 * 從 data/character-names-zh.json 讀取日文→中文翻譯對照表，
 * 比對每張卡片的 name 欄位，若找到匹配則寫入 nameZh 欄位。
 * 若無匹配，透過 OpenRouter API (Gemini) 自動翻譯日文名 → 中文名。
 * API 翻譯也失敗時，nameZh 設為空字串。
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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'google/gemini-3.1-flash-image';

/**
 * 透過 OpenRouter API 將日文角色名翻譯成繁體中文
 * @param {string} jpName - 日文角色名
 * @returns {Promise<string>} - 中文翻譯，失敗時返回空字串
 */
async function autoTranslate(jpName) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('[add-zh-names] ⚠️ OPENROUTER_API_KEY 未設定，跳過自動翻譯');
    return '';
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: 'user',
            content: `Translate this Hololive character name from Japanese to Traditional Chinese. Respond with ONLY the translation, no explanation. Name: ${jpName}`,
          },
        ],
        max_tokens: 50,
        temperature: 0.0,
      }),
    });

    if (!response.ok) {
      console.error(`[add-zh-names] ⚠️ API 錯誤 (${response.status}): ${await response.text()}`);
      return '';
    }

    const data = await response.json();
    const translation = data.choices?.[0]?.message?.content?.trim();

    if (translation) {
      console.log(`[add-zh-names] 🤖 Auto-translated: ${jpName} → ${translation}`);
      return translation;
    }

    console.warn(`[add-zh-names] ⚠️ API 回傳空內容: ${jpName}`);
    return '';
  } catch (err) {
    console.error(`[add-zh-names] ⚠️ API 呼叫失敗: ${err.message}`);
    return '';
  }
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
  let autoCount = 0;
  let missCount = 0;

  for (const cardId of cardIds) {
    const card = database.cards[cardId];
    const cardName = card.name || '';

    if (translationMap[cardName] !== undefined) {
      card.nameZh = translationMap[cardName];
      matchCount++;
    } else {
      const translated = await autoTranslate(cardName);
      if (translated) {
        card.nameZh = translated;
        translationMap[cardName] = translated;
        autoCount++;
      } else {
        card.nameZh = '';
        missCount++;
      }
    }
  }

  // 寫回資料庫
  fs.writeFileSync(dbPath, `${JSON.stringify(database, null, 2)}\n`, 'utf-8');

  console.log(`[add-zh-names] ✅ 完成！`);
  console.log(`[add-zh-names]   靜態匹配: ${matchCount} 張卡片`);
  console.log(`[add-zh-names]   自動翻譯: ${autoCount} 張卡片`);
  console.log(`[add-zh-names]   未匹配: ${missCount} 張卡片`);
  console.log(`[add-zh-names]   輸出: ${dbPath}`);
}

// 獨立執行
if (process.argv[1]?.includes('add-zh-names')) {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;
  await addZhNames(dbPath);
}