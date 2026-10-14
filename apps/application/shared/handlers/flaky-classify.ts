/**
 * Classify (and persist) a flaky test case's root cause from its recent
 * failure evidence. Shared so the server endpoint and the demo's client-side
 * handler run the exact same query + classification + write, never two
 * hand-mirrored copies.
 *
 * Categories are assigned automatically: when a run finishes, the tests that
 * passed on retry in it are classified (`classifyRunFlakyTests`), and a flaky
 * list read fills in the tests that still have none (`withFlakyRootCauses`).
 */
import { eq, and, desc, gt, inArray } from 'drizzle-orm';
import { testCases, testRunsCases, testRuns, networkRequests } from '../../server/database/schema';
import { classifyFlakyRootCause, type BrowserOutcomes, type FlakyRootCause } from '../flaky-classify';
import { FAILED_STATUS_KEYS } from '../utils/test-counts';
import { getAttemptDiff } from './test-cases';
import { notLabRun } from './probes';
import { isOrderDependent } from './coverage-insights';
import type { DrizzleDB } from './db';

/** How many recent flaky executions to diff for the attempt-diff network vote. */
const ATTEMPT_DIFF_SAMPLE = 10;
/** How many recent failed attempts, and how many recent passes, to read the evidence from. */
const RECENT_ATTEMPTS = 100;
/** How many of a finished run's retry-passed tests are classified in the background. */
const FINALIZE_CLASSIFY_LIMIT = 20;
/** How many unclassified tests a flaky-list read classifies before it answers. */
const READ_CLASSIFY_LIMIT = 10;
/** Recent failed attempts with coverage needed before the test's path variation is read for an order dependency. */
const ORDER_MIN_FAILURES_WITH_COVERAGE = 2;

export async function classifyAndPersistFlakyRootCause(
  db: DrizzleDB,
  projectId: number,
  testCaseId: number,
): Promise<{ testCaseId: number; rootCause: FlakyRootCause }> {
  const tcRows = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(and(eq(testCases.id, testCaseId), eq(testCases.projectId, projectId)));
  if (tcRows.length === 0) throw new Error('Test case not found');

  const rootCause = await classifyFromRecentAttempts(db, testCaseId);

  await db
    .update(testCases)
    .set({ flakyRootCause: rootCause, updatedAt: new Date() })
    .where(eq(testCases.id, testCaseId));

  return { testCaseId, rootCause };
}

async function classifyFromRecentAttempts(db: DrizzleDB, testCaseId: number): Promise<FlakyRootCause> {
  // The test's recent failed attempts and its recent passes, read apart so a
  // rare flake keeps its failures however many passes came since. Both come
  // from green runs as well as red ones: a retry-pass leaves its failed attempt
  // in a run that finished green. Lab runs (probes, flake experiments) fail by
  // design under an injected fault or condition, so their executions are left
  // out of the evidence.
  const recentAttempts = (statuses: string[]) =>
    db
      .select({
        id: testRunsCases.id,
        status: testRunsCases.status,
        error: testRunsCases.error,
        steps: testRunsCases.steps,
        browser: testRunsCases.browser,
        coveragePayloadId: testRunsCases.coveragePayloadId,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(
        and(
          eq(testRunsCases.testCaseId, testCaseId),
          inArray(testRunsCases.status, statuses),
          notLabRun(testRuns.origin),
        ),
      )
      .orderBy(desc(testRunsCases.createdAt))
      .limit(RECENT_ATTEMPTS);
  const recentFailures = await recentAttempts([...FAILED_STATUS_KEYS]);

  if (recentFailures.length === 0) return 'other';
  const recentPasses = await recentAttempts(['passed']);

  const errorMessages: string[] = [];
  const stepErrors: string[] = [];
  const stepNames: string[] = [];
  const browserDistribution: Record<string, BrowserOutcomes> = {};

  for (const row of recentFailures) {
    if (row.error) errorMessages.push(row.error);
    const steps = row.steps as Array<{ title: string; category: string; duration: number }> | null;
    if (steps) {
      for (const s of steps) {
        stepNames.push(s.title);
        if (s.title.toLowerCase().includes('error') || s.title.toLowerCase().includes('fail')) {
          stepErrors.push(s.title);
        }
      }
    }
  }
  for (const row of [...recentFailures, ...recentPasses]) {
    const b = row.browser as Record<string, unknown> | null;
    const browserKey = (b?.projectName as string) ?? (b?.browserName as string) ?? '';
    if (!browserKey) continue;
    const outcomes = (browserDistribution[browserKey] ??= { passed: 0, failed: 0 });
    if (row.status === 'passed') outcomes.passed++;
    else outcomes.failed++;
  }

  // Count the failed requests actually captured across the recent failing
  // attempts.
  let networkErrorCount = 0;
  let status5xxCount = 0;
  const failingIds = recentFailures.map((r) => r.id);
  if (failingIds.length > 0) {
    const netRows = await db
      .select({ status: networkRequests.status })
      .from(networkRequests)
      .where(inArray(networkRequests.testRunsCaseId, failingIds));
    for (const nr of netRows) {
      const s = nr.status ?? 0;
      if (s === 0) networkErrorCount++;
      else if (s >= 500) status5xxCount++;
    }
  }

  // The sharpest network signal: a recent flaky execution whose failing attempt
  // had a request that failed (or 5xx'd) and the passing attempt did not.
  let attemptDiffNetworkVotes = 0;
  const flakyExecutions = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, testCaseId),
        eq(testRunsCases.status, 'passed'),
        gt(testRunsCases.retries, 0),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRunsCases.createdAt))
    .limit(ATTEMPT_DIFF_SAMPLE);
  for (const exec of flakyExecutions) {
    const diff = await getAttemptDiff(db, exec.id);
    if (diff.differences.some((d) => d.kind === 'network' && d.only === 'failing')) {
      attemptDiffNetworkVotes++;
    }
  }

  // Only a test whose recent failures recorded coverage has its path variation read.
  const failuresWithCoverage = recentFailures.filter((r) => r.coveragePayloadId != null).length;
  const orderDependent =
    failuresWithCoverage >= ORDER_MIN_FAILURES_WITH_COVERAGE && (await isOrderDependent(db, testCaseId));

  return classifyFlakyRootCause({
    errorMessages,
    stepErrors,
    stepNames,
    networkErrorCount,
    status5xxCount,
    attemptDiffNetworkVotes,
    browserDistribution,
    orderDependent,
  });
}

/** Classify the cases one after another; a case that fails is logged and skipped. */
async function classifyEach(db: DrizzleDB, projectId: number, testCaseIds: number[]) {
  const classified = new Map<number, FlakyRootCause>();
  for (const testCaseId of testCaseIds) {
    try {
      classified.set(testCaseId, (await classifyAndPersistFlakyRootCause(db, projectId, testCaseId)).rootCause);
    } catch (e) {
      console.error('[flaky-classify] classifyAndPersistFlakyRootCause failed', testCaseId, e);
    }
  }
  return classified;
}

/**
 * Classify the tests that passed on retry in a finished run, so a category
 * follows every new flake and stays current as the evidence grows.
 */
export async function classifyRunFlakyTests(db: DrizzleDB, projectId: number, runId: number): Promise<void> {
  const flaky = await db
    .selectDistinct({ testCaseId: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.status, 'passed'), gt(testRunsCases.retries, 0)))
    .limit(FINALIZE_CLASSIFY_LIMIT);
  await classifyEach(
    db,
    projectId,
    flaky.map((r) => r.testCaseId),
  );
}

/**
 * Flaky-list items with the root cause of the first few that have none
 * classified in. Each classification is stored, so a test is classified once
 * and the rest follow on the next reads.
 */
export async function withFlakyRootCauses<T extends { testCaseId: number; rootCause: string | null }>(
  db: DrizzleDB,
  projectId: number,
  items: T[],
): Promise<T[]> {
  const unclassified = items
    .filter((i) => !i.rootCause)
    .slice(0, READ_CLASSIFY_LIMIT)
    .map((i) => i.testCaseId);
  if (unclassified.length === 0) return items;
  const classified = await classifyEach(db, projectId, unclassified);
  return items.map((i) => {
    const rootCause = classified.get(i.testCaseId);
    return rootCause ? { ...i, rootCause } : i;
  });
}
