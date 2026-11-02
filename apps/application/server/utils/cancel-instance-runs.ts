import { runEventBus } from './run-events';
import { cancelInstanceRuns as sharedCancelInstanceRuns } from '#shared/handlers/failure-cluster-ops';
import type { DbClient as DB } from '../database';

/**
 * Cancel the instance's runs in flight (`#shared/handlers/failure-cluster-ops`) and announce each. What the server
 * holds in memory for a cancelled run goes, its stream token with it, so its reporter's next request reads the run
 * from the database and is refused (`authorizeStreamToken`).
 */
export async function cancelInstanceRuns(
  db: DB,
  projectId: number,
  instanceId: string | null,
  excludeRunId?: number,
  isShardedRun?: boolean,
) {
  const cancelledRuns = await sharedCancelInstanceRuns(db, projectId, instanceId, excludeRunId, isShardedRun);
  for (const run of cancelledRuns) {
    runEventBus.cleanup(run.id);
    runEventBus.publishGlobal({ type: 'run-cancelled', runId: run.id, projectId: run.projectId, status: 'cancelled' });
  }
}
