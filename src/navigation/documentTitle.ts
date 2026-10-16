/**
 * Browser tab title on web (v41, QA baseline 2026-10-16: the zh landing page showed the
 * English route name "Login"). react-navigation's default formatter falls back to the
 * route NAME, an internal English identifier; this one uses the screen's localized title
 * when it has one and otherwise the brand — never a route name.
 */
export const APP_TITLE = 'HoloHunter';

export function formatDocumentTitle(options: { title?: unknown } | undefined): string {
  const title = typeof options?.title === 'string' ? options.title.trim() : '';
  return title && title !== APP_TITLE ? `${title} · ${APP_TITLE}` : APP_TITLE;
}
