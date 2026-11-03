import type { ComputedRef } from 'vue';
import type { HubSession } from '@piwitests/core/run-hub';
import { desktopRunOf } from '~/utils/desktop-run-view';

/**
 * The live runs the desktop shell started that report to the Piwi run `runId` (the Local runs entries linked to it, by
 * their steps' names), as their hub tells them: the run page finds the worker of each running row among them
 * (`desktopRowWorker`). Empty outside the shell, and for a run the shell did not start, which the window cannot steer.
 */
export function useDesktopRunSessions(runId: number): ComputedRef<HubSession[]> {
  const { runs } = useDesktopLocalRuns();
  const hub = useDesktopRunHub();
  return computed(() => {
    const refs = new Set(runs.value.filter((run) => run.piwiRunId === runId).flatMap((run) => run.hubRefs));
    if (refs.size === 0) return [];
    return Object.values(hub.state.sessions).filter((session) => refs.has(desktopRunOf(session.ref)));
  });
}
