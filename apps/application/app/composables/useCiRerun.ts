import type { MaybeRefOrGetter } from 'vue';
import type { CiDispatchRun, CiDispatchView } from '#shared/ci-dispatches';

/** A CI re-run's availability and last dispatch, from a cluster's or an execution's `/rerun`. */
export interface RerunInfo {
  available: boolean;
  reason: string | null;
  provider: string | null;
  /** The CI action a dispatch would run, or null when none can. */
  action?: { id: string; name: string } | null;
  enabled: boolean;
  hasToken: boolean;
  /** The last dispatch the provider took, with the run that answered it. */
  lastDispatch: CiDispatchView | null;
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
 * Dispatch a CI re-run through a `/rerun` route (a cluster's affected tests, or
 * one execution's test). The failure pages fetch the `RerunInfo` themselves
 * (their SSR strategies differ) but share this POST and its toasts, which say
 * what re-runs (`started`, one sentence) and link to the provider's runs; the
 * caller refreshes the info afterwards.
 */
export function useCiRerun(
  endpoint: MaybeRefOrGetter<string | null | undefined>,
  refreshRerun: () => unknown,
  started: MaybeRefOrGetter<string> = 'The affected tests are re-running in CI.',
) {
  const toast = useToast();
  const rerunning = ref(false);

  async function triggerRerun() {
    const url = toValue(endpoint);
    if (!url || rerunning.value) return;
    rerunning.value = true;
    try {
      const res = await $fetch<{ ok: boolean; message?: string; dispatch?: { url: string | null } }>(url, {
        method: 'POST',
      });
      if (res.ok && res.dispatch) {
        const watch = res.dispatch.url;
        toast.add({
          title: 'CI re-run dispatched',
          description: toValue(started),
          color: 'success',
          ...(watch
            ? { actions: [{ label: 'Watch it', to: watch, target: '_blank', color: 'neutral', variant: 'outline' }] }
            : {}),
        });
        await refreshRerun();
      } else {
        toast.add({ title: 'CI re-run not started', description: res.message ?? 'Not available.', color: 'warning' });
      }
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
