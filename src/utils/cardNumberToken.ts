/**
 * Strict card-number tokens (CR 2026-10-15 P2_2).
 *
 * Canonical catalog numbers are `h` + 1–2 letters + optional 2-digit set + `-` + exactly
 * 3 digits: hBP01-010, hSD12-009, hY01-014, hPR-002. The previous normalizers searched
 * for a number ANYWHERE in the text (`\d{1,3}` unanchored), so `hBP01-0100` became the
 * real `hbp01-010` and was then trusted as an exact match. A token is now accepted only
 * if the WHOLE token is a card number: extra digits, extra letters or several numbers
 * fail closed.
 *
 * Tolerated, because they are how a correct number is mis-read rather than a different
 * number: NFKC width/case, dash/underscore/space variants, a missing dash, the known
 * prefix aliases printed on cards (BP → hBP, NP → hBP …), and the OCR confusions
 * O/〇 → 0 and l/I/|/｜ → 1 — applied to the DIGIT groups only, never to the prefix.
 *
 * Dependency-free: shared by api/recognize-card and the local OCR paths.
 */

/** Printed / OCR prefix aliases → catalog prefix. */
const PREFIX_ALIASES: Record<string, string> = {
  np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr', sp: 'hsp', ys: 'hys', eb: 'heb', bd: 'hbd',
};

const DIGITISH = '0-9oil|〇｜';
const TOKEN = new RegExp(`^(h?)([a-z]{1,3}?)([${DIGITISH}]{2})?-?([${DIGITISH}]{3})$`);

function digits(s: string): string | null {
  const out = s.replace(/[o〇]/g, '0').replace(/[il|｜]/g, '1');
  return /^\d+$/.test(out) ? out : null;
}

/** The canonical lower-case number for a whole token, or null. */
export function parseCardNumberToken(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
    .replace(/[－‐‑‒–—―−_‾~\s]+/g, '-');
  if (!cleaned || cleaned === 'none' || cleaned === 'unknown') return null;
  const m = cleaned.match(TOKEN);
  if (!m) return null;
  const [, h, letters, setRaw, numRaw] = m;
  if (!letters) return null;
  const set = setRaw ? digits(setRaw) : '';
  const num = digits(numRaw);
  if (set === null || num === null) return null;
  let prefix: string;
  if (h) prefix = `h${letters}`;
  else if (PREFIX_ALIASES[letters]) prefix = PREFIX_ALIASES[letters];
  else return null; // an unknown bare prefix is not a card number
  // hPR-002 has no set; everything else carries a 2-digit set (hBP01, hY01 …).
  if (!set && prefix !== 'hpr') return null;
  return `${prefix}${set}-${num}`;
}

/**
 * Card numbers found in free OCR text. The text is split on everything that cannot be
 * part of a number, and each piece must parse as a whole token — `hBP01-0100` or
 * `hBP01-010SR` is rejected, not trimmed into hBP01-010.
 */
export function findCardNumberTokens(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || !text) return [];
  const pieces = text
    .normalize('NFKC')
    .replace(/[－‐‑‒–—―−‾~_]/g, '-')
    // A printed "BP04 005" is one number with a space for the dash; join only when the
    // second part is exactly three digit-like characters ending the word.
    .replace(/(^|[^0-9a-z])([a-z]{1,3}[0-9oil〇]{2})[ \t]+([0-9oil〇]{3})(?![0-9a-z])/gi, '$1$2-$3')
    .split(/[^0-9A-Za-z〇｜|\-]+/);
  const out = new Set<string>();
  for (const piece of pieces) {
    const token = parseCardNumberToken(piece.replace(/^-+|-+$/g, ''));
    if (token) out.add(token);
  }
  return [...out];
}
