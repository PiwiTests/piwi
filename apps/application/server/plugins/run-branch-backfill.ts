import { getDatabase } from '../database';
import { readOnlyNow } from '../utils/operator-limits';
import { backfillRunBranches } from '../utils/run-branch-backfill';

/**
 * Give stored runs the branch their metadata reported, off the request path,
 * unless the instance starts read-only. New runs get it on ingest.
 */
async function backfillBranches() {
  try {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return;
    const filled = await backfillRunBranches(db);
    if (filled > 0) console.log(`[RunBranch] Set the branch of ${filled} stored runs from their metadata`);
  } catch (error) {
    console.error('[RunBranch] Error while setting the branch of stored runs:', error);
  }
}

export default defineNitroPlugin(() => {
  void backfillBranches();
});
