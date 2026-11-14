/** The UI languages, and how the "System default" choice resolves to one of them. */

export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];

/** What Settings → Application stores: a language, or the system's. */
export type LanguageSetting = 'system' | Language;
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['system', ...LANGUAGES];

export interface LanguageInfo {
  setting: LanguageSetting;
  /** The language in use: the chosen one, or the system's when it is supported. */
  language: Language;
  /** What "System default" gives on this computer. */
  system: Language;
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return typeof value === 'string' && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/**
 * The system's language when the app has it, else English. Only the first preferred
 * language counts: a German system with French second gets English.
 * `systemLanguages` are BCP 47 tags such as `fr-CH` or `en-US`, most preferred first.
 */
export function systemLanguage(systemLanguages: readonly string[]): Language {
  const primary = systemLanguages[0]?.toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(primary ?? '') ? (primary as Language) : 'en';
}

export function resolveLanguage(
  setting: LanguageSetting,
  systemLanguages: readonly string[],
): LanguageInfo {
  const system = systemLanguage(systemLanguages);
  return { setting, language: setting === 'system' ? system : setting, system };
}
