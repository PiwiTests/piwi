/**
 * The tests a re-run of a failure cluster runs, chosen once for every surface
 * that re-runs it: the CI dispatch, the fix plan's verify command and its
 * reproduction, the cluster page's copied command and the desktop app's run.
 * Lives in `shared/handlers` so the server and the demo read it the same way.
 */
import { desc, eq } from 'drizzle-orm';
import { testCases, testRunsCases } from '../../server/database/schema';
import type { RetryCase } from '#shared/retry-command';
import type { DrizzleDB } from './db';

/** Affected tests a re-run names at most. */
export const MAX_RERUN_TESTS = 100;

/**
 * Each affected test of the cluster at the line and in the Playwright project of
 * its latest failure in the cluster, newest first, at most {@link MAX_RERUN_TESTS}.
 */
export async function clusterRerunCases(db: DrizzleDB, clusterId: number): Promise<RetryCase[]> {
  const rows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .orderBy(desc(testRunsCases.id))
    .limit(MAX_RERUN_TESTS * 10);
  const latest = new Map<number, RetryCase>();
  for (const r of rows) {
    if (r.testCaseId == null || latest.has(r.testCaseId)) continue;
    latest.set(r.testCaseId, {
      filePath: r.filePath,
      title: r.title,
      line: r.line,
      projectName: r.projectName || null,
    });
    if (latest.size >= MAX_RERUN_TESTS) break;
  }
  return [...latest.values()];
}
