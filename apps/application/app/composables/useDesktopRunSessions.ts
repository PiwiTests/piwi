import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import type { HubSession } from '@piwitests/core/run-hub';
import { desktopSessionsOfRun } from '~/utils/desktop-run-view';

/**
 * The live runs of the Local runs entry that reports the Piwi run `run` (its id and the origin its metadata records),
 * as their hub tells them: the run page finds the worker of each running row among them (`desktopRowWorker`). Empty
 * outside the shell, and for a run the shell did not start, which the window cannot steer.
 */
export function useDesktopRunSessions(
  run: MaybeRefOrGetter<{ id: number; kind: string; ref: string | null } | null>,
): ComputedRef<HubSession[]> {
  const { runs } = useDesktopLocalRuns();
  const hub = useDesktopRunHub();
  return computed(() => desktopSessionsOfRun(toValue(run), runs.value, Object.values(hub.state.sessions)));
}
