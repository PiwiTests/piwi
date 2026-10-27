/**
 * The languages Piwi Picker ships, by their `public/_locales/` directory
 * name. A draft is a translation no native reader has reviewed yet; this is
 * the one place a language changes status.
 */
export const SHIPPED_LANGUAGES = [
  { code: 'en', draft: false },
  { code: 'fr', draft: false },
  { code: 'de', draft: true },
  { code: 'es', draft: true },
  { code: 'pt_BR', draft: true },
] as const;

export type Language = (typeof SHIPPED_LANGUAGES)[number]['code'];

export const LANGUAGES: readonly Language[] = SHIPPED_LANGUAGES.map((language) => language.code);

/** Where a reader suggests a correction to a translation: GitHub's form for translation fixes. */
export const TRANSLATION_ISSUE_URL = 'https://github.com/PiwiTests/piwi/issues/new?template=translation.yml';

/** Whether a shipped language, by its directory name (`pt_BR`) or its tag (`pt-BR`), is still a draft. */
export function isDraftLanguage(code: string): boolean {
  const name = code.replace(/-/g, '_');
  return SHIPPED_LANGUAGES.some((language) => language.code === name && language.draft);
}
