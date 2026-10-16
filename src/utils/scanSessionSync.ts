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
      // Same scan on both sides: the copy with a resolved version wins (an explicit
      // pick is newer information than the default).
      const prev = byId.get(e.instanceId);
      if (!prev || (!prev.versionConfident && e.versionConfident)) byId.set(e.instanceId, e);
    }
  }
  return [...byId.values()]
    .sort((a, b) => ms(a.scannedAt) - ms(b.scannedAt) || a.instanceId.localeCompare(b.instanceId))
    .slice(-MAX_SCAN_SESSION_ENTRIES);
}
