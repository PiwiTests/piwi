import { loadRunSpeaker } from '@piwitests/run-model/speakers';
import { englishRunSpeaker, type RunSpeaker } from '@piwitests/run-model/words';
import englishCatalog from '../../locales/en.json';
import {
  readRunnerLanguageInfo,
  runnerLanguageOf,
  runnerLanguageTag,
  type RunnerLanguage,
  type RunnerLanguageInfo,
} from '~/utils/runner-language';

const RUNNER_CATALOG_LOADERS: Record<Exclude<RunnerLanguage, 'en'>, () => Promise<{ default: RunUiRawCatalog }>> = {
  de: () => import('../../locales/de.json'),
  es: () => import('../../locales/es.json'),
  fr: () => import('../../locales/fr.json'),
  pt_BR: () => import('../../locales/pt_BR.json'),
};

/** The language on screen and its catalogs, once loaded: the layer's, Runner's and the run model's words. */
interface Shown {
  info: RunnerLanguageInfo;
  layer: RunUiRawCatalog;
  runner: RunUiRawCatalog;
  run: RunSpeaker;
}

const shown = shallowRef<Shown>({
  info: { language: 'en', chosen: null, system: 'en' },
  layer: RUN_UI_ENGLISH_CATALOG,
  runner: englishCatalog,
  run: englishRunSpeaker,
});

/** The language the latest answer asked for, so an answer that loads late never replaces a newer one. */
let asked: RunnerLanguage = 'en';

/** Shows the language the shell answered, once its catalogs are loaded. */
async function show(value: unknown): Promise<void> {
  const info = readRunnerLanguageInfo(value);
  asked = info.language;
  const code = info.language;
  const [layer, runner, run] = await Promise.all([
    loadRunUiCatalog(code),
    code === 'en' ? englishCatalog : RUNNER_CATALOG_LOADERS[code]().then((m) => m.default),
    loadRunSpeaker(code),
  ]);
  if (asked === code) shown.value = { info, layer, runner, run };
}

/**
 * Piwi Runner's language: the one the shell answers (the Language setting, else the system's), told again on each
 * change (`piwi:language`), and outside the shell the browser's. `start` loads it once, before the window shows.
 */
export function useRunnerLanguage() {
  /** The layer's words in the language on screen (`RUN_UI_WORDS`). */
  const words = runUiWords(() => {
    const tag = runnerLanguageTag(shown.value.info.language);
    return { language: tag, catalog: shown.value.layer, run: shown.value.run, timeLocale: tag };
  });

  /** Runner's own words in the language on screen. */
  const runnerWords = runUiTranslator(
    () => ({ language: runnerLanguageTag(shown.value.info.language), catalog: shown.value.runner }),
    englishCatalog,
  );

  async function start(): Promise<void> {
    const core = tauriCore();
    if (!core) {
      await show({ language: runnerLanguageOf(navigator.language), chosen: null, system: 'en' });
      return;
    }
    await tauriEvent()?.listen<RunnerLanguageInfo>('piwi:language', ({ payload }) => void show(payload));
    await show(await core.invoke('desktop_get_language').catch(() => null));
  }

  /** Chooses a language, or follows the system's again (`null`): the shell saves it and tells every side. */
  async function choose(language: RunnerLanguage | null): Promise<void> {
    const core = tauriCore();
    if (!core) return;
    await show(await core.invoke('desktop_set_language', { language }));
  }

  return {
    info: computed(() => shown.value.info),
    words,
    runnerWords,
    start,
    choose,
  };
}
