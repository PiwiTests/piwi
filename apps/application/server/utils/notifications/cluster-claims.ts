/**
 * The `cluster.new` claim's own helpers, apart from the notifications that send it: startup runs
 * `releaseUnannouncedClusterClaimsOnce` before any request, so this module imports nothing that needs the
 * server's request context.
 */

import { and, eq, inArray, ne, notExists } from 'drizzle-orm';
import { failureClusters, testRuns, testRunsCases } from '../../database/schema';
import { eligibleRunSql } from '#shared/run-eligibility';
import { getAppSetting, setAppSetting } from '../app-settings';
import type { DbClient } from '../../database';

/**
 * The statuses of a run that ran to its end. A run that sends notifications
 * (the `notifications` use) announces the clusters it failed into only with
 * one of them; a cancelled, interrupted or abandoned run announces none.
 */
export const ANNOUNCING_RUN_STATUSES = ['passed', 'failed', 'timedout'];

/** The app setting that records when {@link releaseUnannouncedClusterClaimsOnce} ran on this instance. */
export const UNANNOUNCED_CLUSTER_CLAIMS_RELEASED_SETTING = 'failure_cluster_unannounced_claims_released_at';

/**
 * Release the `cluster.new` claim the migration adding `announced_at` set on
 * every stored cluster (`announced_at = created_at`) where no run that ran to
 * its end and sends notifications, other than an import, failed into the
 * cluster: no run announced it, so the next such run that fails into it does.
 * A cluster such a run failed into stays claimed, as does one claimed at
 * another time. Runs once per instance; returns how many claims it released,
 * null when it had already run.
 */
export async function releaseUnannouncedClusterClaimsOnce(db: DbClient): Promise<number | null> {
  if (await getAppSetting(db, UNANNOUNCED_CLUSTER_CLAIMS_RELEASED_SETTING)) return null;
  const announcingRun = db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(
      and(
        eq(testRunsCases.failureClusterId, failureClusters.id),
        inArray(testRuns.status, ANNOUNCING_RUN_STATUSES),
        ne(testRuns.origin, 'import'),
        eligibleRunSql('notifications'),
      ),
    );
  const released = await db
    .update(failureClusters)
    .set({ announcedAt: null })
    .where(and(eq(failureClusters.announcedAt, failureClusters.createdAt), notExists(announcingRun)))
    .returning({ id: failureClusters.id });
  await setAppSetting(db, UNANNOUNCED_CLUSTER_CLAIMS_RELEASED_SETTING, new Date().toISOString());
  return released.length;
}
