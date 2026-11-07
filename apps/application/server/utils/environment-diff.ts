/**
 * Environment diff — compare a failing execution's environment against the same
 * test's most recent passing execution: the run's columns and metadata, the
 * declared browser settings (test_runs_cases.browser) and the run's environment
 * snapshots (the runner of the execution's shard, the browser of its shard and
 * project, the servers under test). Used by the REST endpoint, the AI diagnosis section, and the
 * demo router (browser-safe: drizzle queries only).
 */
import { and, eq, desc } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../database/schema';
import { buildEnvironmentSnapshot, computeEnvironmentDiff, type EnvironmentDiffEntry } from '#shared/environment-diff';
import { loadRunsSnapshots } from '#shared/handlers/environment-snapshots';
import { CLOCK_OFFSET_WARN_MS } from '#shared/environment-snapshots';
import type { WireEnvironmentSnapshot, WireServerEnvironment } from '#shared/types';
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
  /** What the failing run's servers under test tell on their own: a restart, a clock off from the runner's. */
  serverNotes?: string[];
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

/** The snapshots of the execution's place: its shard's runner, its shard's and project's browser, the servers. */
function executionSnapshots(row: ExecutionEnvironmentRow, snapshots: readonly WireEnvironmentSnapshot[]) {
  const shard = row.shardIndex ?? null;
  const project = (row.browser as BrowserConfig | null)?.projectName ?? null;
  const runners = snapshots.filter((s) => s.kind === 'runner');
  const runner = runners.find((s) => (s.shardIndex ?? null) === shard) ?? (runners.length === 1 ? runners[0] : null);
  const browsers = snapshots.filter((s) => s.kind === 'browser');
  const browser =
    browsers.find((s) => s.project === project && (s.shardIndex ?? null) === shard) ??
    browsers.find((s) => s.project === project) ??
    null;
  const servers = snapshots.filter((s): s is WireServerEnvironment => s.kind === 'server');
  return { runner: runner ?? null, observedBrowser: browser, servers };
}

/** The lines a run's servers under test add on their own: a restart during the run, a clock off from the runner's. */
export function serverEnvironmentNotes(servers: readonly WireServerEnvironment[]): string[] {
  const notes: string[] = [];
  for (const server of servers) {
    if (server.restarted) notes.push(`Server ${server.origin} restarted during the failing run.`);
    if (server.clockOffsetMs != null && Math.abs(server.clockOffsetMs) > CLOCK_OFFSET_WARN_MS) {
      const error = server.clockOffsetErrorMs != null ? ` (± ${server.clockOffsetErrorMs} ms)` : '';
      notes.push(
        `Server ${server.origin}'s clock is ${server.clockOffsetMs} ms off the runner's${error}: token expiry and "created just now" checks can fail.`,
      );
    }
  }
  return notes;
}

function toSnapshot(row: ExecutionEnvironmentRow, snapshots: readonly WireEnvironmentSnapshot[]) {
  const meta = (row.runMetadata as RunMetadataLens | null) ?? null;
  return buildEnvironmentSnapshot({
    ...executionSnapshots(row, snapshots),
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
  const snapshots = await loadRunsSnapshots(db, [failing.runId, baseline.runId]);
  const failingSnapshots = snapshots.get(failing.runId) ?? [];
  const entries = computeEnvironmentDiff(
    toSnapshot(failing, failingSnapshots),
    toSnapshot(baseline, snapshots.get(baseline.runId) ?? []),
  ).filter((entry) => !(baselineNote && entry.key === 'environment'));

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
    serverNotes: serverEnvironmentNotes(executionSnapshots(failing, failingSnapshots).servers),
  };
}
