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
 * Rules — pinned by `test-card-display-name.mjs`. DIC-1380 W6 CR fix:
 * the zh-only and non-zh legs are now SYMMETRIC — each preference falls
 * back to the OTHER language for the primary slot when the preferred-
 * language field is blank, so an empty primary never leaves the user
 * with a bare subtitle.
 *
 *   • `preferredLanguage === 'zh'`:
 *       - `nameZh` non-blank → primary=nameZh, secondary=name (only when
 *         `name` differs from `nameZh`).
 *       - `nameZh` blank    → primary=name (fallback), secondary='' (no
 *         misleading duplicate line).
 *   • any non-Chinese preference (ja / en / …):
 *       - `name` non-blank  → primary=name, secondary=nameZh (only when
 *         `nameZh` differs from `name`).
 *       - `name` blank      → primary=nameZh (fallback — SYMMETRIC with
 *         the zh path above; DIC-1380 W6), secondary=''.
 *   • Both fields blank: primary='' and secondary=''. Callers decide
 *     the placeholder (usually the card number).
 */
export function resolveCardDisplayName(
  card: CardDisplayNameInput,
  preferredLanguage: LanguagePreference,
): CardDisplayName {
  const name = trimOrEmpty(card?.name);
  const nameZh = trimOrEmpty(card?.nameZh);

  if (preferredLanguage === 'zh') {
    if (nameZh.length > 0) {
      return {
        primary: nameZh,
        secondary: name && name !== nameZh ? name : '',
      };
    }
    // Blank Chinese name → fall back to the Japanese name as primary; no
    // secondary because there is no meaningful alternate.
    return { primary: name, secondary: '' };
  }

  if (name.length > 0) {
    return {
      primary: name,
      secondary: nameZh && nameZh !== name ? nameZh : '',
    };
  }
  // DIC-1380 W6 CR: non-zh preference with a blank primary MUST fall back
  // to nameZh in the PRIMARY slot — the previous code left the primary
  // empty and pushed nameZh into secondary, contradicting the zh-side
  // fallback behavior. Symmetric fallback fixes the resolver contradiction.
  return { primary: nameZh, secondary: '' };
}
