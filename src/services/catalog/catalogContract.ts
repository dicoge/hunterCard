/**
 * Remote native catalog — wire contract and pure validation (2026-11-06).
 *
 * The native app ships a sanitized catalog in its bundle (public/data/database.json
 * + data/series-names.json). After this client version, a published catalog can
 * replace it without an App release: the web export publishes a small manifest
 * plus two immutable, content-addressed assets on the canonical production origin
 * (scripts/lib/native-catalog-publish.mjs, called from scripts/fix-html.js):
 *
 *   /data/catalog/manifest.json                              (written LAST)
 *   /data/catalog/v1/database.<sha256>.json                  JSON.stringify(sanitizeDatabase(canonical))
 *   /data/catalog/v1/series-names.<sha256>.json              JSON.stringify(series names)
 *
 * Everything here is pure (no react-native / expo / node imports) so the same
 * rules run on device, in Node tests, and mirror the publisher. Downloaded data
 * is DATA only: nothing here evaluates or loads code.
 *
 * Integrity, not authentication: the sha256 in the manifest proves the assets are
 * the bytes the manifest named and were not truncated or mixed; trust in the
 * manifest itself comes from HTTPS to the fixed production origin. A remote asset
 * that carries a forbidden field is REJECTED, never stripped — safe publication is
 * the publisher's job, and a payload that violates it is not used at all.
 */

/** Data-shape version this client understands. Bump only with a reviewed client change. */
export const CLIENT_CATALOG_SCHEMA = 1;
export const MANIFEST_FORMAT = 'holohunter-native-catalog';
export const MANIFEST_SCHEMA_VERSION = 1;
/** Fixed path on PRODUCTION_ORIGIN; there is no runtime override. */
export const MANIFEST_PATH = '/data/catalog/manifest.json';
export const ASSET_PATH_RE = /^\/data\/catalog\/v1\/(database|series-names)\.([0-9a-f]{64})\.json$/;
export const REVISION_RE = /^r-[0-9a-f]{16}-[0-9a-f]{8}$/;

export const LIMITS = {
  manifestBytes: 64 * 1024,
  databaseBytes: 32 * 1024 * 1024, // current sanitized asset is ~6.98 MB
  seriesNamesBytes: 512 * 1024,
  seriesNameEntries: 1000,
  maxCardCount: 50000,
};

/**
 * Mirrors scripts/lib/store-mvp-sanitize.mjs (FORBIDDEN_CARD_FIELDS,
 * FORBIDDEN_VARIANT_FIELDS, INTERNAL_AUDIT_FIELDS). scripts/test-remote-catalog-
 * contract.mjs fails if the two lists ever drift apart.
 */
export const FORBIDDEN_CARD_FIELDS = ['buyPrice', 'buyPriceHistory', 'priceHistory', 'ytStats', 'buyPriceRetained', 'buyLastKnown', 'buyPriorSource'] as const;
export const FORBIDDEN_VARIANT_FIELDS = ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp', 'buyPriceRetained', 'buyLastKnown'] as const;
export const INTERNAL_AUDIT_FIELDS = ['_rawPricesArchive', 'buyLastKnown', 'buyPriorSource'] as const;

export interface CatalogAssetRef {
  path: string;
  bytes: number;
  sha256: string;
}

export interface CatalogManifest {
  format: typeof MANIFEST_FORMAT;
  schemaVersion: number;
  minClientSchema: number;
  revision: string;
  /** Publish counter (build time in ms). A rollback is a NEW, higher sequence. */
  sequence: number;
  /** Build/publish metadata — never shown as data freshness. */
  publishedAt: string;
  /** Honest observation time of the data (database.lastUpdated). */
  dataObservedAt: string;
  cardCount: number;
  assets: { database: CatalogAssetRef; seriesNames: CatalogAssetRef };
}

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** UTF-8 byte length of a JS string (lone surrogates count as U+FFFD, 3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { bytes += 4; i += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function expectedRevision(databaseSha: string, seriesNamesSha: string): string {
  return `r-${databaseSha.slice(0, 16)}-${seriesNamesSha.slice(0, 8)}`;
}

function validateAssetRef(ref: unknown, kind: 'database' | 'series-names', maxBytes: number): Validation<CatalogAssetRef> {
  if (!isObj(ref)) return fail(`${kind}: missing asset`);
  const { path, bytes, sha256 } = ref;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return fail(`${kind}: bad sha256`);
  if (typeof path !== 'string') return fail(`${kind}: bad path`);
  const m = ASSET_PATH_RE.exec(path);
  if (!m || m[1] !== kind || m[2] !== sha256) return fail(`${kind}: path must be /data/catalog/v1/${kind}.<sha256>.json on the production origin`);
  if (!isPosInt(bytes) || bytes > maxBytes) return fail(`${kind}: size out of bounds`);
  return { ok: true, value: { path, bytes, sha256 } };
}

/**
 * Parse and validate a manifest. Rejects unknown formats, a schema this client
 * cannot read, assets off the fixed path shape (so no other origin or path can be
 * named), inconsistent revision ids and implausible counters.
 */
export function parseCatalogManifest(text: string): Validation<CatalogManifest> {
  if (typeof text !== 'string' || utf8ByteLength(text) > LIMITS.manifestBytes) return fail('manifest: size out of bounds');
  let raw: any;
  try { raw = JSON.parse(text); } catch { return fail('manifest: invalid JSON'); }
  if (!isObj(raw)) return fail('manifest: not an object');
  if (raw.format !== MANIFEST_FORMAT) return fail('manifest: unknown format');
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) return fail('manifest: unsupported schemaVersion');
  if (!isPosInt(raw.minClientSchema)) return fail('manifest: bad minClientSchema');
  if (raw.minClientSchema > CLIENT_CATALOG_SCHEMA) return fail('manifest: requires a newer client');
  if (!isPosInt(raw.sequence)) return fail('manifest: bad sequence');
  if (!isIso(raw.publishedAt)) return fail('manifest: bad publishedAt');
  if (!isIso(raw.dataObservedAt)) return fail('manifest: bad dataObservedAt');
  if (!isPosInt(raw.cardCount) || raw.cardCount > LIMITS.maxCardCount) return fail('manifest: bad cardCount');
  if (!isObj(raw.assets)) return fail('manifest: missing assets');
  const db = validateAssetRef(raw.assets.database, 'database', LIMITS.databaseBytes);
  if (!db.ok) return db;
  const names = validateAssetRef(raw.assets.seriesNames, 'series-names', LIMITS.seriesNamesBytes);
  if (!names.ok) return names;
  if (typeof raw.revision !== 'string' || !REVISION_RE.test(raw.revision)
      || raw.revision !== expectedRevision(db.value.sha256, names.value.sha256)) {
    return fail('manifest: revision does not match its assets');
  }
  return {
    ok: true,
    value: {
      format: MANIFEST_FORMAT,
      schemaVersion: raw.schemaVersion,
      minClientSchema: raw.minClientSchema,
      revision: raw.revision,
      sequence: raw.sequence,
      publishedAt: raw.publishedAt,
      dataObservedAt: raw.dataObservedAt,
      cardCount: raw.cardCount,
      assets: { database: db.value, seriesNames: names.value },
    },
  };
}

/** First forbidden/internal field found on a card or one of its prices[] entries. */
export function findForbiddenField(card: Record<string, any>): string | null {
  for (const f of [...FORBIDDEN_CARD_FIELDS, ...INTERNAL_AUDIT_FIELDS]) {
    if (Object.prototype.hasOwnProperty.call(card, f)) return f;
  }
  if (Array.isArray(card.prices)) {
    for (const p of card.prices) {
      if (!isObj(p)) continue;
      for (const f of [...FORBIDDEN_VARIANT_FIELDS, ...INTERNAL_AUDIT_FIELDS]) {
        if (Object.prototype.hasOwnProperty.call(p, f)) return `prices[].${f}`;
      }
    }
  }
  return null;
}

/**
 * Validate a parsed catalog database before it is persisted or used. Fails
 * closed on any forbidden field, a card count other than the manifest's, a
 * row whose id is not its key, or an observation time that disagrees with the
 * manifest.
 */
export function validateCatalogDatabase(
  db: unknown,
  expect: { cardCount: number; dataObservedAt: string; minCardCount: number },
): Validation<Record<string, any>> {
  if (!isObj(db) || !isObj(db.cards)) return fail('database: missing cards');
  const entries = Object.entries(db.cards);
  if (entries.length !== expect.cardCount) return fail('database: card count differs from manifest');
  if (entries.length < expect.minCardCount) return fail('database: implausibly small catalog');
  if (db.lastUpdated !== expect.dataObservedAt) return fail('database: observation time differs from manifest');
  for (const [key, card] of entries) {
    if (!isObj(card)) return fail('database: card is not an object');
    if (card.id !== key) return fail('database: card id differs from its key');
    if (card.prices != null && !Array.isArray(card.prices)) return fail('database: prices is not an array');
    const forbidden = findForbiddenField(card);
    if (forbidden) return fail(`database: forbidden field ${forbidden}`);
  }
  return { ok: true, value: db };
}

export function validateSeriesNames(names: unknown): Validation<Record<string, string>> {
  if (!isObj(names)) return fail('series-names: not an object');
  const entries = Object.entries(names);
  if (entries.length === 0 || entries.length > LIMITS.seriesNameEntries) return fail('series-names: entry count out of bounds');
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || k.length > 64 || v.length > 200) return fail('series-names: bad entry');
  }
  return { ok: true, value: names as Record<string, string> };
}
