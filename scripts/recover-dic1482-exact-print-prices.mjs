#!/usr/bin/env node
/**
 * recover-dic1482-exact-print-prices.mjs — recover source-proven exact-print
 * prices from a scrape candidate into the canonical database (DIC-1482).
 *
 * Production sat at 0 priced hBP09 cardNumbers while the candidate scrape
 * (bot/scrape/2026-09-19 @ 1a35e14b) proved 111 of them from exact /hbp09/
 * yuyu-tei listings — but the candidate also silently nulled 29 source-proven
 * hBD24 promo printings, so it must never be merged wholesale. This script is
 * the surgical alternative:
 *
 *   - FILL-ONLY, EXACT-ID: a candidate payload is considered only for the row
 *     with the identical printing id in the current database, and only when
 *     that row is currently unpriced. Priced rows (including the 29 hBD24
 *     last-known-good rows) are never touched. No cross-printing, no
 *     cardNumber fallback, no deletion.
 *   - STRICT PROVENANCE: a candidate payload is adopted only when
 *     `classifyExactPrintPayload` proves it against the row's own
 *     sourceProduct (lawful card.yuyu-tei.jp URL, exact product path, only
 *     the shipped promo-*→hPR carve-out). SEC signed printings and
 *     aggregation-label (ent07) cross-product rows are rejected with
 *     machine-readable reasons.
 *   - PRICE FIELDS ONLY: the adoption rewrites the priced payload and nothing
 *     else. It deliberately does NOT touch `localImage` — image acquisition is
 *     governed by build-database.js Step 2 + its own file-existence rule, and
 *     backfilling it here produced 2,230 rows of unrelated generated-data
 *     drift in the first PR #214 revision (DIC-1484 CR blocker 3).
 *   - BUY-SIDE ISOLATION: copied prices[]/_rawPricesArchive entries are
 *     stripped of buyPrice* fields — buy prices are governed exclusively by
 *     data/buy-prices/*.json via merge-buy-prices/regen-buy-alignment, which
 *     must be re-run after this script.
 *   - priceHistory is NOT imported: durable history accrues through
 *     build-database Step 5/6 under the DIC-1229 freshness contract.
 *
 * Usage:
 *   node scripts/recover-dic1482-exact-print-prices.mjs --candidate <db.json> \
 *     [--apply] [--report <path>]
 *
 * Without --apply this is a dry run: it prints the classification and writes
 * nothing. With --apply it rewrites data/database.json (atomic), writes the
 * data/price-rejections.json manifest and the audit report. Follow-up steps
 * (buy alignment + native regeneration) stay explicit:
 *   node scripts/regen-buy-alignment.mjs
 *   node scripts/generate-native-database.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyExactPrintPayload,
  evaluatePriceRegressionGate,
  buildPriceRejectionManifest,
  formatGateViolations,
  writeJsonAtomic,
  makeRejection,
  isPricedRow,
} from './lib/price-regression-gate.mjs';
import { orderCardsForDetailAlignment } from './lib/order-cards-for-detail-alignment.js';
import {
  pricesEntryExactPrintMatchesSource,
  pricesEntryMatchesSource,
  deriveTopLevelFromEntries,
} from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const BUY_FIELDS = ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp', 'buyPriceHistory'];

function stripBuyFields(entry) {
  const clean = { ...entry };
  for (const field of BUY_FIELDS) delete clean[field];
  return clean;
}

function cardNumberPrefix(cardNumber) {
  return String(cardNumber || '').split('-')[0];
}

/**
 * Pure recovery core (exported for the DIC-1482 regression suite).
 *
 * Mutates `currentCards` in place (callers pass a deep copy when they need
 * the original) and returns the full classification:
 *   accepted  — exact-id, fill-only adoptions with strict exact-print proof.
 *   rejected  — candidate-priced payloads refused, with manifest reasons.
 *   regressions — cardNumbers priced in current whose candidate counterparts
 *     are ALL unpriced (the candidate's losses), classified per printing:
 *     preserve when the current payload is source-proven, otherwise the
 *     printing is nulled and lands in `rejected` (fail-closed).
 */
export function recoverExactPrintPrices(currentCards, candidateCards) {
  const accepted = [];
  const refreshed = [];
  const rejected = [];

  const adoptPayload = (current, candidate) => {
    current.sellPrice = candidate.sellPrice;
    current.prices = (Array.isArray(candidate.prices) ? candidate.prices : []).map(stripBuyFields);
    current.yuyuName = candidate.yuyuName || '';
    current.yuyuImage = candidate.yuyuImage || '';
    current.timestamp = candidate.timestamp || '';
    current._rawPricesArchive = (Array.isArray(candidate._rawPricesArchive) ? candidate._rawPricesArchive : [])
      .map(stripBuyFields);
    // Internal consistency: the row-level sellPrice must equal one of the
    // row's OWN entries (the native-artifact invariant — no synthesized
    // scalar). The 2026-09-19 candidate carries one row (hBP02-078_hBP02_S)
    // whose scrape-time top-level predates entry canonicalization; re-derive
    // the top-level from the strict exact-print entries in that case, the
    // same derivation preservation uses.
    if (current.prices.length > 0
        && !current.prices.some((entry) => entry?.sellPrice === current.sellPrice)) {
      const strictEntries = current.prices.filter(
        (entry) => Number.isFinite(entry?.sellPrice) && entry.sellPrice > 0
          && pricesEntryExactPrintMatchesSource(entry, current.sourceProduct || current.series || ''),
      );
      const derived = deriveTopLevelFromEntries(strictEntries, current.timestamp);
      if (derived.sellPrice != null) {
        current.sellPrice = derived.sellPrice;
        current.yuyuName = derived.yuyuName;
        current.yuyuImage = derived.yuyuImage;
      }
    }
  };

  // ── Candidate → current exact-id adoption ──────────────────────────────
  // Two shapes, both strictly per-printing:
  //   fill    — current row unpriced, candidate proven → recover.
  //   refresh — BOTH priced and the candidate's proven payload is strictly
  //             NEWER (timestamp) → supersede the stale payload with the
  //             fresh source listing for the same exact printing. Without
  //             this, a stale pre-hardening aggregate row (mixed
  //             cross-product entries) survives next to freshly recovered
  //             sibling rows and the detail/deck default-version pipelines
  //             diverge (verify-version-alignment catches exactly that).
  // A candidate payload that is unpriced or unproven never displaces a
  // priced current row — that is the last-known-good preservation side.
  for (const [id, candidate] of Object.entries(candidateCards || {})) {
    const current = currentCards?.[id];
    if (!current || !isPricedRow(candidate)) continue;
    const currentPriced = isPricedRow(current);
    const verdict = classifyExactPrintPayload(candidate);
    if (!verdict.proven) {
      // Only surfaces as a rejection when it would have filled a hole; an
      // unproven candidate never touches a priced row in the first place.
      if (!currentPriced) rejected.push(makeRejection(id, candidate, verdict.reason));
      continue;
    }
    if (!currentPriced) {
      adoptPayload(current, candidate);
      accepted.push({ id, cardNumber: candidate.cardNumber, sourceProduct: candidate.sourceProduct, sellPrice: candidate.sellPrice });
      continue;
    }
    const currentTs = Date.parse(String(current.timestamp || ''));
    const candidateTs = Date.parse(String(candidate.timestamp || ''));
    if (!Number.isFinite(candidateTs) || (Number.isFinite(currentTs) && candidateTs <= currentTs)) continue;
    adoptPayload(current, candidate);
    refreshed.push({ id, cardNumber: candidate.cardNumber, sourceProduct: candidate.sourceProduct, sellPrice: candidate.sellPrice });
  }

  // ── Same-lineage refresh for rows outside the strict class ─────────────
  // Aggregation-label rows (ent07 etc.) can never be strict exact-print
  // proven, but they are ALREADY priced under the pipeline's shipped relaxed
  // convention. Leaving them at a stale scrape date next to freshly
  // refreshed sibling rows creates duplicate variant labels with conflicting
  // prices — the deck adapter then fails closed on the whole label
  // (NO_EXACT_PRICE) and detail/deck defaults diverge. A same-id refresh of
  // an already-priced row keeps its existing provenance class: it is allowed
  // when EVERY priced candidate entry passes the row's own relaxed matcher
  // (`pricesEntryMatchesSource` — parseable card.yuyu-tei.jp URLs, own
  // product / promo / origin-prefix / aggregation-label rules). It never
  // creates price where none existed and never accepts cross-product
  // contamination the relaxed matcher would reject.
  for (const [id, candidate] of Object.entries(candidateCards || {})) {
    const current = currentCards?.[id];
    if (!current || !isPricedRow(current) || !isPricedRow(candidate)) continue;
    if (classifyExactPrintPayload(candidate).proven) continue; // handled above
    const sourceProduct = String(candidate.sourceProduct || candidate.series || '');
    const pricedEntries = (Array.isArray(candidate.prices) ? candidate.prices : [])
      .filter((entry) => Number.isFinite(entry?.sellPrice) && entry.sellPrice > 0);
    if (pricedEntries.length === 0) continue;
    if (!pricedEntries.every((entry) => pricesEntryMatchesSource(entry, sourceProduct, candidate.cardNumber || null))) continue;
    const currentTs = Date.parse(String(current.timestamp || ''));
    const candidateTs = Date.parse(String(candidate.timestamp || ''));
    if (!Number.isFinite(candidateTs) || (Number.isFinite(currentTs) && candidateTs <= currentTs)) continue;
    adoptPayload(current, candidate);
    refreshed.push({ id, cardNumber: candidate.cardNumber, sourceProduct, sellPrice: current.sellPrice });
  }

  // ── Candidate regressions + supersession: rows the fresh source no longer
  // lists. For every current-priced printing whose candidate counterpart is
  // unpriced, the decision is per-printing and fail-closed:
  //   proven   — the current payload's OWN evidence proves this exact
  //              printing → preserve last-known-good (the 29 hBD24 promo
  //              rows). Reported as a candidate regression when the whole
  //              cardNumber lost candidate pricing.
  //   unproven — the payload never proved its printing (stale ent07
  //              aggregates, cross-product leftovers) AND the fresh source
  //              dropped it → null it with a machine-readable, gate-
  //              verifiable rejection. Keeping it would leave duplicate
  //              variant labels with conflicting stale prices next to the
  //              freshly refreshed rows (the deck adapter then fails closed
  //              on the whole label).
  const candidatePricedCardNumbers = new Set(
    Object.values(candidateCards || {}).filter(isPricedRow).map((c) => c.cardNumber),
  );
  const regressions = [];
  const superseded = [];
  for (const [id, current] of Object.entries(currentCards || {})) {
    if (!isPricedRow(current)) continue;
    const candidate = candidateCards?.[id];
    if (candidate && isPricedRow(candidate)) continue;
    const cardNumberLost = !candidatePricedCardNumbers.has(current.cardNumber);
    const verdict = classifyExactPrintPayload(current);
    if (verdict.proven) {
      if (cardNumberLost) {
        regressions.push({ id, cardNumber: current.cardNumber, decision: 'preserved-last-known-good', reason: null });
      }
      continue;
    }
    rejected.push(makeRejection(id, current, verdict.reason));
    current.sellPrice = null;
    current.prices = [];
    current.yuyuName = '';
    current.yuyuImage = '';
    current.timestamp = '';
    if (Array.isArray(current._rawPricesArchive)) current._rawPricesArchive = [];
    if (current.priceHistory) current.priceHistory = {};
    if (current.priceHistoryMeta) delete current.priceHistoryMeta;
    if (cardNumberLost) {
      regressions.push({ id, cardNumber: current.cardNumber, decision: 'rejected', reason: verdict.reason });
    } else {
      superseded.push({ id, cardNumber: current.cardNumber, reason: verdict.reason });
    }
  }

  return { accepted, refreshed, rejected, regressions, superseded };
}

function summarizeByPrefix(items) {
  const byPrefix = {};
  for (const item of items) {
    const prefix = cardNumberPrefix(item.cardNumber);
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
  }
  return byPrefix;
}

function main() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const candidatePath = getArg('--candidate');
  const apply = args.includes('--apply');
  const reportPath = getArg('--report')
    || path.join(repoRoot, 'docs', 'audits', 'dic1482-price-recovery-report.json');
  if (!candidatePath) {
    console.error('usage: recover-dic1482-exact-print-prices.mjs --candidate <candidate-database.json> [--apply] [--report <path>]');
    process.exit(2);
  }

  const dbPath = path.join(repoRoot, 'data', 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  const previousCards = JSON.parse(JSON.stringify(db.cards));

  const result = recoverExactPrintPrices(db.cards, candidate.cards);

  const gate = evaluatePriceRegressionGate({
    previousCards,
    nextCards: db.cards,
    rejections: result.rejected,
    // Refreshed rows adopted the candidate's OWN fresh listing for that EXACT
    // PRINTING — an entry-count decrease there is the source's current claim,
    // not a silent drop. Keyed by printing id, never by cardNumber: a sibling
    // printing that was not refreshed must not inherit the waiver
    // (DIC-1484 CR blocker 2).
    freshlyScrapedPrintingIds: new Set(result.refreshed.map((r) => r.id)),
  });
  const report = {
    schema: 'huntercard.dic1482-recovery-report/v1',
    generatedAt: new Date().toISOString(),
    candidate: { path: candidatePath, lastUpdated: candidate.lastUpdated || null },
    before: gate.before,
    after: gate.after,
    accepted: {
      total: result.accepted.length,
      uniqueCardNumbers: new Set(result.accepted.map((a) => a.cardNumber)).size,
      byPrefix: summarizeByPrefix(result.accepted),
      rows: result.accepted,
    },
    refreshed: {
      total: result.refreshed.length,
      uniqueCardNumbers: new Set(result.refreshed.map((r) => r.cardNumber)).size,
      byPrefix: summarizeByPrefix(result.refreshed),
      rows: result.refreshed,
    },
    superseded: {
      total: result.superseded.length,
      byPrefix: summarizeByPrefix(result.superseded),
      rows: result.superseded,
    },
    rejected: {
      total: result.rejected.length,
      byReason: result.rejected.reduce((acc, r) => {
        acc[r.reason] = (acc[r.reason] || 0) + 1;
        return acc;
      }, {}),
      rows: result.rejected,
    },
    candidateRegressions: {
      total: result.regressions.length,
      preserved: result.regressions.filter((r) => r.decision === 'preserved-last-known-good').length,
      rejected: result.regressions.filter((r) => r.decision === 'rejected').length,
      rows: result.regressions,
    },
    gate: { ok: gate.ok, violations: gate.violations },
  };

  console.log(`[dic1482] before: ${JSON.stringify(gate.before)}`);
  console.log(`[dic1482] after : ${JSON.stringify(gate.after)}`);
  console.log(`[dic1482] accepted ${report.accepted.total} printings (${report.accepted.uniqueCardNumbers} cardNumbers): ${JSON.stringify(report.accepted.byPrefix)}`);
  console.log(`[dic1482] refreshed ${report.refreshed.total} already-priced printings with fresher proven payloads: ${JSON.stringify(report.refreshed.byPrefix)}`);
  console.log(`[dic1482] rejected ${report.rejected.total} printings: ${JSON.stringify(report.rejected.byReason)}`);
  console.log(`[dic1482] superseded ${report.superseded.total} unproven stale printings (cardNumber still priced): ${JSON.stringify(report.superseded.byPrefix)}`);
  console.log(`[dic1482] candidate regressions: ${report.candidateRegressions.preserved} preserved last-known-good, ${report.candidateRegressions.rejected} rejected`);
  if (!gate.ok) {
    console.error(formatGateViolations('recovery produced uncovered decreases', gate.violations));
    process.exit(1);
  }
  if (!apply) {
    console.log('[dic1482] dry run — pass --apply to write data/database.json, the rejection manifest, and the report');
    return;
  }

  // Mirror the production build sequence: after price fills, reorder every
  // cardNumber group so the origin-product row leads — the DIC-1167 contract
  // verify-version-alignment.js enforces across CardDetail / deck pipelines.
  {
    const { cards: ordered, reorderedCardNumbers } = orderCardsForDetailAlignment(db.cards);
    db.cards = ordered;
    if (reorderedCardNumbers > 0) {
      console.log(`[dic1482] detail-align reordered ${reorderedCardNumbers} cardNumber groups`);
    }
  }

  db.lastUpdated = new Date().toISOString();
  db.totalCards = Object.keys(db.cards).length;
  writeJsonAtomic(dbPath, db);
  writeJsonAtomic(path.join(repoRoot, 'data', 'price-rejections.json'), buildPriceRejectionManifest({
    label: 'dic1482-recovery',
    previousCards,
    nextCards: db.cards,
    rejections: result.rejected,
  }));
  writeJsonAtomic(reportPath, report);
  console.log(`[dic1482] wrote ${dbPath}`);
  console.log(`[dic1482] wrote data/price-rejections.json + ${path.relative(repoRoot, reportPath)}`);
  console.log('[dic1482] next: node scripts/regen-buy-alignment.mjs && node scripts/generate-native-database.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
