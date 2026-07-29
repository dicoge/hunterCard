/**
 * 版本對齊回歸檢查（用真實 public/data/database.json）
 *
 * 跑法：  npx tsx scripts/verify-version-alignment.js
 *   （需經 tsx 以便載入 TS 版對齊邏輯；scripts 目錄為 ESM）
 *
 * 驗證 src/utils/versionAlignment.ts 的 resolveVersionForCard：
 *  - 能唯一對齊時，選中的是「對的版本」而非最低價彙總值。
 *  - 無法唯一對齊時，回報 confident=false（讓 UI 標示「版本待確認」），
 *    絕不靜默把最低價當成已對齊。
 * 覆蓋 CR 指名的 hBP01-008、hBP01-024 等 case。失敗以非零碼結束。
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import versionAlignment from '../src/utils/versionAlignment';

const { buildPriceVersions, resolveVersionForCard } = versionAlignment;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(dirname, '..', 'public', 'data', 'database.json');
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const cards = db.cards || {};

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    console.error(`  ❌ ${name} — ${detail}`);
    failures++;
  }
}

function resolveEntry(key) {
  const card = cards[key];
  if (!card) return null;
  const versions = buildPriceVersions(card);
  const r = resolveVersionForCard(card, versions);
  return { card, versions, r, selected: versions[r.index] };
}

console.log('=== 指名 case（CR 要求）===');

// hBP01-024：rarity HR 的 entry 必須對齊到 "(パラレル/HR)" ¥3980（非最低 ¥50、非 base ¥120）。
for (const key of Object.keys(cards).filter(
  k => cards[k].cardNumber === 'hBP01-024' && /HR/.test(cards[k].rarity || '')
)) {
  const e = resolveEntry(key);
  check(
    `${key} (rarity ${e.card.rarity}) → 對齊 パラレル/HR ¥3980`,
    e.r.confident && e.selected.sellPrice === 3980 && /HR/.test(e.selected.name),
    `got confident=${e.r.confident} name="${e.selected.name}" ¥${e.selected.sellPrice} (${e.r.reason})`
  );
}

// hBP01-008：rarity OUR，必須對齊到 パラレル ¥14800，且不可靜默退回最低價 ¥280（CR 核心 case）。
for (const key of ['hBP01-008_hBP01', 'hBP01-008_ent07']) {
  const e = resolveEntry(key);
  if (!e) { check(`${key} 存在`, false, '找不到此 entry'); continue; }
  check(
    `${key} (rarity ${e.card.rarity}) → 對齊 パラレル ¥14800，非最低 ¥${e.card.sellPrice}`,
    e.r.confident && e.selected.sellPrice === 14800 && e.selected.sellPrice !== e.card.sellPrice,
    `got confident=${e.r.confident} name="${e.selected.name}" ¥${e.selected.sellPrice} (${e.r.reason})`
  );
}

// SEC → パラレル/サイン（最高簽名版）。
{
  const key = Object.keys(cards).find(k => cards[k].cardNumber === 'hBP03-003');
  const e = key ? resolveEntry(key) : null;
  if (e) check(
    `hBP03-003 (rarity ${e.card.rarity}) → 對齊 パラレル/サイン`,
    e.r.confident && e.selected.name.includes('サイン'),
    `got confident=${e.r.confident} name="${e.selected.name}" (${e.r.reason})`
  );
}

// 真實歧義 case（多個原印/重印版本）必須 confident=false，不可硬選價格當成已對齊。
{
  const key = Object.keys(cards).find(k => cards[k].cardNumber === 'hSD01-017');
  const e = key ? resolveEntry(key) : null;
  if (e) check(
    `hSD01-017 (rarity ${e.card.rarity}) 多原印版本 → 版本待確認 (confident=false)`,
    !e.r.confident,
    `got confident=${e.r.confident} (${e.r.reason})`
  );
}

// === 搜尋畫面 rarity 重映射情境（QA 回報的真正 root cause）===
// SearchResultsScreen 會把資料庫 rarity 重映射成顯示用色階（HR/SEC 落到預設 'C'、OUR→'SR'），
// 詳情頁若直接拿這個重映射後的 rarity 對齊，高 rarity 卡會被當成低 rarity → 對到最低價版本。
// 修正：搜尋結果同時帶 sourceRarity（原始 rarity），對齊改用 sourceRarity。
console.log('\n=== 搜尋 rarity 重映射（sourceRarity）===');
function remapRarityForDisplay(raw) {
  const code = (raw || '').toUpperCase();
  if (code.includes('OSR') || code.includes('OUR')) return 'SR';
  if (code === 'UR') return 'R';
  if (code === 'SR') return 'U';
  if (code === 'RR' || code === 'R' || code === 'U' || code === 'C') return 'C';
  if (code === 'N') return 'N';
  return 'C'; // HR / SEC 等未列舉者落到預設 'C'
}
// 模擬搜尋結果送進詳情頁的 card 物件：rarity 已被重映射，並附上 sourceRarity。
function asSearchResult(dbCard) {
  return { ...dbCard, rarity: remapRarityForDisplay(dbCard.rarity), sourceRarity: dbCard.rarity };
}
for (const [key, expectFrag, expectPrice] of [
  ['hBP01-024_ent07', '(パラレル/HR)', 3980],
  ['hBP03-003_ent07', 'サイン', 128000],
]) {
  const db = cards[key];
  if (!db) { check(`${key} 存在`, false, '找不到此 entry'); continue; }
  const versions = buildPriceVersions(db);
  const sr = asSearchResult(db);
  const withSource = resolveVersionForCard(sr, versions);
  const wSel = versions[withSource.index];
  check(
    `${key}（搜尋重映射 rarity=${sr.rarity}，sourceRarity=${sr.sourceRarity}）→ 對齊 ${expectFrag} ¥${expectPrice}`,
    withSource.confident && wSel.name.includes(expectFrag) && wSel.sellPrice === expectPrice,
    `got confident=${withSource.confident} name="${wSel.name}" ¥${wSel.sellPrice} (${withSource.reason})`
  );
  // 若沒有 sourceRarity（舊 bug），只剩重映射 rarity → 會誤判並選錯版本，作為 root-cause 佐證。
  const noSource = resolveVersionForCard({ ...db, rarity: sr.rarity, sourceRarity: undefined }, versions);
  const nSel = versions[noSource.index];
  check(
    `${key} 若無 sourceRarity 會誤對齊（證明 root cause）`,
    !(noSource.confident && nSel.sellPrice === expectPrice),
    `unexpectedly still correct: name="${nSel.name}" ¥${nSel.sellPrice}`
  );
}

console.log('\n=== 全庫掃描（多版本卡）===');
const multi = Object.entries(cards).filter(
  ([, c]) => buildPriceVersions(c).filter(v => (v.sellPrice ?? 0) > 0).length > 1
);
let confidentCount = 0;
let waitCount = 0;
let confidentPickedMin = 0; // 已對齊卻選到該卡最低價版本的張數（審視是否仍有混版嫌疑）
let badIndex = 0;
for (const [, c] of multi) {
  const versions = buildPriceVersions(c);
  const r = resolveVersionForCard(c, versions);
  if (r.index < 0 || r.index >= versions.length) badIndex++;
  if (r.confident) {
    confidentCount++;
    const prices = versions.map(v => v.sellPrice ?? 0);
    const min = Math.min(...prices);
    if ((versions[r.index].sellPrice ?? 0) === min && new Set(prices).size > 1) confidentPickedMin++;
  } else {
    waitCount++;
  }
}
console.log(`  多版本卡：${multi.length}｜唯一對齊：${confidentCount}｜版本待確認：${waitCount}`);
console.log(`  （其中「已對齊但選中最低價版本」：${confidentPickedMin} — 多為低 rarity 原印版，屬正常）`);
check('所有解析的 index 皆合法', badIndex === 0, `${badIndex} 筆越界`);

console.log('');
if (failures > 0) {
  console.error(`回歸檢查失敗：${failures} 項未通過。`);
  process.exit(1);
} else {
  console.log('回歸檢查全部通過。');
}
