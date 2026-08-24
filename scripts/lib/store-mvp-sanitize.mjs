/**
 * store-mvp-sanitize.mjs — pure Store MVP data-asset sanitizer (DIC-908 / CR DIC-913).
 *
 * The in-app mapping filter (src/utils/cardReleaseFilter.ts) strips advanced fields
 * as cards cross into a Store MVP session. But the raw DATA ASSETS that ship or cross
 * the wire — the web export's dist/data/database.json and the recognize-card API
 * response bytes — must ALSO fail closed, or a Store MVP build still leaks buyPrice /
 * priceHistory / ytStats before the app ever maps them (CR DIC-913 blockers #1/#2).
 *
 * This module is the single choke point for that boundary. It is intentionally pure
 * (no react-native / expo / puppeteer imports) so it can be unit-verified in plain
 * Node and shared by the web-export post-build script and the regression tests. It
 * mirrors the exact field set removed by stripDisabledCardFields.
 */
import fs from 'fs';
import path from 'path';

/**
 * Advanced card-level fields hidden under Store MVP. Sale price stays.
 * `buyPriceHistory` is buy-back historical data (same feature group as buyPrice),
 * so it must fail closed too — CR DIC-913 flagged it shipping in the web artifact.
 */
export const FORBIDDEN_CARD_FIELDS = ['buyPrice', 'buyPriceHistory', 'priceHistory', 'ytStats'];

/** Buy-price fields stripped from each prices[] variant entry. Besides the price
 * itself, the per-version provenance stamped by merge-buy-prices.js
 * (buyPriceVersion / buyPriceSource / buyPriceTimestamp) is the same feature
 * group and must fail closed too — it would otherwise leak store buy-back data. */
export const FORBIDDEN_VARIANT_FIELDS = ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp'];

/**
 * Internal audit fields — canonicalisation bookkeeping the source of truth
 * keeps for provenance, but that MUST never ship to any user-visible payload,
 * whether Store MVP is on or off (DIC-1140 blocker #1). Adding a field here
 * makes every export path (native asset, full web copy, Store MVP web copy)
 * drop it in one edit.
 *
 * `_rawPricesArchive` is the pre-canonicalisation prices[] snapshot; every row
 * that carried `エラッタ前/後` in the source lives on this array. If it leaks,
 * shipped artifacts contain the very shop-history labels DIC-1139 hides.
 */
export const INTERNAL_AUDIT_FIELDS = ['_rawPricesArchive'];

/**
 * Resolve the Store MVP profile for a BUILD context (web export) from env.
 * Fail-closed opt-out is the only path to OFF; explicit opt-in is the only path
 * to ON. A build has no native platform, so anything unresolved preserves full
 * web production (matches releaseFlags.ts web branch). Native store builds do not
 * run this script (they use EAS), so their gating lives in releaseFlags.ts.
 */
export function resolveStoreMvpFromEnv(env = process.env) {
  const raw = typeof env.EXPO_PUBLIC_STORE_MVP === 'string'
    ? env.EXPO_PUBLIC_STORE_MVP.trim().toLowerCase()
    : '';
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return false;
}

/**
 * Strip internal audit / bookkeeping fields (DIC-1140). Runs on every export
 * path — Store MVP or not — because these fields represent source-maintenance
 * history the shipped product must never expose. Also strips them from each
 * prices[] entry for symmetry with future per-variant audit additions.
 */
export function stripInternalAuditFields(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  for (const field of INTERNAL_AUDIT_FIELDS) delete out[field];
  if (Array.isArray(out.prices)) {
    out.prices = out.prices.map((p) => {
      if (p && typeof p === 'object') {
        const rest = { ...p };
        for (const field of INTERNAL_AUDIT_FIELDS) delete rest[field];
        return rest;
      }
      return p;
    });
  }
  return out;
}

/**
 * Return a shallow clone of a single card entry with the forbidden advanced
 * fields removed (card-level buyPrice/priceHistory/ytStats and nested
 * prices[].buyPrice). Internal audit fields are stripped too (unconditional).
 * sellPrice and prices[].sellPrice are always preserved. Fail-closed: keys are
 * deleted, not nulled.
 */
export function stripForbiddenCardFields(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = stripInternalAuditFields(entry);
  for (const field of FORBIDDEN_CARD_FIELDS) delete out[field];
  if (Array.isArray(out.prices)) {
    out.prices = out.prices.map((p) => {
      if (p && typeof p === 'object') {
        const rest = { ...p };
        for (const field of FORBIDDEN_VARIANT_FIELDS) delete rest[field];
        return rest;
      }
      return p;
    });
  }
  return out;
}

/**
 * Sanitize a whole `{ cards: { key: entry } }` database object. Returns a new
 * object; the input is not mutated. Non-database shapes pass through untouched.
 * Applies BOTH the internal-audit strip and the Store MVP forbidden strip so
 * `sanitizeDatabase` alone is a safe transform for any shipped artifact.
 */
export function sanitizeDatabase(db) {
  if (!db || typeof db !== 'object' || !db.cards || typeof db.cards !== 'object') {
    return db;
  }
  const cards = {};
  for (const [key, entry] of Object.entries(db.cards)) {
    cards[key] = stripForbiddenCardFields(entry);
  }
  return { ...db, cards };
}

/**
 * Return a shipped-safe (non-Store-MVP) database: keeps buyPrice / priceHistory
 * / ytStats etc for full production but ALWAYS strips internal audit fields.
 * Used by the full web export path so `_rawPricesArchive` cannot ship.
 */
export function stripInternalAuditDatabase(db) {
  if (!db || typeof db !== 'object' || !db.cards || typeof db.cards !== 'object') {
    return db;
  }
  const cards = {};
  for (const [key, entry] of Object.entries(db.cards)) {
    cards[key] = stripInternalAuditFields(entry);
  }
  return { ...db, cards };
}

/**
 * Copy `source` database.json to `dest`. When `storeMvp` is true the shipped copy
 * is sanitized (forbidden fields stripped); otherwise only internal audit fields
 * are stripped so full web production keeps every real market field. This is the
 * exact code path the web-export post-build script uses, so tests can exercise
 * the real built-artifact boundary without a full `expo export`.
 */
export function copyDatabaseFile(source, dest, storeMvp) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = JSON.parse(fs.readFileSync(source, 'utf-8'));
  const shaped = storeMvp ? sanitizeDatabase(db) : stripInternalAuditDatabase(db);
  fs.writeFileSync(dest, JSON.stringify(shaped), 'utf-8');
  return { sanitized: !!storeMvp };
}
