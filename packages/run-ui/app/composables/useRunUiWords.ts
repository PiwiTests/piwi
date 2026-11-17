/**
 * The layer's words in the language on screen: those its host provides under `RUN_UI_WORDS`, else English. It reads the
 * host's words where Vue can inject them (a component's setup, a plugin); code that speaks later, from a stream or a
 * timer, keeps what this returned.
 */
export function useRunUiWords(): RunUiWords {
  return hasInjectionContext() ? inject(RUN_UI_WORDS, ENGLISH_RUN_UI_WORDS) : ENGLISH_RUN_UI_WORDS;
}
