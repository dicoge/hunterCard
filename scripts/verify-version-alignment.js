/**
 * 版本對齊回歸檢查
 *
 * 跑法：npm run test:version-alignment
 *
 * 具名個案（釘住 ¥ 金額的那些）讀的是凍結快照 scripts/fixtures/frozen-card-prices.json，
 * 不是每晚會被重寫的 public/data/database.json（DIC-1127）。yuyu-tei 價格是市場資料：
 * 2026-08-21 的爬取為 hBP02-017 新增了 ¥80 的 (hEB01) 重印掛牌，於是「預設 ¥120」這條
 * 斷言在程式碼毫無變動的情況下失敗並卡住所有 PR。凍結輸入才能讓釘住的金額有意義。
 * 全庫掃描（不釘金額、只驗規則）仍然跑真實出貨資料，任何價格都成立。
 *
 * 驗證 src/utils/versionAlignment.ts 在 DIC-1013 之後的合約：
 *  - 版本身分只來自來源掛牌名稱，不再由 rarity 推論（不得再出現 SEC→パラレル/サイン、
 *    SR→パラレル 這種來源沒說過的對應）。
 *  - 預設版本與組牌器低配預設是同一條規則（原印版優先、同層取最低參考售價）。
 *  - 同一版本代碼有多筆掛牌時 confident=false（版本待確認），不替使用者選價格。
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPriceVersions, resolveVersionForCard } from '../src/utils/versionAlignment.ts';
import { printingFromLabel, isPlainPrinting } from '../src/utils/printingIdentity.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { groupVariantsByCardNumber, buildLowCostIndex } from '../src/utils/deckVariants.ts';
import { frozenRawCards } from './lib/frozen-price-fixture.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(dirname, '..', 'public', 'data', 'database.json');
const liveCards = JSON.parse(readFileSync(dbPath, 'utf8')).cards || {};

// 具名個案用的資料：真實出貨列，但把受測卡號的掛牌換成凍結快照。
const frozenRows = frozenRawCards(Object.values(liveCards));
const frozenById = new Map(frozenRows.map((r) => [r.id, r]));
const cards = Object.fromEntries(
  Object.entries(liveCards).map(([k, row]) => [k, frozenById.get(row.id) ?? row]),
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.error(`  ❌ ${name} — ${detail}`); failures++; }
}

const entryFor = (cardNumber, rarityFrag) => Object.keys(cards).find(
  (k) => cards[k].cardNumber === cardNumber
    && (!rarityFrag || new RegExp(rarityFrag).test(cards[k].rarity || ''))
);
function resolveEntry(key) {
  const card = cards[key];
  if (!card) return null;
  const versions = buildPriceVersions(card);
  const r = resolveVersionForCard(versions);
  return { card, versions, r, selected: versions[r.index] };
}

console.log('=== 版本身分只來自來源掛牌 ===');

// 每個版本的 printing 必須等於它自己的掛牌名稱推導值，且與 rarity 無關。
{
  let mismatched = 0;
  for (const c of Object.values(cards)) {
    for (const v of buildPriceVersions(c)) {
      if (v.printing !== printingFromLabel(v.name)) mismatched++;
    }
  }
  check('全庫每個版本的 printing 都由自己的掛牌名稱推導', mismatched === 0, `${mismatched} 筆不符`);
}

// rarity 完全不影響對齊結果：同一組 versions 換掉 rarity 也得到同一個 index。
{
  const key = entryFor('hBP04-005');
  const e = resolveEntry(key);
  const versions = buildPriceVersions({ ...e.card, rarity: 'C', sourceRarity: 'C' });
  check(
    'hBP04-005 改寫 rarity 不改變對齊結果（rarity 不再參與推論）',
    resolveVersionForCard(versions).index === e.r.index,
    `got ${resolveVersionForCard(versions).index} vs ${e.r.index}`
  );
}

console.log('\n=== 預設版本 = 原印版最低參考售價（與組牌器同規則）===');

// hBP04-005 的 row rarity 是 SEC。舊版會據此對到 ¥69,800 簽名版；現在必須是 ¥980 原印版。
{
  const e = resolveEntry(entryFor('hBP04-005'));
  check(
    'hBP04-005（rarity SEC）→ 原印 ¥980，而非簽名 ¥69,800',
    e.r.confident && e.selected.sellPrice === 980 && e.selected.printing === 'BASE',
    `got confident=${e.r.confident} printing=${e.selected.printing} ¥${e.selected.sellPrice} (${e.r.reason})`
  );
}

// hBP02-084 的 hBP04 row rarity 是 SR。舊版會據此對到 ¥1,780 的泛用パラレル；
// 現在必須是原印最低價 ¥120，且 hBP04 重印 ¥180 是另一個獨立版本。
{
  const e = resolveEntry(entryFor('hBP02-084', 'SR'));
  const reprint = e.versions.find((v) => v.printing === 'HBP04');
  check(
    'hBP02-084（rarity SR）→ 原印 ¥120，而非泛用パラレル ¥1,780',
    e.r.confident && e.selected.sellPrice === 120 && e.selected.printing === 'BASE',
    `got confident=${e.r.confident} printing=${e.selected.printing} ¥${e.selected.sellPrice} (${e.r.reason})`
  );
  check(
    'hBP02-084 的 (hBP04) 重印是獨立版本 ¥180，未與原印 ¥120 併鍵',
    !!reprint && reprint.sellPrice === 180,
    `got ${JSON.stringify(reprint)}`
  );
}

// hSD01-017：原印 ¥80 與 (hBP04) 重印 ¥120 必須各自保有價格。
{
  const e = resolveEntry(entryFor('hSD01-017'));
  const base = e.versions.find((v) => v.printing === 'BASE');
  const reprint = e.versions.find((v) => v.printing === 'HBP04');
  check(
    'hSD01-017 原印 ¥80 與 (hBP04) 重印 ¥120 各自獨立且都有價',
    base?.sellPrice === 80 && reprint?.sellPrice === 120,
    `base=${JSON.stringify(base)} reprint=${JSON.stringify(reprint)}`
  );
  check(
    'hSD01-017 預設取較便宜的原印 ¥80',
    e.r.confident && e.selected.sellPrice === 80,
    `got confident=${e.r.confident} ¥${e.selected.sellPrice} (${e.r.reason})`
  );
}

console.log('\n=== 來源無法辨識時 fail closed ===');

// hBP02-017 真的有兩筆同名「白銀ノエル(パラレル)」¥3,480／¥500。預設仍是原印 ¥120，
// 但若使用者切到那個版本，來源無法辨識 —— 這裡驗證預設不會落在歧義版本上。
{
  const e = resolveEntry(entryFor('hBP02-017'));
  const dupes = e.versions.filter((v) => v.printing === 'PARALLEL');
  check(
    'hBP02-017 來源確實有多筆同代碼 パラレル 掛牌',
    dupes.length > 1,
    `got ${dupes.length}`
  );
  check(
    'hBP02-017 預設落在可辨識的原印 ¥120',
    e.r.confident && e.selected.sellPrice === 120 && e.selected.printing === 'BASE',
    `got confident=${e.r.confident} printing=${e.selected.printing} ¥${e.selected.sellPrice} (${e.r.reason})`
  );
}

// 預設版本本身是重複代碼時必須 confident=false。
{
  const versions = [
    { name: 'X(パラレル)', printing: 'PARALLEL', sellPrice: 3480, buyPrice: null },
    { name: 'X(パラレル)', printing: 'PARALLEL', sellPrice: 500, buyPrice: null },
  ];
  const r = resolveVersionForCard(versions);
  check('預設版本代碼有多筆掛牌 → confident=false', !r.confident, `got ${JSON.stringify(r)}`);
}

console.log('\n=== 全庫掃描（多版本卡，真實出貨資料）===');
const multi = Object.entries(liveCards).filter(
  ([, c]) => buildPriceVersions(c).filter((v) => (v.sellPrice ?? 0) > 0).length > 1
);
let badIndex = 0;
let premiumDefault = 0;
let waitCount = 0;
for (const [, c] of multi) {
  const versions = buildPriceVersions(c);
  const r = resolveVersionForCard(versions);
  if (r.index < 0 || r.index >= versions.length) badIndex++;
  if (!r.confident) waitCount++;
  const hasPlain = versions.some((v) => isPlainPrinting(v.printing));
  if (hasPlain && !isPlainPrinting(versions[r.index].printing)) premiumDefault++;
}
console.log(`  多版本卡：${multi.length}｜版本待確認：${waitCount}`);
check('所有解析的 index 皆合法', badIndex === 0, `${badIndex} 筆越界`);
check('有原印掛牌時，預設一律不落在パラレル/サイン 版', premiumDefault === 0, `${premiumDefault} 筆誤選溢價版`);

console.log('\n=== 跨消費端一致性（卡片頁／掃描 vs 組牌搜尋／遷移）===');

// 卡片頁與掃描讀的是來源掛牌順序，組牌搜尋讀的是排序後的版本清單。同價時若讓輸入順序
// 決定勝負，兩邊就會對同一張卡給出不同的版本代碼 —— 那是不同的擁有權／持久化／缺卡鍵。
// 這裡跑的是真正的兩條產線，不是重寫的簡化版。
{
  const db = adaptDatabase(Object.values(liveCards));
  const deckPick = new Map(
    groupVariantsByCardNumber(db.cards, db.priceRecords).map((g) => [g.cardNumber, g.card.printing]),
  );
  const rowFor = new Map();
  for (const c of Object.values(liveCards)) if (!rowFor.has(c.cardNumber)) rowFor.set(c.cardNumber, c);

  const detailPick = (row) => {
    const versions = buildPriceVersions(row);
    return versions[resolveVersionForCard(versions).index].printing;
  };

  // CR 具名的六張：同價的エラッタ前／エラッタ後，先前一邊挑前、一邊挑後。
  const CR_CASES = ['hBP03-027', 'hSD07-003', 'hBP01-081', 'hBP02-003', 'hBP02-078', 'hBP02-102'];
  for (const num of CR_CASES) {
    const detail = detailPick(rowFor.get(num));
    const deck = deckPick.get(num);
    check(
      `${num} 卡片頁／掃描與組牌選到同一個版本代碼`,
      detail === deck && !!deck,
      `detail=${detail} deck=${deck}`,
    );
  }

  let compared = 0;
  const diverged = [];
  for (const [num, row] of rowFor) {
    const deck = deckPick.get(num);
    if (!deck) continue; // 組牌完全不提供（無可放置分區）的卡號
    compared++;
    if (detailPick(row) !== deck) diverged.push(`${num}: detail=${detailPick(row)} deck=${deck}`);
  }
  console.log(`  比對卡號：${compared}`);
  check(
    '全庫每個卡號的預設版本在兩條產線上一致',
    diverged.length === 0,
    `${diverged.length} 筆分歧，例如 ${diverged.slice(0, 3).join('；')}`,
  );

  // 舊草稿遷移吃的就是 buildLowCostIndex，上面比對的即是它的值域。
  const index = buildLowCostIndex(groupVariantsByCardNumber(db.cards, db.priceRecords));
  check(
    '草稿遷移索引與組牌搜尋同源（同一個 printing）',
    CR_CASES.every((n) => index.get(n)?.printing === deckPick.get(n)),
    CR_CASES.map((n) => `${n}=${index.get(n)?.printing}`).join(' '),
  );

  // 順序無關性本身：把來源掛牌反轉後仍解析到同一個版本代碼。
  const orderStable = CR_CASES.every((num) => {
    const versions = buildPriceVersions(rowFor.get(num));
    const reversed = versions.slice().reverse();
    return reversed[resolveVersionForCard(reversed).index].printing === detailPick(rowFor.get(num));
  });
  check('反轉來源掛牌順序不改變預設版本', orderStable, '順序仍然影響結果');
}

console.log('');
if (failures > 0) {
  console.error(`回歸檢查失敗：${failures} 項未通過。`);
  process.exit(1);
} else {
  console.log('回歸檢查全部通過。');
}
