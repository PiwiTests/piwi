/**
 * Desktop shell only: when the dashboard window holds the stream of its runs' hub (`useDesktopRunHub.want`), from the
 * window's start for as long as it has a run to show. `plugins/desktop-run-hub.client.ts` starts it in the main window,
 * and loads this module only there.
 */

/** How long the window holds the hub's stream as it starts, waiting for it to open, before it gives up. */
export const HUB_ATTACH_MS = 15_000;
/** How long after the stream opens, each time it does, the window waits for the hub to tell the runs it has. */
export const HUB_SETTLE_MS = 3_000;

/** The event the shell sends the window with the ids of the local runs it runs, each time they change. */
const LOCAL_RUNS_EVENT = 'piwi:local-runs';

/** What the window holds the hub's stream for (`holdsDesktopRunHub`). */
export interface DesktopHubNeeds {
  /** The stream opened a moment ago, or is opening: the hub has not told it its runs yet. */
  attaching: boolean;
  /** The local runs of the window that run. */
  activeRuns: number;
  /**
   * The local runs the shell runs, as it lists them, whoever started them: one a reload left going, before its workers
   * reach the hub (its web server starting, a reproduction checking out, a bisect between steps).
   */
  shellRuns: number;
  /** The hub's live runs, the window's or another's. */
  liveRuns: number;
}

/**
 * Whether the window holds the stream of its runs' hub: while it opens, so a reload attaches again to the runs still
 * going, then while a local run runs, in the window or in the shell, or the hub has a live run. Never otherwise: while
 * the stream is open, every headless stop waits for the window.
 */
export function holdsDesktopRunHub(needs: DesktopHubNeeds): boolean {
  return needs.attaching || needs.activeRuns > 0 || needs.shellRuns > 0 || needs.liveRuns > 0;
}

/**
 * Holds the stream for the life of the window, as `holdsDesktopRunHub` decides: from now, and again for
 * `HUB_SETTLE_MS` each time the stream opens, since its `hello` empties the runs the hub then tells again.
 */
export function holdDesktopRunHub(): void {
  const hub = useDesktopRunHub();
  const { activeCount } = useDesktopLocalRuns();

  const attaching = ref(true);
  let attachTimer = setTimeout(() => (attaching.value = false), HUB_ATTACH_MS);
  watch(
    () => hub.state.connected,
    (connected) => {
      if (!connected) return;
      attaching.value = true;
      clearTimeout(attachTimer);
      attachTimer = setTimeout(() => (attaching.value = false), HUB_SETTLE_MS);
    },
    // At once, before the runs the `hello` emptied are read.
    { flush: 'sync' },
  );

  // The shell's own list of its runs, which a reload leaves as it was: asked once, then told of each change.
  const shellRuns = ref(0);
  let told = false;
  tauriEvent()
    ?.listen<number[]>(LOCAL_RUNS_EVENT, ({ payload }) => {
      told = true;
      shellRuns.value = Array.isArray(payload) ? payload.length : 0;
    })
    .catch(() => {});
  tauriCore()
    ?.invoke<number[] | null>('desktop_local_runs')
    .then((ids) => {
      if (!told) shellRuns.value = Array.isArray(ids) ? ids.length : 0;
    })
    .catch(() => {});

  watch(
    () =>
      holdsDesktopRunHub({
        attaching: attaching.value,
        activeRuns: activeCount.value,
        shellRuns: shellRuns.value,
        liveRuns: Object.keys(hub.state.sessions).length,
      }),
    (on) => hub.want(on),
    { immediate: true },
  );
}
