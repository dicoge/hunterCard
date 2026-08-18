import { useSettingsStore, type LanguageCode } from '../store/settingsStore';
import { zh } from './locales/zh';
import { ja } from './locales/ja';

export type TranslationKey = keyof typeof zh;

const dictionaries: Record<LanguageCode, Record<TranslationKey, string>> = {
  zh,
  ja,
};

/**
 * Pure translation lookup function.
 * Safe fallback: returns default (zh) string if key or language is missing.
 */
export function t(
  key: TranslationKey,
  language: LanguageCode = 'zh',
  params?: Record<string, string | number>,
): string {
  const dict = dictionaries[language] || dictionaries.zh;
  let text = dict[key] || dictionaries.zh[key] || (key as string);

  if (params) {
    Object.entries(params).forEach(([paramKey, val]) => {
      text = text.replace(new RegExp(`\\{\\{${paramKey}\\}\\}`, 'g'), String(val));
    });
  }

  return text;
}

/**
 * React Hook for i18n.
 * Re-renders automatically when preferredLanguage changes in settingsStore.
 */
export function useTranslation() {
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const lang: LanguageCode = preferredLanguage in dictionaries ? preferredLanguage : 'zh';

  const translate = (
    key: TranslationKey,
    params?: Record<string, string | number>,
  ): string => t(key, lang, params);

  return {
    t: translate,
    language: lang,
  };
}

export { zh, ja };
