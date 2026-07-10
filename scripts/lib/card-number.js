/**
 * Shared card-number parsing for the hololive TCG scrapers.
 *
 * Card numbers look like hBP01-091 / hSD05-001, and promo sets like hPR-001 or
 * hYELL-01 that carry no digits before the dash. The set prefix is `h` + 1-4
 * letters + up to 3 optional digits, then `-` and a 2-3 digit index. Torecolo
 * embeds them inside longer hrefs (e.g. gHL-HPR-001SEC-S), so this matches a
 * substring rather than the whole string.
 *
 * Keep this shape in ONE place: the earlier per-file copies drifted apart, and
 * a stricter copy that required digits before the dash silently dropped every
 * hPR-* promo card (DIC-199).
 */
export const CARD_NUMBER_RE = /h[A-Za-z]{1,4}\d{0,3}-\d{2,3}/i;

// First card number found in `str`, or null if none. Value is returned as-is
// (original casing); callers uppercase when matching against database keys.
export function extractCardNumber(str) {
  const m = String(str ?? '').match(CARD_NUMBER_RE);
  return m ? m[0] : null;
}
