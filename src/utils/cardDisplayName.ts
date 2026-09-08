/**
 * Card name display helper (DIC-1380 W3 naming consistency).
 *
 * Every surface that renders a card name (SearchResults, ScanResultCard,
 * ScanCandidateSelector, CardDetail, DeckEditor) was open-coding the same
 * `preferredLanguage === 'zh' && card.nameZh ? card.nameZh : card.name`
 * expression. That worked but let each surface drift independently — a
 * subtle bug in one place stopped being caught by every other, and the
 * inconsistent handling of empty / whitespace `nameZh` values was already
 * different across surfaces.
 *
 * This helper is the single choke point. Every renderer of a card name
 * calls it and gets the same primary + secondary line back:
 *
 *   • Primary   — the name to render in the largest / primary text slot.
 *   • Secondary — the alternate-language name to render underneath as a
 *                 subtitle, or `''` when there is nothing meaningful to
 *                 show (secondary equals primary, or the field is empty).
 *
 * The helper is pure and language-code-agnostic — it does not import
 * settingsStore or i18n so it can be unit-tested without a runtime, and so
 * callers keep their own binding to the preference source.
 */

export interface CardDisplayNameInput {
  /** Primary catalog name — Japanese in every shipped fixture. Required. */
  name?: string | null;
  /** Optional Chinese/translated name from the catalog. */
  nameZh?: string | null;
}

export interface CardDisplayName {
  primary: string;
  secondary: string;
}

type LanguagePreference = 'zh' | 'ja' | 'en' | (string & {});

function trimOrEmpty(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Resolve the primary + secondary display name for a card given the user's
 * preferred UI language.
 *
 * Rules — pinned by `test-card-display-name.mjs`:
 *
 *   • `preferredLanguage === 'zh'` and `nameZh` is a non-blank string:
 *     primary = nameZh, secondary = name (only when name differs).
 *   • `preferredLanguage === 'zh'` with a blank / missing nameZh: primary
 *     = name (fallback), secondary = '' (no misleading duplicate line).
 *   • Any non-Chinese preference: primary = name, secondary = nameZh only
 *     when nameZh differs from name (avoid duplicate rows).
 *   • Both fields blank: primary = '' and secondary = ''. Callers decide
 *     the placeholder (usually the card number).
 */
export function resolveCardDisplayName(
  card: CardDisplayNameInput,
  preferredLanguage: LanguagePreference,
): CardDisplayName {
  const name = trimOrEmpty(card?.name);
  const nameZh = trimOrEmpty(card?.nameZh);

  if (preferredLanguage === 'zh' && nameZh.length > 0) {
    return {
      primary: nameZh,
      secondary: name && name !== nameZh ? name : '',
    };
  }

  return {
    primary: name,
    secondary: nameZh && nameZh !== name ? nameZh : '',
  };
}
