/**
 * native-catalog-publish.mjs — publish the remote native catalog (2026-11-06).
 *
 * Produces, inside the web export (dist/), the files native clients read through
 * src/services/catalog/catalogRepository.ts:
 *
 *   data/catalog/v1/database.<sha256>.json      JSON.stringify(sanitizeDatabase(canonical))
 *   data/catalog/v1/series-names.<sha256>.json  JSON.stringify(series names)
 *   data/catalog/manifest.json                  written LAST, after both assets are
 *                                               written and read back byte-identical
 *
 * The database asset is ALWAYS sanitizeDatabase(canonical) — the exact transform
 * scripts/generate-native-database.mjs pins public/data/database.json to — whatever
 * EXPO_PUBLIC_STORE_MVP says for the web copy. Publication fails closed (throws, so
 * the build fails) if a forbidden or internal field would cross the boundary.
 *
 * The stable legacy URLs (/data/database.json, /data/series-names.json) are not
 * touched here; current web clients and the recognition backend keep using them.
 *
 * Times: `dataObservedAt` is the database's own lastUpdated (when the data was
 * observed); `publishedAt`/`sequence` are build metadata and never stand in for data
 * freshness. A rollback is published as a NEW, higher sequence that names older
 * content.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FORBIDDEN_CARD_FIELDS,
  FORBIDDEN_VARIANT_FIELDS,
  INTERNAL_AUDIT_FIELDS,
  sanitizeDatabase,
} from './store-mvp-sanitize.mjs';

export const MANIFEST_FORMAT = 'holohunter-native-catalog';
export const MANIFEST_SCHEMA_VERSION = 1;
export const MIN_CLIENT_SCHEMA = 1;
export const CATALOG_REL_DIR = path.join('data', 'catalog');
export const MANIFEST_REL_PATH = path.join('data', 'catalog', 'manifest.json');
/** Mirrors LIMITS in src/services/catalog/catalogContract.ts (pinned by test-remote-catalog-contract). */
export const CLIENT_LIMITS = {
  databaseBytes: 32 * 1024 * 1024,
  seriesNamesBytes: 512 * 1024,
  seriesNameEntries: 1000,
  maxCardCount: 50000,
};

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Throws if any card (or prices[] entry) still carries a forbidden/internal field. */
export function assertNativeCatalogSafe(db) {
  if (!db || typeof db !== 'object' || !db.cards || typeof db.cards !== 'object') {
    throw new Error('[native-catalog] database has no cards');
  }
  for (const [key, card] of Object.entries(db.cards)) {
    if (!card || typeof card !== 'object') throw new Error(`[native-catalog] card ${key} is not an object`);
    if (card.id !== key) throw new Error(`[native-catalog] card ${key} has id ${JSON.stringify(card.id)}`);
    if (card.prices != null && !Array.isArray(card.prices)) throw new Error(`[native-catalog] card ${key} prices is not an array`);
    for (const f of [...FORBIDDEN_CARD_FIELDS, ...INTERNAL_AUDIT_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(card, f)) throw new Error(`[native-catalog] card ${key} carries ${f}`);
    }
    for (const p of Array.isArray(card.prices) ? card.prices : []) {
      if (!p || typeof p !== 'object') continue;
      for (const f of [...FORBIDDEN_VARIANT_FIELDS, ...INTERNAL_AUDIT_FIELDS]) {
        if (Object.prototype.hasOwnProperty.call(p, f)) throw new Error(`[native-catalog] card ${key} prices[] carries ${f}`);
      }
    }
  }
}

/**
 * Pure: build the release (asset texts + manifest) from the canonical database
 * and the series-name map. `now` is build metadata only.
 */
export function buildNativeCatalogRelease({ canonical, seriesNames, now }) {
  if (typeof canonical?.lastUpdated !== 'string' || !Number.isFinite(Date.parse(canonical.lastUpdated))) {
    throw new Error('[native-catalog] canonical database has no valid lastUpdated observation time');
  }
  if (!seriesNames || typeof seriesNames !== 'object' || Array.isArray(seriesNames)
      || Object.values(seriesNames).some((v) => typeof v !== 'string') || Object.keys(seriesNames).length === 0) {
    throw new Error('[native-catalog] series names must be a non-empty string map');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('[native-catalog] invalid publish time');

  const sanitized = sanitizeDatabase(canonical);
  assertNativeCatalogSafe(sanitized);
  const databaseText = JSON.stringify(sanitized);
  const seriesNamesText = JSON.stringify(seriesNames);
  // Same bounds the client enforces (src/services/catalog/catalogContract.ts LIMITS):
  // a publish the client would reject must fail the build instead.
  const nameEntries = Object.entries(seriesNames);
  if (nameEntries.length > CLIENT_LIMITS.seriesNameEntries
      || nameEntries.some(([k, v]) => k.length > 64 || v.length > 200)) {
    throw new Error('[native-catalog] series names exceed client bounds');
  }
  if (Buffer.byteLength(databaseText, 'utf8') > CLIENT_LIMITS.databaseBytes) throw new Error('[native-catalog] database exceeds client size bound');
  if (Buffer.byteLength(seriesNamesText, 'utf8') > CLIENT_LIMITS.seriesNamesBytes) throw new Error('[native-catalog] series names exceed client size bound');
  if (Object.keys(sanitized.cards).length > CLIENT_LIMITS.maxCardCount) throw new Error('[native-catalog] card count exceeds client bound');
  const dbSha = sha256(databaseText);
  const namesSha = sha256(seriesNamesText);
  const databaseRel = path.posix.join('data', 'catalog', 'v1', `database.${dbSha}.json`);
  const namesRel = path.posix.join('data', 'catalog', 'v1', `series-names.${namesSha}.json`);

  const manifest = {
    format: MANIFEST_FORMAT,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    minClientSchema: MIN_CLIENT_SCHEMA,
    revision: `r-${dbSha.slice(0, 16)}-${namesSha.slice(0, 8)}`,
    sequence: now.getTime(),
    publishedAt: now.toISOString(),
    dataObservedAt: sanitized.lastUpdated,
    cardCount: Object.keys(sanitized.cards).length,
    assets: {
      database: { path: `/${databaseRel}`, bytes: Buffer.byteLength(databaseText, 'utf8'), sha256: dbSha },
      seriesNames: { path: `/${namesRel}`, bytes: Buffer.byteLength(seriesNamesText, 'utf8'), sha256: namesSha },
    },
  };
  return {
    manifest,
    assets: [
      { rel: databaseRel, text: databaseText, sha256: dbSha },
      { rel: namesRel, text: seriesNamesText, sha256: namesSha },
    ],
  };
}

function writeImmutable(absPath, text, expectedSha) {
  if (fs.existsSync(absPath)) {
    const existing = fs.readFileSync(absPath, 'utf8');
    if (sha256(existing) !== expectedSha) throw new Error(`[native-catalog] refusing to overwrite immutable asset ${absPath}`);
    return;
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, absPath);
}

/**
 * Write the release into `distDir`: assets first (verified by readback), the
 * manifest last, so a manifest never names an asset that is not completely there.
 */
export function publishNativeCatalog({ canonicalPath, seriesNamesPath, distDir, now = new Date() }) {
  const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  const seriesNames = JSON.parse(fs.readFileSync(seriesNamesPath, 'utf8'));
  const release = buildNativeCatalogRelease({ canonical, seriesNames, now });
  for (const asset of release.assets) {
    const abs = path.join(distDir, asset.rel);
    writeImmutable(abs, asset.text, asset.sha256);
    const back = fs.readFileSync(abs, 'utf8');
    if (sha256(back) !== asset.sha256) throw new Error(`[native-catalog] readback mismatch for ${asset.rel}`);
  }
  const manifestAbs = path.join(distDir, MANIFEST_REL_PATH);
  fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
  const tmp = `${manifestAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(release.manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, manifestAbs);
  return release.manifest;
}
