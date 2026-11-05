/**
 * Desktop shell only: the dashboard window holds the stream of its runs' hub (`useDesktopRunHub`) while it has a run
 * to show, whatever page or layout it shows. It opens the stream as the window starts, so a reload attaches again to
 * the runs still going in the hub, and keeps it while a local run of the window runs or the hub has a live run
 * (`holdsDesktopRunHub`); with neither, it lets the stream go once the hub has had time to tell its runs. While it is
 * open, every headless stop waits for the window, and the Local runs tray, mounted for every layout, opens on each one.
 *
 * The main window alone holds it: a run's output window and the other windows of the app answer no stop.
 */
import { HUB_ATTACH_MS, HUB_SETTLE_MS, holdsDesktopRunHub } from '~/utils/desktop-run-view';

export default defineNuxtPlugin(() => {
  if (!tauriCore() || tauriWindowLabel() !== 'main') return;
  const hub = useDesktopRunHub();
  const { activeCount } = useDesktopLocalRuns();

  // As the window starts, the hub has not told it its runs: a moment after the stream opens it has, and the window
  // gives up on a stream that does not open.
  const attaching = ref(true);
  let attachTimer = setTimeout(() => (attaching.value = false), HUB_ATTACH_MS);
  const stopWaiting = watch(
    () => hub.state.connected,
    (connected) => {
      if (!connected) return;
      clearTimeout(attachTimer);
      attachTimer = setTimeout(() => (attaching.value = false), HUB_SETTLE_MS);
      stopWaiting();
    },
  );

  // Once the app has hydrated, so the tray already listens for the stops the hub holds.
  onNuxtReady(() => {
    watch(
      () =>
        holdsDesktopRunHub({
          attaching: attaching.value,
          activeRuns: activeCount.value,
          liveRuns: Object.keys(hub.state.sessions).length,
        }),
      (on) => hub.want(on),
      { immediate: true },
    );
  });
});
