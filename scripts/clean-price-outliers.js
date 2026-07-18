/**
 * clean-price-outliers.js
 *
 * 清理 data/price-history/ 內的髒價格資料（DIC-511）。
 *
 * 背景：早期爬蟲未按稀有度分版，不同 rarity 的價格混進同一張卡的歷史。
 * 該結構性問題已在 PR #23 / commit 54a4dbd3b 修復（所有檔案現以
 * cardNumber_rarity 命名並分版）。殘留的髒資料是「單日爬蟲異常」——
 * 某一天的價格暴衝到與前後兩天皆偏離 5 倍以上的孤立尖峰
 * （例：49800 → 2480 → 49800）。
 *
 * 本腳本只移除這類「孤立單點尖峰」，保留真實的持續性漲跌
 * （持續性漲跌時，相鄰的下一筆會同向，不會被判為孤立尖峰）。
 *
 * 用法：
 *   node scripts/clean-price-outliers.js            # 實際清理
 *   node scripts/clean-price-outliers.js --dry-run  # 只列出、不寫檔
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const PRICE_DIR = path.join(PROJECT_DIR, 'data', 'price-history');

const RATIO = 5; // 超過 5 倍視為版本混雜/爬蟲異常特徵

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * 判斷第 i 筆是否為孤立單點尖峰。
 * 中段：需同時對前後兩筆同向偏離 > RATIO 倍。
 * 端點：對唯一相鄰筆與序列中位數皆偏離 > RATIO 倍才算（較保守）。
 */
function isIsolatedSpike(records, i) {
  const p = records[i].price;
  if (!(p > 0)) return false;

  const prev = i > 0 ? records[i - 1].price : null;
  const next = i < records.length - 1 ? records[i + 1].price : null;

  const anomalouslyLow = (x) => x > 0 && x / p > RATIO;   // p 相對 x 過低
  const anomalouslyHigh = (x) => x > 0 && p / x > RATIO;  // p 相對 x 過高

  if (prev != null && next != null) {
    return (anomalouslyLow(prev) && anomalouslyLow(next)) ||
           (anomalouslyHigh(prev) && anomalouslyHigh(next));
  }

  const neighbor = prev != null ? prev : next;
  if (neighbor == null) return false;

  const rest = records.filter((_, j) => j !== i).map((r) => r.price).filter((x) => x > 0);
  if (rest.length === 0) return false;
  const med = median(rest);

  return (anomalouslyLow(neighbor) && anomalouslyLow(med)) ||
         (anomalouslyHigh(neighbor) && anomalouslyHigh(med));
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const files = fs.readdirSync(PRICE_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json');

  let filesTouched = 0;
  let recordsRemoved = 0;
  const removed = [];

  for (const file of files) {
    const fp = path.join(PRICE_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      continue;
    }

    const recs = [...(data.records || [])].sort((a, b) => a.date.localeCompare(b.date));
    if (recs.length < 3) continue; // 太少無法可靠判定孤立尖峰

    const kept = [];
    let removedHere = 0;
    for (let i = 0; i < recs.length; i++) {
      if (isIsolatedSpike(recs, i)) {
        removed.push({ file, date: recs[i].date, price: recs[i].price });
        removedHere++;
      } else {
        kept.push(recs[i]);
      }
    }

    if (removedHere > 0) {
      filesTouched++;
      recordsRemoved += removedHere;
      if (!dryRun) {
        data.records = kept;
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(fp, JSON.stringify(data, null, 2) + '\n');
      }
    }
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Isolated-spike cleanup complete`);
  console.log(`  Files scanned:  ${files.length}`);
  console.log(`  Files touched:  ${filesTouched}`);
  console.log(`  Records removed:${recordsRemoved}`);
  for (const r of removed) {
    console.log(`    - ${r.file} ${r.date} price=${r.price}`);
  }
}

main();
