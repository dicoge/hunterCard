#!/usr/bin/env node
// DIC-1321: rigorous fresh-source audit of the "55 completely lost cardNumbers"
// (priced at immutable e8322c8003, entirely unpriced in production HEAD).
//
// This mirrors the REAL preservation flow: for every FRESH official printing
// of a lost cardNumber, it runs `findPreservedMatch` against the e8322 index
// (exact-id first, then strict signature) and applies `yuyuPayloadMatchesSource`
// (previous row's yuyuImage product path == fresh sourceProduct, promo→hpr).
// A fresh printing is "exactly recoverable" only when BOTH the exact printing
// exists in the current official catalog AND the previous yuyu payload provably
// matches that fresh sourceProduct. A cardNumber is:
//   recoverable  — every one of its fresh printings recovers; nothing unproven.
//   mixed        — some fresh printings recover, others stay null (proven or
//                  deliberately isolated per printing — BASE/parallel/promo).
//   unavailable  — no fresh printing can be provably restored (genuinely
//                  unproven, or no longer in the fresh catalog).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  buildPreservationIndex,
  findPreservedMatch,
  yuyuPayloadMatchesSource,
  yuyuImageProductPath,
} from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..');
const dbPath = process.argv[2] || path.join(repo, 'data', 'database.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const loadGitDb = (ref) =>
  JSON.parse(execSync(`git show ${ref}:data/database.json`, { cwd: repo, encoding: 'utf-8', maxBuffer: 1 << 28 }));

const priced = (c) => Number.isFinite(c?.sellPrice) && c.sellPrice > 0;

const e8322 = loadGitDb('e8322c8003');
const head = readJson(dbPath);

const headPriced = new Set(
  Object.values(head.cards).filter(priced).map((c) => c.cardNumber),
);
const lost = [
  ...new Set(
    Object.values(e8322.cards)
      .filter(priced)
      .map((c) => c.cardNumber),
  ),
].filter((cn) => !headPriced.has(cn)).sort();

const official = readJson(path.join(repo, 'data', 'official', 'all-cards.json'));
const freshOfficialByCN = new Map();
for (const o of official) {
  if (!freshOfficialByCN.has(o.cardNumber)) freshOfficialByCN.set(o.cardNumber, []);
  freshOfficialByCN.get(o.cardNumber).push(o);
}

const index = buildPreservationIndex(e8322.cards);

const results = [];
for (const cn of lost) {
  const fresh = freshOfficialByCN.get(cn) || [];
  const rowDetails = fresh.map((o) => {
    const freshCard = {
      id: `${cn}_${o.sourceProduct}`,
      cardNumber: cn,
      rarity: o.rarity,
      sourceProduct: o.sourceProduct,
      series: o.series,
    };
    const match = findPreservedMatch(index, freshCard.id, freshCard);
    const prev = match?.card || e8322.cards[freshCard.id];
    const freshSrc = String(o.sourceProduct || '').toLowerCase();
    const provablyMatches = prev ? yuyuPayloadMatchesSource(prev, o.sourceProduct || o.series || '') : false;
    const prevPriced = prev ? priced(prev) : false;
    const recoverable = Boolean(prev) && prevPriced && provablyMatches;
    return {
      rarity: o.rarity,
      sourceProduct: freshSrc,
      freshImage: o.imageUrl || '',
      prev_id: prev?.id ?? null,
      exact_match: match?.matchKind || null,
      prev_priced: prevPriced,
      provablyMatchesSource: provablyMatches,
      recoverable,
    };
  });
  const recoverRows = rowDetails.filter((r) => r.recoverable).length;
  const unprovenRows = rowDetails.filter((r) => !r.recoverable).length;
  const verdict =
    rowDetails.length === 0
      ? 'no-fresh-printing'
      : unprovenRows === 0
        ? 'recoverable'
        : recoverRows > 0
          ? 'mixed'
          : 'unavailable';
  results.push({
    cardNumber: cn,
    fresh_printings: rowDetails.length,
    recoverable_printings: recoverRows,
    unproven_printings: unprovenRows,
    verdict,
    printings: rowDetails,
  });
}

const countBy = (v) => results.filter((r) => r.verdict === v).length;
const out = {
  generated_at: new Date().toISOString(),
  source_baseline: 'e8322c8003',
  fresh_official_catalog: 'data/official/all-cards.json',
  e8322_priced_unique_cardnumbers: new Set(Object.values(e8322.cards).filter(priced).map((c) => c.cardNumber)).size,
  head_priced_unique_cardnumbers: headPriced.size,
  lost_count: lost.length,
  verdicts: {
    recoverable: countBy('recoverable'),
    mixed: countBy('mixed'),
    unavailable: countBy('unavailable'),
    no_fresh_printing: countBy('no-fresh-printing'),
  },
  recoverable_cardnumbers: results.filter((r) => r.verdict === 'recoverable').map((r) => r.cardNumber),
  mixed_cardnumbers: results.filter((r) => r.verdict === 'mixed').map((r) => r.cardNumber),
  unavailable_cardnumbers: results.filter((r) => r.verdict === 'unavailable').map((r) => r.cardNumber),
  no_fresh_printing_cardnumbers: results.filter((r) => r.verdict === 'no-fresh-printing').map((r) => r.cardNumber),
  detail: results,
};
console.log(JSON.stringify(out, null, 2));
