import { getDatabase } from '../database';
import { createReachability, interruptStaleRuns, settleStaleFinalizingRuns } from '../utils/stale-runs';

const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds

const reachability = createReachability(CHECK_INTERVAL_MS);

async function cleanupStaleRuns() {
  const reachableSince = reachability.beginSweep(Date.now());
  if (reachableSince === null) return;
  try {
    const db = await getDatabase();
    const reaped = await interruptStaleRuns(db, Date.now(), reachableSince);
    if (reaped.length > 0) {
      console.log(`[StaleRunCleanup] Marked ${reaped.length} stale run(s) as interrupted: ${reaped.join(', ')}`);
    }
    const settled = await settleStaleFinalizingRuns(db, Date.now(), reachableSince);
    if (settled.length > 0) {
      console.log(
        `[StaleRunCleanup] Settled ${settled.length} finalizing run(s) whose report upload never arrived: ${settled.join(', ')}`,
      );
    }
  } catch (error) {
    reachability.failed(Date.now());
    console.error('[StaleRunCleanup] Error during stale run cleanup:', error);
  }
}

export default defineNitroPlugin((nitroApp) => {
  // A run's quiet time counts from the moment the database is ready at the earliest.
  getDatabase().then(
    () => reachability.ready(Date.now()),
    () => {},
  );
  const interval = setInterval(cleanupStaleRuns, CHECK_INTERVAL_MS);

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval);
  });
});
