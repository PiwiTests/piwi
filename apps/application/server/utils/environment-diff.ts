/**
 * Environment diff — compare a failing execution's run/browser environment
 * against the same test's most recent passing execution. All from data already
 * stored (test_runs columns/metadata + test_runs_cases.browser); no extra
 * collection. Used by the REST endpoint, the AI diagnosis section, and the
 * demo router (browser-safe: drizzle queries only).
 */
import { and, eq, desc } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../database/schema';
import { buildEnvironmentSnapshot, computeEnvironmentDiff, type EnvironmentDiffEntry } from '#shared/environment-diff';
import { baselineEnvironmentNote, rankBaselineCandidates } from '#shared/baseline-order';
import { resolveRunBranch } from './run-branch';
import type { BrowserConfig } from '#shared/types';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleRunSql } from '#shared/run-eligibility';

/** Passing executions inspected when choosing the baseline. */
const BASELINE_CANDIDATES = 20;

export interface EnvironmentDiffResult {
  status: 'ok' | 'no-baseline' | 'not-found';
  /** The passing execution the failing one was compared against. */
  baseline?: {
    runId: number;
    executionId: number;
    /** Run start time (epoch ms) — null when the run has no start time. */
    startTime: number | null;
    /** Environment label of the baseline run. */
    environment: string | null;
  };
  /**
   * Set when no passing execution from the failing run's environment exists and
   * the baseline came from another one — the environment label is then left
   * out of `entries`, since the choice, not the app, put it there.
   */
  baselineNote?: string | null;
  /** Changed keys only; empty array means "environment identical to last pass". */
  entries?: EnvironmentDiffEntry[];
}

interface RunMetadataLens {
  scm?: { branch?: string | null } | null;
  ci?: { provider?: string | null } | null;
}

function selectExecutionEnvironment(db: DrizzleDB, where: ReturnType<typeof and>) {
  return db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      browser: testRunsCases.browser,
      browserName: testRunsCases.browserName,
      workerIndex: testRunsCases.workerIndex,
      parallelIndex: testRunsCases.parallelIndex,
      shardIndex: testRunsCases.shardIndex,
      runId: testRuns.id,
      runEnvironment: testRuns.environment,
      runMetadata: testRuns.metadata,
      playwrightVersion: testRuns.playwrightVersion,
      reporterVersion: testRuns.reporterVersion,
      startTime: testRuns.startTime,
      runBranch: testRuns.branch,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(where)
    .orderBy(desc(testRuns.startTime), desc(testRunsCases.id));
}

function loadExecutionEnvironment(db: DrizzleDB, where: ReturnType<typeof and>) {
  return selectExecutionEnvironment(db, where)
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

type ExecutionEnvironmentRow = NonNullable<Awaited<ReturnType<typeof loadExecutionEnvironment>>>;

function scopeOf(row: ExecutionEnvironmentRow) {
  return { environment: row.runEnvironment ?? null, branch: row.runBranch ?? resolveRunBranch(row.runMetadata) };
}

function toSnapshot(row: ExecutionEnvironmentRow) {
  const meta = (row.runMetadata as RunMetadataLens | null) ?? null;
  return buildEnvironmentSnapshot({
    playwrightVersion: row.playwrightVersion,
    reporterVersion: row.reporterVersion,
    environment: row.runEnvironment,
    ciProvider: meta?.ci?.provider ?? null,
    scmBranch: meta?.scm?.branch ?? null,
    browser: (row.browser as BrowserConfig | null) ?? null,
    workerIndex: row.workerIndex,
    parallelIndex: row.parallelIndex,
    shardIndex: row.shardIndex,
  });
}

/**
 * Diff one execution's environment against the same test's last passing
 * execution — pinned to the same browser when known (a chromium failure is
 * never compared against a webkit pass), preferring the same environment, then
 * the same branch, then the most recent. When the baseline had to come from
 * another environment, `baselineNote` says so and the environment label is not
 * reported as a change.
 */
export async function getEnvironmentDiff(db: DrizzleDB, testRunsCaseId: number): Promise<EnvironmentDiffResult> {
  const failing = await loadExecutionEnvironment(db, and(eq(testRunsCases.id, testRunsCaseId)));
  if (!failing || failing.testCaseId == null) return { status: 'not-found' };

  const baselineConds = [
    eq(testRunsCases.testCaseId, failing.testCaseId),
    eq(testRunsCases.status, 'passed'),
    eligibleRunSql('baseline'),
  ];
  if (failing.browserName) baselineConds.push(eq(testRunsCases.browserName, failing.browserName));

  const candidates = await selectExecutionEnvironment(db, and(...baselineConds)).limit(BASELINE_CANDIDATES);
  const failingScope = scopeOf(failing);
  const baseline = rankBaselineCandidates(
    failingScope,
    candidates.map((row) => ({ ...scopeOf(row), row })),
  )[0]?.row;
  if (!baseline) return { status: 'no-baseline' };

  const baselineNote = baselineEnvironmentNote(failingScope, scopeOf(baseline));
  const entries = computeEnvironmentDiff(toSnapshot(failing), toSnapshot(baseline)).filter(
    (entry) => !(baselineNote && entry.key === 'environment'),
  );

  return {
    status: 'ok',
    baseline: {
      runId: baseline.runId,
      executionId: baseline.id,
      startTime: baseline.startTime instanceof Date ? baseline.startTime.getTime() : (baseline.startTime ?? null),
      environment: baseline.runEnvironment ?? null,
    },
    baselineNote,
    entries,
  };
}
