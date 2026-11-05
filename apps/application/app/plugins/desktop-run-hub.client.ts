/**
 * Desktop shell only: the dashboard window holds the stream of its runs' hub (`useDesktopRunHub`) while it has a run
 * to show, whatever page, layout or error page it shows (`holdDesktopRunHub`). It opens the stream as the window
 * starts, so a reload attaches again to the runs still going, and keeps it while a local run runs, in the window or in
 * the shell, or the hub has a live run; with none, it lets the stream go once the hub has had time to tell its runs.
 * While it is open, every headless stop waits for the window, and the Local runs tray opens on each one, a stop heard
 * before the tray loaded included.
 *
 * The main window alone holds it, and loads its code: a run's output window, the other windows of the app and any
 * other build answer no stop.
 */
export default defineNuxtPlugin((nuxtApp) => {
  if (!tauriCore() || tauriWindowLabel() !== 'main') return;
  onNuxtReady(async () => {
    const { holdDesktopRunHub } = await import('~/utils/desktop-run-hub-hold');
    nuxtApp.runWithContext(() => holdDesktopRunHub());
  });
});
