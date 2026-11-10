/**
 * regen-buy-alignment.mjs — 一次性重跑買取價「版本精確對齊」到 committed database.json（DIC-856）。
 *
 * 日常 cron 是 scrape → merge-buy-prices.js（18h + 本輪起始 HUNTERCARD_RUN_STARTED_AT 證明新報價，
 * history 以該報價自身觀測日記錄）。DIC-1334 官方-only fallback 與排程 official-catalog-sync.yml
 * 都「不抓買取價」，因此同樣跑 merge-buy-prices.js：所有既有報價都只能是 retained（原來源／原時間），
 * 不寫也不修剪 history（review N4）。
 * 這支只在 PR 內重建 committed 資料用（一次性、決定性工具）：直接以「來源檔自身 timestamp」當 now，
 * 讓既有 committed 來源被當作快照內報價，套用與 merge-buy-prices.js 相同的 reconcile。任何 pipeline
 * 步驟（日常、fallback、排程 sync）都不得使用本檔：它會把未在本輪觀測的快取當成新報價。
 *
 * Run proof（review N5）：merge 會在 artifact 寫入 internal `db.buyQuoteRun`（run start / now / 時區 /
 * 來源檔 sha256）。只要來源檔位元與該 merge 讀到的完全相同，本檔就「重現」那次 merge 的決定
 * （regenerateFromRunProof）：fresh 依同一 notBefore 重算、retained 只以自身完整證據原樣保留、history
 * 以觀測日（merge 的時區）只補不改且永不修剪。缺少／不合法／來源已變更 → 走下列原有快照語意（並移除
 * 失效的 proof），因此真正較新或較低的新來源一定會讓 byte-identity gate 失敗，不會被遮蔽。
 *
 * 決定性（determinism, DIC-856 CR；快照語意，無 run proof 時）：
 *   - `buyPriceHistory` 的日期 key 一律用「來源快照日期」（最新來源 timestamp 的 UTC 日），
 *     而非 wall-clock `new Date()`。可用環境變數 BUY_PRICE_SNAPSHOT_DATE 覆寫。這樣不論哪一天
 *     重跑，第一次 regen 就與 committed 位元完全一致（不會多寫一個「今天」的 key，也不需跑第二次才穩定）。
 *   - 修剪任何比快照日期「更新」的 history key：committed 來源最多到快照日，晚於它的 key 不可能由任何
 *     committed 來源產生，屬於過去以 wall-clock 重跑留下的假資料，予以刪除以保證可重現。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { normalizeCardNumber, classifyVariant, PARALLEL_RARITIES } from './lib/variant-key.js';
import {
  buildBuyIndex, reconcileCardBuyQuotes, assignVariantBuyMatches, applyVariantBuyProvenance,
  representativeBuyEntry, lastKnownBuyCandidate, historyDateKey,
  notFreshBoundEvidence, auditRetainedQuotes,
} from './merge-buy-prices.js';
import { buySourceDigest } from './lib/buy-source-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = process.env.HUNTERCARD_BUY_PRICES_DIR || path.join(__dirname, '../data/buy-prices');

// 取兩個來源檔中最新的 timestamp（保證 committed 來源一律視為新鮮，也當作快照日期來源）。
export function latestSourceTs(buyDir = BUY_DIR) {
  let latest = 0;
  for (const f of ['torecolo-prices.json', 'fullahead-prices.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(buyDir, f), 'utf-8'));
      for (const e of Object.values(raw || {})) {
        const t = Date.parse(e && e.timestamp);
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    } catch {}
  }
  return latest;
}

/** 由來源檔推導決定性的快照時間與日期（UTC）。BUY_PRICE_SNAPSHOT_DATE 可覆寫日期。 */
export function snapshotInfo(buyDir = BUY_DIR, override = process.env.BUY_PRICE_SNAPSHOT_DATE) {
  const ts = latestSourceTs(buyDir);
  const date = override || new Date(ts).toISOString().slice(0, 10);
  return { ts, date };
}

/**
 * 對 db（會就地修改）套用版本精確對齊，並把 buyPriceHistory 以決定性 `date` key 寫入 + 修剪未來 key。
 * 純函式（不讀寫檔案）：CLI 與測試共用同一份邏輯，避免 drift。
 * @param {object} db  已 parse 的 database（in-place 修改）
 * @param {{now:number, date:string}} opts  now=新鮮度基準時間；date=快照日期 key
 */
export function regenerateBuyAlignment(db, { now, date, buyDir = BUY_DIR }) {
  const buyIndex = buildBuyIndex(now, { dir: buyDir });
  let cardsUpdated = 0;
  let variantsMatched = 0;
  let cardsRetained = 0;
  let variantsRetained = 0;
  for (const card of Object.values(db.cards || {})) {
    if (!card || typeof card !== 'object') continue;
    if (!card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    const buyEntries = (numKey && buyIndex.get(numKey)) || [];

    // 與 merge-buy-prices.js 共用同一個 reconcile：快照窗內的報價照舊對齊（輸出與先前位元一致），
    // 快照內沒有報價的版本只保留驗證過的 last-known（buyPriceRetained），且不寫 history。
    const r = reconcileCardBuyQuotes(card, buyEntries, now);
    variantsMatched += r.variantsFresh;
    variantsRetained += r.variantsRetained;
    if (r.fresh) {
      if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') card.buyPriceHistory = {};
      card.buyPriceHistory[date] = r.fresh.price;
      cardsUpdated += 1;
    } else if (r.retained) {
      cardsRetained += 1;
    }

    // 決定性修剪：刪除任何晚於快照日期的 history key（wall-clock 重跑留下的假資料）。
    if (card.buyPriceHistory && typeof card.buyPriceHistory === 'object') {
      for (const k of Object.keys(card.buyPriceHistory)) {
        if (k > date) delete card.buyPriceHistory[k];
      }
      if (Object.keys(card.buyPriceHistory).length === 0) delete card.buyPriceHistory;
    }
  }
  return { cardsUpdated, variantsMatched, cardsRetained, variantsRetained, buyIndexSize: buyIndex.size };
}

/**
 * The artifact's merge run proof (`db.buyQuoteRun`, written by merge-buy-prices.js), when it is
 * well-formed AND bound to exactly the source bytes in `buyDir`. Otherwise null: a missing,
 * malformed or stale proof (any source file changed since that merge — e.g. a genuinely newer
 * or lower quote) never shields the artifact; regen then uses the legacy snapshot semantics.
 */
export function validRunProof(db, buyDir = BUY_DIR) {
  const p = db && db.buyQuoteRun;
  if (!p || typeof p !== 'object') return null;
  const now = Date.parse(p.now);
  const runStartedAt = p.runStartedAt == null ? null : Date.parse(p.runStartedAt);
  if (!Number.isFinite(now) || (runStartedAt !== null && !Number.isFinite(runStartedAt))) return null;
  if (typeof p.timeZone !== 'string' || !p.timeZone) return null;
  try { historyDateKey(now, p.timeZone); } catch { return null; }
  if (typeof p.sourceDigest !== 'string' || p.sourceDigest !== buySourceDigest(buyDir)) return null;
  if (typeof p.retainedCarryDigest !== 'string') return null;
  // N7/N8/N9: rebuild the merge's not-fresh bound evidence (and its fresh index) from the
  // digest-verified files and audit every retained quote against it with the merge's own rules
  // (own-provider bound entry not older, exact card printing rule and variant uniqueness via the
  // real reconcile); the carried (not source-covered) set must be exactly the one the merge
  // certified. `retainedCarryDigest` is a CONSISTENCY checksum over artifact content, not an
  // authenticity proof: a carried quote whose evidence no longer exists in the files can only be
  // pinned by it (inherent limitation; the hermetic pipeline / replay tests cover that case).
  const cacheByNum = notFreshBoundEvidence(buyDir, now, runStartedAt);
  const freshByNum = runStartedAt == null ? new Map() : buildBuyIndex(now, { dir: buyDir, notBefore: runStartedAt });
  const audit = auditRetainedQuotes(db, cacheByNum, { now, runStartedAt, freshByNum });
  if (audit.carryDigest !== p.retainedCarryDigest) return null;
  return { now, runStartedAt, timeZone: p.timeZone, audit };
}

/**
 * Reproduce a merge from its run proof (review N5). Same fresh index the merge built (its own
 * `now` and run start → `notBefore`), same exact alignment, same history rule (the observation's
 * own date in the merge's recorded zone, written only if absent), and:
 *   - RETAINED quotes are kept by identity only — a variant keeps its own complete retained
 *     tuple, a card keeps its own complete holder — so regen never invents, moves or drops a
 *     retained assignment, and never turns one back into "fresh";
 *   - a fresh quote for the same token always wins (as in the merge);
 *   - history is never pruned (a later-zone-dated real observation is legitimate).
 * Anything the proof cannot justify (a non-retained tuple with no fresh match, an incomplete
 * holder) is cleared, so an inconsistent artifact fails the byte-identity gate.
 */
export function regenerateFromRunProof(db, proof, { buyDir = BUY_DIR } = {}) {
  const { now, runStartedAt, timeZone } = proof;
  // Audit computed on the INPUT (before any change): a retained quote whose value / shop / time
  // contradicts the bound source evidence, is older than it, conflicts with it, or was observed
  // at/after the run start, is NOT kept by identity (review N7).
  const violations = (proof.audit && proof.audit.violations) || new Map();
  const buyIndex = runStartedAt == null ? new Map() : buildBuyIndex(now, { dir: buyDir, notBefore: runStartedAt });
  const freshHistoryKeys = {};
  let cardsUpdated = 0;
  let variantsMatched = 0;
  let cardsRetained = 0;
  let variantsRetained = 0;
  for (const [id, card] of Object.entries(db.cards || {})) {
    if (!card || typeof card !== 'object' || !card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    const fresh = (numKey && buyIndex.get(numKey)) || [];
    const freshTokens = new Set(fresh.map((b) => b.token));
    if (Array.isArray(card.prices) && card.prices.length > 0) {
      const freshMatches = assignVariantBuyMatches(card.prices, fresh);
      card.prices.forEach((v, i) => {
        if (!v || typeof v !== 'object') return;
        if (freshMatches[i] != null) {
          applyVariantBuyProvenance(v, freshMatches[i]);
          variantsMatched += 1;
          return;
        }
        const own = v.buyPriceRetained === true ? lastKnownBuyCandidate({ ...v, buyLastKnown: undefined }, now) : null;
        const cls = classifyVariant(v.name);
        const compatible = own && (cls.token === null ? PARALLEL_RARITIES.has(own.token) : cls.token === own.token);
        if (own && compatible && !freshTokens.has(own.token) && !('buyLastKnown' in v) && !violations.has(`${id}\u0000${i}`)) {
          variantsRetained += 1; // identity: unchanged
          return;
        }
        applyVariantBuyProvenance(v, null);
      });
    }
    const freshRep = representativeBuyEntry(card, fresh);
    if (freshRep) {
      delete card.buyPriceRetained;
      delete card.buyLastKnown;
      card.buyPrice = freshRep.price;
      if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') card.buyPriceHistory = {};
      const key = historyDateKey(Date.parse(freshRep.timestamp), timeZone);
      if (!Object.hasOwn(card.buyPriceHistory, key)) card.buyPriceHistory[key] = freshRep.price;
      freshHistoryKeys[id] = key;
      cardsUpdated += 1;
    } else {
      const holder = card.buyLastKnown;
      const held = card.buyPriceRetained === true && holder && typeof holder === 'object'
        ? lastKnownBuyCandidate({ buyLastKnown: holder }, now) : null;
      if (held && card.buyPrice === held.price && !freshTokens.has(held.token) && !violations.has(`${id}\u0000#card`)) {
        cardsRetained += 1; // identity: unchanged
      } else {
        delete card.buyPrice;
        delete card.buyPriceRetained;
        delete card.buyLastKnown;
      }
    }
    delete card.buyPriorSource;
  }
  return {
    mode: 'run-proof', cardsUpdated, variantsMatched, cardsRetained, variantsRetained, buyIndexSize: buyIndex.size, freshHistoryKeys,
    retainedCovered: proof.audit ? proof.audit.covered : 0,
    retainedCarried: proof.audit ? proof.audit.carried : 0,
    retainedViolations: [...violations].map(([k, why]) => `${k.replace('\u0000', ' :: ')}=${why}`),
  };
}

/**
 * The regeneration the CLI and the byte-identity gate run on a committed artifact: reproduce the
 * merge from its valid run proof, else the legacy snapshot regen (unchanged semantics; a stale
 * or invalid proof is dropped, so that output is never mistaken for a merge's).
 */
export function regenerateCommitted(db, { buyDir = BUY_DIR, snapshotOverride = process.env.BUY_PRICE_SNAPSHOT_DATE } = {}) {
  const proof = validRunProof(db, buyDir);
  if (proof) return { ...regenerateFromRunProof(db, proof, { buyDir }), proof };
  const { ts, date } = snapshotInfo(buyDir, snapshotOverride);
  delete db.buyQuoteRun;
  const stats = regenerateBuyAlignment(db, { now: (ts || Date.now()) + 1000, date, buyDir });
  return { ...stats, mode: 'snapshot', date };
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const s = regenerateCommitted(db);
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  const when = s.mode === 'snapshot' ? `快照日期 ${s.date}` : `run proof ${s.proof.runStartedAt == null ? '(no run marker)' : new Date(s.proof.runStartedAt).toISOString()} @ ${s.proof.timeZone}`;
  console.log(`[regen] mode=${s.mode}；${when}；card 層級 ${s.cardsUpdated} 張、版本層級 ${s.variantsMatched} 筆對齊（買取卡號 ${s.buyIndexSize} 個）；保留舊報價 card ${s.cardsRetained} 張、版本 ${s.variantsRetained} 筆`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
