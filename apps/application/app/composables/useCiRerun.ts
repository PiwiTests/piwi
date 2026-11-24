import type { MaybeRefOrGetter } from 'vue';
import type { CiDispatchRun, CiDispatchView } from '#shared/ci-dispatches';
import type { CiDispatchSourceInput, CiOffered } from '#shared/ci-dispatch-request';

/** A place's CI re-run as the failure pages read it: whether its default action can be sent, and its last dispatch. */
export interface RerunInfo {
  available: boolean;
  reason: string | null;
  /** The CI action a dispatch would run, or null when none can. */
  action: { id: string; name: string } | null;
  /** The last dispatch the provider took, with the run that answered it. */
  lastDispatch: CiDispatchView | null;
}

/** A place that dispatches to CI: its project and its source, as `POST /api/projects/:id/ci-dispatches` takes it. */
export interface CiRerunPlace {
  projectId: number;
  source: CiDispatchSourceInput;
}

/** The `RerunInfo` of what a place is offered: its default action's readiness, and its last dispatch. */
export function rerunInfoFromOffered(offered: CiOffered): RerunInfo {
  const action = offered.actions.find((a) => a.id === offered.defaultActionId) ?? null;
  return {
    available: offered.enabled && Boolean(action?.available),
    reason: action?.reason ?? null,
    action: action ? { id: action.id, name: action.name } : null,
    lastDispatch: offered.lastDispatch,
  };
}

/**
 * A place's `RerunInfo`. A viewer who may dispatch (`run:control`) reads what
 * the place is offered; any other reads only its cluster's last dispatch the
 * provider took, from the project's dispatches.
 */
export async function loadRerunInfo(
  /** `$fetch`, or the `useRequestFetch()` that carries the request's cookies on the server. */
  fetcher: typeof $fetch,
  place: CiRerunPlace & { clusterId: number | null; mayDispatch: boolean },
): Promise<RerunInfo> {
  if (place.mayDispatch) {
    const offered = await fetcher<CiOffered>(`/api/projects/${place.projectId}/ci-actions/offered`, {
      query: place.source,
    });
    return rerunInfoFromOffered(offered);
  }
  const unavailable = { available: false, reason: null, action: null };
  if (place.clusterId == null) return { ...unavailable, lastDispatch: null };
  const { items } = await fetcher<{ items: CiDispatchView[] }>(`/api/projects/${place.projectId}/ci-dispatches`, {
    query: { clusterId: place.clusterId, limit: 20 },
  });
  return { ...unavailable, lastDispatch: items.find((d) => d.state !== 'refused') ?? null };
}

const DISPATCH_TARGETS: Record<string, string> = {
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  bitbucket: 'Bitbucket Pipelines',
  jenkins: 'Jenkins',
  custom: 'the CI server',
};

/** Where a re-run was dispatched, for its "dispatched to Jenkins" line. */
export function rerunDispatchTarget(dispatch: NonNullable<RerunInfo['lastDispatch']>): string {
  const key = dispatch.provider === 'ci-server' ? (dispatch.preset ?? 'custom') : dispatch.provider;
  return DISPATCH_TARGETS[key] ?? 'CI';
}

const RUN_RESULTS: Record<string, string> = {
  initializing: 'is starting',
  running: 'is running',
  finalizing: 'is finishing',
  passed: 'passed',
  failed: 'failed',
  timedout: 'failed',
  interrupted: 'was interrupted',
  cancelled: 'was cancelled',
};

/** How the run that answered a dispatch stands, for its "run #128 passed" line. */
export function dispatchRunResult(run: CiDispatchRun): string {
  return RUN_RESULTS[run.status] ?? run.status;
}

/** What a last re-run ran, for its "Last re-run of 3 tests" line: ` of N tests`, or nothing when it was not recorded. */
export function lastRerunScope(dispatch: RerunInfo['lastDispatch']): string {
  const n = dispatch?.tests;
  return n ? ` of ${n} test${n === 1 ? '' : 's'}` : '';
}

/**
 * Dispatch a place's CI re-run (a cluster's affected tests, or one
 * execution's test) through `POST /api/projects/:id/ci-dispatches`, with the
 * place's default action. The failure pages fetch the `RerunInfo` themselves
 * (their SSR strategies differ) but share this POST and its toasts, which say
 * what re-runs (`started`, one sentence) and link to the provider's runs; the
 * caller refreshes the info afterwards.
 */
export function useCiRerun(
  place: MaybeRefOrGetter<CiRerunPlace | null | undefined>,
  refreshRerun: () => unknown,
  started: MaybeRefOrGetter<string> = 'The affected tests are re-running in CI.',
) {
  const toast = useToast();
  const rerunning = ref(false);

  async function triggerRerun() {
    const target = toValue(place);
    if (!target || rerunning.value) return;
    rerunning.value = true;
    try {
      const dispatch = await $fetch<CiDispatchView>(`/api/projects/${target.projectId}/ci-dispatches`, {
        method: 'POST',
        body: { source: target.source },
      });
      const watch = dispatch.url;
      toast.add({
        title: 'CI re-run dispatched',
        description: toValue(started),
        color: 'success',
        ...(watch
          ? { actions: [{ label: 'Watch it', to: watch, target: '_blank', color: 'neutral', variant: 'outline' }] }
          : {}),
      });
      await refreshRerun();
    } catch (e: unknown) {
      const error = e as { statusCode?: number; data?: { message?: string }; message?: string };
      const message = error?.data?.message ?? 'Dispatch failed.';
      if (error?.statusCode === 409) {
        toast.add({ title: 'CI re-run already dispatched', description: message, color: 'neutral' });
        await refreshRerun();
        return;
      }
      toast.add({ title: 'CI re-run failed', description: message, color: 'error' });
    } finally {
      rerunning.value = false;
    }
  }

  return { rerunning, triggerRerun };
}
