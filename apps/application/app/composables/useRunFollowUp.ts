import type { RunRequestView } from '#shared/handlers/run-requests';
import type { CiDispatchView } from '#shared/ci-dispatches';
import { ciDispatchFollowUp, runFollowUpPollMs, runRequestFollowUp, type RunFollowUpView } from '#shared/run-follow-up';

/** What a page follows: a run request to one of the person's apps, or a CI dispatch. */
export type FollowedRun = { kind: 'request'; view: RunRequestView } | { kind: 'dispatch'; view: CiDispatchView };

/**
 * Follow one run request or CI dispatch while the page is open: a request every 2 seconds until it ends, a dispatch
 * every 5 seconds until a run is matched to it, then every 30 seconds until it is final (`runFollowUpPollMs`), never
 * while the tab is hidden. `onRun` hears the run once it reports; the page never navigates on its own. Reading stops
 * for good once the request or dispatch is gone for this person, or they are signed out. `stop` asks a request to end.
 */
export function useRunFollowUp(options: { onRun?: (runId: number, followed: FollowedRun) => void } = {}) {
  const followed = shallowRef<FollowedRun | null>(null);
  const error = ref<string | null>(null);
  /** A clock the view reads, so a dispatch that waited long says so without a new read. */
  const now = ref(Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waitingToShow = false;
  let disposed = false;

  const view = computed<RunFollowUpView | null>(() => {
    const current = followed.value;
    if (!current) return null;
    return current.kind === 'request' ? runRequestFollowUp(current.view) : ciDispatchFollowUp(current.view, now.value);
  });

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (waitingToShow) document.removeEventListener('visibilitychange', readWhenShown);
    waitingToShow = false;
  }

  function readWhenShown() {
    if (!document.hidden) void read();
  }

  function schedule() {
    const shown = view.value;
    const wait = shown ? runFollowUpPollMs(shown) : null;
    if (!disposed && wait != null) timer = setTimeout(read, wait);
  }

  function urlOf(current: FollowedRun): string {
    return current.kind === 'request'
      ? `/api/run-requests/${current.view.id}`
      : `/api/ci-dispatches/${current.view.id}`;
  }

  async function read() {
    clear();
    const current = followed.value;
    if (disposed || !current || view.value?.final) return;
    if (document.hidden) {
      waitingToShow = true;
      document.addEventListener('visibilitychange', readWhenShown);
      return;
    }
    try {
      const fresh = await $fetch<RunRequestView | CiDispatchView>(urlOf(current));
      // Another one was followed meanwhile, or the page went away.
      if (disposed || followed.value !== current) return;
      const next = { kind: current.kind, view: fresh } as FollowedRun;
      const before = current.view.runId;
      followed.value = next;
      now.value = Date.now();
      error.value = null;
      if (before == null && fresh.runId != null) options.onRun?.(fresh.runId, next);
    } catch (e) {
      if (disposed || followed.value !== current) return;
      error.value = errorMessage(e);
      // Gone for this person (deleted, or its project no longer readable), or they were signed out.
      if ([401, 403, 404].includes(statusOf(e) ?? 0)) return;
    }
    schedule();
  }

  function follow(next: FollowedRun) {
    clear();
    followed.value = next;
    now.value = Date.now();
    error.value = null;
    schedule();
  }

  /** Ask the followed request to end; a dispatch is cancelled in the CI. */
  async function stop() {
    const current = followed.value;
    if (current?.kind !== 'request') return;
    try {
      const view = await $fetch<RunRequestView>(`/api/run-requests/${current.view.id}/stop`, { method: 'POST' });
      if (followed.value === current) followed.value = { kind: 'request', view };
      error.value = null;
    } catch (e) {
      error.value = errorMessage(e);
    }
  }

  function reset() {
    clear();
    followed.value = null;
    error.value = null;
  }

  onScopeDispose(() => {
    disposed = true;
    clear();
  });
  return { followed, view, error, follow, stop, reset };
}

function statusOf(error: unknown): number | undefined {
  return (
    (error as { statusCode?: number; status?: number } | null)?.statusCode ?? (error as { status?: number })?.status
  );
}
