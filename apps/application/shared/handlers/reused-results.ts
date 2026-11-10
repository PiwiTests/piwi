/**
 * A run's reused results: the tests its pass reuse plan skipped, each with the
 * earlier pass that stood in for it. Served by `GET /api/test-runs/:id/reused`
 * and its demo mirror.
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { reusedResults, testCases, testRuns } from '../../server/database/schema';
import type { DrizzleDB } from './db';

/** Reused results one answer lists at most. */
const MAX_LISTED = 500;

export interface ReusedResultItem {
  testCaseId: number;
  title: string;
  filePath: string;
  /** The Playwright projects it was skipped in. */
  projects: string[];
  sourceRunId: number | null;
  /** A final attempt of the pass it reuses, to open; null when none was recorded. */
  sourceExecutionId: number | null;
  sourceCommit: string;
  /** When the pass's run started, ISO 8601; null once that run is pruned. */
  sourceStartedAt: string | null;
}

export interface RunReusedResults {
  count: number;
  planId: number | null;
  items: ReusedResultItem[];
  /** True when the run reused more tests than the answer lists. */
  truncated: boolean;
}

export async function getRunReusedResults(db: DrizzleDB, runId: number): Promise<RunReusedResults> {
  const rows = await db
    .select({
      testCaseId: reusedResults.testCaseId,
      projects: reusedResults.projects,
      sourceRunId: reusedResults.sourceRunId,
      sourceExecutionIds: reusedResults.sourceExecutionIds,
      sourceCommit: reusedResults.sourceCommit,
      planId: reusedResults.planId,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(reusedResults)
    .innerJoin(testCases, eq(testCases.id, reusedResults.testCaseId))
    .where(eq(reusedResults.runId, runId))
    .orderBy(asc(testCases.filePath), asc(testCases.title))
    .limit(MAX_LISTED + 1);
  const listed = rows.slice(0, MAX_LISTED);
  const sourceRunIds = [...new Set(listed.flatMap((r) => (r.sourceRunId == null ? [] : [r.sourceRunId])))];
  const started = new Map<number, Date>();
  if (sourceRunIds.length > 0) {
    const runs = await db
      .select({ id: testRuns.id, startTime: testRuns.startTime })
      .from(testRuns)
      .where(inArray(testRuns.id, sourceRunIds));
    for (const run of runs) started.set(run.id, run.startTime);
  }
  const [run] = await db.select({ reusedCount: testRuns.reusedCount }).from(testRuns).where(eq(testRuns.id, runId));
  const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : []);
  return {
    count: run?.reusedCount ?? 0,
    planId: rows[0]?.planId ?? null,
    items: listed.map((r) => ({
      testCaseId: r.testCaseId,
      title: r.title,
      filePath: r.filePath,
      projects: Array.isArray(r.projects) ? r.projects.filter((p): p is string => typeof p === 'string') : [],
      sourceRunId: r.sourceRunId,
      sourceExecutionId: ids(r.sourceExecutionIds)[0] ?? null,
      sourceCommit: r.sourceCommit,
      sourceStartedAt:
        r.sourceRunId != null && started.has(r.sourceRunId) ? started.get(r.sourceRunId)!.toISOString() : null,
    })),
    truncated: rows.length > MAX_LISTED,
  };
}
