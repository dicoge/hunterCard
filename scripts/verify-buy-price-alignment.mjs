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
 *  7. 版本塌陷以 **provenance 相等** 判定（DIC-1128）：多個版本共用同一個來源 listing／token
 *     才算塌陷；兩個不同印次恰好報同價（市場常態，尤其低價位）必須放行。變異測試同時釘住
 *     兩個方向 —— 合法同價不誤報、真正的 token 複製一定失敗。
 *  8. 抽樣 ≥10 張多版本卡，輸出 canonical key / 販售 / 收購 / 是否 fail-closed。
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
  normalizeRarityCode,
  isOwnSetPrinting,
  versionClassFromName,
  classifyVariant,
  classifySourceRarity,
  sourceToken,
  canonicalVariantKey,
  PARALLEL_RARITIES,
  UNKNOWN_TOKEN,
} from './lib/variant-key.js';
import { assignVariantBuyPrices, assignVariantBuyMatches, applyVariantBuyProvenance, buildBuyIndex, buyPriceByToken, representativeBuyPrice } from './merge-buy-prices.js';
import { latestSourceTs } from './regen-buy-alignment.mjs';
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
// 一列 database card：representativeBuyPrice 需要卡號 + 該印次 rarity + series。
const ROW = (cardNumber, rarity, series) => ({ cardNumber, rarity, series });

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
check('normalizeRarityCode（卡層級別名）：序號後綴剝掉後得真代碼', () => {
  assert.equal(normalizeRarityCode('02_HR'), 'HR');
  assert.equal(normalizeRarityCode('UR_02'), 'UR');
  assert.equal(normalizeRarityCode('P_02'), 'P');
  assert.equal(normalizeRarityCode('C_re'), 'C');
  assert.equal(normalizeRarityCode(' sr '), 'SR');
  // 看起來像後綴的 premium 代碼不得被切壞
  assert.equal(normalizeRarityCode('OSR'), 'OSR');
  assert.equal(normalizeRarityCode('OUR'), 'OUR');
  assert.equal(normalizeRarityCode(null), '');
});
check('isOwnSetPrinting：series 等於卡號集前綴才是原印列', () => {
  assert.equal(isOwnSetPrinting('hBP03-025', 'hBP03'), true);
  assert.equal(isOwnSetPrinting('hBP03-025', 'ent07'), false);
  assert.equal(isOwnSetPrinting('hBP03-025', 'hPR'), false);
  assert.equal(isOwnSetPrinting('hBP03-025', ''), false);
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
  // 簽名／平行印次對不到自己的 token → null（非退回 150）
  assert.equal(representativeBuyPrice(ROW('hBP04-005', 'SEC', 'hBP04'), buy), null);
  assert.equal(representativeBuyPrice(ROW('hBP04-005', 'HR', 'hBP04'), buy), null);
  // 卡號原印集的一般 rarity 列 → 吃無標記 listing
  assert.equal(representativeBuyPrice(ROW('hBP04-005', 'C', 'hBP04'), buy), 150);
  // premium 印次用精確 token，且不因為來源另有 bare 就退回 bare
  assert.equal(representativeBuyPrice(ROW('hBP04-005', 'UR', 'ent07'), [E('UR', 300), E(null, 150)]), 300);
});
check('representativeBuyPrice：非原印列不得吃無標記（bare）listing', () => {
  const buy = [E(null, 150)];
  // 再刷／促銷列與「無標記 listing」無從連結 → fail closed
  assert.equal(representativeBuyPrice(ROW('hBP03-025', 'C', 'ent07'), buy), null);
  assert.equal(representativeBuyPrice(ROW('hBP03-025', 'C_02', 'hBP07'), buy), null);
  // 原印列才可以
  assert.equal(representativeBuyPrice(ROW('hBP03-025', 'C', 'hBP03'), buy), 150);
});
check('representativeBuyPrice：未知 rarity 標記 fail closed，絕不當成原印版', () => {
  const buy = [E(null, 150), E('HR', 4200)];
  for (const rarity of ['XYZ', 'P_XX', '謎', '', null]) {
    assert.equal(representativeBuyPrice(ROW('hBP03-025', rarity, 'hBP03'), buy), null, `rarity=${rarity}`);
  }
});
check('representativeBuyPrice：來源同時有 bare 與本列代碼 → 歧義 fail closed', () => {
  // hBP08-014 情境：卡本身是 SR，來源同時列出無標記 ¥1 與 -SR ¥250，
  // 無法證明本列對應哪一個 listing。
  const buy = [E(null, 1), E('SR', 250), E('UR', 1600)];
  assert.equal(representativeBuyPrice(ROW('hBP08-014', 'SR', 'hBP08'), buy), null);
  // 代碼不撞就沒有歧義：RR 原印列照樣吃 bare
  assert.equal(representativeBuyPrice(ROW('hSD04-009', 'RR', 'hSD04'), buy), 1);
});

console.log('── Regression: hBP03-025（DIC-1008 CR：02_HR 曾拿到 bare ¥10）──');
check('production-shaped hBP03-025：只有原印 C 列拿 ¥10，HR ¥4200 不外溢', () => {
  // 來源（fullahead）實際只有兩筆：無標記 ¥10、-HR ¥4200。
  const buy = [E(null, 10), E('HR', 4200)];
  // database 的四列印次，rarity 依 committed 資料原樣（含 02_HR 別名）。
  const rows = [
    ROW('hBP03-025', 'C', 'hBP03'), // 原印列
    ROW('hBP03-025', 'HR', 'hBP07'), // HR 再刷
    ROW('hBP03-025', '02_HR', 'ent07'), // HR 再刷（別名寫法）
    ROW('hBP03-025', 'P', 'hPR'), // 促銷列，來源無 P listing
  ];
  const out = rows.map((r) => representativeBuyPrice(r, buy));
  assert.deepEqual(out, [10, 4200, 4200, null]);
  // bare ¥10 只能出現在原印列；任何 premium 印次拿到 10 就是本次 CR 的洩漏
  assert.deepEqual(out.map((p) => p === 10), [true, false, false, false]);
  // 版本相互隔離：base 不吃 HR、HR 不吃 base
  assert.notEqual(out[1], out[0]);
  const variants = [{ name: 'さくらみこ' }, { name: 'さくらみこ(パラレル/HR)(エラッタ前)' }];
  assert.deepEqual(assignVariantBuyPrices(variants, buy), [10, 4200]);
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
  assert.equal(representativeBuyPrice(ROW('hBP01-001', 'C', 'hBP01'), buy), 100);
  // 沒有任何 variant 會對到 UNKNOWN_TOKEN。
  const parallel = assignVariantBuyPrices([{ name: 'X(パラレル)' }, { name: 'X' }], buy);
  assert.deepEqual(parallel, [null, 100]);
});
check('scraper（Torecolo）extractRarityFromHref：known / bare / unknown', () => {
  assert.equal(extractRarityFromHref('/shop/g/HL-HBP08-003SEC-S/', 'HBP08-003'), 'SEC');
  assert.equal(extractRarityFromHref('/shop/g/HBP01-001/', 'HBP01-001'), null); // 無尾綴 → bare
  assert.equal(extractRarityFromHref('/shop/g/HBP01-001XYZ/', 'HBP01-001'), UNKNOWN_TOKEN);
});
check('scraper（Fullahead）extractRarity：known / bare / unknown（含非 ASCII / 底線標記）', () => {
  assert.equal(fullaheadRarity('【UR】hBP01-091 ムーナ'), 'UR');
  assert.equal(fullaheadRarity('hBP01-091 ムーナ'), null); // 無【】→ bare
  assert.equal(fullaheadRarity('【XYZ】hBP01-091 ムーナ'), UNKNOWN_TOKEN);
  // CR DIC-857 Round-3：任何非空括號都算「有標記」，不限 ASCII 英數；非 allowlist → UNKNOWN。
  // 這幾筆在舊 [A-Za-z0-9] regex 下會落空→回 null→塌成 bare→被 max 蓋掉原印價，必須修掉。
  assert.equal(fullaheadRarity('【謎】hBP01-091 ムーナ'), UNKNOWN_TOKEN); // 非 ASCII
  assert.equal(fullaheadRarity('【XYZ_1】hBP01-091 ムーナ'), UNKNOWN_TOKEN); // 含底線
  assert.equal(fullaheadRarity('【 UR 】hBP01-091 ムーナ'), 'UR'); // 內含空白仍精確命中
});
// 參數化：每一種未知標記（含非 ASCII / 底線）+ 無標記原印，base 都須維持 100 並丟棄未知筆。
for (const marker of ['【XYZ】', '【謎】', '【XYZ_1】']) {
  await acheck(`scraper（Fullahead）整合：${marker}9999 + 無標記 100 → base 維持 100，未知筆丟棄`, async () => {
    const outFile = path.join(os.tmpdir(), `fa-unknown-${process.pid}-${Buffer.from(marker).toString('hex')}.json`);
    try { fs.unlinkSync(outFile); } catch { /* noop */ }
    const records = [
      { productName: `${marker}hBP01-001 テスト`, price: '9999' },
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
}

console.log('── Unit: provenance 輸出 ──');
check('assignVariantBuyMatches 帶出 token/source/timestamp；applyVariantBuyProvenance 寫入欄位', () => {
  const variants = [{ name: 'X(パラレル/サイン)' }, { name: 'X' }];
  const buy = [
    { token: 'SEC', price: 38000, source: 'fullahead', timestamp: '2026-08-14T12:15:00Z' },
    { token: '', price: 150, source: 'torecolo', timestamp: '2026-08-13T09:00:00Z' },
  ];
  const matches = assignVariantBuyMatches(variants, buy);
  assert.equal(matches[0].price, 38000);
  assert.equal(matches[0].token, 'SEC');
  assert.equal(matches[0].source, 'fullahead');
  assert.equal(matches[1].token, '');
  assert.equal(matches[1].source, 'torecolo');
  const v1 = {};
  const v2 = {};
  applyVariantBuyProvenance(v1, matches[0]);
  applyVariantBuyProvenance(v2, matches[1]);
  assert.deepEqual(v1, {
    buyPrice: 38000, buyPriceVersion: 'SEC',
    buyPriceSource: 'fullahead', buyPriceTimestamp: '2026-08-14T12:15:00Z',
  });
  assert.equal(v2.buyPriceVersion, 'BASE'); // bare 原印版以 'BASE' 標記
  assert.equal(v2.buyPriceSource, 'torecolo');
  // null → 連同 provenance 一起清乾淨（不留殘值）
  applyVariantBuyProvenance(v1, null);
  assert.deepEqual(v1, {});
});
check('buildBuyIndex 每筆都帶來源店家 + 抓取時間戳', () => {
  const idx = buildBuyIndex(latestSourceTs() + 1000); // 以來源自身時間基準，跨日重跑也新鮮
  let saw = 0;
  for (const [, perNum] of idx) {
    for (const e of perNum) {
      if (saw >= 3) break;
      assert.ok(typeof e.price === 'number' && e.price > 0, 'price 異常');
      assert.ok(e.source, '每筆都必須有來源店家');
      assert.ok(e.timestamp, '每筆都必須有來源抓取時間戳');
      assert.ok(['fullahead', 'torecolo', 'yuyu'].includes(e.source), `來源店家異常 ${e.source}`);
      saw += 1;
    }
    if (saw >= 3) break;
  }
  assert.ok(saw >= 3, '買取來源應有資料可驗');
});

// ── 真實資料驗證 ──
console.log('── Integration: 真實 database.json ──');
const db = JSON.parse(fs.readFileSync(path.join(DATA, 'database.json'), 'utf-8')).cards;

// 直接使用 merge 端的 buildBuyIndex（以來源自身最新時間戳為基準 → 跨日重跑都新鮮）重建
// numKey → Map(token → { price, source, timestamp })，與寫入 DB 的同一支邏輯、同一檔案
// 順序，保證 provenance 重算與 committed 完全可比（不另造一份可能 drift 的 replica）。
const srcIdx = buildBuyIndex(latestSourceTs() + 1000);
function buyEntriesFor(num) {
  const m = (num && srcIdx.get(num)) || new Map();
  return [...m.entries()].map(([token, e]) => ({ token, ...e }));
}

// ── 純函式偵測器（供全庫 invariant 與變異測試共用同一支邏輯）──
// 全庫 invariant 直接呼叫這些函式，變異測試則餵入「注入過塌陷的卡列」，證明偵測器真的會抓。

/** 該卡號來源本身有幾個版本（token 數）。<2 代表來源不分版，塌陷檢查無意義。 */
function sourceTokenCount(num, entriesFor) {
  return new Set(entriesFor(num).map((e) => e.token)).size;
}

/**
 * 版本塌陷偵測（provenance 相等，非數值相等）——DIC-1128。
 *
 * 塌陷的定義是「**同一筆來源 listing 的價格被複製到多個版本**」，也就是多個版本共用同一個
 * provenance token。判斷依據必須是 provenance，不是價格數值：同卡號的兩個不同印次（例如
 * hBP02-022 的 SR 與 HEB01）各自綁回自己的 listing、卻剛好都報 ¥50，是完全合法的市場情形，
 * 尤其在低價位很常見。舊版以 `new Set(prices).size === 1` 推論塌陷，每晚爬取只要有兩個版本
 * 撞價就誤報一次（DIC-1128 讓乾淨 main 的 CI 全紅），且無法用白名單根治。
 *
 * 這裡改成：同一張卡內，兩個以上帶價版本宣告同一個 (numKey, token) → 塌陷；帶價卻沒有
 * provenance token → 無法證明來源，同樣算違規。價格相等本身不再是證據。
 */
function findVersionCollapses(cards, entriesFor) {
  const violations = [];
  for (const [id, c] of Object.entries(cards)) {
    if (!Array.isArray(c.prices) || c.prices.length < 2) continue;
    const num = normalizeCardNumber(c.cardNumber);
    if (sourceTokenCount(num, entriesFor) < 2) continue; // 來源本身只有單一版本，跳過
    const byToken = new Map(); // provenance token → 宣告它的版本名稱
    for (const v of c.prices) {
      if (!v || v.buyPrice == null) continue;
      const token = v.buyPriceVersion ?? null;
      if (token == null) {
        violations.push(`${id} :: ${v.name} buyPrice=${v.buyPrice} 無 provenance token（無法證明來源 listing）`);
        continue;
      }
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(v.name);
    }
    for (const [token, names] of byToken) {
      if (names.length > 1) {
        violations.push(`${id} token=${token} 被 ${names.length} 個版本共用：${names.join(' / ')}`);
      }
    }
  }
  return violations;
}

/** 逐版本以 assignVariantBuyPrices 重算並比對 DB（回傳違規列表 + 掃描數）。 */
function findRecomputeViolations(cards, entriesFor) {
  const violations = [];
  let scanned = 0;
  for (const [id, c] of Object.entries(cards)) {
    if (!Array.isArray(c.prices) || c.prices.length === 0) continue;
    const expected = assignVariantBuyPrices(c.prices, entriesFor(normalizeCardNumber(c.cardNumber)));
    c.prices.forEach((v, i) => {
      scanned += 1;
      const stored = v.buyPrice ?? null;
      if (stored !== (expected[i] ?? null)) {
        violations.push(`${id} :: ${v.name} stored=${stored} expected=${expected[i] ?? null}`);
      }
    });
  }
  return { violations, scanned };
}

/** 逐版本比對 provenance（價格/版本/來源/時間戳）與來源重算（回傳違規列表 + 掃描數）。 */
function findProvenanceViolations(cards, entriesFor) {
  const violations = [];
  let scanned = 0;
  for (const [id, c] of Object.entries(cards)) {
    if (!Array.isArray(c.prices) || c.prices.length === 0) continue;
    const expected = assignVariantBuyMatches(c.prices, entriesFor(normalizeCardNumber(c.cardNumber)));
    c.prices.forEach((v, i) => {
      const e = expected[i];
      scanned += 1;
      const wantVersion = e ? (e.token === '' ? 'BASE' : e.token) : null;
      const wantSource = e ? e.source : null;
      const wantTs = e ? e.timestamp : null;
      if ((v.buyPrice ?? null) !== (e ? e.price : null)) violations.push(`${id} :: ${v.name} buyPrice`);
      if ((v.buyPriceVersion ?? null) !== wantVersion) violations.push(`${id} :: ${v.name} buyPriceVersion stored=${v.buyPriceVersion ?? null} want=${wantVersion}`);
      if ((v.buyPriceSource ?? null) !== wantSource) violations.push(`${id} :: ${v.name} buyPriceSource stored=${v.buyPriceSource ?? null} want=${wantSource}`);
      if ((v.buyPriceTimestamp ?? null) !== wantTs) violations.push(`${id} :: ${v.name} buyPriceTimestamp`);
    });
  }
  return { violations, scanned };
}
function findByCardNumber(cardNum) {
  const target = String(cardNum).toUpperCase();
  for (const [, c] of Object.entries(db)) {
    if (c && String(c.cardNumber || '').toUpperCase() === target) return c;
  }
  return null;
}

check('acceptance: hBP04-005 三版本互異（BASE / OUR / SEC，來源 provenance 齊備）', () => {
  // DIC-1139: yuyu-tei added as a third buy source, so per-version buy
  // prices now reflect whichever source proves the tier that day. We no
  // longer assert specific numbers (they drift daily as any of the three
  // sources reprices). What we DO still assert:
  //   - three distinct tiers exist and none collapses onto another
  //   - each version aligns to the correct provenance token (BASE/OUR/SEC)
  //   - every version carries source + timestamp
  const c = findByCardNumber('hBP04-005');
  assert.ok(c, 'card hBP04-005 存在');
  const byName = Object.fromEntries(c.prices.map((v) => [v.name, v]));
  const base = byName['ラプラス・ダークネス'];
  const parallel = byName['ラプラス・ダークネス(パラレル)'];
  const signed = byName['ラプラス・ダークネス(パラレル/サイン)'];
  assert.ok(base, 'base 版本存在');
  assert.ok(parallel, 'parallel 版本存在');
  assert.ok(signed, 'signed 版本存在');
  const vals = [base.buyPrice, parallel.buyPrice, signed.buyPrice].filter((v) => v != null);
  // Every present value must differ from the others (no max-collapse).
  assert.equal(new Set(vals).size, vals.length, `重複的 buyPrice 顯示塌陷: ${JSON.stringify(vals)}`);
  if (base.buyPrice != null) assert.equal(base.buyPriceVersion, 'BASE');
  if (parallel.buyPrice != null) assert.equal(parallel.buyPriceVersion, 'OUR');
  if (signed.buyPrice != null) assert.equal(signed.buyPriceVersion, 'SEC');
  for (const [nm, v] of Object.entries(byName)) {
    if (v.buyPrice == null) continue;
    assert.ok(v.buyPriceSource, `hBP04-005 ${nm} 缺來源店家`);
    assert.ok(v.buyPriceTimestamp, `hBP04-005 ${nm} 缺來源時間戳`);
  }
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
  const { violations, scanned } = findRecomputeViolations(db, buyEntriesFor);
  assert.ok(scanned > 500, `掃描版本數過少（${scanned}）`);
  assert.equal(violations.length, 0, `發現與精確重算不符 ${violations.length} 筆，例：\n      ${violations.slice(0, 8).join('\n      ')}`);
  console.log(`      （掃描 ${scanned} 個版本，全部等於精確 token 重算結果）`);
});

check('全庫 invariant: 每個版本 buyPrice 的 provenance（版本/來源/時間戳）與來源重算一致', () => {
  const { violations, scanned } = findProvenanceViolations(db, buyEntriesFor);
  assert.ok(scanned > 500, `掃描版本數過少（${scanned}）`);
  assert.equal(violations.length, 0, `provenance 與精確重算不符 ${violations.length} 筆，例：\n      ${violations.slice(0, 8).join('\n      ')}`);
  console.log(`      （掃描 ${scanned} 個版本，buyPrice/版本/來源/時間戳全等於來源重算）`);
});

check('全庫 invariant: card.buyPrice 等於 representativeBuyPrice（本列印次精確 token）', () => {
  const violations = [];
  for (const [id, c] of Object.entries(db)) {
    const num = normalizeCardNumber(c.cardNumber);
    const expected = representativeBuyPrice(c, buyEntriesFor(num));
    const stored = c.buyPrice ?? null;
    if (stored !== (expected ?? null)) violations.push(`${id} stored=${stored} expected=${expected ?? null}`);
  }
  assert.equal(violations.length, 0, `card.buyPrice 與精確重算不符 ${violations.length} 筆，例：\n      ${violations.slice(0, 8).join('\n      ')}`);
});

// DIC-1008 CR：上一版的全庫 invariant 用「同一支 resolver」算期望值，resolver 自己的
// 洩漏因此永遠測不出來（107 列非原印卡拿到 bare 報價卻全綠）。以下這條刻意 **不呼叫
// resolver**，直接從來源檔重建每個卡號的 listing 表，逐列檢查「這個價格是哪一筆 listing
// 給的、那筆 listing 能不能綁到這一列印次」。
check('全庫 invariant（獨立於 resolver）: 每個 card.buyPrice 都能綁回一筆可證明的來源 listing', () => {
  // 直接讀原始來源檔（不經 buildBuyIndex）：numKey → { token → 最高報價 }。
  // 與 buildBuyIndex 一致，套用 18h 新鮮度過濾：來源 timestamp 超過 MAX_SOURCE_AGE_HOURS
  // 的資料視為過期（避免把昨天殘留檔當今天資料），確保與 DB 中 committed buyPrice 的
  // 計算基準一致（DIC-1192 CI 修正）。
  const INDEPENDENT_MAX_SOURCE_AGE_HOURS = 18;
  const nowForIndependent = latestSourceTs() + 1000;
  const listings = new Map();
  for (const file of ['torecolo-prices.json', 'fullahead-prices.json', 'yuyu-prices.json']) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'buy-prices', file), 'utf-8'));
    for (const [key, entry] of Object.entries(raw || {})) {
      const price = Number(entry && entry.buyPrice);
      const num = normalizeCardNumber(key);
      if (!num || !Number.isFinite(price) || price <= 0) continue;
      const t = Date.parse(entry && entry.timestamp);
      if (!Number.isFinite(t) || nowForIndependent - t > INDEPENDENT_MAX_SOURCE_AGE_HOURS * 3600 * 1000) continue;
      const token = normalizeRarity((entry && entry.rarity) || key.slice(num.length).replace(/^[-_\s]+/, ''));
      if (!listings.has(num)) listings.set(num, new Map());
      const perNum = listings.get(num);
      if (!perNum.has(token) || price > perNum.get(token)) perNum.set(token, price);
    }
  }

  const bareOnPremium = []; // CR 指出的 107 列類別
  const unprovable = [];
  const ambiguous = [];
  let priced = 0;
  let ownSetBase = 0;
  for (const [id, c] of Object.entries(db)) {
    const stored = c.buyPrice ?? null;
    if (stored === null) continue; // fail closed 永遠合法
    priced += 1;
    const perNum = listings.get(normalizeCardNumber(c.cardNumber)) || new Map();
    const code = normalizeRarityCode(c.rarity);
    const bare = perNum.get('') ?? null;
    const exact = perNum.get(code) ?? null;
    const own = isOwnSetPrinting(c.cardNumber, c.series);
    const where = `${id} rarity=${c.rarity} series=${c.series} stored=${stored} bare=${bare} exact(${code})=${exact}`;
    if (exact !== null && stored === exact) continue; // 來源以本列代碼明確標記
    if (stored === bare) {
      // 無標記 listing 只描述「卡號的原印版」：非原印列拿到它就是跨印次借價。
      if (!own) bareOnPremium.push(where);
      else if (exact !== null) ambiguous.push(where); // bare 與 -CODE 並存 → 無從選定
      else ownSetBase += 1;
      continue;
    }
    unprovable.push(where); // 既非 bare 也非本列代碼的報價 → 來源根本沒證明過
  }

  assert.equal(bareOnPremium.length, 0,
    `非原印列吃到無標記（原印）報價 ${bareOnPremium.length} 筆，例：\n      ${bareOnPremium.slice(0, 8).join('\n      ')}`);
  assert.equal(ambiguous.length, 0,
    `bare 與同代碼 listing 並存卻仍給價 ${ambiguous.length} 筆，例：\n      ${ambiguous.slice(0, 8).join('\n      ')}`);
  assert.equal(unprovable.length, 0,
    `card.buyPrice 對不到任何來源 listing ${unprovable.length} 筆，例：\n      ${unprovable.slice(0, 8).join('\n      ')}`);
  assert.ok(priced > 100, `帶價卡列過少（${priced}），invariant 失去意義`);
  console.log(`      （${priced} 張帶價卡列全部可綁回來源 listing：原印 bare ${ownSetBase} 張、來源明確標記 ${priced - ownSetBase} 張）`);
});

check('acceptance: hBP03-025 四列印次 —— 只有原印 C 列帶 bare ¥10（DIC-1008 CR 具體案例）', () => {
  const rows = Object.entries(db).filter(([, c]) => c.cardNumber === 'hBP03-025');
  assert.equal(rows.length, 4, `hBP03-025 應有 4 列印次，實得 ${rows.length}`);
  const byId = Object.fromEntries(rows.map(([id, c]) => [id, c.buyPrice ?? null]));
  assert.equal(byId['hBP03-025_hBP03'], 10, '原印 C 列應為 bare ¥10');
  assert.equal(byId['hBP03-025_hBP07'], 4200, 'HR 列應為精確 HR ¥4200');
  assert.equal(byId['hBP03-025_ent07'], 4200, '02_HR 別名列應正規化成 HR ¥4200，絕不是 bare ¥10');
  assert.equal(byId['hBP03-025_hPR'], null, '來源無 P listing，促銷列須 fail closed');
  assert.equal(Object.values(byId).filter((p) => p === 10).length, 1, '¥10 只能出現在原印列');
});

check('全庫 invariant: 多版本卡不得多個版本共用同一來源 listing（provenance 相等，非數值相等）', () => {
  const collapsed = findVersionCollapses(db, buyEntriesFor);
  assert.equal(collapsed.length, 0, `發現版本塌陷（多版本共用同一 provenance token）例：\n      ${collapsed.slice(0, 5).join('\n      ')}`);
});

// ── DIC-1128 變異測試：塌陷偵測必須對「真塌陷」敏感、對「不同印次恰好同價」放行 ──
// 舊版 invariant 用「所有版本價格數值相等」推論塌陷，2026-08-22 的爬取讓 hBP02-022 的
// SR / HEB01 兩個印次都報 ¥50，乾淨 main 因此全紅。下面三條把偵測器的兩個方向都釘住：
// 合法資料不得誤報，真正的 token 複製必須失敗（且被三條 invariant 各自獨立抓到）。
console.log('── Mutation: 版本塌陷偵測靈敏度（DIC-1128）──');

const MUT_TS = '2026-08-22T12:13:15.218Z';
// production-shaped：hBP02-022 兩筆 fullahead listing，SR 與 HEB01 各自獨立、恰好同為 ¥50。
const mutEntries = {
  'HBP02-022': [
    { token: 'SR', price: 50, source: 'fullahead', timestamp: MUT_TS },
    { token: 'HEB01', price: 50, source: 'fullahead', timestamp: MUT_TS },
  ],
};
const mutEntriesFor = (num) => mutEntries[num] || [];
const mutCard = (parallel, heb01) => ({
  'hBP02-022_hBP02': {
    cardNumber: 'hBP02-022',
    rarity: 'SR',
    series: 'hBP02',
    prices: [
      { name: 'パヴォリア・レイネ(パラレル)', sellPrice: 580, ...parallel },
      { name: 'パヴォリア・レイネ', sellPrice: 80 },
      { name: 'パヴォリア・レイネ(パラレル/hEB01)', sellPrice: 120, ...heb01 },
      { name: 'パヴォリア・レイネ(hEB01)', sellPrice: 50 },
    ],
  },
});
const P = (price, version) => ({ buyPrice: price, buyPriceVersion: version, buyPriceSource: 'fullahead', buyPriceTimestamp: MUT_TS });

check('不同印次（SR / HEB01）各自綁回自己的 listing 卻同為 ¥50 → 合法，不得誤報塌陷', () => {
  const cards = mutCard(P(50, 'SR'), P(50, 'HEB01'));
  assert.deepEqual(findVersionCollapses(cards, mutEntriesFor), [],
    '兩個不同 provenance token 恰好同價必須放行（DIC-1128 false positive）');
  // 同一份資料在兩條較強的 provenance invariant 下也必須是乾淨的 —— 證明 fixture 就是
  // committed database 的真實形狀，不是為了過測而捏出來的。
  assert.deepEqual(findRecomputeViolations(cards, mutEntriesFor).violations, []);
  assert.deepEqual(findProvenanceViolations(cards, mutEntriesFor).violations, []);
});

check('真塌陷（SR 的價與 token 一起複製到 HEB01 版本）→ 三條 invariant 各自獨立抓到', () => {
  // 注入「借別版價」：HEB01 版本拿到 SR listing 的價格與 provenance。
  const cards = mutCard(P(6500, 'SR'), P(6500, 'SR'));
  const entriesFor = (num) => (num === 'HBP02-022'
    ? [{ token: 'SR', price: 6500, source: 'fullahead', timestamp: MUT_TS },
       { token: 'HEB01', price: 50, source: 'fullahead', timestamp: MUT_TS }]
    : []);
  const collapsed = findVersionCollapses(cards, entriesFor);
  assert.equal(collapsed.length, 1, `塌陷偵測器未抓到 token 複製：${JSON.stringify(collapsed)}`);
  assert.match(collapsed[0], /token=SR 被 2 個版本共用/);
  // 兩條較強的 provenance invariant 必須維持有效（不因本次改寫而失去偵測力）。
  assert.ok(findRecomputeViolations(cards, entriesFor).violations.length > 0, '重算 invariant 應抓到借價');
  assert.ok(findProvenanceViolations(cards, entriesFor).violations.length > 0, 'provenance invariant 應抓到借價');
});

check('帶價但無 provenance token → 視為無法證明來源，塌陷偵測必須報', () => {
  const cards = mutCard({ buyPrice: 50 }, P(50, 'HEB01'));
  const violations = findVersionCollapses(cards, mutEntriesFor);
  assert.equal(violations.length, 1, '缺 provenance token 的帶價版本必須被抓到');
  assert.match(violations[0], /無 provenance token/);
});

check('真實 committed hBP02-022：現況合法；把 SR provenance 複製到 hEB01 列即失敗', () => {
  const realId = 'hBP02-022_hBP02';
  const real = db[realId];
  if (!real || !Array.isArray(real.prices)) { console.log('      （DB 無 hBP02-022，跳過）'); return; }
  const asIs = { [realId]: real };
  assert.deepEqual(findVersionCollapses(asIs, buyEntriesFor), [], '乾淨 main 的 hBP02-022 必須通過');
  // 深拷貝後注入塌陷：把第一個帶價版本的 provenance 覆蓋到其他帶價版本上。
  const mutated = JSON.parse(JSON.stringify(real));
  const priced = mutated.prices.filter((v) => v.buyPrice != null);
  if (priced.length < 2) { console.log('      （帶價版本不足 2 個，跳過注入）'); return; }
  for (const v of priced.slice(1)) {
    v.buyPrice = priced[0].buyPrice;
    v.buyPriceVersion = priced[0].buyPriceVersion;
    v.buyPriceSource = priced[0].buyPriceSource;
    v.buyPriceTimestamp = priced[0].buyPriceTimestamp;
  }
  assert.ok(findVersionCollapses({ [realId]: mutated }, buyEntriesFor).length > 0,
    '注入真塌陷後 invariant 必須失敗（否則檢查已失去意義）');
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
