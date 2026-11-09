/**
 * Client-side implementations of the /api/test-runs* endpoints for demo mode.
 *
 * Only contains functions that are NOT trivial shared-handler wrappers
 * (those are inlined directly in router.ts).
 */

import { eq, sql } from 'drizzle-orm';
import { getDemoDb } from '../db.client';
import { testRuns, testRunsCases, files } from '~~/server/database/schema.sqlite';
import { recomputeClusterOccurrences } from '#shared/handlers/failure-cluster-ops';
import { demoHttpError } from './http-error';
import { isRunKept, keptRunDeleteMessage } from '#shared/handlers/run-keep';
import { recomputeRollupCells } from '#shared/handlers/analytics/rollups';
import { dayKey } from '#shared/handlers/analytics/common';
import { dropProjectTestFilters } from '#shared/handlers/analytics/test-filter-memo';

/** DELETE /api/test-runs/:id */
export async function apiDeleteTestRun(id: number) {
  const db = await getDemoDb();

  const runRows = await db
    .select({ id: testRuns.id, projectId: testRuns.projectId, startTime: testRuns.startTime })
    .from(testRuns)
    .where(eq(testRuns.id, id));
  if (!runRows[0]) throw demoHttpError(404, 'Test run not found');
  if (await isRunKept(db, id)) throw demoHttpError(409, keptRunDeleteMessage(id));

  // Remember the clusters this run contributed to; their occurrence counters
  // must be recomputed after the cases are gone (mirrors the server route).
  const runsCases = await db
    .select({ id: testRunsCases.id, failureClusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, id));
  const affectedClusterIds = [
    ...new Set(runsCases.map((c) => c.failureClusterId).filter((x): x is number => x != null)),
  ];
  const caseIds = runsCases.map((c) => c.id);
  if (caseIds.length > 0) {
    await db.delete(files).where(
      sql`${files.testRunsCaseId} IN (${sql.join(
        caseIds.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
  }

  await db.delete(files).where(eq(files.testRunId, id));
  await db.delete(testRunsCases).where(eq(testRunsCases.testRunId, id));
  await db.delete(testRuns).where(eq(testRuns.id, id));
  // Deleting a run by hand is a correction: its numbers leave the day.
  await recomputeRollupCells(db, [{ projectId: runRows[0].projectId, day: dayKey(runRows[0].startTime) }]);

  for (const clusterId of affectedClusterIds) {
    await recomputeClusterOccurrences(db, clusterId);
  }
  dropProjectTestFilters(runRows[0].projectId);
  return { success: true };
}
