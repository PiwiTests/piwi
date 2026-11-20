/**
 * The languages Piwi Runner speaks, and the shell's answer about the one on screen. A draft is a translation no native
 * reader has reviewed yet; this is the one place a language changes status.
 */

export const RUNNER_LANGUAGES = [
  { code: 'en', draft: false },
  { code: 'fr', draft: false },
  { code: 'de', draft: true },
  { code: 'es', draft: true },
  { code: 'pt_BR', draft: true },
] as const;

export type RunnerLanguage = (typeof RUNNER_LANGUAGES)[number]['code'];

/** Where a reader suggests a correction to a translation: GitHub's form for translation fixes. */
export const RUNNER_TRANSLATION_ISSUE_URL =
  'https://github.com/PiwiTests/piwi/issues/new?template=translation-runner.yml';

/**
 * What the shell says of the language (`desktop_get_language`, `piwi:language`): on screen, chosen, the system's, and
 * the number of the choice it follows, which only grows.
 */
export interface RunnerLanguageInfo {
  language: RunnerLanguage;
  chosen: RunnerLanguage | null;
  system: RunnerLanguage;
  serial: number;
}

export function isRunnerLanguage(code: unknown): code is RunnerLanguage {
  return typeof code === 'string' && RUNNER_LANGUAGES.some((language) => language.code === code);
}

/** Whether `code` is a draft translation. */
export function isDraftRunnerLanguage(code: RunnerLanguage): boolean {
  return RUNNER_LANGUAGES.some((language) => language.code === code && language.draft);
}

/** `pt_BR` → `pt-BR`: a language's code as a BCP 47 tag. */
export function runnerLanguageTag(code: RunnerLanguage): string {
  return code.replace(/_/g, '-');
}

/**
 * The shipped language a browser's language reads as, for the window outside the shell: its language's catalog,
 * Portuguese for `pt-BR` alone, English for any other, as the shell reads the system's.
 */
export function runnerLanguageOf(tag: string | null | undefined): RunnerLanguage {
  const [primary = '', region = ''] = (tag ?? '').toLowerCase().replace(/_/g, '-').split('-');
  if (primary === 'pt') return region === 'br' ? 'pt_BR' : 'en';
  return isRunnerLanguage(primary) ? primary : 'en';
}

/** A language's name in that language, capitalized: `Français`, `English`, `Português (Brasil)`. */
export function runnerLanguageName(code: RunnerLanguage): string {
  const tag = runnerLanguageTag(code);
  let name = tag;
  try {
    name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    // An engine without display names: the code will do.
  }
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}

/** The shell's answer as the window keeps it, from what it sent: English for anything it does not know. */
export function readRunnerLanguageInfo(value: unknown): RunnerLanguageInfo {
  const info = (value ?? {}) as Partial<Record<keyof RunnerLanguageInfo, unknown>>;
  return {
    language: isRunnerLanguage(info.language) ? info.language : 'en',
    chosen: isRunnerLanguage(info.chosen) ? info.chosen : null,
    system: isRunnerLanguage(info.system) ? info.system : 'en',
    serial: typeof info.serial === 'number' && Number.isFinite(info.serial) ? info.serial : 0,
  };
}
