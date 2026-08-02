/**
 * verify-buy-price-alignment.mjs — DIC-856 版本精確對齊自動測試（CR DIC-857 版）。
 *
 * 證明（精確 token 對齊，非 class + Math.max）：
 *  1. token 正規化「完全相等」比對：HSD06≠S、hBP07≠P、P_03≠P（不子字串臆測版本）。
 *  2. 同卡號多版本各自對齊，base≠parallel≠signed，絕不塌成最高價（不取 max、不混版）。
 *  3. 某版本對不到精確 token → null（fail closed），絕不退回最高價 / 別版價 / 純卡號價。
 *  4. 帶標籤替代平行版（パラレル/HR、パラレル/hSD06）只吃完全相同 token。
 *  5. 歧義即 fail closed：兩個純 (パラレル) 對多個平行來源 → 全 null（hBP02-017）；
 *     同名重複版本 → 全 null。
 *  6. 對真實 database.json：以同一支 assignVariantBuyPrices 由來源重算，逐版本比對，
 *     證明每個 buyPrice 都是精確 token 對齊的結果，不存在跨版本借價。
 *  7. 抽樣 ≥10 張多版本卡，輸出 canonical key / 販售 / 收購 / 是否 fail-closed。
 *
 * 純 node，無測試框架；任何斷言失敗 → process.exit(1)（CI 會擋）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  normalizeCardNumber,
  normalizeRarity,
  versionClassFromRarity,
  versionClassFromName,
  classifyVariant,
  classifySourceRarity,
  sourceToken,
  canonicalVariantKey,
  PARALLEL_RARITIES,
  UNKNOWN_TOKEN,
} from './lib/variant-key.js';
import { assignVariantBuyPrices, representativeBuyPrice, buyPriceByToken } from './merge-buy-prices.js';
import { scrapeFullaheadBuy, extractRarity as fullaheadRarity } from './scrape-fullahead-buy.js';
import { extractRarityFromHref } from './scrape-torecolo-buy.js';

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
async function acheck(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

// 買取版本清單 entry：assignVariantBuyPrices 讀 { token, price }。token = 精確正規化 rarity。
const E = (rarity, price) => ({ token: normalizeRarity(rarity), price });

console.log('── Unit: token 精確正規化（不子字串臆測）──');
check('已知 rarity 代碼 → 原碼', () => {
  assert.equal(normalizeRarity('SEC'), 'SEC');
  assert.equal(normalizeRarity('OUR'), 'OUR');
  assert.equal(normalizeRarity('HR'), 'HR');
  assert.equal(normalizeRarity('【PR】'), 'P'); // 別名 PR→P
});
check('產品／套牌碼 → 原樣（HSD06 不得被當成 S）', () => {
  assert.equal(normalizeRarity('HSD06'), 'HSD06');
  assert.equal(normalizeRarity('HBP07'), 'HBP07');
  assert.notEqual(normalizeRarity('HSD06'), 'S');
  assert.notEqual(normalizeRarity('HBP07'), 'P');
});
check('normalizeRarity（卡層級）：非代碼 → \'\'（不臆測成 P/HR）', () => {
  // 這是「卡片自身 rarity」正規化：卡的 P_03 屬 base class → 取 bare 來源（合法）。
  assert.equal(normalizeRarity(null), '');
  assert.equal(normalizeRarity(''), '');
  assert.equal(normalizeRarity('P_03'), '');
  assert.equal(normalizeRarity('02_HR'), '');
});
check('classifySourceRarity（來源層級）：bare / known / unknown 三態', () => {
  assert.deepEqual(classifySourceRarity(null), { kind: 'bare', token: '' });
  assert.deepEqual(classifySourceRarity(''), { kind: 'bare', token: '' });
  assert.deepEqual(classifySourceRarity('  '), { kind: 'bare', token: '' });
  assert.deepEqual(classifySourceRarity('SEC'), { kind: 'known', token: 'SEC' });
  assert.deepEqual(classifySourceRarity('HSD06'), { kind: 'known', token: 'HSD06' });
  // 有標記但不在 allowlist → unknown（絕非 bare）。這是與前一版最關鍵的差異：來源的 XYZ /
  // P_03 標記「不可信」，不得塌成原印版。
  assert.deepEqual(classifySourceRarity('XYZ'), { kind: 'unknown', token: UNKNOWN_TOKEN });
  assert.deepEqual(classifySourceRarity('【XYZ】'), { kind: 'unknown', token: UNKNOWN_TOKEN });
  assert.deepEqual(classifySourceRarity('P_03'), { kind: 'unknown', token: UNKNOWN_TOKEN });
});
check('sourceToken：bare→\'\'、known→精確 token、unknown→UNKNOWN_TOKEN（不塌成 bare）', () => {
  assert.equal(sourceToken('SEC', '-SEC'), 'SEC');
  assert.equal(sourceToken(null, '-SEC'), 'SEC');
  assert.equal(sourceToken(null, ''), ''); // 純卡號 → bare
  assert.equal(sourceToken('HSD06', ''), 'HSD06');
  // 未知來源標記絕不可變 bare（否則會與真原印版合併／取 max）。
  assert.equal(sourceToken('XYZ', ''), UNKNOWN_TOKEN);
  assert.equal(sourceToken(null, '-XYZ'), UNKNOWN_TOKEN);
  assert.notEqual(sourceToken('XYZ', ''), ''); // 明確：不是 bare
});

console.log('── Unit: 版本分類 ──');
check('rarity → class（產品碼不臆測成平行/簽名）', () => {
  assert.equal(versionClassFromRarity('SEC'), 'signed');
  assert.equal(versionClassFromRarity('OUR'), 'parallel');
  assert.equal(versionClassFromRarity('UR'), 'parallel');
  assert.equal(versionClassFromRarity('HR'), 'parallel');
  assert.equal(versionClassFromRarity(null), 'base');
  assert.equal(versionClassFromRarity('C'), 'base');
  assert.equal(versionClassFromRarity('S'), 'base');
  assert.equal(versionClassFromRarity('P'), 'base');
  assert.equal(versionClassFromRarity('HSD06'), 'base');
  assert.equal(versionClassFromRarity('HBP04'), 'base');
});
check('classifyVariant：名稱 → { versionClass, token }', () => {
  assert.deepEqual(classifyVariant('ラプラス'), { versionClass: 'base', token: '' });
  assert.deepEqual(classifyVariant('ラプラス(パラレル)'), { versionClass: 'parallel', token: null });
  assert.deepEqual(classifyVariant('ラプラス(パラレル/サイン)'), { versionClass: 'signed', token: 'SEC' });
  assert.deepEqual(classifyVariant('ラプラス(パラレル/HR)'), { versionClass: 'parallel', token: 'HR' });
  assert.deepEqual(classifyVariant('ラプラス(パラレル/hSD06)'), { versionClass: 'parallel', token: 'HSD06' });
  // 有明確標籤但無對應代碼 → sentinel（不落純平行池，之後 fail closed）
  const unknown = classifyVariant('X(パラレル/謎)');
  assert.equal(unknown.versionClass, 'parallel');
  assert.ok(unknown.token && unknown.token.startsWith('#'));
});
check('versionClassFromName', () => {
  assert.equal(versionClassFromName('X'), 'base');
  assert.equal(versionClassFromName('X(パラレル)'), 'parallel');
  assert.equal(versionClassFromName('X(パラレル/サイン)'), 'signed');
});

console.log('── Unit: 不取 max、不混版 ──');
check('三版本各自對齊，base≠parallel≠signed（不塌成最高價）', () => {
  const variants = [{ name: 'X(パラレル/サイン)' }, { name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('SEC', 38000), E('OUR', 5000), E(null, 150)];
  const out = assignVariantBuyPrices(variants, buy);
  assert.deepEqual(out, [38000, 5000, 150]);
  assert.notEqual(out[2], out[0]); // 普通版不得等於簽名版（無 max 塌陷）
});

console.log('── Unit: fail closed（不借別版、不退純卡號）──');
check('某版本無對應 token → null，不借別版', () => {
  const variants = [{ name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E(null, 150)]; // 只有原印版收購價
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [null, 150]);
});
check('完全無收購資料 → 全 null', () => {
  assert.deepEqual(assignVariantBuyPrices([{ name: 'X' }, { name: 'X(パラレル)' }], []), [null, null]);
});
check('representativeBuyPrice 精確 token，不跨版本 fallback', () => {
  const buy = [E(null, 150)]; // 只有原印版
  assert.equal(representativeBuyPrice('SEC', buy), null); // 簽名卡對不到 → null（非退回 150）
  assert.equal(representativeBuyPrice('C', buy), 150); // base 卡 → bare 來源
  // 標準平行卡 rarity 用精確 token，對不到不退回 bare。
  assert.equal(representativeBuyPrice('UR', [E('UR', 300), E(null, 150)]), 300);
  assert.equal(representativeBuyPrice('HR', [E(null, 150)]), null); // 無 HR 來源 → null，不吃 bare 150
  // 卡層級：產品碼/雜訊 rarity 屬 base class → 取 bare 來源（hBP01-050 P_03 → 原印價）。
  assert.equal(representativeBuyPrice('P_03', [E('HSD06', 70), E(null, 5800)]), 5800);
});

console.log('── Unit: 帶標籤替代平行版精確對齊 ──');
check('パラレル/HR 只吃 HR；純パラレル吃剩餘唯一標準平行', () => {
  const variants = [{ name: 'X(パラレル/HR)' }, { name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('HR', 3000), E('OUR', 800), E(null, 100)];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [3000, 800, 100]);
});
check('純パラレル不吃被 token 宣告的 HR 價', () => {
  const variants = [{ name: 'X(パラレル/HR)' }, { name: 'X(パラレル)' }];
  const buy = [E('HR', 3000)]; // 只有 HR，且已被 /HR 版本宣告
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [3000, null]);
});
check('パラレル/hSD06 只吃 HSD06 產品碼（hBP01-050 情境）', () => {
  const variants = [{ name: 'X(パラレル/hSD06)' }, { name: 'X' }];
  const buy = [E('HSD06', 70), E(null, 20)];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [70, 20]);
});

console.log('── Unit: 歧義即 fail closed ──');
check('兩個純 (パラレル) 對多個平行來源 → 全 null（hBP02-017 情境）', () => {
  const variants = [{ name: 'X(パラレル)' }, { name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('SR', 9980), E('UR', 5000), E(null, 980)];
  // 兩個無標籤平行版無法證明各自對應 SR 或 UR → 兩者皆 null；base 仍精確
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [null, null, 980]);
});
check('單一純 (パラレル) 對兩個平行來源 → null（無法選定）', () => {
  const variants = [{ name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('SR', 9980), E('UR', 5000), E(null, 980)];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [null, 980]);
});
check('單一純 (パラレル) 對唯一未被宣告平行來源 → 對齊', () => {
  const variants = [{ name: 'X(パラレル)' }, { name: 'X' }];
  const buy = [E('SR', 9980), E(null, 980)];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [9980, 980]);
});
check('同名重複具體版本 → 全 null（無法證明 provenance）', () => {
  const variants = [{ name: 'X(パラレル/HR)' }, { name: 'X(パラレル/HR)' }];
  const buy = [E('HR', 3000)];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [null, null]);
});

console.log('── Unit: 未知版本標記 fail closed（不塌成原印版、不被 max）──');
check('merge：UNKNOWN_TOKEN 報價不得洩漏到 base，也不 match 任何 variant', () => {
  // 來源同時有「真原印 100」與「未知標記 9999（token=UNKNOWN_TOKEN）」。
  const buy = [{ token: '', price: 100 }, { token: UNKNOWN_TOKEN, price: 9999 }];
  // 原印版只吃 bare → 100，絕不被 9999 蓋掉。
  assert.deepEqual(assignVariantBuyPrices([{ name: 'X' }], buy), [100]);
  assert.equal(representativeBuyPrice('C', buy), 100);
  // 沒有任何 variant 會對到 UNKNOWN_TOKEN。
  const parallel = assignVariantBuyPrices([{ name: 'X(パラレル)' }, { name: 'X' }], buy);
  assert.deepEqual(parallel, [null, 100]);
});
check('scraper（Torecolo）extractRarityFromHref：known / bare / unknown', () => {
  assert.equal(extractRarityFromHref('/shop/g/HL-HBP08-003SEC-S/', 'HBP08-003'), 'SEC');
  assert.equal(extractRarityFromHref('/shop/g/HBP01-001/', 'HBP01-001'), null); // 無尾綴 → bare
  assert.equal(extractRarityFromHref('/shop/g/HBP01-001XYZ/', 'HBP01-001'), UNKNOWN_TOKEN);
});
check('scraper（Fullahead）extractRarity：known / bare / unknown', () => {
  assert.equal(fullaheadRarity('【UR】hBP01-091 ムーナ'), 'UR');
  assert.equal(fullaheadRarity('hBP01-091 ムーナ'), null); // 無【】→ bare
  assert.equal(fullaheadRarity('【XYZ】hBP01-091 ムーナ'), UNKNOWN_TOKEN);
});
await acheck('scraper（Fullahead）整合：【XYZ】9999 + 無標記 100 → base 維持 100，未知筆丟棄', async () => {
  const outFile = path.join(os.tmpdir(), `fa-unknown-${process.pid}.json`);
  try { fs.unlinkSync(outFile); } catch { /* noop */ }
  const records = [
    { productName: '【XYZ】hBP01-001 テスト', price: '9999' },
    { productName: 'hBP01-001 テスト', price: '100' },
  ];
  await scrapeFullaheadBuy({
    dbPath: path.join(DATA, 'database.json'),
    outputFile: outFile,
    scrapeWithRestartFn: async () => records,
    nowFn: () => new Date('2026-01-01T00:00:00Z'),
  });
  const out = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
  fs.unlinkSync(outFile);
  assert.ok(out['hBP01-001'], 'base key 應存在');
  assert.equal(out['hBP01-001'].buyPrice, 100); // 原印價維持 100
  const prices = Object.values(out).map((x) => x.buyPrice);
  assert.ok(!prices.includes(9999), '未知標記 9999 絕不得寫入');
  assert.ok(!Object.keys(out).some((k) => k.includes(UNKNOWN_TOKEN)), '不得出現 UNKNOWN key');
});

// ── 真實資料驗證 ──
console.log('── Integration: 真實 database.json ──');
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'database.json'), 'utf-8')).cards;

// 由來源檔重建 numKey → Map(token → maxPrice)，即 merge 端 buildBuyIndex 的等價重算。
function loadSourceIndex() {
  const byNum = new Map(); // numKey -> Map(token -> maxPrice)
  for (const f of ['fullahead-prices.json', 'torecolo-prices.json']) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(DATA, 'buy-prices', f), 'utf-8')); } catch { continue; }
    for (const [k, v] of Object.entries(raw || {})) {
      const num = normalizeCardNumber(k);
      const price = v && Number(v.buyPrice);
      if (!num || !(price > 0)) continue;
      const token = sourceToken(v.rarity, k.slice(num.length));
      if (token === UNKNOWN_TOKEN) continue; // 與 merge buildBuyIndex 一致：未知標記 fail closed
      if (!byNum.has(num)) byNum.set(num, new Map());
      const m = byNum.get(num);
      const prev = m.get(token);
      if (prev == null || price > prev) m.set(token, price);
    }
  }
  return byNum;
}
const srcIdx = loadSourceIndex();
function buyEntriesFor(num) {
  const m = (num && srcIdx.get(num)) || new Map();
  return [...m.entries()].map(([token, price]) => ({ token, price }));
}
function findByCardNumber(cardNum) {
  const target = String(cardNum).toUpperCase();
  for (const [, c] of Object.entries(db)) {
    if (c && String(c.cardNumber || '').toUpperCase() === target) return c;
  }
  return null;
}

check('acceptance: hBP04-005 base=150 / parallel=5000 / signed=38000（不固定 38000）', () => {
  const c = findByCardNumber('hBP04-005');
  assert.ok(c, 'card hBP04-005 存在');
  const byName = Object.fromEntries(c.prices.map((v) => [v.name, v.buyPrice ?? null]));
  assert.equal(byName['ラプラス・ダークネス'], 150);
  assert.equal(byName['ラプラス・ダークネス(パラレル)'], 5000);
  assert.equal(byName['ラプラス・ダークネス(パラレル/サイン)'], 38000);
  // 三版本必須互異（證明無 max 塌陷）
  const vals = [byName['ラプラス・ダークネス'], byName['ラプラス・ダークネス(パラレル)'], byName['ラプラス・ダークネス(パラレル/サイン)']];
  assert.equal(new Set(vals).size, 3);
});

check('acceptance: hBP02-017 兩個純 (パラレル) 不得塌成同價（歧義 → fail closed）', () => {
  const c = findByCardNumber('hBP02-017');
  if (!c || !Array.isArray(c.prices)) { console.log('      （DB 無 hBP02-017，跳過）'); return; }
  const plains = c.prices.filter((v) => { const cl = classifyVariant(v.name); return cl.versionClass === 'parallel' && cl.token === null; });
  if (plains.length >= 2) {
    const buys = plains.map((v) => v.buyPrice).filter((x) => x != null);
    // 若來源有分版，兩個無標籤平行版必須 fail closed（不得同時帶價且相同）
    assert.ok(buys.length === 0 || new Set(buys).size === buys.length, '重複純平行版塌成同價');
  }
});

check('全庫 invariant: 逐版本以 assignVariantBuyPrices 重算，與 DB 完全一致（精確 token provenance）', () => {
  let scanned = 0;
  const violations = [];
  for (const [id, c] of Object.entries(db)) {
    if (!Array.isArray(c.prices) || c.prices.length === 0) continue;
    const num = normalizeCardNumber(c.cardNumber);
    const expected = assignVariantBuyPrices(c.prices, buyEntriesFor(num));
    c.prices.forEach((v, i) => {
      scanned += 1;
      const stored = v.buyPrice ?? null;
      if (stored !== (expected[i] ?? null)) {
        violations.push(`${id} :: ${v.name} stored=${stored} expected=${expected[i] ?? null}`);
      }
    });
  }
  assert.ok(scanned > 500, `掃描版本數過少（${scanned}）`);
  assert.equal(violations.length, 0, `發現與精確重算不符 ${violations.length} 筆，例：\n      ${violations.slice(0, 8).join('\n      ')}`);
  console.log(`      （掃描 ${scanned} 個版本，全部等於精確 token 重算結果）`);
});

check('全庫 invariant: card.buyPrice 等於 representativeBuyPrice（本卡 rarity 精確 token）', () => {
  const violations = [];
  for (const [id, c] of Object.entries(db)) {
    const num = normalizeCardNumber(c.cardNumber);
    const expected = representativeBuyPrice(c.rarity, buyEntriesFor(num));
    const stored = c.buyPrice ?? null;
    if (stored !== (expected ?? null)) violations.push(`${id} stored=${stored} expected=${expected ?? null}`);
  }
  assert.equal(violations.length, 0, `card.buyPrice 與精確重算不符 ${violations.length} 筆，例：\n      ${violations.slice(0, 8).join('\n      ')}`);
});

check('全庫 invariant: 多版本卡不得所有版本共用同一收購價（當來源本身分版時）', () => {
  const collapsed = [];
  for (const [id, c] of Object.entries(db)) {
    if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
    const num = normalizeCardNumber(c.cardNumber);
    const tokens = new Set([...((num && srcIdx.get(num)) || new Map()).keys()]);
    if (tokens.size < 2) continue; // 來源本身只有單一版本，跳過
    const buys = c.prices.map((v) => v.buyPrice).filter((x) => x != null);
    if (buys.length >= 2 && new Set(buys).size === 1) collapsed.push(`${id} all=${buys[0]}`);
  }
  assert.equal(collapsed.length, 0, `發現版本塌陷（來源分版卻共用同價）例：\n      ${collapsed.slice(0, 5).join('\n      ')}`);
});

check('全庫 invariant: 同一卡片內不得有重複 canonical key 卻都帶收購價', () => {
  const violations = [];
  for (const [id, c] of Object.entries(db)) {
    if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
    const keyCount = new Map();
    for (const v of c.prices) {
      const k = canonicalVariantKey(c.cardNumber, v.name);
      keyCount.set(k, (keyCount.get(k) || 0) + 1);
    }
    for (const v of c.prices) {
      const k = canonicalVariantKey(c.cardNumber, v.name);
      if (keyCount.get(k) > 1 && v.buyPrice != null) violations.push(`${id} :: ${v.name} (${k})`);
    }
  }
  assert.equal(violations.length, 0, `重複 canonical key 仍帶買取價 ${violations.length} 筆，例：\n      ${violations.slice(0, 5).join('\n      ')}`);
});

// ── 抽樣輸出 ≥10 張多版本卡 ──
console.log('\n── Sample: 多版本卡對齊明細（canonical key / 販售 / 收購 / fail-closed）──');
const samples = [];
const seenNum = new Set();
for (const [id, c] of Object.entries(db)) {
  if (samples.length >= 12) break;
  if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
  const num = normalizeCardNumber(c.cardNumber);
  if (seenNum.has(num)) continue;
  const tokens = (num && srcIdx.get(num)) || new Map();
  if (tokens.size < 2) continue; // 只抽來源分版的卡，最能展示對齊
  seenNum.add(num);
  samples.push([id, c]);
}
for (const [id, c] of samples) {
  const num = normalizeCardNumber(c.cardNumber);
  console.log(`\n${id}  (cardNumber ${num}, card.rarity ${c.rarity})  card.buyPrice=${c.buyPrice ?? 'null'}`);
  for (const v of c.prices) {
    const key = canonicalVariantKey(c.cardNumber, v.name);
    const buy = v.buyPrice != null ? `¥${v.buyPrice}` : '（此版本暫無收購價 → fail-closed）';
    console.log(`   key=${key}  販售¥${v.sellPrice}  收購${buy}`);
  }
}
assert.ok(samples.length >= 10, `多版本抽樣不足 10 張（${samples.length}）`);
console.log(`\n抽樣張數：${samples.length}`);

if (failures > 0) {
  console.error(`\n❌ ${failures} 項測試失敗`);
  process.exit(1);
}
console.log('\n✅ 全部通過');
