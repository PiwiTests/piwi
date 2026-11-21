import type { HubSession } from '@piwitests/core/run-hub';
import type { LocalRun } from '~/composables/useDesktopLocalRuns';
import { desktopHeldSessions, desktopRunHoldRefusal, desktopRunHolds } from '~/utils/desktop-run-view';

/**
 * The **Hold failures** of a running run of the Local runs tray, as its switch and the run's own window show it:
 * whether it holds its failures, why it holds none (a run nobody attends, by its kind or as the hub names its steps),
 * and the person turning it over, its live steps at once and the steps to come as they start.
 */
export function useDesktopRunHold() {
  const { holds } = useDesktopLocalRuns();
  const hub = useDesktopRunHub();
  const liveSessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

  return {
    refusal: (run: LocalRun): string | null => desktopRunHoldRefusal(run, liveSessions.value),
    holdsFailures: (run: LocalRun): boolean => desktopRunHolds(run, holds.value[run.key], liveSessions.value),
    setHold(run: LocalRun, on: boolean): void {
      for (const session of desktopHeldSessions(run, liveSessions.value)) {
        void hub.command({ type: 'hold', ref: session.ref, on });
      }
      holds.value = { ...holds.value, [run.key]: on };
    },
  };
}
