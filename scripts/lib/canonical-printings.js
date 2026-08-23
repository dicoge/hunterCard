/**
 * canonical-printings.js — collapse errata history out of user-facing card
 * printings (DIC-1139).
 *
 * yuyu-tei ships every physical listing it has ever recorded for a card
 * number, including source-maintenance revisions of the same printing when a
 * card gets rebalanced (`エラッタ前` / `エラッタ後`). Those revisions belong
 * to shop bookkeeping, not to the card's tier identity: a player who owns a
 * signed 宝鐘マリン owns the SIGNED printing, not one of two DB rows the shop
 * uses to keep pre/post-errata inventory separate.
 *
 * Rule (issue owner's spec):
 *   - User-facing tiers for a card number are only 普通版 / 平行版 / 簽名版
 *     (plus any independently meaningful collectible tier).
 *   - Any `(エラッタ前)` / `(エラッタ後)` label is stripped from every
 *     user-facing surface.
 *   - When both pre- and post-errata rows exist inside the same tier, the
 *     corrected (`エラッタ後`) row is the canonical product record; the
 *     pre-errata row is dropped from the public prices[] and archived
 *     internally for audit only.
 *   - No cross-tier averaging / max / borrowing. A canonical row without a
 *     proven sell price stays unpriced — it never inherits from the row it
 *     replaced.
 *
 * This is a build-time collapse — every downstream reader (UI selectors,
 * card detail, Collection, decks, alerts, tournament reports, buy-price
 * merge) sees the canonical prices[] and never has to know errata history
 * existed.
 */

const ERRATA_LABEL_RE = /\s*[(（]\s*エラッタ[前後]\s*[)）]/g;

// Order matters: post-errata beats pre-errata beats no-errata-label rows only
// when both errata rows are present. When ONLY one label exists in the tier
// we simply strip the label (nothing to collapse), never demote a legitimate
// listing.
const ERRATA_PRIORITY = { post: 3, pre: 2, none: 1 };

function detectErrataKind(name) {
  const s = String(name ?? '');
  if (/エラッタ後/.test(s)) return 'post';
  if (/エラッタ前/.test(s)) return 'pre';
  return 'none';
}

/**
 * Strip the `(エラッタ前)` / `(エラッタ後)` parenthetical from a listing
 * name while preserving every other descriptor the source published.
 * `宝鐘マリン(パラレル/サイン)(エラッタ後)` → `宝鐘マリン(パラレル/サイン)`.
 */
function stripErrataLabel(name) {
  if (name == null) return '';
  return String(name).replace(ERRATA_LABEL_RE, '').trim();
}

/**
 * Group key used to decide when two source rows describe the same canonical
 * printing: the listing name with the errata label removed. Two rows that
 * differ ONLY in errata history collapse to a single canonical row; rows
 * that differ in any other descriptor stay separate.
 */
function canonicalGroupKey(name) {
  return stripErrataLabel(name).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Collapse a card's raw prices[] into canonical, user-facing rows.
 * Returns { canonical, archive }:
 *   - canonical: prices[] with errata history hidden and post-errata chosen
 *     as the canonical row when both pre/post exist in the same tier.
 *   - archive:   the untouched raw rows, preserved for internal audit. Never
 *     rendered.
 *
 * Groups that share a canonical name because of errata history collapse to
 * ONE row (post-errata > pre-errata > none). Groups that share a canonical
 * name for any OTHER reason — the DIC-1013 case of two `白銀ノエル(パラレル)`
 * listings at different sell prices — are NOT collapsed here: the source
 * itself never proved they were the same printing, so they must survive as
 * separate rows and the downstream `buildSourcePrintings` fail-closed rule
 * still fires on them (dropping both prices rather than picking one).
 *
 * Pure function; input is not mutated.
 */
function canonicalizePrices(raw) {
  const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
  if (list.length === 0) return { canonical: [], archive: [] };

  // Preserve first-seen order across group buckets so the canonical prices[]
  // still reads in the source's original priority (which the card-detail UI
  // relies on for tier ordering).
  const groupOrder = [];
  const groups = new Map();
  for (const entry of list) {
    const key = canonicalGroupKey(entry?.name || '');
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push(entry);
  }

  const canonical = [];
  const archive = list.map((e) => ({ ...e }));

  for (const key of groupOrder) {
    const members = groups.get(key);
    const hasErrataMember = members.some((m) => detectErrataKind(m?.name || '') !== 'none');
    if (!hasErrataMember) {
      // No errata history in this group — the members are already whatever
      // the source shipped. Emit each verbatim so DIC-1013 same-name-diff-
      // price ambiguity keeps triggering the sourcePrinting fail-closed rule.
      for (const m of members) canonical.push({ ...m });
      continue;
    }
    // Prefer post-errata (corrected record) > pre-errata > plain (no label).
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < members.length; i += 1) {
      const kind = detectErrataKind(members[i]?.name || '');
      const score = ERRATA_PRIORITY[kind] || 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const chosen = members[bestIdx];
    const cleanedName = stripErrataLabel(chosen?.name || '');
    canonical.push({ ...chosen, name: cleanedName });
  }

  return { canonical, archive };
}

/**
 * Same collapse for the top-level `yuyuName` / `yuyuImage` snapshot that
 * build-database.js copies from the lowest-price row. Returns null when the
 * input is not a string.
 */
function canonicalYuyuName(name) {
  if (name == null || name === '') return name;
  return stripErrataLabel(name);
}

/**
 * Choose the canonical top-level image URL for a card given the canonical
 * prices[] (post-collapse) and the previous top-level yuyuName / yuyuImage.
 *
 * Prefers the canonical row whose stripped name equals the canonical yuyuName
 * — that keeps the top-level image aligned with the top-level name (a signed-
 * only card ships its signed post-errata image; a base-anchored card ships
 * its base post-errata image). Falls back to the first canonical row's image,
 * finally to the previous value untouched (nothing to canonicalise).
 *
 * Never returns an image URL that appears ONLY in the raw archive rows — that
 * is the exact leak DIC-1140 blocker #1 named (hBP02-003 previously shipped
 * pre-errata 10008.jpg because build-database.js took the FIRST raw row's
 * image before the collapse). If no canonical row publishes an image, returns
 * an empty string.
 */
function canonicalYuyuImage(canonicalPrices, yuyuName, previousImage) {
  const rows = Array.isArray(canonicalPrices) ? canonicalPrices : [];
  const target = (yuyuName || '').normalize('NFKC').trim();
  const withImages = rows.filter((r) => r && typeof r.imageUrl === 'string' && r.imageUrl);
  if (withImages.length === 0) {
    // Preserve the old value only when it's genuinely absent from prices[] —
    // never invent a canonical image. When there is no canonical row image,
    // fall back to an empty string, mirroring build-database.js's original
    // "no yuyu image" case rather than smuggling in an archive URL.
    return '';
  }
  const matched = withImages.find((r) => (r.name || '').normalize('NFKC').trim() === target);
  if (matched) return matched.imageUrl;
  // No canonical row shares the name; take the first canonical row's image
  // (deterministic, source-order-preserving fallback). Do not fall back to
  // previousImage — that is the very field the caller is asking us to fix.
  return withImages[0].imageUrl;
}

/**
 * True when any user-facing string still carries an errata-history label.
 * Used by the full-DB assertion to prove the collapse ran everywhere.
 */
function hasErrataLabel(value) {
  if (value == null) return false;
  return /エラッタ[前後]/.test(String(value));
}

export {
  canonicalizePrices,
  canonicalYuyuName,
  canonicalYuyuImage,
  stripErrataLabel,
  canonicalGroupKey,
  detectErrataKind,
  hasErrataLabel,
};
