/**
 * Desktop shell: the window's hold on the stream of its runs' hub (`useDesktopRunHub`), from the window's start and
 * whatever layout shows, so a page without the Local runs tray (an analytics dashboard in TV mode) keeps it and a
 * reload takes it again.
 *
 * The window holds it only while it has a run to show: a run of the Local runs tray runs, the stream still has a live
 * run, or, in the dashboard window, the hub says it has one (`hub-runs` on the desktop event stream, sent as that
 * stream opens, so a reload finds out at once whether its runs still go on). While it holds it, every headless stop
 * waits for the window: each stop the window hears opens the tray, once, and a failure or a `page.pause()` is told to
 * the system while the window is in the background. It says `show` for the running runs whose Hold failures is on
 * (`desktopShownRefs`); expanding a run or closing the tray changes none.
 *
 * A run's output window shows no runs of its own and holds nothing.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { desktopShownRefs, desktopStopSaid } from '~/utils/desktop-run-view';

export default defineNuxtPlugin(() => {
  const label = tauriWindowLabel();
  if (!tauriCore() || label?.startsWith('output-')) return;
  // Another window holds the stream for the runs it started itself alone.
  const followsHub = label === null || label === 'main';

  const store = useDesktopLocalRuns();
  const hub = useDesktopRunHub();
  const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

  const hubLive = ref(0);
  subscribeDesktopEvents((message) => {
    if (message.type === 'hub-runs' && followsHub) hubLive.value = typeof message.live === 'number' ? message.live : 0;
  });

  watch(
    () => store.activeCount.value > 0 || hubLive.value > 0 || sessions.value.length > 0,
    (on) => hub.want(on),
    { immediate: true },
  );

  const shownRefs = computed(() => desktopShownRefs(store.runs.value, store.holds.value, sessions.value));
  watch(
    () => shownRefs.value.join(' '),
    () => hub.show(shownRefs.value),
    { immediate: true },
  );

  hub.onStop((session: HubSession, worker: HubWorker) => {
    const stop = worker.stop;
    if (!stop) return;
    store.trayOpen.value = true;
    // A step, a pause or a line run to, which the person's own controls asked for here or in Piwi Picker, is not said.
    if (stop.reason !== 'failure' && stop.reason !== 'page-pause') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    try {
      new Notification(stop.reason === 'failure' ? 'A test failed and waits' : 'A test waits at page.pause()', {
        body: desktopStopSaid(session, worker, stop),
      });
    } catch {
      // Notifications unavailable in this webview — the tray still shows the stop.
    }
  });
});
