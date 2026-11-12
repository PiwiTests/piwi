import { runEventBus } from '../utils/run-events';
import { pendingStatuses } from '../utils/scm/pending-status';

/** A CI run's pending commit status follows its tally while it runs (`pending-status.ts`). */
export default defineNitroPlugin((nitroApp) => {
  const stop = runEventBus.subscribeRunProgress((progress) => pendingStatuses.progress(progress));
  nitroApp.hooks.hook('close', stop);
});
