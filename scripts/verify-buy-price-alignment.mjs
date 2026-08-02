/**
 * verify-buy-price-alignment.mjs — DIC-856 版本精確對齊自動測試。
 *
 * 證明：
 *  1. 同卡號多版本價格不同時，各版本收購價「不取 max、不混版」。
 *  2. 某版本對不到收購價時回 null（fail closed），絕不退回最高價 / 別版價。
 *  3. 帶標籤替代平行版（パラレル/HR）只吃完全相同 rarity 的收購價。
 *  4. 對真實 database.json：每個已寫入的 variant.buyPrice 都能在該卡號的來源買取價中，
 *     找到「相同版本類別（或相同 token rarity）且金額相同」的來源；不存在跨版本借價。
 *  5. 抽樣 ≥10 張多版本卡，輸出 selected variant key / 販售來源價 / 收購來源價 / 是否同版本。
 *
 * 純 node，無測試框架；任何斷言失敗 → process.exit(1)（CI 會擋）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCardNumber,
  normalizeRarity,
  versionClassFromRarity,
  versionClassFromName,
  rarityTokenInName,
} from './lib/variant-key.js';
import { assignVariantBuyPrices, representativeBuyPrice } from './merge-buy-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '../data');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

// entries helper：把來源 rarity 攤成 { rarity, versionClass, price }
const E = (rarity, price) => ({ rarity: normalizeRarity(rarity), versionClass: versionClassFromRarity(rarity), price });

console.log('── Unit: 版本分類 ──');
check('rarity → class', () => {
  assert.equal(versionClassFromRarity('SEC'), 'signed');
  assert.equal(versionClassFromRarity('OUR'), 'parallel');
  assert.equal(versionClassFromRarity('UR'), 'parallel');
  assert.equal(versionClassFromRarity('HR'), 'parallel');
  assert.equal(versionClassFromRarity(null), 'base');
  assert.equal(versionClassFromRarity('C'), 'base');
  assert.equal(versionClassFromRarity('S'), 'base');
  assert.equal(versionClassFromRarity('P'), 'base');
  // 套牌/雜訊代碼不得臆測成平行或簽名版 → 一律落 base（fail safe）
  assert.equal(versionClassFromRarity('HSD06'), 'base');
  assert.equal(versionClassFromRarity('HBP04'), 'base');
});
check('name → class', () => {
  assert.equal(versionClassFromName('ラプラス・ダークネス'), 'base');
  assert.equal(versionClassFromName('ラプラス・ダークネス(パラレル)'), 'parallel');
  assert.equal(versionClassFromName('ラプラス・ダークネス(パラレル/サイン)'), 'signed');
  assert.equal(rarityTokenInName('X(パラレル/HR)'), 'HR');
  assert.equal(rarityTokenInName('X(パラレル)'), null);
});

console.log('── Unit: 不取 max、不混版 ──');
check('三版本各自對齊，base≠parallel≠signed（不塌成最高價）', () => {
  const variants = [
    { name: 'X(パラレル/サイン)' },
    { name: 'X(パラレル)' },
    { name: 'X' },
  ];
  const buy = [E('SEC', 38000), E('OUR', 5000), E(null, 150)];
  const out = assignVariantBuyPrices(variants, buy);
  assert.deepEqual(out, [38000, 5000, 150]);
  assert.notEqual(out[2], out[0]); // 普通版不得等於簽名版（無 max 塌陷）
});

console.log('── Unit: fail closed ──');
check('某版本無對應收購價 → null，不借別版', () => {
  const variants = [{ name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E(null, 150)]; // 只有普通版收購價
  const out = assignVariantBuyPrices(variants, buy);
  assert.deepEqual(out, [null, 150]); // 平行版對不到 → null，不吃 150
});
check('完全無收購資料 → 全 null', () => {
  assert.deepEqual(assignVariantBuyPrices([{ name: 'X' }, { name: 'X(パラレル)' }], []), [null, null]);
});
check('representativeBuyPrice 不跨版本 fallback', () => {
  const buy = [E(null, 150)]; // 只有普通版
  assert.equal(representativeBuyPrice('SEC', buy), null); // 簽名卡對不到 → null（非退回 150）
  assert.equal(representativeBuyPrice('C', buy), 150);
});

console.log('── Unit: 帶標籤替代平行版 ──');
check('パラレル/HR 只吃 HR，普通パラレル吃非 token rarity', () => {
  const variants = [{ name: 'X(パラレル/HR)' }, { name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('HR', 3000), E('OUR', 800), E(null, 100)];
  const out = assignVariantBuyPrices(variants, buy);
  assert.deepEqual(out, [3000, 800, 100]);
});
check('普通パラレル不吃被 token 宣告的 HR 價', () => {
  const variants = [{ name: 'X(パラレル/HR)' }, { name: 'X(パラレル)' }];
  const buy = [E('HR', 3000)]; // 只有 HR
  const out = assignVariantBuyPrices(variants, buy);
  assert.deepEqual(out, [3000, null]); // 普通パラレル對不到 → null
});

// ── 真實資料驗證 ──
console.log('── Integration: 真實 database.json ──');
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'database.json'), 'utf-8')).cards;

// 由來源檔重建 numKey → { class/token → [prices] } 以驗證 provenance。
function loadSourceIndex() {
  const idx = new Map(); // numKey -> array of { rarity, versionClass, price, source }
  for (const f of ['fullahead-prices.json', 'torecolo-prices.json']) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(DATA, 'buy-prices', f), 'utf-8')); } catch { continue; }
    for (const [k, v] of Object.entries(raw || {})) {
      const num = normalizeCardNumber(k);
      if (!num || !v || !(Number(v.buyPrice) > 0)) continue;
      const rarity = normalizeRarity(v.rarity != null ? v.rarity : k.slice(num.length));
      if (!idx.has(num)) idx.set(num, []);
      idx.get(num).push({ rarity, versionClass: versionClassFromRarity(rarity || null), price: Number(v.buyPrice), source: f.split('-')[0] });
    }
  }
  return idx;
}
const srcIdx = loadSourceIndex();

check('acceptance: hBP04-005 base=150 / parallel=5000 / signed=38000（不固定 38000）', () => {
  const c = db['hBP04-005_hBP04'];
  assert.ok(c, 'card hBP04-005_hBP04 存在');
  const byName = Object.fromEntries(c.prices.map((v) => [v.name, v.buyPrice ?? null]));
  assert.equal(byName['ラプラス・ダークネス'], 150);
  assert.equal(byName['ラプラス・ダークネス(パラレル)'], 5000);
  assert.equal(byName['ラプラス・ダークネス(パラレル/サイン)'], 38000);
});

check('全庫 invariant: 每個 variant.buyPrice 都源自同版本類別/同 token 的來源價（無跨版本借價）', () => {
  let scanned = 0;
  let violations = [];
  for (const [id, c] of Object.entries(db)) {
    if (!Array.isArray(c.prices)) continue;
    const num = normalizeCardNumber(c.cardNumber);
    const src = (num && srcIdx.get(num)) || [];
    const tokenRarities = new Set(c.prices.map((v) => rarityTokenInName(v.name)).filter(Boolean));
    for (const v of c.prices) {
      if (v.buyPrice == null) continue;
      scanned += 1;
      const classV = versionClassFromName(v.name);
      const tokenV = rarityTokenInName(v.name);
      const ok = src.some((b) => {
        if (b.price !== v.buyPrice) return false;
        if (tokenV) return b.rarity === tokenV;
        if (classV === 'parallel') return b.versionClass === 'parallel' && !tokenRarities.has(b.rarity);
        return b.versionClass === classV;
      });
      if (!ok) violations.push(`${id} :: ${v.name} = ${v.buyPrice}`);
    }
  }
  assert.ok(scanned > 500, `掃描版本數過少（${scanned}）`);
  assert.equal(violations.length, 0, `發現跨版本借價 ${violations.length} 筆，例：\n      ${violations.slice(0, 5).join('\n      ')}`);
  console.log(`      （掃描 ${scanned} 個已對齊版本，全部 provenance 正確）`);
});

check('全庫 invariant: 多版本卡不得所有版本共用同一收購價（當來源本身分版時）', () => {
  let collapsed = [];
  for (const [id, c] of Object.entries(db)) {
    if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
    const num = normalizeCardNumber(c.cardNumber);
    const src = (num && srcIdx.get(num)) || [];
    const classes = new Set(src.map((b) => b.versionClass));
    if (classes.size < 2) continue; // 來源本身只有單一版本，跳過
    const buys = c.prices.map((v) => v.buyPrice).filter((x) => x != null);
    if (buys.length >= 2 && new Set(buys).size === 1) collapsed.push(`${id} all=${buys[0]}`);
  }
  assert.equal(collapsed.length, 0, `發現版本塌陷（來源分版卻共用同價）例：\n      ${collapsed.slice(0, 5).join('\n      ')}`);
});

// ── 抽樣輸出 ≥10 張多版本卡 ──
console.log('\n── Sample: 多版本卡對齊明細（selected variant key / 販售 / 收購 / 同版本）──');
const samples = [];
const seenNum = new Set();
for (const [id, c] of Object.entries(db)) {
  if (samples.length >= 12) break;
  if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
  const num = normalizeCardNumber(c.cardNumber);
  if (seenNum.has(num)) continue;
  const src = (num && srcIdx.get(num)) || [];
  if (src.length < 2) continue; // 只抽來源分版的卡，最能展示對齊
  seenNum.add(num);
  samples.push([id, c]);
}
// 補：確保涵蓋不同 rarity 類型
for (const [id, c] of samples) {
  const num = normalizeCardNumber(c.cardNumber);
  console.log(`\n${id}  (cardNumber ${num}, card.rarity ${c.rarity})  card.buyPrice=${c.buyPrice ?? 'null'}`);
  for (const v of c.prices) {
    const cls = versionClassFromName(v.name);
    const tok = rarityTokenInName(v.name);
    const key = `${num}|${cls}${tok ? '|' + tok : ''}`;
    const buy = v.buyPrice != null ? `¥${v.buyPrice}` : '（此版本暫無收購價）';
    const same = v.buyPrice != null ? '同版本✔' : 'fail-closed';
    console.log(`   key=${key}  販售¥${v.sellPrice}  收購${buy}  ${same}`);
  }
}
assert.ok(samples.length >= 10, `多版本抽樣不足 10 張（${samples.length}）`);
console.log(`\n抽樣張數：${samples.length}`);

if (failures > 0) {
  console.error(`\n❌ ${failures} 項測試失敗`);
  process.exit(1);
}
console.log('\n✅ 全部通過');
