import type { HubSession } from '@piwitests/core/run-hub';
import { endedAtStopWords } from '@piwitests/run-model/outcome';
import { englishRunSpeaker } from '@piwitests/run-model/words';
import { flakeLabOutcome, localRunProgressLabel, type LocalRun } from '~/composables/useDesktopLocalRuns';
import { desktopRunOf, desktopRunProgress, type DesktopRunCount } from '~/utils/desktop-run-view';
import type { BadgeColor } from '~/utils';

/** A run's state as the Local runs tray and its output window show it: its words and color. */
export interface LocalRunBadge {
  label: string;
  color: BadgeColor;
}

/**
 * How far each run of the Local runs tray is and how it stands, as its steps' own processes count it on the runs' hub
 * (`desktopRunProgress`): live while the window holds the hub's stream, as each step last counted once it ended.
 * `badge` is the state the tray, its compact rows and a run's output window show.
 */
export function useDesktopRunBadge() {
  const hub = useDesktopRunHub();
  const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

  function count(run: Pick<LocalRun, 'hubRefs'>): DesktopRunCount | null {
    return desktopRunProgress(run, sessions.value, hub.state.endedProgress);
  }

  /** How many tests of a run's steps were ended at a stop (End the test), as the hub heard them end. */
  function endedAtStop(run: Pick<LocalRun, 'hubRefs'>): number {
    return Object.entries(hub.state.endedAtStop).reduce(
      (sum, [ref, ended]) => sum + (run.hubRefs.includes(desktopRunOf(ref)) ? ended : 0),
      0,
    );
  }

  function badge(run: LocalRun): LocalRunBadge {
    switch (run.status) {
      case 'running':
        return { label: localRunProgressLabel(run, count(run)), color: run.stopRequested ? 'neutral' : 'info' };
      case 'passed': {
        if (run.kind === 'flake') {
          return flakeLabOutcome(run.exitCode) === 'reproduced'
            ? { label: 'Reproduced', color: 'success' }
            : { label: 'Not reproduced', color: 'neutral' };
        }
        // A test ended at a stop is skipped: the run passed, marked so.
        const ended = endedAtStopWords(endedAtStop(run), englishRunSpeaker);
        return { label: ended ? `Passed · ${ended}` : 'Passed', color: 'success' };
      }
      case 'failed':
        return { label: run.exitCode != null ? `Failed (exit ${run.exitCode})` : 'Failed', color: 'error' };
      case 'stopped':
        return { label: 'Stopped', color: 'neutral' };
      default:
        return { label: 'Could not run', color: 'error' };
    }
  }

  return { count, badge };
}
