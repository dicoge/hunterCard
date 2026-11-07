#!/usr/bin/env node
/**
 * replay-buy-transition.mjs — deterministic, offline replay of a REAL buy-price transition
 * through the real rebuild + merge functions (review N1, PR283: base 3bd8898f → 4252d46f).
 *
 * Inputs (read-only public git blobs; never modified — sha256 checked before and after):
 *   <fixtures>/previous-database.json     the base artifact (previous run's database)
 *   <fixtures>/previous-sources/*.json    the base source cache (on disk when the builder runs)
 *   <fixtures>/current-database.json      PR283's actual artifact (its rebuilt rows = "this build")
 *   <fixtures>/current-sources/*.json     PR283's partial fresh source files ("this run")
 *   <fixtures>/MANIFEST.json              commits + sha256 of every file above
 *
 * Pipeline replayed (same order as local-scrape-and-push.sh, same functions as the CLIs):
 *   rebuilt = current-database rows with EVERY buy field removed (what build-database.js
 *             produces before the buy step: no claim, no holder, no history)
 *   restoreBuyPriceHistory(rebuilt, previous)   history by exact id (never rewritten)
 *   restoreBuyQuotes(rebuilt, previous)         variant tuples + card holders → holders
 *   capturePriorBuySources(rebuilt, previous-sources)   pre-scrape cache → raw evidence
 *   mergeBuyPricesInto(rebuilt, current-sources)        fresh wins; else retained-only
 *
 * REPLAY CLOCK (labelled, deterministic, never the wall clock; no timestamp is restamped):
 *   runStartedAt = newest observation in previous-sources + 1 ms (everything quoted after the
 *                  previous snapshot is "this run"); now = newest observation in either
 *                  snapshot + 1 s. Observation timestamps are always the sources' own.
 *
 * Output: one JSON report (--out) with a per-id outcome for every same-id card whose
 * card-level buy was lost from previous → current: recovered (price / version / source /
 * observation time / source key, retained) or fail-closed with its exact reason, plus an
 * independent oracle check, history / privacy / parity checks and newly surfaced retained
 * quotes. Exit 1 when any check fails. No network, no fetch, no retries, no writes except --out.
 *
 * Usage: node scripts/replay-buy-transition.mjs --fixtures DIR [--out FILE]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mergeBuyPricesInto, reconcileCardBuyQuotes, buildBuyIndex } from './merge-buy-prices.js';
import { restoreBuyPriceHistory, restoreBuyQuotes } from './lib/preserve-market-fields.js';
import {
  capturePriorBuySources, readBuySourceEntries, groupByNumKey, BUY_SOURCE_FILES,
} from './lib/buy-source-cache.js';
import { sanitizeDatabase, stripInternalAuditDatabase } from './lib/store-mvp-sanitize.mjs';
import {
  normalizeCardNumber, normalizeRarityCode, isKnownRarityCode, isPremiumRarityCode, isOwnSetPrinting, sourceToken, UNKNOWN_TOKEN,
} from './lib/variant-key.js';

const SAMPLE_IDS = ['hSD03-004_hSD03_U_hSD03-004_U', 'hSD06-003_hSD06_U_hSD06-003_U', 'hSD07-004_hSD07_U_hSD07-004_U'];
const SAMPLE_TIME = '2026-11-06T12:09:18.847Z';
const MAX_FRESH_MS = 18 * 3600 * 1000;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.fixtures) throw new Error('--fixtures DIR is required');
  return out;
}
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Raw source file → [{sourceKey, numKey, token, price, source, timestamp}] — independent of the reader under test. */
function rawEntries(dir) {
  const out = [];
  for (const file of BUY_SOURCE_FILES) {
    let raw;
    try { raw = readJson(path.join(dir, file)); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = file.replace(/-prices\.json$/, '');
    for (const [sourceKey, e] of Object.entries(raw)) {
      const price = e && e.buyPrice != null ? Number(e.buyPrice) : NaN;
      const t = Date.parse(e && e.timestamp);
      const numKey = normalizeCardNumber(sourceKey);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(t) || !numKey) continue;
      const token = sourceToken(e.rarity, sourceKey.slice(numKey.length));
      if (token === UNKNOWN_TOKEN) continue;
      out.push({ sourceKey, numKey, token, price, source, timestamp: e.timestamp, t });
    }
  }
  return out;
}

const BUY_VARIANT_FIELDS = ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp', 'buyPriceRetained', 'buyLastKnown'];
const BUY_CARD_FIELDS = ['buyPrice', 'buyPriceRetained', 'buyLastKnown', 'buyPriorSource', 'buyPriceHistory'];
function stripBuy(cards) {
  const out = {};
  for (const [id, c] of Object.entries(cards)) {
    const copy = JSON.parse(JSON.stringify(c));
    for (const f of BUY_CARD_FIELDS) delete copy[f];
    if (Array.isArray(copy.prices)) for (const p of copy.prices) if (p && typeof p === 'object') for (const f of BUY_VARIANT_FIELDS) delete p[f];
    out[id] = copy;
  }
  return out;
}

/**
 * Independent oracle for the card-level quote: the rarity → token rule (premium exact code;
 * own-set base → bare; reprint / unknown → none; bare + own-code listing → none) applied to
 * every snapshot entry not fresh this run, newest unique observation wins.
 */
function oracleFor(card, prevEntries, curEntries, isFresh) {
  const code = normalizeRarityCode(card.rarity);
  if (!isKnownRarityCode(code)) return { expect: null, why: 'unknown rarity' };
  const numKey = normalizeCardNumber(card.cardNumber);
  const all = [...prevEntries, ...curEntries].filter((e) => e.numKey === numKey);
  const fresh = curEntries.filter((e) => e.numKey === numKey && isFresh(e));
  let token;
  if (isPremiumRarityCode(code)) token = code;
  else {
    if (!isOwnSetPrinting(card.cardNumber, card.series)) return { expect: null, why: 'reprint row' };
    if (all.some((e) => e.token === code) || fresh.some((e) => e.token === code)) return { expect: null, why: `bare and ${code} listings` };
    token = '';
  }
  if (fresh.some((e) => e.token === token)) return { expect: 'fresh', why: 'fresh this run' };
  const list = all.filter((e) => e.token === token && !isFresh(e));
  if (list.length === 0) return { expect: null, why: 'no snapshot evidence' };
  const newest = Math.max(...list.map((e) => e.t));
  const atNewest = list.filter((e) => e.t === newest);
  if (new Set(atNewest.map((e) => `${e.price}|${e.source}`)).size > 1) return { expect: null, why: 'conflicting newest evidence' };
  return { expect: atNewest[0] };
}

function main() {
  const a = args(process.argv.slice(2));
  const dir = path.resolve(a.fixtures);
  const manifest = readJson(path.join(dir, 'MANIFEST.json'));
  const inputFiles = Object.keys(manifest.files);
  const before = Object.fromEntries(inputFiles.map((f) => [f, sha256(path.join(dir, f))]));
  const checks = {};
  checks.inputsMatchManifest = inputFiles.every((f) => before[f] === manifest.files[f].sha256);

  const previous = readJson(path.join(dir, 'previous-database.json')).cards;
  const currentDb = readJson(path.join(dir, 'current-database.json'));
  const current = currentDb.cards;
  const prevDir = path.join(dir, 'previous-sources');
  const curDir = path.join(dir, 'current-sources');
  const prevEntries = rawEntries(prevDir);
  const curEntries = rawEntries(curDir);

  const prevNewest = Math.max(...prevEntries.map((e) => e.t));
  const anyNewest = Math.max(prevNewest, ...curEntries.map((e) => e.t));
  const runStartedAt = prevNewest + 1;
  const now = anyNewest + 1000;
  const isFresh = (e) => now - e.t <= MAX_FRESH_MS && e.t >= runStartedAt;

  const lostIds = Object.keys(previous).filter((id) => previous[id]?.buyPrice > 0 && current[id] && !(current[id].buyPrice > 0));

  // ── replay ──
  const db = { ...currentDb, cards: stripBuy(current) };
  const hist = restoreBuyPriceHistory(db.cards, previous);
  const held = restoreBuyQuotes(db.cards, previous);
  const captured = capturePriorBuySources(db.cards, { dir: prevDir, now });
  const preMerge = JSON.parse(JSON.stringify(db.cards));
  const merged = mergeBuyPricesInto(db, { now, runStartedAt, dir: curDir });
  const out = db.cards;
  const failReason = makeReasonProbe(curDir, now, runStartedAt);

  // ── per-id outcomes for every lost card ──
  const lost = lostIds.map((id) => {
    const p = previous[id];
    const c = out[id];
    const hadRichVariant = (p.prices || []).some((v) => v && v.buyPrice > 0);
    const oracle = oracleFor(c, prevEntries, curEntries, isFresh);
    const priorEvidence = prevEntries.filter((e) => e.numKey === normalizeCardNumber(p.cardNumber))
      .map(({ sourceKey, token, price, source, timestamp }) => ({ sourceKey, token: token === '' ? 'BASE' : token, price, source, timestamp }));
    const row = { id, cardNumber: p.cardNumber, rarity: p.rarity, series: p.series, oldCardBuy: p.buyPrice, hadRichVariant, priorEvidence };
    if (c.buyPrice > 0) {
      row.outcome = c.buyPriceRetained === true ? 'recovered-retained' : 'recovered-fresh';
      row.recovered = c.buyPriceRetained === true
        ? { ...c.buyLastKnown, retained: true }
        : { price: c.buyPrice, retained: false };
      row.matchesOldValue = c.buyPrice === p.buyPrice;
    } else {
      row.outcome = 'fail-closed';
      // Re-run the reconcile reason on the pre-merge copy (same inputs) for the exact reason.
      row.reason = failReason(preMerge[id]);
    }
    if (oracle.expect && oracle.expect !== 'fresh') {
      const e = oracle.expect;
      row.oracle = { price: e.price, source: e.source, timestamp: e.timestamp, sourceKey: e.sourceKey };
      row.oracleAgrees = row.outcome === 'recovered-retained' && row.recovered.price === e.price
        && row.recovered.source === e.source && row.recovered.timestamp === e.timestamp;
    } else if (oracle.expect === 'fresh') {
      row.oracle = 'fresh-this-run';
      row.oracleAgrees = row.outcome === 'recovered-fresh';
    } else {
      row.oracle = { none: oracle.why };
      row.oracleAgrees = row.outcome === 'fail-closed';
    }
    return row;
  });

  // ── checks ──
  checks.lostCount = lostIds.length;
  checks.everyLostIdAccountedFor = lost.every((r) => r.outcome !== 'fail-closed' || (typeof r.reason === 'string' && r.reason.length > 0));
  checks.oracleDisagreements = lost.filter((r) => !r.oracleAgrees).map((r) => r.id);
  checks.samplesRecovered = SAMPLE_IDS.map((id) => {
    const r = lost.find((x) => x.id === id);
    return {
      id,
      ok: !!r && r.outcome === 'recovered-retained' && r.recovered.timestamp === SAMPLE_TIME && r.recovered.source === 'fullahead' && r.recovered.price === r.oldCardBuy,
      recovered: r ? r.recovered ?? null : 'not-in-lost-set',
    };
  });

  // History: no record rewritten or removed; new records only for FRESH card quotes, at their own date.
  const historyViolations = [];
  for (const [id, c] of Object.entries(out)) {
    const prevH = previous[id]?.buyPriceHistory || {};
    const h = c.buyPriceHistory || {};
    for (const [d, v] of Object.entries(prevH)) {
      if (current[id] && previous[id] && h[d] !== v && sameIdentity(current[id], previous[id])) historyViolations.push(`${id}: ${d} changed/removed`);
    }
    for (const d of Object.keys(h).filter((k) => !Object.hasOwn(prevH, k))) {
      if (c.buyPriceRetained === true) historyViolations.push(`${id}: retained quote wrote ${d}`);
      else if (!(c.buyPrice > 0) || h[d] !== c.buyPrice) historyViolations.push(`${id}: ${d}=${h[d]} without a matching fresh quote`);
    }
  }
  checks.historyViolations = historyViolations.slice(0, 50);
  checks.historyViolationCount = historyViolations.length;

  // PR283 fresh parity: every card PR283 priced freshly gets the same fresh value here.
  const parity = Object.keys(current).filter((id) => current[id].buyPrice > 0)
    .filter((id) => !(out[id]?.buyPrice === current[id].buyPrice && out[id]?.buyPriceRetained !== true));
  checks.pr283FreshParityMismatches = parity.slice(0, 50);
  checks.pr283FreshParityMismatchCount = parity.length;

  // Privacy: no holder in any published profile; Store MVP has no buy key at all.
  const pubText = JSON.stringify(sanitizeDatabase(db));
  const fullText = JSON.stringify(stripInternalAuditDatabase(db));
  checks.storeMvpHasNoBuyField = !/"buyPrice|"buyLastKnown|"buyPriorSource|"buyQuoteRun/.test(pubText);
  checks.fullWebHasNoHolder = !/"buyLastKnown|"buyPriorSource|"buyQuoteRun/.test(fullText);
  checks.noHolderLeftInCanonicalVariants = Object.values(out).every((c) => !('buyPriorSource' in c) && (c.prices || []).every((v) => !v || !('buyLastKnown' in v)));

  // Quotes surfaced that the BASE artifact did not show (old caches the base ignored).
  const surfaced = { cards: 0, variants: 0, bySource: {}, oldestTimestamp: null, sampleIds: [] };
  for (const [id, c] of Object.entries(out)) {
    if (c.buyPriceRetained === true && !(previous[id]?.buyPrice > 0)) {
      surfaced.cards += 1;
      const s = c.buyLastKnown?.source || '?';
      surfaced.bySource[s] = (surfaced.bySource[s] || 0) + 1;
      const ts = c.buyLastKnown?.timestamp;
      if (ts && (!surfaced.oldestTimestamp || ts < surfaced.oldestTimestamp)) surfaced.oldestTimestamp = ts;
      if (surfaced.sampleIds.length < 10) surfaced.sampleIds.push({ id, ...c.buyLastKnown });
    }
    for (const v of c.prices || []) {
      if (v && v.buyPriceRetained === true) {
        const pv = (previous[id]?.prices || []).find((x) => x && x.name === v.name);
        if (!(pv && pv.buyPrice > 0)) surfaced.variants += 1;
      }
    }
  }

  const after = Object.fromEntries(inputFiles.map((f) => [f, sha256(path.join(dir, f))]));
  checks.inputsUnchanged = inputFiles.every((f) => after[f] === before[f]);

  const summary = (pred) => lost.filter(pred).length;
  const report = {
    replay: 'PR283 buy transition (offline, deterministic)',
    commits: { previous: manifest.files['previous-database.json'].commit, current: manifest.files['current-database.json'].commit },
    replayClock: {
      label: 'REPLAY CLOCK — not wall clock; observation timestamps are the sources\' own and are never restamped',
      runStartedAt: new Date(runStartedAt).toISOString(),
      runStartedAtRule: 'newest previous-sources observation + 1 ms',
      now: new Date(now).toISOString(),
      nowRule: 'newest observation in either snapshot + 1 s',
      historyDateZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    stages: { restoreBuyPriceHistory: hist, restoreBuyQuotes: held, capturePriorBuySources: captured, merge: merged },
    totals: {
      lost: lost.length,
      lostWithRichVariant: summary((r) => r.hadRichVariant),
      lostWithoutRichVariant: summary((r) => !r.hadRichVariant),
      recoveredRetained: summary((r) => r.outcome === 'recovered-retained'),
      recoveredRetainedWithoutRichVariant: summary((r) => r.outcome === 'recovered-retained' && !r.hadRichVariant),
      recoveredFresh: summary((r) => r.outcome === 'recovered-fresh'),
      failClosed: summary((r) => r.outcome === 'fail-closed'),
      recoveredValueDiffersFromOld: summary((r) => r.outcome !== 'fail-closed' && !r.matchesOldValue),
      cardsWithBuyAfterReplay: Object.values(out).filter((c) => c.buyPrice > 0).length,
      variantsWithBuyAfterReplay: Object.values(out).reduce((n, c) => n + (c.prices || []).filter((v) => v && v.buyPrice > 0).length, 0),
    },
    newlySurfacedRetained: surfaced,
    checks,
    lost,
  };

  const failures = [];
  if (!checks.inputsMatchManifest) failures.push('fixture sha256 does not match MANIFEST');
  if (!checks.inputsUnchanged) failures.push('fixture files changed during the replay');
  if (!checks.everyLostIdAccountedFor) failures.push('a lost id has no outcome / reason');
  if (checks.oracleDisagreements.length > 0) failures.push(`oracle disagreements: ${checks.oracleDisagreements.length}`);
  if (checks.samplesRecovered.some((s) => !s.ok)) failures.push('a PR283 sample was not recovered with its 2026-11-06 time');
  if (checks.historyViolationCount > 0) failures.push(`history violations: ${checks.historyViolationCount}`);
  if (checks.pr283FreshParityMismatchCount > 0) failures.push(`PR283 fresh parity mismatches: ${checks.pr283FreshParityMismatchCount}`);
  if (!checks.storeMvpHasNoBuyField || !checks.fullWebHasNoHolder || !checks.noHolderLeftInCanonicalVariants) failures.push('privacy check failed');
  report.result = failures.length === 0 ? 'all checks passed' : { failures };

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (a.out) fs.writeFileSync(path.resolve(a.out), text);
  console.log(JSON.stringify({ replayClock: report.replayClock, totals: report.totals, newlySurfacedRetained: { ...surfaced, sampleIds: undefined }, samples: checks.samplesRecovered, result: report.result }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

function sameIdentity(a, b) {
  const n = (c) => String(c?.cardNumber || '').trim().toUpperCase();
  const r = (c) => String(c?.rarity || '').trim().toUpperCase();
  return n(a) !== '' && n(a) === n(b) && r(a) === r(b);
}

/**
 * Exact fail-closed reason: the shared reconcile on a COPY of the pre-merge row with the very
 * inputs mergeBuyPricesInto used (same fresh index, same not-fresh cache) → same decision,
 * plus the reason the merge does not persist.
 */
function makeReasonProbe(curDir, now, runStartedAt) {
  const index = buildBuyIndex(now, { dir: curDir, notBefore: runStartedAt });
  const cache = groupByNumKey(readBuySourceEntries(curDir, now).entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return !(now - t <= MAX_FRESH_MS && t >= runStartedAt);
  }));
  return (preRow) => {
    const card = JSON.parse(JSON.stringify(preRow));
    const numKey = normalizeCardNumber(card.cardNumber);
    const r = reconcileCardBuyQuotes(card, (numKey && index.get(numKey)) || [], now, { cacheEntries: (numKey && cache.get(numKey)) || [] });
    return r.cardReason || (r.fresh ? 'unexpected: fresh on probe' : r.retained ? 'unexpected: retained on probe' : 'unknown');
  };
}

main();
