/**
 * price-evidence.js — DIC-1461 opt-in price-provenance diagnostic evidence.
 *
 * The daily scrape can reject hundreds of live yuyu listings at the DIC-1334
 * exact-printing gates, and the cron log only records the terminal fail-closed
 * line per cardNumber — not WHICH predicate rejected WHICH listing. This module
 * captures, per scraped cardNumber, the structured metadata the matcher
 * actually decided on (sourceSeries, parsed rarity, yuyu image URL + parsed
 * product path, price presence, candidate counts) plus the decision and the
 * first failing predicate, so a live failure can be diagnosed from one JSON
 * artifact without re-running the scrape.
 *
 * Contract (DIC-1461):
 *   - Opt-in only: build-database.js calls this ONLY when
 *     HUNTERCARD_PRICE_EVIDENCE_PATH is set. Default builds never emit
 *     anything and never take this code path's write.
 *   - The collector is READ-ONLY over the build's in-memory structures and
 *     re-applies the very same predicate functions the build used
 *     (yuyuEntryMatchesOfficial, yuyuImageProductPath, normalizeRarityCode
 *     are passed in, not re-implemented), so evidence can never diverge from
 *     nor influence canonical matching.
 *   - Structured metadata only: no cookies, headers, raw HTML, credentials,
 *     or bulk page content. Strings are bounded; listings per cardNumber are
 *     capped.
 *   - Atomic write: temp file + rename, so a crashed run never leaves a
 *     half-written artifact at the target path.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LISTINGS_PER_CARDNUMBER = 40;
const MAX_OFFICIAL_ROWS_PER_CARDNUMBER = 40;
const MAX_STRING = 300;

function bounded(value) {
  const s = String(value ?? '');
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
}

/**
 * Decision taxonomy. `decision` is the cardNumber-level outcome; `reason` is
 * the first failing predicate (matcher order) for rejected cardNumbers.
 * `bucket` maps every decision onto the DIC-1461 report buckets:
 *   unique_exact_proof | same_product_multi_print_ambiguity |
 *   cross_product_or_reprint_ambiguity | missing_source_metadata |
 *   invalid_or_missing_image_evidence | source_listing_absent
 */
const BUCKETS = [
  'unique_exact_proof',
  'same_product_multi_print_ambiguity',
  'cross_product_or_reprint_ambiguity',
  'missing_source_metadata',
  'invalid_or_missing_image_evidence',
  'source_listing_absent',
];

/**
 * Classify one scraped cardNumber exactly the way build-database.js's
 * official-match + yuyu-only-fallback pass does, using the SAME predicate
 * functions, and record the first failing predicate for rejections.
 */
function classifyCardNumber({
  cardNumber,
  entries,
  officialRows,
  officialKeyByRow,
  officialAlreadyPriced,
  matchesOfficial,
  imageProductPath,
  normalizeRarity,
  finalCards,
}) {
  const officialProducts = new Set(
    officialRows.map((row) => String(row.sourceProduct || row.series || '').toLowerCase()).filter(Boolean),
  );
  const candidateCountFor = (official) => {
    const src = String(official.sourceProduct || official.series || '').toLowerCase();
    return officialRows.filter(
      (c) => String(c.sourceProduct || c.series || '').toLowerCase() === src,
    ).length;
  };

  // Exact re-application of the fallback loop's proven-printings algorithm.
  const provenPrintings = new Map(); // official compound key → count of proving listings
  const listings = [];
  for (const entry of entries) {
    const sourceSeries = String(entry.sourceSeries || '').toLowerCase();
    const rarity = String(entry.rarity || '');
    const normalizedRarity = normalizeRarity(rarity);
    const imageUrl = String(entry.yuyuImage || '');
    const imageProduct = imageProductPath(imageUrl);
    const matchedKeys = [];
    for (const official of officialRows) {
      if (!matchesOfficial(entry, official, candidateCountFor(official))) continue;
      const key = officialKeyByRow.get(official);
      if (!key) continue;
      matchedKeys.push(key);
      provenPrintings.set(key, (provenPrintings.get(key) || 0) + 1);
    }

    // First failing predicate for THIS listing, in matcher evaluation order.
    let listingReason = 'matched';
    if (matchedKeys.length === 0) {
      if (!sourceSeries) listingReason = 'missing_source_series';
      else if (!imageProduct) listingReason = 'invalid_or_missing_image_url';
      else if (!officialProducts.has(imageProduct)) listingReason = 'image_product_has_no_official_row';
      else {
        // Image URL proves a product that HAS official rows for this
        // cardNumber; find why the matcher still refused.
        const sameProductRows = officialRows.filter(
          (row) => String(row.sourceProduct || row.series || '').toLowerCase() === imageProduct,
        );
        const candidateCount = sameProductRows.length;
        const seriesAgrees = sameProductRows.some((row) => {
          const officialSeries = String(row.series || '').toLowerCase();
          const officialSource = String(row.sourceProduct || row.series || '').toLowerCase();
          return sourceSeries === officialSeries || sourceSeries === officialSource;
        });
        if (normalizedRarity !== '') listingReason = 'rarity_token_matches_no_official_row';
        else if (candidateCount > 1) listingReason = 'empty_rarity_multiple_candidates_same_product';
        else if (!seriesAgrees) listingReason = 'source_series_label_disagrees_with_image_product';
        else listingReason = 'exact_print_image_check_failed';
      }
    }

    if (listings.length < MAX_LISTINGS_PER_CARDNUMBER) {
      listings.push({
        sourceSeries: bounded(entry.sourceSeries),
        rarity: bounded(rarity),
        normalizedRarity: bounded(normalizedRarity),
        sellPrice: Number.isFinite(entry.sellPrice) ? entry.sellPrice : null,
        hasPrice: Number.isFinite(entry.sellPrice) && entry.sellPrice > 0,
        yuyuImage: bounded(imageUrl),
        imageProductPath: bounded(imageProduct),
        matchedPrintings: matchedKeys.slice(0, MAX_OFFICIAL_ROWS_PER_CARDNUMBER).map(bounded),
        reason: listingReason,
      });
    }
  }

  const provenKeys = [...provenPrintings.keys()];
  const provenProducts = new Set(
    provenKeys.map((key) => {
      const row = officialRows.find((r) => officialKeyByRow.get(r) === key);
      return row ? String(row.sourceProduct || row.series || '').toLowerCase() : '';
    }),
  );

  let decision;
  let reason;
  let bucket;
  if (officialRows.length === 0) {
    // Truly yuyu-only cardNumber: no official identity exists to prove
    // against, and the build emits it as a yuyu-only row (unchanged
    // behavior). It is evidence of an official-catalog gap, not a matcher
    // rejection.
    decision = 'yuyu_only_no_official_row';
    reason = 'no_official_row_for_cardnumber';
    bucket = 'source_listing_absent';
  } else if (officialAlreadyPriced) {
    decision = 'accepted_official_match';
    reason = 'matched';
    bucket = 'unique_exact_proof';
  } else if (provenKeys.length === 1) {
    decision = 'accepted_fallback_bound';
    reason = 'matched';
    bucket = 'unique_exact_proof';
    if (!finalCards[provenKeys[0]]) {
      decision = 'rejected_no_official_row_to_bind';
      reason = 'proven_printing_missing_from_artifact';
      bucket = 'source_listing_absent';
    }
  } else if (provenKeys.length > 1) {
    if (provenProducts.size > 1) {
      decision = 'rejected_ambiguous_printings';
      reason = 'multiple_printings_proven_across_products';
      bucket = 'cross_product_or_reprint_ambiguity';
    } else {
      decision = 'rejected_ambiguous_printings';
      reason = 'multiple_printings_proven_same_product';
      bucket = 'same_product_multi_print_ambiguity';
    }
  } else {
    // provenKeys.length === 0 — rejected. cardNumber-level reason is the
    // first listing's failing predicate; the bucket aggregates over listings
    // so one malformed listing does not mask another listing's ambiguity.
    decision = 'rejected_unproven';
    const reasons = listings.map((l) => l.reason);
    reason = reasons[0] || 'no_listings';
    const pick = (needle) => reasons.find((r) => r === needle);
    if (reasons.length === 0) {
      bucket = 'source_listing_absent';
    } else if (pick('empty_rarity_multiple_candidates_same_product')) {
      bucket = 'same_product_multi_print_ambiguity';
      reason = 'empty_rarity_multiple_candidates_same_product';
    } else if (pick('image_product_has_no_official_row')) {
      bucket = 'cross_product_or_reprint_ambiguity';
      reason = 'image_product_has_no_official_row';
    } else if (pick('source_series_label_disagrees_with_image_product')) {
      bucket = 'missing_source_metadata';
      reason = 'source_series_label_disagrees_with_image_product';
    } else if (pick('rarity_token_matches_no_official_row')) {
      bucket = 'missing_source_metadata';
      reason = 'rarity_token_matches_no_official_row';
    } else if (reasons.every((r) => r === 'missing_source_series')) {
      bucket = 'missing_source_metadata';
    } else if (reasons.every((r) => r === 'invalid_or_missing_image_url' || r === 'missing_source_series')) {
      bucket = 'invalid_or_missing_image_evidence';
      reason = 'invalid_or_missing_image_url';
    } else {
      bucket = 'missing_source_metadata';
    }
  }

  return {
    cardNumber: bounded(cardNumber),
    decision,
    reason,
    bucket,
    officialRowCount: officialRows.length,
    officialProducts: [...officialProducts].slice(0, MAX_OFFICIAL_ROWS_PER_CARDNUMBER).map(bounded),
    provenPrintings: provenKeys.slice(0, MAX_OFFICIAL_ROWS_PER_CARDNUMBER).map(bounded),
    listings,
  };
}

/**
 * Build the full evidence payload for one build run. Pure over its inputs.
 */
export function collectPriceEvidence({
  prices,
  officialByCardNum,
  officialKeyByRow,
  officialPricedCardNums,
  canonicalizeCardNumber,
  matchesOfficial,
  imageProductPath,
  normalizeRarity,
  finalCards,
  prevPricedCardNumbers = new Set(),
  pricingUnavailable = false,
  partialScrape = false,
  gate = null,
}) {
  const cardNumbers = [];
  const classification = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const decisionCounts = {};

  const scrapedCanonical = new Set();
  for (const [rawCardNum, priceData] of Object.entries(prices || {})) {
    const cardNum = canonicalizeCardNumber(rawCardNum);
    scrapedCanonical.add(cardNum);
    const entries = Array.isArray(priceData) ? priceData : [priceData];
    const officialRows = officialByCardNum[cardNum] || [];
    const row = classifyCardNumber({
      cardNumber: cardNum,
      entries,
      officialRows,
      officialKeyByRow,
      officialAlreadyPriced: officialPricedCardNums.has(cardNum),
      matchesOfficial,
      imageProductPath,
      normalizeRarity,
      finalCards,
    });
    if (rawCardNum !== cardNum) row.rawCardNumber = bounded(rawCardNum);
    classification[row.bucket] += 1;
    decisionCounts[row.decision] = (decisionCounts[row.decision] || 0) + 1;
    cardNumbers.push(row);
  }

  // Previously-priced cardNumbers the current scrape did not list at all:
  // the source listing itself is absent (nothing for the matcher to decide).
  const sourceListingAbsent = [...prevPricedCardNumbers].filter((n) => !scrapedCanonical.has(n));
  classification.source_listing_absent += sourceListingAbsent.length;

  return {
    schema: 'dic1461-price-evidence/v1',
    generatedAt: new Date().toISOString(),
    context: {
      scrapedCardNumberCount: scrapedCanonical.size,
      previouslyPricedCardNumberCount: prevPricedCardNumbers.size,
      pricingUnavailable: Boolean(pricingUnavailable),
      partialScrape: Boolean(partialScrape),
    },
    gate,
    classification,
    decisionCounts,
    previouslyPricedNowUnlisted: sourceListingAbsent.slice(0, 2000).map(bounded),
    cardNumbers,
  };
}

/**
 * Atomically write the evidence payload: write to a same-directory temp file,
 * then rename over the target. Throws on any failure — when the operator
 * explicitly asked for evidence, a silent no-artifact run would defeat the
 * diagnostic contract.
 */
export function writePriceEvidenceAtomic(outPath, payload) {
  const resolved = path.resolve(outPath);
  const tmp = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.tmp-${process.pid}`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`, 'utf-8');
  try {
    fs.renameSync(tmp, resolved);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return resolved;
}
