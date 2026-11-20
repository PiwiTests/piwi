/**
 * Piwi Runner's words: the language the shell answers, loaded before the window shows, and the layer's words in it
 * under `RUN_UI_WORDS`, before any other plugin speaks.
 */
export default defineNuxtPlugin({
  name: 'runner-words',
  enforce: 'pre',
  async setup(nuxtApp) {
    const language = useRunnerLanguage();
    nuxtApp.vueApp.provide(RUN_UI_WORDS, language.words);
    await language.start();
  },
});
