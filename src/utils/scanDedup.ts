/**
 * scanDedup — pure helpers for de-duplicating rapid repeat scans.
 *
 * Kept free of React / zustand / react-native imports so the logic can be
 * unit-verified in plain Node (see scripts/verify-scan-dedup.mjs).
 */

export interface DedupKeyInput {
  cardNumber?: string | null;
  id?: string | null;
  series?: string | null;
  rarity?: string | null;
}

/** Window during which the same card is treated as a repeat and skipped. */
export const SCAN_DEDUP_WINDOW_MS = 8000;

/** Identity of a scanned card for dedup purposes: cardNumber (or id) + series + rarity. */
export function dedupKey(card: DedupKeyInput): string {
  const num = (card.cardNumber || card.id || '').trim().toLowerCase();
  const series = (card.series || '').trim().toLowerCase();
  const rarity = (card.rarity || '').trim().toLowerCase();
  return `${num}|${series}|${rarity}`;
}

/**
 * True when `nextKey` matches the last-seen card and we are still inside the
 * dedup window. The window is measured from the last time the same card was
 * seen (add or blocked attempt), so a card held continuously in frame never
 * duplicates until it has been absent for `windowMs`.
 */
export function isDuplicateScan(
  lastKey: string | null,
  lastAt: number | null,
  nextKey: string,
  now: number,
  windowMs: number = SCAN_DEDUP_WINDOW_MS
): boolean {
  if (!lastKey || lastAt == null) return false;
  if (lastKey !== nextKey) return false;
  return now - lastAt < windowMs;
}
