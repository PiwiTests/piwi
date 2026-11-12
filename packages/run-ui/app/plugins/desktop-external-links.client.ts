/**
 * Inside a shell's window (the dashboard's, Piwi Runner's): a cross-origin `http(s)` or `mailto:` link opens in the
 * user's default browser (`desktop_open_external`), never in the window, where a `target="_blank"` link opens nothing.
 * Same-origin links (routes, anchors, same-origin file links handled elsewhere) are left to Vue Router and the download
 * handler.
 */
export default defineNuxtPlugin(() => {
  const core = tauriCore();
  if (!core) return;
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }

      const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
      const isExternalWeb = isWeb && url.origin !== window.location.origin;
      const isMail = url.protocol === 'mailto:';
      if (!isExternalWeb && !isMail) return;

      event.preventDefault();
      core.invoke('desktop_open_external', { url: anchor.href }).catch(() => {});
    },
    true, // capture — beat Vue Router's own click handling
  );
});
