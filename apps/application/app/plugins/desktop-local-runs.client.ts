/**
 * Desktop shell: a window's Local runs across a reload of its page. As the page goes, the store writes its runs to the
 * window's session storage (`keepForReload`), and once the next page hydrated it takes them back
 * (`takeBackAfterReload`): the runs the shell still runs are followed again, with their Hold failures and their
 * separate output windows, and those that ended meanwhile end with their exit codes. A run's output window and a
 * worker's window show no runs of their own.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const label = tauriWindowLabel();
  if (!tauriCore() || label?.startsWith('output-') || label?.startsWith('worker-')) return;
  const store = useDesktopLocalRuns();
  window.addEventListener('pagehide', () => store.keepForReload());
  // Once the page hydrated, so the runs it takes back never differ from what the server rendered.
  nuxtApp.hooks.hookOnce('app:suspense:resolve', () => void store.takeBackAfterReload());
});
