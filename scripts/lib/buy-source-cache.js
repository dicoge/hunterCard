/**
 * buy-source-cache.js — read the raw buy-price source files (data/buy-prices/*.json) as
 * EVIDENCE, independent of freshness (2026-11-07, review N1 on PR283).
 *
 * PR283 lost 106 card-level buy quotes: the daily pipeline runs build-database.js BEFORE the
 * buy scrapes, then a PARTIAL fresh scrape overwrites e.g. fullahead-prices.json, and the
 * merge only ever looked at the overwritten file. 42 of those cards had no per-variant tuple
 * to carry, so their proof (e.g. hSD03-004 ¥10 @ 2026-11-06T12:09:18.847Z in the previous
 * fullahead file) existed only in the source cache that the scrape then replaced.
 *
 * This module turns every source entry into an evidence record — exact source key, exact
 * version token, shop, price and the entry's OWN observation timestamp — with the same
 * fail-closed rules as merge-buy-prices.js (positive finite price, parseable time not in the
 * future beyond the 5-minute skew, allowlisted token; unknown suffix → dropped, never bare).
 * It never decides freshness and never writes a price: the rebuild stores the records as an
 * internal holder (`card.buyPriorSource`) and the merge offers them as RETAINED-ONLY
 * candidates. Market data only — nothing from accounts, history or card scalars.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { normalizeCardNumber, sourceToken, UNKNOWN_TOKEN } from './variant-key.js';

export const BUY_SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json', 'yuyu-prices.json'];
export const BUY_SOURCES = new Set(BUY_SOURCE_FILES.map((f) => f.replace(/-prices\.json$/, '')));
export const BUY_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Every valid entry of every source file in `dir`, any age.
 * @returns {{ entries: Array<{numKey:string, sourceKey:string, token:string, price:number, source:string, timestamp:string}>, files: Record<string,string> }}
 */
export function readBuySourceEntries(dir, now = Date.now()) {
  const entries = [];
  const files = {};
  for (const file of BUY_SOURCE_FILES) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    } catch (err) {
      files[file] = err && err.code === 'ENOENT' ? 'missing' : 'unreadable';
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      files[file] = 'malformed';
      continue;
    }
    const source = file.replace(/-prices\.json$/, '');
    let kept = 0;
    for (const [sourceKey, entry] of Object.entries(raw)) {
      // Same coercion as merge-buy-prices.js buildBuyIndex, so "valid as fresh" and
      // "valid as evidence" can never disagree about one entry.
      const price = entry && entry.buyPrice != null ? Number(entry.buyPrice) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      const timestamp = entry && entry.timestamp;
      const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(t) || t > now + BUY_FUTURE_SKEW_MS) continue;
      const numKey = normalizeCardNumber(sourceKey);
      if (!numKey) continue;
      const token = sourceToken(entry.rarity, sourceKey.slice(numKey.length));
      if (token === UNKNOWN_TOKEN) continue;
      entries.push({ numKey, sourceKey, token, price, source, timestamp });
      kept += 1;
    }
    files[file] = `ok:${kept}`;
  }
  return { entries, files };
}

/**
 * sha256 over the exact bytes of every source file in `dir` (name-tagged; a missing file is
 * tagged as missing). Binds a merge's run proof to the very cache it read (review N5).
 */
export function buySourceDigest(dir) {
  const h = createHash('sha256');
  for (const file of BUY_SOURCE_FILES) {
    h.update(`${file}\0`);
    try {
      h.update(fs.readFileSync(path.join(dir, file)));
    } catch {
      h.update('\0missing\0');
    }
    h.update('\0');
  }
  return h.digest('hex');
}

/** numKey → evidence records (deterministic order). */
export function groupByNumKey(entries) {
  const out = new Map();
  for (const e of entries) {
    if (!out.has(e.numKey)) out.set(e.numKey, []);
    out.get(e.numKey).push(e);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.source.localeCompare(b.source) || a.sourceKey.localeCompare(b.sourceKey)));
  }
  return out;
}

const evidenceRecord = (e) => ({ sourceKey: e.sourceKey, token: e.token, price: e.price, source: e.source, timestamp: e.timestamp });

/**
 * Rebuild-stage capture (build-database.js / sync-official-catalog-to-database.mjs). Runs
 * BEFORE the buy scrapes can overwrite `dir`, so the previous run's quotes are still on disk.
 * Each card with a card number gets `buyPriorSource` = every valid evidence record for its
 * number (internal; consumed and removed by merge-buy-prices.js / regen-buy-alignment.mjs,
 * stripped from every published profile). Replaces any stale holder from an earlier stage.
 */
export function capturePriorBuySources(cards, { dir, now = Date.now() } = {}) {
  const summary = { cards: 0, records: 0, files: {} };
  if (!cards || typeof cards !== 'object' || !dir) return summary;
  const { entries, files } = readBuySourceEntries(dir, now);
  summary.files = files;
  const byNum = groupByNumKey(entries);
  for (const card of Object.values(cards)) {
    if (!card || typeof card !== 'object') continue;
    delete card.buyPriorSource;
    const numKey = normalizeCardNumber(card.cardNumber);
    const list = numKey ? byNum.get(numKey) : null;
    if (!list || list.length === 0) continue;
    card.buyPriorSource = list.map(evidenceRecord);
    summary.cards += 1;
    summary.records += list.length;
  }
  return summary;
}
