import type { ComputedRef } from 'vue';
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';
import { WAITING_DISPATCHES_READ, waitingRunRows, waitingRunsPollMs, type WaitingRunRow } from '~/utils/waiting-runs';

type Kind = WaitingRunRow['kind'];

/** The run events that change what waits: a run that starts, reports, ends or is cancelled. */
const RUN_EVENTS = new Set([
  'run-initializing',
  'run-started',
  'run-finalizing',
  'run-finished',
  'run-submitted',
  'run-cancelled',
]);

export interface WaitingRunsOptions {
  /** Read the project's CI dispatches: its CI actions are on. */
  dispatches: () => boolean;
  /** Read the viewer's own run requests: they may ask their apps for runs here. */
  requests: () => boolean;
  /** The rows show: the page shows its newest runs (the Runs tab, no kept runs alone, no period from Analytics). */
  shown: () => boolean;
  /** The last dispatch sent from the page. */
  sent: () => CiDispatchView | null;
}

/**
 * The waiting rows of a project's runs list (`app/utils/waiting-runs.ts`). The project's open dispatches are read with
 * the page's server render while its CI actions are on and the page opens on its runs; the viewer's own requests in
 * the browser, once the page has mounted. While the rows show, each kind is read again on its own cadence while a row
 * of it shows (`waitingRunsPollMs`), and both on each run event of the project and when the tab shows again; never
 * while the tab is hidden. A kind whose read is refused (signed out, no access, the feature off) is no longer read.
 * A dispatch sent from the page shows at once.
 */
export function useWaitingRuns(
  projectId: number,
  options: WaitingRunsOptions,
): Promise<{ rows: ComputedRef<WaitingRunRow[]> }> {
  const now = useState(`waiting-runs-now:${projectId}`, () => Date.now());
  // Not awaited here: every hook and watcher below is set up in the page's setup, before it awaits the read.
  const dispatchFetch = useFetch<{ items: CiDispatchView[] }>(`/api/projects/${projectId}/ci-dispatches`, {
    key: `waiting-dispatches:${projectId}`,
    query: { state: 'open', limit: WAITING_DISPATCHES_READ },
    immediate: options.dispatches() && options.shown(),
    watch: false,
    default: () => ({ items: [] }),
  });
  const { data: dispatchData, status: dispatchStatus } = dispatchFetch;
  const requests = ref<RunRequestView[]>([]);
  const refused: Record<Kind, boolean> = { dispatch: false, request: false };

  const rows = computed(() => waitingRunRows(dispatchData.value?.items ?? [], requests.value, now.value));

  const timers: Record<Kind, ReturnType<typeof setTimeout> | null> = { dispatch: null, request: null };
  /** The latest read of each kind: an earlier one that answers after it is dropped. */
  const reads: Record<Kind, number> = { dispatch: 0, request: 0 };
  let started = false;
  let disposed = false;
  let eventTimer: ReturnType<typeof setTimeout> | null = null;

  const enabled = (kind: Kind) => !refused[kind] && (kind === 'dispatch' ? options.dispatches() : options.requests());
  const active = () => started && !disposed && options.shown();

  function setItems(kind: Kind, items: CiDispatchView[] | RunRequestView[]) {
    if (kind === 'dispatch') dispatchData.value = { items: items as CiDispatchView[] };
    else requests.value = items as RunRequestView[];
  }

  function clearTimer(kind: Kind) {
    const timer = timers[kind];
    if (timer) clearTimeout(timer);
    timers[kind] = null;
  }

  function schedule(kind: Kind) {
    clearTimer(kind);
    const wait = active() && enabled(kind) ? waitingRunsPollMs(rows.value, kind) : null;
    if (wait == null) return;
    timers[kind] = setTimeout(() => {
      timers[kind] = null;
      // A hidden tab stops reading; it reads again when it shows.
      if (!document.hidden) void read(kind);
    }, wait);
  }

  async function read(kind: Kind) {
    clearTimer(kind);
    if (!enabled(kind)) {
      setItems(kind, []);
      return;
    }
    const current = ++reads[kind];
    try {
      const answer =
        kind === 'dispatch'
          ? await $fetch<{ items: CiDispatchView[] }>(`/api/projects/${projectId}/ci-dispatches`, {
              query: { state: 'open', limit: WAITING_DISPATCHES_READ },
            })
          : await $fetch<{ items: RunRequestView[] }>('/api/run-requests', { query: { projectId } });
      if (disposed || current !== reads[kind]) return;
      setItems(kind, answer.items);
    } catch (error) {
      if (disposed || current !== reads[kind]) return;
      if ([401, 403, 404].includes(statusOf(error) ?? 0)) {
        refused[kind] = true;
        setItems(kind, []);
        return;
      }
      // Another failed read keeps the rows it had, and is tried again on the cadence.
    }
    now.value = Date.now();
    schedule(kind);
  }

  function readAll() {
    void read('dispatch');
    void read('request');
  }

  /** Read both kinds once a burst of run events has passed. */
  function readSoon() {
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      if (active()) readAll();
    }, 1_000);
  }

  function onVisible() {
    if (!document.hidden && active()) readAll();
  }

  useRunEvents((event) => {
    if (event.projectId === projectId && RUN_EVENTS.has(event.type) && active()) readSoon();
  });

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisible);
    // Once every mounted hook of the page has run: one of them may hide the rows (a period from Analytics).
    void nextTick(() => {
      started = true;
      if (!active()) return;
      // Dispatches the server render read are as fresh as the page.
      if (dispatchStatus.value === 'success') schedule('dispatch');
      else void read('dispatch');
      void read('request');
    });
  });

  // The rows shown again (back on the Runs tab, Kept runs only off): read what may have changed meanwhile.
  watch(options.shown, (shown) => {
    if (!started) return;
    if (shown) readAll();
    else {
      clearTimer('dispatch');
      clearTimer('request');
    }
  });

  watch(
    () => `${options.dispatches()}:${options.requests()}`,
    () => {
      if (active()) readAll();
    },
  );

  watch(options.sent, (sent) => {
    if (!sent) return;
    // A read begun before the dispatch would answer without it, or with an older copy of it.
    reads.dispatch++;
    const items = dispatchData.value?.items ?? [];
    dispatchData.value = { items: [sent, ...items.filter((d) => d.id !== sent.id)] };
    now.value = Date.now();
    schedule('dispatch');
  });

  onBeforeUnmount(() => {
    disposed = true;
    clearTimer('dispatch');
    clearTimer('request');
    if (eventTimer) clearTimeout(eventTimer);
    document.removeEventListener('visibilitychange', onVisible);
  });

  return Promise.resolve(dispatchFetch).then(() => ({ rows }));
}

function statusOf(error: unknown): number | undefined {
  return (
    (error as { statusCode?: number; status?: number } | null)?.statusCode ?? (error as { status?: number })?.status
  );
}
