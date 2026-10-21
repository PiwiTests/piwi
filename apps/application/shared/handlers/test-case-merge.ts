/**
 * Merging two test cases of a project: the history of one (the source) moves to the other (the target), and the
 * source is deleted. It joins the two halves of a test's history when a rename or a move was not matched, for
 * example a test renamed before it declared an external ID, or one whose ID changed in the test management tool.
 *
 * Two test cases that ran in the same run are two tests, not one test under two names, so they are never merged.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
  bugReports,
  codeReach,
  entityLinks,
  failureClusterTestRoutes,
  flakeExperiments,
  locatorSnapshots,
  locatorUsages,
  probes,
  quarantinedTests,
  scenarioGaps,
  testCases,
  testCoverage,
  testRunsCases,
} from '../../server/database/schema';
import type { DrizzleDB } from './db';

export type MergeTestCasesError = 'not-found' | 'same-case' | 'other-project' | 'ran-together';

export type MergeTestCasesResult =
  | { ok: true; targetId: number; sourceId: number; projectId: number; executionsMoved: number }
  | { ok: false; error: MergeTestCasesError; message: string };

/**
 * A table holding rows per test case, and the columns that, with its test case, make a row unique. A source row
 * whose key the target already holds is dropped rather than moved: the target's row is the same fact, kept once.
 */
interface PerCaseTable {
  table: SQLiteTable;
  id: SQLiteColumn;
  testCaseId: SQLiteColumn;
  key: SQLiteColumn[];
}

// The per-test data recorded by runs, each unique per test case and key.
const KEYED_TABLES: PerCaseTable[] = [
  {
    table: codeReach,
    id: codeReach.id,
    testCaseId: codeReach.testCaseId,
    key: [codeReach.branch, codeReach.runtime, codeReach.file],
  },
  {
    table: locatorSnapshots,
    id: locatorSnapshots.id,
    testCaseId: locatorSnapshots.testCaseId,
    key: [locatorSnapshots.location],
  },
  {
    table: locatorUsages,
    id: locatorUsages.id,
    testCaseId: locatorUsages.testCaseId,
    key: [
      locatorUsages.browserName,
      locatorUsages.branch,
      locatorUsages.callSite,
      locatorUsages.action,
      locatorUsages.locator,
      locatorUsages.page,
    ],
  },
  {
    table: testCoverage,
    id: testCoverage.id,
    testCaseId: testCoverage.testCaseId,
    key: [testCoverage.branch, testCoverage.fragmentId],
  },
  {
    table: failureClusterTestRoutes,
    id: failureClusterTestRoutes.id,
    testCaseId: failureClusterTestRoutes.testCaseId,
    key: [failureClusterTestRoutes.projectId, failureClusterTestRoutes.fingerprint],
  },
  {
    table: probes,
    id: probes.id,
    testCaseId: probes.testCaseId,
    key: [probes.projectId, probes.routeKey, probes.fault],
  },
];

// Rows that only point at their test case: they all move.
const PLAIN_TABLES: Array<{ table: SQLiteTable; testCaseId: SQLiteColumn }> = [
  { table: testRunsCases, testCaseId: testRunsCases.testCaseId },
  { table: bugReports, testCaseId: bugReports.testCaseId },
  { table: entityLinks, testCaseId: entityLinks.testCaseId },
  { table: flakeExperiments, testCaseId: flakeExperiments.testCaseId },
  { table: scenarioGaps, testCaseId: scenarioGaps.testCaseId },
  { table: quarantinedTests, testCaseId: quarantinedTests.testCaseId },
];

/** Ids are deleted in chunks, under the database's limit on bound parameters. */
const DELETE_CHUNK = 500;

async function dropKeyedDuplicates(db: DrizzleDB, spec: PerCaseTable, targetId: number, sourceId: number) {
  const rows = (await db
    .select({ id: spec.id, testCaseId: spec.testCaseId, ...Object.fromEntries(spec.key.map((c, i) => [`k${i}`, c])) })
    .from(spec.table)
    .where(inArray(spec.testCaseId, [targetId, sourceId]))) as Array<Record<string, unknown>>;
  const keyOf = (row: Record<string, unknown>) => JSON.stringify(spec.key.map((_, i) => row[`k${i}`] ?? null));
  const held = new Set(rows.filter((r) => r.testCaseId === targetId).map(keyOf));
  const dropped = rows.filter((r) => r.testCaseId === sourceId && held.has(keyOf(r))).map((r) => r.id as number);
  for (let i = 0; i < dropped.length; i += DELETE_CHUNK) {
    await db.delete(spec.table).where(inArray(spec.id, dropped.slice(i, i + DELETE_CHUNK)));
  }
}

/** Whether the two test cases have an execution in one run. */
async function ranTogether(db: DrizzleDB, targetId: number, sourceId: number): Promise<boolean> {
  const sourceRuns = db
    .select({ runId: testRunsCases.testRunId })
    .from(testRunsCases)
    .where(eq(testRunsCases.testCaseId, sourceId));
  const [row] = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testCaseId, targetId), inArray(testRunsCases.testRunId, sourceRuns)))
    .limit(1);
  return row !== undefined;
}

/**
 * Merge the source test case into the target one. The target keeps its own title, file and describe path, the
 * newest; it takes the source's external ID and display title when it holds none, and its stored metadata
 * (tags, owner…) stays the target's. Everything the source's runs recorded moves to the target; of two rows
 * recording the same fact, the target's is kept. One active quarantine is kept: the target's when both are.
 */
export async function mergeTestCases(db: DrizzleDB, targetId: number, sourceId: number): Promise<MergeTestCasesResult> {
  if (targetId === sourceId)
    return { ok: false, error: 'same-case', message: 'A test case cannot be merged into itself' };
  const found = await db
    .select()
    .from(testCases)
    .where(inArray(testCases.id, [targetId, sourceId]));
  const target = found.find((row) => row.id === targetId);
  const source = found.find((row) => row.id === sourceId);
  if (!target || !source) return { ok: false, error: 'not-found', message: 'Test case not found' };
  if (target.projectId !== source.projectId) {
    return { ok: false, error: 'other-project', message: 'Only two test cases of one project can be merged' };
  }
  if (await ranTogether(db, targetId, sourceId)) {
    return {
      ok: false,
      error: 'ran-together',
      message: 'These two test cases ran in the same run: they are two tests, not one test under two names',
    };
  }

  const executionsMoved = await db.transaction(async (tx) => {
    const t = tx as unknown as DrizzleDB;
    for (const spec of KEYED_TABLES) await dropKeyedDuplicates(t, spec, targetId, sourceId);
    for (const spec of KEYED_TABLES) {
      await t
        .update(spec.table)
        .set({ testCaseId: targetId } as never)
        .where(eq(spec.testCaseId, sourceId));
    }

    // One active quarantine per test case: the target's wins.
    const [activeOnTarget] = await t
      .select({ id: quarantinedTests.id })
      .from(quarantinedTests)
      .where(and(eq(quarantinedTests.testCaseId, targetId), isNull(quarantinedTests.releasedAt)))
      .limit(1);
    if (activeOnTarget) {
      await t
        .delete(quarantinedTests)
        .where(and(eq(quarantinedTests.testCaseId, sourceId), isNull(quarantinedTests.releasedAt)));
    }

    const [{ moved } = { moved: 0 }] = await t
      .select({ moved: sql<number>`count(*)`.mapWith(Number) })
      .from(testRunsCases)
      .where(eq(testRunsCases.testCaseId, sourceId));
    for (const spec of PLAIN_TABLES) {
      await t
        .update(spec.table)
        .set({ testCaseId: targetId } as never)
        .where(eq(spec.testCaseId, sourceId));
    }

    await t.delete(testCases).where(eq(testCases.id, sourceId));
    const adopted: Record<string, unknown> = {};
    if (!target.externalId && source.externalId) {
      adopted.externalId = source.externalId;
      adopted.displayTitle = target.displayTitle ?? source.displayTitle;
    }
    if (!target.flakyRootCause && source.flakyRootCause) adopted.flakyRootCause = source.flakyRootCause;
    if (target.bugReportId == null && source.bugReportId != null) adopted.bugReportId = source.bugReportId;
    await t
      .update(testCases)
      .set({ ...adopted, updatedAt: new Date() })
      .where(eq(testCases.id, targetId));
    return moved;
  });

  return { ok: true, targetId, sourceId, projectId: target.projectId, executionsMoved };
}
