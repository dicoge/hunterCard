/**
 * scripts/lib/official-effects-enrichment.mjs
 *
 * DIC-1468: pure helpers for the official-catalog effects enrichment path.
 *
 * The Official Catalog Sync workflow discovers brand-new official printings and
 * upserts them into data/database.json, but nothing in that pipeline ever grew
 * data/effects-jp.json — scripts/scrape-effects.js is a manual backfill tool no
 * workflow invoked. DIC-1439 fixed the cardNumber -> printing-row JOIN; the
 * ACQUISITION gap stayed open, so any genuinely new cardNumber shipped with no
 * skillsJp at all and tripped verify-official-catalog-completeness.mjs.
 *
 * Two helpers live here, both pure and both fail-closed by construction:
 *
 *   missingEffectsCardNumbers() — which official cardNumbers still have no
 *   entry in an effects map. This is the work list the acquisition step feeds
 *   to the official detail pages; it never invents a cardNumber.
 *
 *   deriveStructuralZh() — the ONLY Traditional-Chinese derivation allowed in
 *   this repo. data/effects-zh.json is a translation artifact, not an upstream
 *   source: the official cardlist publishes Japanese only and
 *   scripts/translate-effects.js is hard-disabled under the DIC-1185 OpenRouter
 *   denylist, so no rules text may ever be synthesized. But a card whose
 *   Japanese entry carries NO rules text at all has no rules text TO translate:
 *   its entry is a pure structural envelope (cardNumber/name/cardType/color).
 *   For exactly that class, every field can be resolved from a controlled,
 *   committed map — the DIC-1415 `nameZh` precedent — with nothing fabricated:
 *
 *     name     <- data/character-names-zh.json (own-property only, DIC-1417)
 *     cardType <- the GLOSSARY_ZH controlled term map in translate-effects.js
 *     color    <- copied VERBATIM from the Japanese entry
 *
 *   That is not a guess: it reproduces the six rules-text-free entries already
 *   committed to data/effects-zh.json (hY01-014, hY02-012, hY03-016, hY04-013,
 *   hY05-011, hY06-011) byte for byte, including their verbatim Japanese colour
 *   glyphs. Anything carrying rules text — including a yell with keywords and
 *   every `oshiSkill`/`spOshiSkill` holder such as hYS01-001..004 — returns
 *   null and stays fail-closed until a reviewed translation lands in
 *   data/effects-zh.json (DIC-1167: there is no exemption baseline).
 */
import { canonicalizeTerms } from '../translate-effects.js';

// DIC-465: a `zh` field may never leak Japanese kana. Interpunct U+30FB is
// normalized by canonicalizeTerms() and is excluded upstream, so this range
// check only has to reject hiragana/katakana proper.
const KANA_RE = /[぀-ゟァ-ヺー-ヿ]/u;

// Every field that can carry rules text in the data/effects-jp.json schema.
// A card with ANY of them populated is out of scope for derivation.
export const RULES_TEXT_FIELDS = Object.freeze([
  'oshiSkill',
  'spOshiSkill',
  'arts',
  'keywords',
  'abilityText',
]);

/**
 * Does this effects entry carry rules text? Deliberately biased toward `true`:
 * an unrecognized shape in a rules-text field counts as rules text, because the
 * only consequence of a false positive is that derivation refuses and the card
 * stays fail-closed until a reviewed translation lands.
 *
 * Shape validation of the entry itself is deriveStructuralZh()'s job — this
 * predicate answers the narrow rules-text question for a plain object.
 */
export function hasRulesText(entry) {
  if (!entry || typeof entry !== 'object') return false;
  for (const field of RULES_TEXT_FIELDS) {
    if (!Object.hasOwn(entry, field)) continue;
    const value = entry[field];
    if (value == null) continue;
    if (Array.isArray(value)) {
      if (value.length) return true;
      continue;
    }
    if (typeof value === 'string') {
      if (value.trim()) return true;
      continue;
    }
    // An object (oshiSkill/spOshiSkill) or anything unexpected: rules-bearing.
    return true;
  }
  return false;
}

/**
 * Official cardNumbers that have no entry in `effectsMap`, sorted and deduped.
 * `officialCards` is the raw row list read from data/official/<code>.json, so
 * rows missing an `id` (no detail page to fetch) or a `cardNumber` are skipped.
 * Returns `{ cardNumber, id, name, cardType }` work items, preferring the first
 * row that actually carries a cardType — same representative-row rule
 * scripts/scrape-effects.js uses.
 */
export function missingEffectsCardNumbers(officialCards, effectsMap) {
  const byCardNumber = new Map();
  for (const card of Array.isArray(officialCards) ? officialCards : []) {
    if (!card || typeof card !== 'object') continue;
    const { id, cardNumber } = card;
    if (typeof id !== 'string' || !id.trim()) continue;
    if (typeof cardNumber !== 'string' || !cardNumber.trim()) continue;
    if (effectsMap && Object.hasOwn(effectsMap, cardNumber)) continue;
    const previous = byCardNumber.get(cardNumber);
    if (previous && previous.cardType) continue;
    byCardNumber.set(cardNumber, {
      cardNumber,
      id,
      name: typeof card.name === 'string' ? card.name : (previous?.name ?? ''),
      cardType: typeof card.cardTypeJp === 'string' && card.cardTypeJp
        ? card.cardTypeJp
        : (typeof card.cardType === 'string' ? card.cardType : ''),
    });
  }
  return [...byCardNumber.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
}

/**
 * Derive the Traditional-Chinese entry for a rules-text-free Japanese entry, or
 * null when anything at all is unresolved. Every `null` return leaves the card
 * fail-closed — the completeness gate then requires a reviewed
 * data/effects-zh.json translation (DIC-1167: no exemption baseline exists).
 */
export function deriveStructuralZh(jpEntry, nameZhMap) {
  if (!jpEntry || typeof jpEntry !== 'object') return null;
  if (!nameZhMap || typeof nameZhMap !== 'object') return null;

  const { cardNumber, name, cardType, color } = jpEntry;
  for (const field of [cardNumber, name, cardType, color]) {
    if (typeof field !== 'string' || !field.trim()) return null;
  }

  // Only a card with nothing to translate may be derived.
  if (hasRulesText(jpEntry)) return null;

  // DIC-1417: own-property lookups only, so a name like `constructor` cannot
  // inherit a truthy Object.prototype member and sail past the gate.
  if (!Object.hasOwn(nameZhMap, name)) return null;
  const nameZh = nameZhMap[name];
  if (typeof nameZh !== 'string' || !nameZh.trim()) return null;

  // The controlled glossary must actually KNOW this card type. An unchanged
  // string means the term was never in the map, so passing it through would
  // launder Japanese into a zh field — refuse instead.
  const cardTypeZh = canonicalizeTerms(cardType);
  if (typeof cardTypeZh !== 'string' || !cardTypeZh.trim()) return null;
  if (cardTypeZh === cardType) return null;

  // DIC-465: no kana may survive into a zh field.
  if (KANA_RE.test(nameZh) || KANA_RE.test(cardTypeZh)) return null;

  // `color` is copied verbatim: the committed rules-text-free entries keep the
  // Japanese colour glyph (e.g. "緑", "黄"), so translating it here would
  // diverge from the shipped artifact.
  return { cardNumber, name: nameZh, cardType: cardTypeZh, color };
}
