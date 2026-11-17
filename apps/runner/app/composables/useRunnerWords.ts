import englishCatalog from '../../locales/en.json';

/** Piwi Runner's catalog, as its English source types it. */
export type RunnerCatalog = typeof englishCatalog;

/**
 * Piwi Runner's own words (`locales/`), in the language the layer's words are in: the window's frame, its runs and its
 * settings. The layer's words (`useRunUiWords`) say the rest.
 */
export function useRunnerWords(): RunUiTranslator<RunnerCatalog> {
  const words = useRunUiWords();
  return runUiTranslator(() => ({ language: words.language, catalog: englishCatalog }), englishCatalog);
}
