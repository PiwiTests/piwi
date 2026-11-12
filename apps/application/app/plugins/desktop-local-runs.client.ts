/**
 * Desktop shell: a window's Local runs across a reload of its page. As the page goes for good (a `pagehide` that does
 * not keep it for Back), the store writes its runs to the window's session storage (`keepForReload`); the next page
 * reads them as it starts (`readKeptForReload`), which drops them from the storage, and takes them back once it
 * hydrated (`takeBackAfterReload`): the runs the shell still runs are followed again, with their Hold failures and
 * their separate output windows, and those that ended meanwhile end with their exit codes. A page that shows again
 * (`pageshow`) drops what it kept. A run's output window and a worker's window show no runs of their own.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const label = tauriWindowLabel();
  if (!tauriCore() || label?.startsWith('output-') || label?.startsWith('worker-')) return;
  const store = useDesktopLocalRuns();
  store.readKeptForReload();
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) store.keepForReload();
  });
  window.addEventListener('pageshow', () => store.forgetKeptForReload());
  // Once the page hydrated, so the runs it takes back never differ from what the server rendered.
  nuxtApp.hooks.hookOnce('app:suspense:resolve', () => void store.takeBackAfterReload());
});
