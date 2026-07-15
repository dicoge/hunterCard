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

const RARITY_BRACKET_RE = /【(OUR|OSR|P|PR|UR|SR|SEC)】/i;
const RARITY_CODES = ['SEC', 'OSR', 'OUR', 'PR', 'UR', 'SR', 'P'];

// First card number found in `str`, or null if none. Value is returned as-is
// (original casing); callers uppercase when matching against database keys.
export function extractCardNumber(str) {
  const m = String(str ?? '').match(CARD_NUMBER_RE);
  return m ? m[0] : null;
}

// Extracts rarity from a product name or href.
// Fullahead format: 【OUR】hBP04-002 ... → OUR
// Torecolo format: HL-HBP08-003SEC-S → SEC
// 【PR】normalizes to P.
// Returns null if no rarity found.
export function extractRarity(str) {
  if (!str) return null;
  const s = String(str);

  const bracketMatch = s.match(RARITY_BRACKET_RE);
  if (bracketMatch) {
    const r = bracketMatch[1].toUpperCase();
    return r === 'PR' ? 'P' : r;
  }

  const cn = extractCardNumber(s);
  if (cn) {
    const remainder = s.substring(s.indexOf(cn) + cn.length);
    for (const code of RARITY_CODES) {
      if (remainder.toUpperCase().startsWith(code)) {
        return code === 'PR' ? 'P' : code;
      }
    }
  }

  return null;
}
