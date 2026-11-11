import { getDatabase } from '../database';
import { runEventBus } from '../utils/run-events';
import { closePendingStatus, pendingStatuses } from '../utils/scm/pending-status';

/**
 * A CI run's pending commit status follows its tally while it runs (`pending-status.ts`). A run cancelled or interrupted
 * gets its closing status at once; one that finishes gets its final status from its PR feedback, or a closing one from
 * `runFinalizeSideEffects` when no feedback goes.
 */
export default defineNitroPlugin((nitroApp) => {
  const stopProgress = runEventBus.subscribeRunProgress((progress) => pendingStatuses.progress(progress));
  const stopEnds = runEventBus.subscribeGlobal((event) => {
    if (event.type !== 'run-cancelled' && !(event.type === 'run-finished' && event.status === 'interrupted')) return;
    void getDatabase()
      .then((db) => closePendingStatus(db, event.runId))
      .catch((e) => console.error('[pr-feedback] closing the pending status failed', e));
  });
  nitroApp.hooks.hook('close', () => {
    stopProgress();
    stopEnds();
  });
});
