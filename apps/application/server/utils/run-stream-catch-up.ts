import { asc, eq } from 'drizzle-orm';
import { testCases, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';

/**
 * The catch-up a run's stream sends a page that connects: the `run-finished` of
 * a run that already ended, and the `test-completed` of each stored execution.
 * The server's stream and the demo's both send it, ahead of the tests still running.
 */

/** A run's final counts, as its `run-finished` event carries them. */
export function runFinishedEventData(run: {
  status: string;
  duration: number | null;
  totalTests: number | null;
  passedTests: number | null;
  failedTests: number | null;
  skippedTests: number | null;
  didNotRunTests: number | null;
}): Record<string, unknown> {
  return {
    status: run.status,
    duration: run.duration,
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    skippedTests: run.skippedTests,
    didNotRunTests: run.didNotRunTests,
  };
}

/** The `test-completed` data of each stored execution of the run, each test's attempts in order (error left out). */
export async function storedCaseEventData(db: DrizzleDB, runId: number): Promise<Record<string, unknown>[]> {
  const existingCases = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      title: testCases.title,
      externalId: testCases.externalId,
      displayTitle: testCases.displayTitle,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      line: testRunsCases.line,
      column: testRunsCases.column,
      workerIndex: testRunsCases.workerIndex,
      parallelIndex: testRunsCases.parallelIndex,
      shardIndex: testRunsCases.shardIndex,
      startedAt: testRunsCases.startedAt,
      browser: testRunsCases.browser,
      tags: testRunsCases.tags,
      locks: testRunsCases.locks,
      testMeta: testRunsCases.testMeta,
      testAnnotations: testRunsCases.testAnnotations,
      retries: testRunsCases.retries,
      attempts: testRunsCases.attempts,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      didNotRunReason: testRunsCases.didNotRunReason,
      expectedStatus: testRunsCases.expectedStatus,
      blockedBy: testRunsCases.blockedBy,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId))
    // Each test's attempts in order, so its latest one is replayed last.
    .orderBy(asc(testRunsCases.retries), asc(testRunsCases.id));

  return existingCases.map((tc) => ({
    title: tc.title,
    externalId: tc.externalId ?? null,
    displayTitle: tc.displayTitle ?? null,
    filePath: tc.filePath,
    suitePath: tc.suitePath ? tc.suitePath.split('\x1f') : null,
    status: tc.status,
    duration: tc.duration,
    location: tc.line && tc.column ? `${tc.filePath}:${tc.line}:${tc.column}` : tc.filePath,
    workerIndex: tc.workerIndex ?? null,
    parallelIndex: tc.parallelIndex ?? null,
    shardIndex: tc.shardIndex ?? null,
    startedAt: tc.startedAt ?? null,
    browser: tc.browser ?? null,
    tags: tc.tags ?? null,
    locks: tc.locks ?? null,
    testMeta: tc.testMeta ?? null,
    testAnnotations: tc.testAnnotations ?? null,
    retries: tc.retries ?? null,
    attempts: tc.attempts ?? null,
    passedAfterFailure: tc.passedAfterFailure,
    repeatEachIndex: tc.repeatEachIndex,
    didNotRunReason: tc.didNotRunReason ?? null,
    expectedStatus: tc.expectedStatus ?? null,
    blockedBy: tc.blockedBy ?? null,
    executionId: tc.id,
    testCaseId: tc.testCaseId,
  }));
}
