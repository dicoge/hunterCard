/**
 * buy-retained-coverage.mjs — INDEPENDENT classification of every retained (last-known) BUY quote of
 * an artifact against the raw source files (2026-11-10, PR #287 independent review R1, P1-1).
 *
 * Why: for a no-marker artifact every BUY quote is retained, and the verifier's resolver-free
 * invariant skips retained rows; value / shop / time / printing were then certified only by the
 * merge's own `auditRetainedQuotes` (via validRunProof). This module re-derives the covered /
 * carried split WITHOUT the resolver, the merge, the audit or buy-source-cache: it reads the three
 * raw files itself and uses only the shared token vocabulary (variant-key normalizeCardNumber /
 * sourceToken — the same primitives the existing independent invariant uses).
 *
 *   covered  — the raw files hold an entry with the same normalized card number, exact token, shop,
 *              price and observation time (and, for a card holder that names one, the same
 *              sourceKey), observed strictly before the retained bound (run start, else proof now).
 *   carried  — a well-formed retained tuple with no such entry. Its only protection is the
 *              artifact's own `retainedCarryDigest` — a CONSISTENCY checksum, NOT a source proof.
 *              A carried quote is acceptable for a merge decision only with a host comparison
 *              against the immutable parent artifact; this module never fetches anything.
 *   incomplete / atOrAfterBound — not a valid retained quote at all (fail).
 *
 * The carried lines use the merge's documented digest format so the independently rebuilt carried
 * set can be compared with the proof's digest; equality proves only that the artifact is
 * self-consistent, never that a carried value is real.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCardNumber, sourceToken, UNKNOWN_TOKEN } from './variant-key.js';

const SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json', 'yuyu-prices.json'];
const SHOPS = SOURCE_FILES.map((f) => f.replace(/-prices\.json$/, ''));
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** numKey → raw entries { sourceKey, token, price, source, timestamp, t, file } (any age). */
function readRaw(buyDir, now) {
  const byNum = new Map();
  for (const file of SOURCE_FILES) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(buyDir, file), 'utf-8')); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = file.replace(/-prices\.json$/, '');
    for (const [sourceKey, entry] of Object.entries(raw)) {
      const price = entry && entry.buyPrice != null ? Number(entry.buyPrice) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = typeof (entry && entry.timestamp) === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(t) || t > now + FUTURE_SKEW_MS) continue;
      const numKey = normalizeCardNumber(sourceKey);
      if (!numKey) continue;
      const token = sourceToken(entry.rarity, sourceKey.slice(numKey.length));
      if (token === UNKNOWN_TOKEN) continue;
      if (!byNum.has(numKey)) byNum.set(numKey, []);
      byNum.get(numKey).push({ sourceKey, token, price, source, timestamp: entry.timestamp, t, file });
    }
  }
  return byNum;
}

/** A retained tuple → { token, price, source, timestamp, t } or null (malformed / not exact). */
function tupleOf(price, version, source, timestamp, now) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof version !== 'string' || version === '' || version.startsWith('#') || version === UNKNOWN_TOKEN) return null;
  if (!SHOPS.includes(source)) return null;
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(t) || t > now + FUTURE_SKEW_MS) return null;
  const token = version === 'BASE' ? '' : version;
  if (token !== '' && sourceToken(token, '') !== token) return null;
  return { token, price, source, timestamp, t };
}

/**
 * @param {object} rawDb  parsed artifact (top level: `cards`, `buyQuoteRun`)
 * @param {{ buyDir: string, now: number, runStartedAt: number|null }} ctx  times from the proof
 * @returns stable, non-secret classification report (market data only)
 */
export function classifyRetainedQuotes(rawDb, { buyDir, now, runStartedAt }) {
  const bound = runStartedAt == null ? now : runStartedAt;
  const raw = readRaw(buyDir, now);
  const coveredRows = [];
  const carriedRows = [];
  const incomplete = [];
  const atOrAfterBound = [];
  const carriedLines = [];
  let retainedTuples = 0;
  const judge = (id, slot, numKey, q, sourceKey, isCard) => {
    if (!(q.t < bound)) { atOrAfterBound.push(`${id} ${slot}`); return; }
    const hit = (raw.get(numKey) || []).find((e) => e.token === q.token && e.source === q.source && e.price === q.price
      && e.t === q.t && (!isCard || !sourceKey || e.sourceKey === sourceKey));
    if (hit) { coveredRows.push({ id, slot, token: q.token, file: hit.file, sourceKey: hit.sourceKey }); return; }
    carriedRows.push({ id, slot, token: q.token, price: q.price, source: q.source, timestamp: q.timestamp, sourceKey: isCard ? (sourceKey || '') : '' });
    const key = `${id}\u0000${slot === 'card' ? '#card' : slot}`;
    carriedLines.push([key, q.token, q.price, q.source, q.timestamp, isCard ? (sourceKey || '') : ''].join('|'));
  };
  for (const [id, card] of Object.entries((rawDb && rawDb.cards) || {})) {
    if (!card || typeof card !== 'object' || !card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    (Array.isArray(card.prices) ? card.prices : []).forEach((v, i) => {
      if (!v || v.buyPriceRetained !== true) return;
      retainedTuples += 1;
      const q = tupleOf(v.buyPrice, v.buyPriceVersion, v.buyPriceSource, v.buyPriceTimestamp, now);
      if (!q) { incomplete.push(`${id} ${i}`); return; }
      judge(id, String(i), numKey, q, undefined, false);
    });
    if (card.buyPriceRetained === true) {
      retainedTuples += 1;
      const h = card.buyLastKnown;
      const q = h && typeof h === 'object' ? tupleOf(h.price, h.version, h.source, h.timestamp, now) : null;
      if (!q || card.buyPrice !== q.price) { incomplete.push(`${id} card`); return; }
      judge(id, 'card', numKey, q, typeof h.sourceKey === 'string' ? h.sourceKey : undefined, true);
    }
  }
  const byKey = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0);
  coveredRows.sort(byKey);
  carriedRows.sort(byKey);
  carriedLines.sort();
  return {
    bound: new Date(bound).toISOString(),
    retainedTuples,
    covered: coveredRows.length,
    carried: carriedRows.length,
    incomplete,
    atOrAfterBound,
    carriedDigest: createHash('sha256').update(carriedLines.join('\n')).digest('hex'),
    carriedRows,
    coveredRows,
  };
}

/**
 * Problems of an independent classification against the run proof (empty = consistent).
 * Carried quotes are NOT a problem here — they are reported as consistency-only.
 */
export function retainedCoverageProblems(cov, proof, declaredCarryDigest) {
  const p = [];
  if (cov.incomplete.length) p.push(`${cov.incomplete.length} retained tuple(s) malformed: ${cov.incomplete.slice(0, 5).join(', ')}`);
  if (cov.atOrAfterBound.length) p.push(`${cov.atOrAfterBound.length} retained tuple(s) observed at/after the retained bound: ${cov.atOrAfterBound.slice(0, 5).join(', ')}`);
  if (cov.covered + cov.carried !== cov.retainedTuples) p.push(`covered ${cov.covered} + carried ${cov.carried} != retained tuples ${cov.retainedTuples}`);
  if (cov.retainedTuples > 0 && cov.covered === 0) p.push('no retained tuple is source-covered (vacuous: every retained quote would rest on the self digest alone)');
  const audit = proof && proof.audit;
  if (!audit) p.push('run proof has no audit to compare');
  else {
    if (cov.covered !== audit.covered) p.push(`independent covered ${cov.covered} != proof audit covered ${audit.covered}`);
    if (cov.carried !== audit.carried) p.push(`independent carried ${cov.carried} != proof audit carried ${audit.carried}`);
  }
  if (cov.carriedDigest !== declaredCarryDigest) p.push('independently rebuilt carried set does not match buyQuoteRun.retainedCarryDigest');
  return p;
}
