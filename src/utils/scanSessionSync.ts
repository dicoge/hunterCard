/**
 * The 估值清單 (scan session list) as it travels in the account-sync snapshot
 * (v41, 2026-10-17). Dependency-free: the server validator, the client store and
 * the Node tests share these types and limits.
 *
 * Compact on purpose — only what the list renders and prices with: the card's
 * identity / display fields and the listing prices captured at scan time. No photo,
 * no recognition data, no diagnostics. Deletion travels as `clearedAt` (the whole
 * list was cleared at that time) and as per-entry removal tombstones on the device
 * that removed them.
 */
export const MAX_SCAN_SESSION_ENTRIES = 300;
export const MAX_SCAN_PRICE_VERSIONS = 24;
export const MAX_SCAN_TEXT = 300;
export const MAX_SCAN_URL = 600;

export interface SyncScanCard {
  id: string;
  cardNumber: string;
  name: string;
  nameZh?: string;
  rarity?: string;
  series?: string;
  imageUrl?: string;
  sellPrice: number | null;
}

export interface SyncScanPriceVersion {
  name: string;
  printing: string;
  sellPrice: number | null;
  buyPrice: number | null;
}

export interface SyncScanEntry {
  instanceId: string;
  scannedAt: string;
  card: SyncScanCard;
  priceVersions: SyncScanPriceVersion[];
  selectedVersion: number;
  versionConfident: boolean;
  /** When the player last picked the version EXPLICITLY (ISO). Absent = never picked
   *  by hand (the scan's own resolution). Merge provenance: a later explicit pick wins
   *  over an older one or none, whichever side it is on (CR 2026-10-17). */
  selectedAt?: string;
}

export interface SyncScanSession {
  entries: SyncScanEntry[];
  /** The whole list was cleared at this time; entries scanned at or before it are gone. */
  clearedAt: string | null;
}

export const INSTANCE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function emptyScanSession(): SyncScanSession {
  return { entries: [], clearedAt: null };
}

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

/**
 * Which copy of the SAME scan wins in a merge (lists are passed server-first):
 *   1. the later explicit version pick (`selectedAt`) — a correction made on a stale
 *      device must survive the 409 against an older pick or none, and an unchanged
 *      copy never overrides a newer pick made elsewhere;
 *   2. no pick on either side, or the same pick time: a resolved version beats an
 *      unresolved one;
 *   3. still tied: the earlier list (the server's copy) stays.
 * Pick times come from device clocks: a device whose clock is far behind can lose a
 * genuinely newer pick (documented limitation, as for clearedAt).
 */
export function preferScanEntry(prev: SyncScanEntry, next: SyncScanEntry): SyncScanEntry {
  const a = ms(prev.selectedAt);
  const b = ms(next.selectedAt);
  if (a !== b) return b > a ? next : prev;
  if (!prev.versionConfident && next.versionConfident) return next;
  return prev;
}

/** The later of two clear times (null = never cleared). */
export function laterClear(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return ms(a) >= ms(b) ? a : b;
}

/**
 * Union two lists by instanceId (a scan is one physical scan on one device, so the
 * same id is the same scan), dropping entries removed by `removedAt` tombstones or
 * scanned at/before `clearedAt`. Sorted by scan time so both devices show one order.
 */
export function unionScanEntries(
  lists: SyncScanEntry[][],
  clearedAt: string | null,
  removedAt: Record<string, string> = {},
): SyncScanEntry[] {
  const byId = new Map<string, SyncScanEntry>();
  for (const list of lists) {
    for (const e of list) {
      if (!e || !INSTANCE_ID.test(e.instanceId)) continue;
      if (clearedAt && ms(e.scannedAt) <= ms(clearedAt)) continue;
      if (removedAt[e.instanceId]) continue;
      // Same scan on both sides: see preferScanEntry (newer explicit pick, then a
      // resolved version, then the server's copy).
      const prev = byId.get(e.instanceId);
      byId.set(e.instanceId, prev ? preferScanEntry(prev, e) : e);
    }
  }
  return [...byId.values()]
    .sort((a, b) => ms(a.scannedAt) - ms(b.scannedAt) || a.instanceId.localeCompare(b.instanceId))
    .slice(-MAX_SCAN_SESSION_ENTRIES);
}
