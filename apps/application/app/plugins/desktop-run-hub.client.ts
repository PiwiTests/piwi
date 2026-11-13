/**
 * Desktop shell: the window's hold on the stream of its runs' hub (`useDesktopRunHub`), from the window's start and
 * whatever layout shows, so a page without the Local runs tray (an analytics dashboard in TV mode, an error page) keeps
 * it and a reload takes it again.
 *
 * The window holds it only while it has a run to show: a run of the Local runs tray runs, the stream still has a live
 * run, or, in the dashboard window, the hub says it has one (`hub-runs` on the desktop event stream, sent as that
 * stream opens, so a reload finds out at once whether its runs still go on). While it holds it, every headless stop
 * waits for the window, and each stop it hears opens the tray, once.
 *
 * While a tray is mounted (`trayMounts`), the window says `show` for the running runs whose Hold failures is on
 * (`desktopShownRefs`), and a failure or a `page.pause()` is told to the system while the window is in the background.
 * While none is, nothing on the page shows a stop: the window shows no run live, so no failure no pause bar shows is
 * held, and every stop is told to the system, whatever the focus. A `page.pause()`, a step or a breakpoint still
 * waits there until something answers it: the tray once a page shows it again, Piwi Picker's Runs window, an agent.
 *
 * One window tells the system of a stop: the one whose tray owns the run, else the dashboard window. The windows say
 * which runs their trays own on a `BroadcastChannel`, again every `CLAIM_BEAT_MS`; a claim not renewed for
 * `CLAIM_MS` lapses, as a window that closed without saying so. A stop from before the page loaded (`since`), heard
 * again after a reload, opens the tray but is not told again. A run's output window shows no runs of its own and holds
 * nothing; a worker's window holds the stream for its worker itself.
 */
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { desktopRunOf, desktopRunRef, desktopShellIdOf, desktopShownRefs } from '~/utils/desktop-run-view';
import { desktopStopSaid } from '@piwitests/run-ui/run-view';

/** The channel on which the app's windows say which runs their trays own. */
const OWNERS_CHANNEL = 'piwi-desktop-run-owners';

type OwnersMessage = { type: 'ask' } | { type: 'owned'; window: string; refs: string[] };

/** How often a window says again which runs its tray owns. */
const CLAIM_BEAT_MS = 5000;
/** How long a window's claim holds without being said again. */
const CLAIM_MS = 3 * CLAIM_BEAT_MS;

const STOP_TITLES: Partial<Record<string, string>> = {
  failure: 'A test failed and waits',
  'page-pause': 'A test waits at page.pause()',
};

export default defineNuxtPlugin(() => {
  const label = tauriWindowLabel();
  // A run's output window shows no runs; a worker's window holds the stream itself (`pages/desktop/run-worker.vue`).
  if (!tauriCore() || label?.startsWith('output-') || label?.startsWith('worker-')) return;
  const loadedAt = Date.now();
  // Another window holds the stream for the runs it started itself alone.
  const main = label === null || label === 'main';
  const self = label ?? 'main';

  const store = useDesktopLocalRuns();
  const hub = useDesktopRunHub();
  const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);
  const trayShown = computed(() => store.trayMounts.value > 0);

  const hubLive = ref(0);
  subscribeDesktopEvents((message) => {
    if (message.type === 'hub-runs' && main) hubLive.value = typeof message.live === 'number' ? message.live : 0;
  });

  watch(
    () => store.activeCount.value > 0 || hubLive.value > 0 || sessions.value.length > 0,
    (on) => hub.want(on),
    { immediate: true },
  );

  // The window is present on the runs while its tray shows them to a person.
  const visibility = useDocumentVisibility();
  watch(
    () => trayShown.value && visibility.value === 'visible',
    (on) => hub.present(on),
    { immediate: true },
  );

  const shownRefs = computed(() =>
    trayShown.value ? desktopShownRefs(store.runs.value, store.holds.value, sessions.value) : [],
  );
  watch(
    () => shownRefs.value.join(' '),
    () => hub.show(shownRefs.value),
    { immediate: true },
  );

  // The runs each other window's tray owns, by the window's label, and when it last said so.
  const ownRefs = computed(() => [...new Set(store.runs.value.flatMap((run) => run.hubRefs))].sort());
  const others = new Map<string, { refs: Set<string>; at: number }>();
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(OWNERS_CHANNEL);
  const post = (message: OwnersMessage) => channel?.postMessage(message);
  const tellOwned = () => post({ type: 'owned', window: self, refs: ownRefs.value });
  if (channel) {
    channel.onmessage = ({ data }: MessageEvent<OwnersMessage>) => {
      if (data?.type === 'ask') tellOwned();
      else if (data?.type === 'owned' && typeof data.window === 'string' && Array.isArray(data.refs)) {
        if (data.refs.length) others.set(data.window, { refs: new Set(data.refs), at: Date.now() });
        else others.delete(data.window);
      }
    };
    watch(() => ownRefs.value.join(' '), tellOwned, { immediate: true });
    setInterval(tellOwned, CLAIM_BEAT_MS);
    post({ type: 'ask' });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => post({ type: 'owned', window: self, refs: [] }));
    }
  }

  /** Whether this window tells the system of a stop of a run: its tray owns it, or no window's does and it is main. */
  function tellsSystem(ref: string): boolean {
    const run = desktopRunOf(ref);
    if (ownRefs.value.includes(run)) return true;
    const now = Date.now();
    return main && ![...others.values()].some((claim) => now - claim.at < CLAIM_MS && claim.refs.has(run));
  }

  // Another tool asked through the hub to stop a run: the window whose tray holds it stops it as its own Stop does; with
  // none, the main window has the shell stop the process. Once a run, whoever asks again: a second stop of the shell's
  // is the tray's Force stop, which only the tray offers.
  const stopsAsked = new Set<number>();
  hub.onStopRun((ref) => {
    if (!tellsSystem(ref)) return;
    const run = store.runs.value.find((r) => r.hubRefs.includes(desktopRunOf(ref)));
    if (run) {
      // A step of the run that ended, its session left a moment longer, stops nothing: the step running now is another.
      const current = run.shellId != null && desktopRunRef(run.shellId) === desktopRunOf(ref);
      if (current && !run.stopRequested) void store.stopRun(run);
      return;
    }
    const runId = desktopShellIdOf(ref);
    if (runId === null || stopsAsked.has(runId)) return;
    stopsAsked.add(runId);
    void tauriCore()
      ?.invoke('desktop_stop_local_tests', { runId })
      .catch(() => {});
  });

  hub.onStop((session: HubSession, worker: HubWorker) => {
    const stop = worker.stop;
    if (!stop) return;
    store.trayOpen.value = true;
    if (Date.parse(stop.since) < loadedAt) return;
    const title = STOP_TITLES[stop.reason];
    // With a tray, a step, a pause or a line run to, which the person's own controls asked for here or in Piwi Picker,
    // is not said, and nothing is said while the window has the focus.
    if (trayShown.value && !title) return;
    if (!tellsSystem(session.ref)) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (trayShown.value && !document.hidden && document.hasFocus()) return;
    try {
      new Notification(title ?? 'A test stopped and waits', { body: desktopStopSaid(session, worker, stop) });
    } catch {
      // Notifications unavailable in this webview — the tray still shows the stop.
    }
  });
});
