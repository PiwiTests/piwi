import type englishCatalog from '../../locales/en.json';

/** Piwi Runner's catalog, as its English source types it. */
export type RunnerCatalog = typeof englishCatalog;

/**
 * Piwi Runner's own words (`locales/`), in the language on screen: the window's frame, its runs and its settings. The
 * layer's words (`useRunUiWords`) say the rest.
 */
export function useRunnerWords(): RunUiTranslator<RunnerCatalog> {
  return useRunnerLanguage().runnerWords as RunUiTranslator<RunnerCatalog>;
}
