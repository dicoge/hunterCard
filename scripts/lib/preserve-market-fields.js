/**
 * preserve-market-fields.js — signature-based market-field preservation across
 * canonical printing-ID rebuilds (DIC-1204).
 *
 * Background. `scripts/build-database.js` and `scripts/sync-official-catalog-to-database.mjs`
 * both look up the previous database row by exact card id when they need to
 * carry proven market data forward into the freshly rebuilt row. DIC-1084's
 * printing-ID canonicalization renames existing printings (e.g. `hSD03-011_hSD03`
 * → `hSD03-011_hSD03_U_hSD03-011_U`), so the exact-id lookup misses every
 * renamed row and the freshly rebuilt DB ships with sellPrice/priceHistory/
 * ytStats emptied out. That is the shipped DIC-1204 regression the market-
 * fields test caught on main.
 *
 * Preservation contract (issue-owner spec, kept fail-closed):
 *   - Same exact card id wins first (bit-for-bit compatible with prior behaviour).
 *   - When the id has been renamed, fall back to a **strict** signature match:
 *     `cardNumber | sourceProduct | rarity` MUST all match, non-empty on both
 *     sides. Ambiguous signatures (multiple previous rows collapsing onto the
 *     same signature — the DIC-1013 case) are dropped rather than picked from,
 *     so no cross-printing or cross-rarity leakage can occur.
 *   - Only carry forward proven market payload; never a saved `sellPrice: null`
 *     over a freshly proven yuyu price. Freshly written non-null fields on the
 *     current card always win.
 *
 * Pure module, no filesystem or network access; both build-database.js and
 * sync-official-catalog-to-database.mjs import from here.
 */

function toStr(value) {
  return value == null ? '' : String(value).trim();
}

function cardSignatureParts(card) {
  return {
    cardNumber: toStr(card?.cardNumber),
    sourceProduct: toStr(card?.sourceProduct || card?.series || card?.expansion),
    rarity: toStr(card?.rarity),
  };
}

/**
 * Origin-product prefix of a cardNumber. `hBP04-028` → `hBP04`,
 * `hEB01-001` → `hEB01`, `hPR-014` → `hPR`. Returns '' when the input is
 * unparsable so the caller treats it as "no prefix match" (never wildcard).
 */
export function cardNumberOriginPrefix(cardNumber) {
  const m = String(cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
  return m ? m[1] : '';
}

/**
 * A "reprint row" is a printing whose sourceProduct differs from the origin-
 * product prefix of its cardNumber — hBP04-028 shipped in hBP08 as a reprint,
 * hBP02-026 shipped in hCO01 as a reprint, etc. Reprint rows are the exact
 * pool where cross-product price-history contamination surfaced (DIC-1219):
 * DIC-1204's seed script wrote origin-product records into these rows'
 * canonical-ID history files and every subsequent build cycle carried them
 * forward. Unstamped legacy records on a reprint row cannot be proven to
 * belong to the reprint printing, so we treat them as unverified.
 */
export function isReprintRow(card) {
  const prefix = cardNumberOriginPrefix(card?.cardNumber);
  const source = String(card?.sourceProduct || card?.series || '');
  if (!prefix || !source) return false;
  return prefix !== source;
}

/**
 * DIC-1219 provenance stamp for a durable price-history record. Every record
 * written from `scripts/build-database.js` Step 5 carries this stamp so a
 * later Step 6 read (or a preservation copy-over) can prove the record was
 * produced under this exact printing's yuyu listing rather than a cross-
 * product base's history that a seed script accidentally wrote onto this
 * canonical-ID file. Existing records without the stamp are treated as
 * unverified: origin-product rows grandfather them in (their durable files
 * are structurally clean), reprint rows drop them (their unstamped payload
 * was seeded from cross-product base data).
 */
export function stampHistoryRecord(record, card) {
  const sp = toStr(card?.sourceProduct || card?.series);
  if (!record || !sp) return record;
  return { ...record, sourceProduct: sp };
}

/**
 * DIC-1227: extract the yuyu-tei product path from a `yuyuImage` URL so the
 * caller can prove the previous row's yuyu payload actually belongs to the
 * current row's `sourceProduct`. Returns the lowercased path segment
 * (e.g. `hbp08`, `heb01`, `promo-hbp10`) or '' when the URL cannot be parsed.
 *
 * DIC-1227 CR follow-up hardening (rev.3): fail-closed on lookalike
 * hostnames like `evil-yuyu-tei.jp`, malformed / opaque URLs, and missing
 * imageUrl values. Uses the URL parser and asserts host equals exactly
 * `card.yuyu-tei.jp`, protocol is https/http, and the path matches the
 * shipped `/hocg/{size}/{product}/{filename}.{ext}` shape (product path
 * segment is at least one alphanumeric or hyphenated token). Any deviation
 * returns '' so the caller fails closed.
 */
// DIC-1227 CR rev.5: parse a raw yuyuImage URL into a normalised { product,
// pathname } record, or `null` when the URL fails any of the hardened
// checks (host, protocol, path shape, extension). The product path is
// lowercased; the pathname is preserved case as-shipped so canonical
// identity keys can distinguish {product}/10008.jpg vs 10009.jpg.
function parseYuyuImage(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname.toLowerCase() !== 'card.yuyu-tei.jp') return null;
  // DIC-1227 CR rev.6: accept ONLY the protocol default port (URL API
  // normalises https://…:443/… and http://…:80/… to `port === ''`). Any
  // non-default (`https://…:444/…`, `http://…:8080/…`) or protocol-
  // mismatched (`http://…:443/…`, `https://…:80/…`) port survives as an
  // explicit `parsed.port` string — those MUST fail closed before
  // canonicalYuyuImageIdentity strips the port, otherwise a spoofed URL
  // collides with and poisons a valid hPR row (Mac-Codex CR flagged this
  // exact bypass class on rev.5 head 628372a5).
  if (parsed.port !== '') return null;
  const m = parsed.pathname.match(/^\/hocg\/[A-Za-z0-9_]+\/([A-Za-z0-9-]+)\/[A-Za-z0-9-]+\.(jpg|jpeg|png|webp)$/i);
  if (!m) return null;
  return { product: m[1].toLowerCase(), pathname: parsed.pathname };
}

/**
 * DIC-1227: extract the yuyu-tei product path from a `yuyuImage` URL so the
 * caller can prove the previous row's yuyu payload actually belongs to the
 * current row's `sourceProduct`. Returns the lowercased path segment
 * (e.g. `hbp08`, `heb01`, `promo-hbp10`) or '' when the URL cannot be parsed.
 *
 * DIC-1227 CR follow-up hardening (rev.3): fail-closed on lookalike
 * hostnames like `evil-yuyu-tei.jp`, malformed / opaque URLs, and missing
 * imageUrl values. Uses the URL parser and asserts host equals exactly
 * `card.yuyu-tei.jp`, protocol is https/http, and the path matches the
 * shipped `/hocg/{size}/{product}/{filename}.{ext}` shape (product path
 * segment is at least one alphanumeric or hyphenated token). Any deviation
 * returns '' so the caller fails closed.
 */
export function yuyuImageProductPath(url) {
  const parsed = parseYuyuImage(url);
  return parsed ? parsed.product : '';
}

/**
 * DIC-1227 CR rev.5: canonical physical identity for a yuyuImage URL, used
 * exclusively by `findAmbiguousPromoRowIds` to detect collisions across
 * distinct hPR rows for the same cardNumber. The validation layer accepts
 * HTTP/HTTPS, mixed-case host, default ports, query strings, and fragments;
 * two rows can therefore reference the same physical yuyu-tei image under
 * different raw yuyuImage strings and evade a naïve string-grouping check.
 *
 * Returns a normalised identity of the form `card.yuyu-tei.jp{pathname}`
 * (scheme dropped, host lowercased to the canonical apex, port dropped,
 * query and fragment stripped) or '' when the URL fails validation. Any
 * two URLs pointing at the same physical yuyu-tei image collapse to the
 * same identity; anything that fails validation returns '' so the caller
 * treats it as "no identity" (an empty-string identity is skipped by
 * `findAmbiguousPromoRowIds` — cannot collide with anything).
 */
export function canonicalYuyuImageIdentity(url) {
  const parsed = parseYuyuImage(url);
  if (!parsed) return '';
  return `card.yuyu-tei.jp${parsed.pathname}`;
}

/**
 * DIC-1227 CR follow-up rev.3: the known set of promo pack yuyu-tei subpaths.
 * `promo-hbp10` etc. are legit (yuyu-tei hosts hPR promo pack images under
 * these paths). Arbitrary `promo-*` values must fail closed — a URL like
 * `/promo-foo/…` where `foo` is not a real promo pack is unverified provenance.
 * The list is derived from the shipped data and PM's evidence; any new promo
 * pack must be added here explicitly, otherwise the daily scrape will fail
 * closed and surface it.
 */
const KNOWN_PROMO_PATHS = new Set([
  // DIC-1227 CR follow-up rev.4: the known set of promo pack yuyu-tei
  // subpaths present in the shipped Yuyu catalog. Each corresponds to a
  // real hPR promo pack that hosts card images at yuyu-tei's
  // `/hocg/{size}/promo-{code}/` path. Adding a new entry here is
  // deliberate: an unknown promo path must fail closed so a daily scrape
  // hitting a new pack surfaces the change rather than silently accepting
  // arbitrary values.
  //   - `promo-hbp10` — Basic PR Pack Vol.1 / エントリーPRパック vol.3
  //   - `promo-hsd10` — hSD10 (Start Deck) PR pack
  //   - `promo-hbd20` — hBD24–hBD30 (Birthday event PR) — added after
  //     Mac-Codex CR flagged 48 unique official hPR rows (incl.
  //     hBD24-008_hPR_P_hBD24-008_P) losing their /promo-hbd20/ listings.
  'promo-hbp10',
  'promo-hsd10',
  'promo-hbd20',
]);

function isKnownPromoPath(urlProd) {
  return KNOWN_PROMO_PATHS.has(urlProd);
}

/**
 * DIC-1227 provenance gate for the yuyu-derived preservation payload
 * (`sellPrice`, `prices`, `yuyuName`, `yuyuImage`, `timestamp`, `priceHistory`,
 * `priceHistoryMeta`, `_rawPricesArchive`). The previous row's `yuyuImage`
 * URL product path MUST match the current row's `sourceProduct` before any of
 * those fields can be carried forward — otherwise the current row is a
 * different printing than the one that produced the yuyu listing (Mac-Codex CR
 * flagged `hBP01-090_hPR_P_hBP01-090_P_02` inheriting `sellPrice=30` +
 * `yuyuName="ムーナ・ホシノヴァ(hEB01)"` + `yuyuImage=/heb01/…` onto an hPR
 * promo, because the pre-fix scrape had matched cross-product yuyu entries
 * onto its ancestor row and every subsequent preservation cycle propagated
 * it forward).
 *
 * Special cases:
 *   - promo-* yuyu-tei product paths legitimately belong to hPR (yuyu-tei
 *     hosts promo pack images under /promo-{pack}/), so promo-* matches
 *     sourceProduct === 'hpr'.
 *   - A missing / unparseable yuyuImage fails the gate: unverified
 *     provenance can never carry forward yuyu payload.
 */
export function yuyuPayloadMatchesSource(previous, currentSourceProduct) {
  const urlProd = yuyuImageProductPath(previous?.yuyuImage);
  const src = String(currentSourceProduct || '').toLowerCase();
  if (!urlProd || !src) return false;
  if (urlProd === src) return true;
  if (isKnownPromoPath(urlProd) && src === 'hpr') return true;
  return false;
}

/**
 * DIC-1227 CR follow-up: match a single yuyu prices[] / _rawPricesArchive[]
 * entry against a target sourceProduct. Same URL-product-path rule and
 * promo-*-to-hPR carve-out as `yuyuPayloadMatchesSource`, but applied to the
 * per-entry `imageUrl` so a row with a wrong TOP-LEVEL yuyuImage can still
 * keep the individual entries whose provenance is provable (Mac-Codex CR
 * flagged: hBP01-048_hPR_P_hBP01-048_P had a valid ¥980 /promo-hbp10/
 * entry inside prices[] that my previous top-level-only clean erased).
 */
// DIC-1227 CR follow-up carve-out: yuyu-tei classifies some cards under
// yuyu-scraper aliases (`ent07` = Entry Pack Vol. 7, etc.) that are NOT
// official product codes. Their yuyuImage URLs point to whatever product
// path yuyu-tei has for the card (often /hbp04/, /hbp01/, …). We can't
// prove cross-product on those rows because the sourceProduct itself is
// the yuyu-scraper's aggregation label. Filter passes any URL for them —
// the filter still fails-closed on rows whose sourceProduct IS an
// official product (hBP01…hSD19, hEB01, hPR, hCO01, hWF01, hCS01,
// hPC01, hSD2025summer, hYS01).
const NON_OFFICIAL_SOURCE_PRODUCTS = new Set(['ent07']);

// DIC-1227 CR follow-up: hPR is a PROMO product — its rows represent standalone
// entry-pack/promo listings, not "variant reprints of a base card". A promo
// row that has no /hpr/ or /promo-*/ listing must fail-closed fully
// (PM: keep hBP01-090_hPR_P_hBP01-090_P_02 fully null/empty). Non-promo
// products like hBP04, hBP08 host reprints of an earlier product's card and
// their prices[] legitimately aggregates the base printing (a /hbp02/ BASE
// entry inside a hBP04 reprint row shows the base printing that the same
// cardNumber originated from), so those rows may keep entries whose URL
// path is the cardNumber's origin prefix in addition to their own
// sourceProduct.
const PROMO_STYLE_SOURCE_PRODUCTS = new Set(['hpr']);

function cardNumberOriginPrefixLower(cardNumber) {
  const m = String(cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
  return m ? m[1].toLowerCase() : '';
}

export function pricesEntryMatchesSource(entry, currentSourceProduct, currentCardNumber = null) {
  const src = String(currentSourceProduct || '').toLowerCase();
  if (!src) return false;
  // DIC-1227 CR follow-up rev.4: even non-official sourceProduct rows
  // (`ent07`) MUST have a parseable yuyu-tei image URL. A committed
  // hBP01-051_ent07 fixture ships an entry with
  // `https://card.yuyu-tei.jp/noimage_100_140.jpg` (yuyu's placeholder for
  // no-image-available), which is not a valid /hocg/{size}/{product}/…
  // image URL. The strict-parse check must fire BEFORE the ent07 pass so
  // malformed/no-image entries never enter prices[] or _rawPricesArchive.
  const urlProd = yuyuImageProductPath(entry?.imageUrl);
  if (!urlProd) return false;
  if (NON_OFFICIAL_SOURCE_PRODUCTS.has(src)) return true;
  if (urlProd === src) return true;
  if (isKnownPromoPath(urlProd) && src === 'hpr') return true;
  // Reprint carve-out (non-promo sourceProduct only): allow the entry whose
  // URL matches the cardNumber's origin-product prefix. This keeps a
  // /hbp02/ BASE entry on a `hBP02-084_hBP04_SR` reprint row so deck
  // aggregation still finds the base printing for the cardNumber. Promo
  // products (hPR) stay strict — they never inherit the base printing's
  // listing, which is what makes hBP01-090_hPR_P fully null when no
  // /hpr/ or /promo-*/ entry exists.
  if (currentCardNumber && !PROMO_STYLE_SOURCE_PRODUCTS.has(src)) {
    const originPrefix = cardNumberOriginPrefixLower(currentCardNumber);
    if (originPrefix && urlProd === originPrefix) return true;
  }
  return false;
}

/**
 * DIC-1227 CR follow-up rev.3: detect hPR rows that share a yuyu image URL
 * across DISTINCT hPR printings of the same cardNumber. A single yuyu
 * listing represents exactly one physical printing; if the DB has two
 * hPR rows (e.g. `hSD03-002_hPR_P_hSD03-002_P` and
 * `hSD03-002_hPR_P_hSD03-002_P_2`) both claiming the same
 * `/promo-hbp10/10020.jpg` URL, we cannot prove either row's provenance —
 * fail-closed on both.
 *
 * Takes a cards map (id → card). Returns a Set of card ids whose top-level
 * yuyu payload (sellPrice, yuyuName, yuyuImage, timestamp, priceHistory,
 * priceHistoryMeta, prices[], _rawPricesArchive) must be nulled because
 * their yuyuImage collides with another hPR row for the same cardNumber.
 *
 * DIC-1227 CR rev.5: group collisions by `canonicalYuyuImageIdentity`
 * (physical identity) rather than the raw yuyuImage string. Two rows can
 * reference the same physical yuyu-tei image under different raw URL
 * strings — https vs http, mixed-case host, default port, query string,
 * fragment — and the previous rev.4 raw-string grouping missed all of
 * those aliases. Any URL that fails the hardened validator returns ''
 * from the identity function and is skipped (an empty identity cannot
 * collide with anything else, so unverifiable URLs never mask a real
 * collision).
 */
export function findAmbiguousPromoRowIds(cards) {
  const bad = new Set();
  if (!cards || typeof cards !== 'object') return bad;
  const groupedByCardNumberAndIdentity = new Map();
  for (const [id, card] of Object.entries(cards)) {
    const sp = String(card?.sourceProduct || card?.series || '').toLowerCase();
    if (sp !== 'hpr') continue;
    const cardNumber = String(card?.cardNumber || '');
    if (!cardNumber) continue;
    const identity = canonicalYuyuImageIdentity(card?.yuyuImage);
    if (!identity) continue;
    const key = `${cardNumber}\x00${identity}`;
    if (!groupedByCardNumberAndIdentity.has(key)) groupedByCardNumberAndIdentity.set(key, []);
    groupedByCardNumberAndIdentity.get(key).push(id);
  }
  for (const [, ids] of groupedByCardNumberAndIdentity) {
    if (ids.length > 1) {
      for (const id of ids) bad.add(id);
    }
  }
  return bad;
}

/**
 * DIC-1229 default freshness window for `hasCurrentPriceProvenance` — a row
 * whose `timestamp` has not been refreshed within this many milliseconds is
 * treated as unproven. Set to 7 days: the daily yuyu scrape refreshes every
 * scraped row's timestamp, so a 7-day gap means the pipeline has been down
 * for a full week and any surviving scalar/entry price on such a row is
 * "stale" in the CR-flagged sense. Callers can override via
 * `options.maxAgeMs` (tests use it for deterministic time-travel).
 */
export const DIC1229_MAX_TIMESTAMP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * DIC-1229 CR rev.2 — a row has "current exact-print price provenance" only
 * when every one of the following holds:
 *   1. **non-ambiguity** — the row is NOT in the caller-supplied ambiguous
 *      set (`options.ambiguousIds`, produced by `findAmbiguousPromoRowIds`).
 *      Two hPR rows for one cardNumber sharing a canonical yuyu-tei image
 *      identity cannot both prove provenance, so the ambiguity contract from
 *      DIC-1227 rev.3 is inherited here.
 *   2. **fresh timestamp** — `card.timestamp` parses and lies within
 *      `options.maxAgeMs` of `options.now` (defaults: `Date.now()` and
 *      `DIC1229_MAX_TIMESTAMP_AGE_MS`). Missing / unparseable / older
 *      timestamps fail closed. This is the "stale scalar" case the Mac-Codex
 *      rev.2 CR flagged — a positive `sellPrice` alone is not proof if the
 *      row hasn't been refreshed for a full scrape cycle.
 *   3. **exact printing + lawful yuyu-tei image + source-product match** —
 *      either the ROW-level payload (positive `sellPrice` AND top-level
 *      `yuyuImage` passing `yuyuPayloadMatchesSource`) OR at least one
 *      `prices[]` entry (positive `entry.sellPrice` AND `entry.imageUrl`
 *      passing `pricesEntryMatchesSource`) proves the row's own printing.
 *      Any positive scalar whose URL fails `parseYuyuImage` (evil host,
 *      wrong protocol, non-default port, no /hocg/{size}/{product}/ shape)
 *      or whose product path doesn't match the row's `sourceProduct` (the
 *      "cross-printing /heb01/" case) fails closed here.
 *
 * When any of (1)–(3) fails the row is unproven — `card.priceHistory` and
 * any durable record surviving on such a row are stale cross-provenance
 * data (the shipped shape Mac-Codex flagged: `hBP01-090_hPR_P_hBP01-090_P_02`
 * with `sellPrice:null`, `prices:[]`, `yuyuImage:""` yet
 * `priceHistory={"2026-08-28":30}` from a record whose stamp
 * `sourceProduct:"hPR"` alone passed the DIC-1219 record filter). Callers
 * use this helper as the gate before merging durable history back onto a
 * row and as the audit predicate that fails-closes the build if any row
 * ships priceHistory without it.
 *
 * @param {object} card
 * @param {{ ambiguousIds?: Set<string>|null, now?: number, maxAgeMs?: number }} [options]
 * @returns {boolean}
 */
export function hasCurrentPriceProvenance(card, options = {}) {
  if (!card || typeof card !== 'object') return false;

  const ambiguousIds = options.ambiguousIds || null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : DIC1229_MAX_TIMESTAMP_AGE_MS;

  // (1) Non-ambiguity — an hPR row that shares a canonical yuyu-tei image
  // identity with another hPR row for the same cardNumber cannot prove
  // provenance on either side. Callers pass the set produced by
  // `findAmbiguousPromoRowIds`; when absent (unit tests / callers that
  // haven't computed it) we skip this rule rather than fail-open silently.
  if (ambiguousIds && card.id && ambiguousIds.has(card.id)) return false;

  const sourceProduct = toStr(card.sourceProduct || card.series);
  if (!sourceProduct) return false;

  // (2) Freshness — the row's own `timestamp` must parse AND lie within
  // maxAgeMs of `now`. `Date.parse` returns NaN for missing / malformed
  // strings; `Number.isFinite(NaN)` is false, so the gate fails closed.
  const timestampMs = Date.parse(toStr(card.timestamp));
  if (!Number.isFinite(timestampMs)) return false;
  if (now - timestampMs > maxAgeMs) return false;

  // (3) Exact-printing + lawful yuyu image + source-product match. Either
  // path (top-level or entry-level) is sufficient — the row-level payload
  // proves the whole row, or at least one prices[] entry proves it. Both
  // paths reuse the DIC-1227 hardened validators (parseYuyuImage host /
  // protocol / port / path shape + sourceProduct match + promo carve-out).
  if (Number.isFinite(card.sellPrice) && card.sellPrice > 0
      && yuyuPayloadMatchesSource(card, sourceProduct)) {
    return true;
  }
  if (!Array.isArray(card.prices)) return false;
  return card.prices.some((entry) => (
    entry
    && Number.isFinite(entry.sellPrice)
    && entry.sellPrice > 0
    && pricesEntryMatchesSource(entry, sourceProduct, card.cardNumber)
  ));
}

/**
 * DIC-1227 CR follow-up entry-by-entry filter for prices[] and
 * _rawPricesArchive[]. Returns the entries whose imageUrl product path
 * matches the current row's sourceProduct (with the same
 * promo-*-to-hPR carve-out). A row whose top-level yuyuImage points to a wrong product
 * can therefore keep its provable per-entry provenance instead of losing
 * the whole payload.
 */
export function filterProvenanceMatchedPriceEntries(entries, currentSourceProduct, currentCardNumber = null) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => pricesEntryMatchesSource(entry, currentSourceProduct, currentCardNumber));
}

/**
 * DIC-1227 CR follow-up: derive TOP-LEVEL yuyu fields (sellPrice, yuyuName,
 * yuyuImage, timestamp) from a set of surviving prices[] entries. Same shape
 * as build-database.js's fresh-loop derivation so a preserved row that only
 * keeps a subset of provable entries lands with consistent top-level fields
 * — never mixing a rejected entry's image with a surviving entry's price.
 * Callers pass `previousTimestamp` so a surviving-entries payload can
 * inherit the prior scrape's timestamp for the whole row (the entries
 * themselves rarely carry per-entry timestamps).
 */
export function deriveTopLevelFromEntries(entries, previousTimestamp = '') {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  if (list.length === 0) {
    return { sellPrice: null, yuyuName: '', yuyuImage: '', timestamp: '' };
  }
  let lowestPrice = null;
  let lowestName = '';
  for (const entry of list) {
    const p = Number(entry.sellPrice);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (lowestPrice === null || p < lowestPrice) {
      lowestPrice = p;
      lowestName = String(entry.name || '');
    }
  }
  // Prefer the image of the row that supplied the lowest price; otherwise
  // fall back to the first entry with an imageUrl.
  const cheapest = list.find((e) => Number(e.sellPrice) === lowestPrice && (e.name || '') === lowestName);
  const derivedImage = String(cheapest?.imageUrl || list.find((e) => e.imageUrl)?.imageUrl || '');
  return {
    sellPrice: lowestPrice,
    yuyuName: lowestName,
    yuyuImage: derivedImage,
    timestamp: previousTimestamp || '',
  };
}

/**
 * Provenance filter for durable price-history records. Returns the records
 * safe to merge onto `card` under the DIC-1219 fail-closed contract:
 *   - Stamped records survive only when `sourceProduct` equals the card's
 *     current sourceProduct.
 *   - Unstamped legacy records survive only on origin-product rows (where
 *     the row's own sourceProduct equals the cardNumber's origin prefix);
 *     reprint rows drop them because DIC-1204's seed script wrote origin-
 *     product base records onto reprint canonical-ID files.
 * The rule is deliberately structural — it never inspects prices or dates —
 * so a mutation that flattens either arm (e.g. "always keep unstamped
 * records" OR "always keep stamped records") is immediately caught by the
 * DIC-1219 mutation test.
 */
/**
 * DIC-1229 rev.2: pure audit — returns the list of violating card ids
 * where `card.priceHistory` is non-empty AND `hasCurrentPriceProvenance`
 * returns false. `build-database.js` and the regression tests both use
 * this so mutation-sensitivity is enforceable at the unit layer: any
 * weakening of the predicate (or of the audit itself) shows up on the
 * returned array. Empty array means the invariant holds. Options are the
 * SAME shape as `hasCurrentPriceProvenance` (ambiguousIds / now /
 * maxAgeMs); the audit derives ambiguousIds when the caller omits them
 * so a bare `findUnprovenPriceHistoryViolations(cards)` call still holds
 * the full contract.
 *
 * @param {Object<string, object>} cards
 * @param {{ ambiguousIds?: Set<string>|null, now?: number, maxAgeMs?: number }} [options]
 * @returns {Array<{ id: string, dayCount: number }>}
 */
export function findUnprovenPriceHistoryViolations(cards, options = {}) {
  const violations = [];
  if (!cards || typeof cards !== 'object') return violations;
  const gateOptions = {
    ...options,
    ambiguousIds: options.ambiguousIds ?? findAmbiguousPromoRowIds(cards),
  };
  for (const [id, card] of Object.entries(cards)) {
    const ph = card?.priceHistory;
    if (!ph || typeof ph !== 'object') continue;
    const dayCount = Object.keys(ph).length;
    if (dayCount === 0) continue;
    if (!hasCurrentPriceProvenance(card, gateOptions)) {
      violations.push({ id, dayCount });
    }
  }
  return violations;
}

export function filterProvenanceMatchedRecords(records, card) {
  if (!Array.isArray(records)) return [];
  const currentSource = toStr(card?.sourceProduct || card?.series);
  const cardIsReprint = isReprintRow(card);
  return records.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    const stamp = toStr(record.sourceProduct);
    if (stamp) return stamp === currentSource;
    return !cardIsReprint;
  });
}

/**
 * Strict signature used for signature-based fallback. All three tokens must be
 * present. When any token is missing we return null so the row is not indexed
 * — an under-specified signature must never provide a match.
 */
export function cardSignature(card) {
  const { cardNumber, sourceProduct, rarity } = cardSignatureParts(card);
  if (!cardNumber || !sourceProduct || !rarity) return null;
  return `${cardNumber}|${sourceProduct}|${rarity}`;
}

/**
 * Build the preservation index over the previous database's cards map.
 * Ambiguous signatures (>1 previous row) are marked ambiguous so the lookup
 * refuses to guess between them.
 */
export function buildPreservationIndex(prevCards) {
  const byId = new Map();
  const bySignature = new Map();
  if (!prevCards || typeof prevCards !== 'object') return { byId, bySignature };
  for (const [id, card] of Object.entries(prevCards)) {
    if (!card || typeof card !== 'object') continue;
    byId.set(String(id), card);
    const sig = cardSignature(card);
    if (!sig) continue;
    const existing = bySignature.get(sig);
    if (existing) {
      existing.ambiguous = true;
      existing.cards.push(card);
    } else {
      bySignature.set(sig, { ambiguous: false, cards: [card] });
    }
  }
  return { byId, bySignature };
}

/**
 * Return the previous row whose market fields should be carried onto
 * `currentCard` (identified by `currentId`), or `null` when nothing safely
 * matches. Exact-id wins over signature; ambiguous signatures refuse.
 * Also returns a `matchKind` describing which lookup strategy hit so the
 * caller can gate copy-out of printing-specific arrays (prices[] and the
 * raw yuyu archive) on an exact-id match. When the id has been renamed by
 * canonicalization, the fresh row's canonicalization decisions (e.g. the
 * DIC-1013/1140 signed-printing empty-prices contract) must not be
 * overridden by a bulk copy of the old row's arrays.
 */
export function findPreservedRow(index, currentId, currentCard) {
  const match = findPreservedMatch(index, currentId, currentCard);
  return match ? match.card : null;
}

export function findPreservedMatch(index, currentId, currentCard) {
  if (!index) return null;
  const exact = index.byId?.get(String(currentId));
  if (exact) return { card: exact, matchKind: 'exact-id' };
  const sig = cardSignature(currentCard);
  if (!sig) return null;
  const hit = index.bySignature?.get(sig);
  if (!hit || hit.ambiguous) return null;
  return { card: hit.cards[0] || null, matchKind: 'signature' };
}

/**
 * Extract the market payload we want to carry forward. Only proven values
 * survive; null/undefined/empty structures are dropped so the caller can
 * spread the payload without overwriting freshly proven data with a stale
 * "we didn't have it either" default.
 */
export function preservedMarketPayload(previous) {
  const payload = {};
  if (!previous || typeof previous !== 'object') return payload;
  if (Number.isFinite(previous.sellPrice) && previous.sellPrice > 0) payload.sellPrice = previous.sellPrice;
  if (Array.isArray(previous.prices) && previous.prices.length > 0) payload.prices = previous.prices;
  if (previous.yuyuName) payload.yuyuName = previous.yuyuName;
  if (previous.yuyuImage) payload.yuyuImage = previous.yuyuImage;
  if (previous.timestamp) payload.timestamp = previous.timestamp;
  if (
    previous.priceHistory
    && typeof previous.priceHistory === 'object'
    && Object.keys(previous.priceHistory).length > 0
  ) {
    payload.priceHistory = previous.priceHistory;
  }
  if (previous.priceHistoryMeta && typeof previous.priceHistoryMeta === 'object') {
    payload.priceHistoryMeta = previous.priceHistoryMeta;
  }
  if (
    Array.isArray(previous._rawPricesArchive)
    && previous._rawPricesArchive.length > 0
  ) {
    payload._rawPricesArchive = previous._rawPricesArchive;
  }
  if (previous.ytStats && typeof previous.ytStats === 'object') {
    payload.ytStats = previous.ytStats;
  }
  return payload;
}

// DIC-1140 / DIC-1013 fail-closed: signed-printing rows must ship with an
// empty prices[] — yuyu-tei listings never prove the signed printing's
// identity, so a bulk copy of the previous row's prices[] would revert that
// canonicalization decision. Also handles OSR/OUR overprint variants for
// the same reason: prev's yuyu-derived prices[] frequently came from a
// pre-DIC-1140 build that had not yet split those printings.
const SIGNED_ONLY_RARITIES = new Set(['SEC']);

function isSignedPrinting(card) {
  return SIGNED_ONLY_RARITIES.has(String(card?.rarity || '').trim().toUpperCase());
}

/**
 * Apply preserved market fields onto `currentCard` in-place, never
 * overwriting freshly proven non-empty values. Returns a summary of what
 * was restored so callers can log.
 *
 * `matchKind` gates the printing-specific arrays `prices[]`,
 * `_rawPricesArchive`, plus `yuyuName` / `yuyuImage`. On an exact-id
 * match these are safe: the previous row and the fresh row describe the
 * same printing under the same canonicalization decisions. On a signature
 * fallback we still restore them for ordinary printings (BASE / PARALLEL
 * / RR / SR / U / C …) so the deck / detail UI keeps rendering per-variant
 * sell + buy prices after a canonicalization rename, but we refuse to
 * restore them onto SEC signed printings — the DIC-1013/1140 fail-closed
 * contract requires their prices[] stay empty. `sellPrice`, `priceHistory`,
 * `priceHistoryMeta`, `ytStats` and `timestamp` are per-printing scalars/
 * history and always safe to preserve — those were the fields the shipped
 * regression was wiping.
 */
/**
 * Canonicalize a card id into the sanitized filename that
 * `src/services/priceHistory.ts::rebuildIndex` (and `scripts/build-database.js`
 * Step 5/6) uses to name the on-disk history file. Kept in lockstep with the
 * regex in `scripts/build-database.js`.
 */
export function historyFilenameFor(cardId) {
  return `${String(cardId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/**
 * Seed the canonical-ID `data/price-history/<id>.json` file with each card's
 * in-memory `priceHistory` so `scripts/build-database.js` Step 5 (append
 * today's record) and Step 6 (unconditionally re-read + overwrite
 * `card.priceHistory`) do not collapse a preserved multi-day history to
 * today's single record when the id was renamed by DIC-1084 canonicalization
 * and no canonical-ID history file exists yet. The reviewer measured 1,566
 * shipped rows that had preserved multi-day history but no canonical-ID
 * file — every one of them would have lost that history on the next daily
 * rebuild without this seed.
 *
 * Idempotent and additive:
 *   - Existing `records[]` entries are preserved verbatim.
 *   - A preserved `(date, price)` pair is only appended when that date is
 *     not already in the file — no cross-printing or stale-price leakage.
 *   - Non-positive / non-finite prices are dropped (fail-closed).
 *   - Rows with fewer than 2 preserved history days do not seed a file
 *     (Step 5 covers the today-only case).
 *
 * Filesystem is injected so the same function is used by build-database.js
 * (real fs), the one-shot repair (real fs) and the mutation test (tmpdir).
 */
export function seedCanonicalHistoryFiles({
  cards,
  historyDir,
  fsAdapter,
  now = new Date(),
} = {}) {
  if (!cards || typeof cards !== 'object') return { seededFiles: 0, addedRecords: 0 };
  if (!historyDir || !fsAdapter) {
    throw new Error('seedCanonicalHistoryFiles requires historyDir and fsAdapter');
  }
  const path = fsAdapter.path;
  const fs = fsAdapter.fs;
  fs.mkdirSync(historyDir, { recursive: true });
  const nowIso = now.toISOString();
  let seededFiles = 0;
  let addedRecords = 0;
  for (const [cardId, card] of Object.entries(cards)) {
    const ph = card?.priceHistory;
    if (!ph || typeof ph !== 'object') continue;
    // DIC-1219 fail-closed: only origin-product rows may re-seed their durable
    // history file from in-memory priceHistory. Reprint rows land here with an
    // in-memory priceHistory carried over from a previous build cycle whose
    // sourceProduct we cannot prove (the map has no per-date stamp), so
    // seeding would re-write the same cross-product records DIC-1219 just
    // migrated out. Fresh Step 5 records still land on reprint rows through
    // the stamped write below — the reprint history rebuilds legitimately.
    if (isReprintRow(card)) continue;
    const preservedDates = Object.entries(ph).filter(
      ([, price]) => Number.isFinite(price) && price > 0,
    );
    if (preservedDates.length < 2) continue;
    const filePath = path.join(historyDir, historyFilenameFor(cardId));
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      existing = null;
    }
    const records = Array.isArray(existing?.records) ? [...existing.records] : [];
    const existingDates = new Set(records.map((r) => r.date));
    let added = 0;
    for (const [date, price] of preservedDates) {
      if (existingDates.has(date)) continue;
      records.push(stampHistoryRecord({
        date,
        price,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId,
      }, card));
      existingDates.add(date);
      added += 1;
    }
    if (added === 0) continue;
    records.sort((a, b) => a.date.localeCompare(b.date));
    const doc = {
      cardId,
      cardNumber: existing?.cardNumber || card.cardNumber || '',
      name: existing?.name || card.name || '',
      nameZh: existing?.nameZh || card.nameZh || '',
      records,
      lastUpdated: nowIso,
    };
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    seededFiles += 1;
    addedRecords += added;
  }
  return { seededFiles, addedRecords };
}

export function applyPreservedMarketFields(currentCard, previous, { matchKind = 'exact-id', preserveYuyuPayload = true } = {}) {
  const summary = { sellPrice: false, prices: false, priceHistory: false, ytStats: false, yuyu: false };
  if (!currentCard || !previous) return summary;
  const payload = preservedMarketPayload(previous);
  if (Object.keys(payload).length === 0) return summary;
  // DIC-1227: gate ALL yuyu-derived preservation (sellPrice, prices, yuyuName,
  // yuyuImage, timestamp, priceHistory, priceHistoryMeta, _rawPricesArchive)
  // on `yuyuPayloadMatchesSource`. The previous row's yuyuImage URL product
  // path must equal the current row's sourceProduct (with a `promo-*/hpr`
  // carve-out) — otherwise the payload came from a different printing whose
  // yuyu listing legally cannot vouch for this row, and every subsequent
  // preservation cycle would re-propagate the contamination. Mac-Codex CR on
  // main 9f4b63bac flagged hBP01-090_hPR_P_hBP01-090_P_02 inheriting a
  // sellPrice/yuyuName/yuyuImage from an hEB01 listing for exactly this
  // reason. ytStats is NOT yuyu-derived and stays subject to its own guard.
  //
  // DIC-1227 CR follow-up: the previous "top-level yuyuImage decides
  // everything" rule was too coarse — the reviewer showed
  // hBP01-048_hPR_P_hBP01-048_P had a valid ¥980 /promo-hbp10/ prices[]
  // entry that survived a fresh scrape but got nulled with the whole
  // payload because an unrelated /hbp06/ entry had become top-level
  // yuyuImage. Filter prices[] and _rawPricesArchive[] entry-by-entry,
  // then derive top-level sellPrice / yuyuName / yuyuImage FROM the
  // surviving entries so provable payload survives whether or not the
  // previous row's top-level pointer was correct.
  const currentSourceProduct = currentCard?.sourceProduct;
  // DIC-1227 CR follow-up split filter:
  //   - prices[] and _rawPricesArchive[] use the RELAXED filter (own product +
  //     promo-*/hpr + origin-prefix on non-promo rows) so a hBP04 reprint
  //     keeps its /hbp02/ BASE entry for deck aggregation.
  //   - top-level fields are derived from the STRICT filter (own product +
  //     promo-*/hpr only) so a hBP04 reprint's TOP-LEVEL sellPrice/yuyuImage
  //     reflects its own printing, not the base's.
  const filteredPrices = filterProvenanceMatchedPriceEntries(payload.prices, currentSourceProduct, currentCard?.cardNumber);
  const filteredArchive = filterProvenanceMatchedPriceEntries(payload._rawPricesArchive, currentSourceProduct, currentCard?.cardNumber);
  const strictSurvivors = filterProvenanceMatchedPriceEntries(payload.prices, currentSourceProduct);
  const anyStrictSurvivor = strictSurvivors.length > 0;
  const anyProvenSurvivor = filteredPrices.length > 0;
  // Signed printings (DIC-1013/1140) fail-closed strip prices[] on
  // signature match — their aggregate top-level fields live on the
  // scalar previous.sellPrice/yuyuImage/yuyuName. Only the payload's
  // top-level yuyu provenance can vouch for those scalars, and only when
  // it points to this row's sourceProduct.
  const preservePrintingArrays = preserveYuyuPayload && anyProvenSurvivor && (matchKind === 'exact-id' || !isSignedPrinting(currentCard));
  const useDerived = preservePrintingArrays;
  const topLevelPayloadMatches = preserveYuyuPayload && yuyuPayloadMatchesSource(previous, currentSourceProduct);
  const derived = useDerived
    ? deriveTopLevelFromEntries(strictSurvivors, payload.timestamp)
    : topLevelPayloadMatches
      ? {
          sellPrice: payload.sellPrice ?? null,
          yuyuName: payload.yuyuName || '',
          yuyuImage: payload.yuyuImage || '',
          timestamp: payload.timestamp || '',
        }
      : { sellPrice: null, yuyuName: '', yuyuImage: '', timestamp: '' };

  const canSetTopLevel = useDerived
    ? anyStrictSurvivor
    : topLevelPayloadMatches;

  if (canSetTopLevel && derived.sellPrice != null && !(Number.isFinite(currentCard.sellPrice) && currentCard.sellPrice > 0)) {
    currentCard.sellPrice = derived.sellPrice;
    summary.sellPrice = true;
  }
  if (preservePrintingArrays && filteredPrices.length > 0 && !(Array.isArray(currentCard.prices) && currentCard.prices.length > 0)) {
    currentCard.prices = filteredPrices;
    summary.prices = true;
  }
  // DIC-1219 + DIC-1227: priceHistory carries no per-date stamp so we cannot
  // filter it per record here. Refuse the copy-out unless (a) at least one
  // prices[] entry survives the DIC-1227 entry-level provenance filter
  // (proving the row has legit provenance under the current sourceProduct)
  // AND (b) either the match was by exact id (provenance-safe by construction)
  // or the previous row's sourceProduct equals current's (DIC-1219).
  const prevSource = String(previous?.sourceProduct || previous?.series || '');
  const currentSource = String(currentCard?.sourceProduct || currentCard?.series || '');
  const historyProvenanceMatches = matchKind === 'exact-id' || (prevSource !== '' && prevSource === currentSource);
  // DIC-1227 CR follow-up rev.3: priceHistory records reflect the previous
  // row's TOP-LEVEL yuyu payload snapshot at each date. If the previous
  // top-level was cross-product (a wrong yuyuImage that our new
  // deriveTopLevelFromEntries just replaced), the historical record values
  // came from that WRONG top-level — carrying them into a corrected row
  // would let a surviving entry vouch for unrelated priceHistory. Refuse
  // priceHistory preservation whenever the previous top-level payload
  // itself did not match current sourceProduct.
  const historyProvenanceOk = topLevelPayloadMatches && (useDerived ? anyStrictSurvivor : true);
  if (preserveYuyuPayload && historyProvenanceOk && historyProvenanceMatches && payload.priceHistory && !(currentCard.priceHistory && Object.keys(currentCard.priceHistory).length > 0)) {
    currentCard.priceHistory = payload.priceHistory;
    summary.priceHistory = true;
  }
  if (preserveYuyuPayload && historyProvenanceOk && historyProvenanceMatches && payload.priceHistoryMeta && !currentCard.priceHistoryMeta) {
    currentCard.priceHistoryMeta = payload.priceHistoryMeta;
  }
  if (payload.ytStats && !currentCard.ytStats) {
    currentCard.ytStats = payload.ytStats;
    summary.ytStats = true;
  }
  if (preservePrintingArrays && filteredArchive.length > 0 && !(Array.isArray(currentCard._rawPricesArchive) && currentCard._rawPricesArchive.length > 0)) {
    currentCard._rawPricesArchive = filteredArchive;
  }
  // yuyuName/yuyuImage are the printing's own identifier; when the signed-
  // printing contract strips prices[] (preservePrintingArrays=false), the
  // corresponding yuyu identity must also NOT carry across.
  if (preservePrintingArrays && derived.yuyuName && !currentCard.yuyuName) {
    currentCard.yuyuName = derived.yuyuName;
    summary.yuyu = true;
  }
  if (preservePrintingArrays && derived.yuyuImage && !currentCard.yuyuImage) {
    currentCard.yuyuImage = derived.yuyuImage;
    summary.yuyu = true;
  }
  if (canSetTopLevel && derived.timestamp && !currentCard.timestamp) {
    currentCard.timestamp = derived.timestamp;
  }
  return summary;
}
