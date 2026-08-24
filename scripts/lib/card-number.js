/**
 * Shared card-number parsing for the hololive TCG scrapers.
 *
 * Card numbers look like hBP01-091 / hSD05-001, and promo sets like hPR-001 or
 * hYELL-01 that carry no digits before the dash. The set prefix is `h` + 1-4
 * letters + up to 3 optional digits, then `-` and a 2+ digit index. Torecolo
 * embeds them inside longer hrefs (e.g. gHL-HPR-001SEC-S), so this matches a
 * substring rather than the whole string.
 *
 * The index uses a greedy `\d{2,}` so 4-digit promos (hPR-1000) match in full
 * instead of being truncated to hPR-100; an earlier `\d{2,3}(?!\d)` guard
 * dropped every 4-digit card (DIC-218).
 *
 * Keep this shape in ONE place: the earlier per-file copies drifted apart, and
 * a stricter copy that required digits before the dash silently dropped every
 * hPR-* promo card (DIC-199).
 */
export const CARD_NUMBER_RE = /h[A-Za-z]{1,4}\d{0,3}-\d{2,}/i;

// First card number found in `str`, or null if none. Value is returned as-is
// (original casing); callers uppercase when matching against database keys.
export function extractCardNumber(str) {
  const m = String(str ?? '').match(CARD_NUMBER_RE);
  return m ? m[0] : null;
}

/**
 * Strict, anchored canonical card-number validator (DIC-1141 CR#3).
 *
 * Distinct from `CARD_NUMBER_RE` — that one is a permissive substring matcher
 * used to yank card numbers out of scraper hrefs / free text. This one is the
 * single canonical schema every persisted card number MUST satisfy: the Bloom
 * overlay keys, `collectHolomenTargets` outputs, and the build-side overlay
 * validator all share this so a bogus key like `bogus-0` cannot silently fill
 * the coverage floor without ever matching a real card.
 *
 * At time of writing, all 316 canonical Bloom keys pass this regex, so it is
 * both what the data already looks like AND what future writes must respect.
 */
export const CANONICAL_CARD_NUMBER_RE = /^h[A-Za-z0-9]+-\d{3}$/;

export function isCanonicalCardNumber(value) {
  return typeof value === 'string' && CANONICAL_CARD_NUMBER_RE.test(value);
}

export function assertCanonicalCardNumber(value, context = 'card number') {
  if (!isCanonicalCardNumber(value)) {
    throw new Error(`${context} has invalid canonical format ${JSON.stringify(value)} (expected ${CANONICAL_CARD_NUMBER_RE})`);
  }
}
