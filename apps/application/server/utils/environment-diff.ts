/**
 * Environment diff — compare a failing execution's environment against the same
 * test's most recent passing execution: the run's columns and metadata, the
 * declared browser settings (test_runs_cases.browser) and the run's environment
 * snapshots (the runner of the execution's shard, the browser of its shard and
 * project, the servers under test). Used by the REST endpoint, the AI diagnosis section, and the
 * demo router (browser-safe: drizzle queries only).
 */
import { and, eq, desc, isNull, or, sql, type SQL } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../database/schema';
import {
  buildEnvironmentSnapshot,
  computeEnvironmentDiff,
  type EnvironmentDiffEntry,
  type EnvironmentSnapshot,
} from '#shared/environment-diff';
import { loadRunsSnapshots } from '#shared/handlers/environment-snapshots';
import { CLOCK_OFFSET_WARN_MS, comparableSnapshots, runnerOfShard } from '#shared/environment-snapshots';
import type { WireEnvironmentSnapshot, WireServerEnvironment } from '#shared/types';
import { baselineEnvironmentNote, rankBaselineCandidates } from '#shared/baseline-order';
import { resolveRunBranch } from './run-branch';
import type { BrowserConfig } from '#shared/types';
import type { DrizzleDB } from '#shared/handlers/db';
import { CI_RUN_ORIGINS, eligibleRunSql, runOriginIn } from '#shared/run-eligibility';
import type { TestComparisonClosestPass } from '#shared/test-comparison';
import { sameCommit } from '#shared/test-comparison-conclusion';
import { foldedEquals } from '#shared/utils/fold-text-sql';

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
  scm?: { branch?: string | null; worktree?: string | null } | null;
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
      runCommit: testRuns.commit,
      runEnvironmentId: testRuns.environmentId,
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
  const runner = runnerOfShard(comparableSnapshots(snapshots), shard);
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

/** One execution's environment snapshot, as the environment diff reads it; null for an execution that does not exist. */
export async function executionEnvironmentSnapshot(
  db: DrizzleDB,
  executionId: number,
): Promise<EnvironmentSnapshot | null> {
  const row = await loadExecutionEnvironment(db, and(eq(testRunsCases.id, executionId)));
  if (!row) return null;
  const snapshots = await loadRunsSnapshots(db, [row.runId]);
  return toSnapshot(row, snapshots.get(row.runId) ?? []);
}

/**
 * A run's commit matches `commit`, a short SHA and a full one either way round: the stored commit starts with
 * `commit`, or `commit` starts with a stored commit of seven characters or more.
 */
export function commitMatches(commit: string): SQL {
  return sql`(${testRuns.commit} LIKE ${`${commit}%`} OR (length(${testRuns.commit}) >= 7 AND ${commit} LIKE ${testRuns.commit} || '%'))`;
}

/** An environment as a run names it: the project's environment its label resolved to, and the label. */
export interface RunEnvironmentRef {
  id: number | null;
  label: string | null;
}

/** The runs of environment `environment`: resolved to its id, or, for a run its label did not resolve, by that label. */
export function runEnvironmentSql(environment: RunEnvironmentRef): SQL | null {
  const byLabel = environment.label ? foldedEquals(testRuns.environment, environment.label) : null;
  if (environment.id === null) return byLabel;
  const byId = eq(testRuns.environmentId, environment.id);
  return byLabel ? (or(byId, and(isNull(testRuns.environmentId), byLabel)) as SQL) : byId;
}

/**
 * The passing CI execution a test that ran elsewhere (a desktop app's run) is compared with: a final attempt of the
 * test in a CI run (`CI_RUN_ORIGINS`), in the same Playwright project when one is named, picked in this order: in the
 * local run's environment on its commit, in its environment, on its commit, then any; within each, on the local
 * branch first, then the most recent. Answers its environment snapshot, which the other side diffs against its own;
 * null when the CI never passed the test.
 */
export async function getClosestCiPass(
  db: DrizzleDB,
  opts: {
    testCaseId: number;
    playwrightProject: string | null;
    environment: RunEnvironmentRef | null;
    branch: string | null;
    commit: string | null;
  },
): Promise<
  | (Omit<TestComparisonClosestPass, 'path' | 'environment'> & {
      environmentId: number | null;
      environmentLabel: string | null;
    })
  | null
> {
  const base: SQL[] = [
    eq(testRunsCases.testCaseId, opts.testCaseId),
    eq(testRunsCases.status, 'passed'),
    eq(testRunsCases.finalAttempt, true),
    runOriginIn(testRuns.origin, CI_RUN_ORIGINS),
    eligibleRunSql('baseline'),
  ];
  if (opts.playwrightProject) base.push(eq(testRunsCases.browserName, opts.playwrightProject));
  const inEnvironment = opts.environment ? runEnvironmentSql(opts.environment) : null;
  const onCommit = opts.commit ? commitMatches(opts.commit) : null;
  const tiers: SQL[][] = [];
  if (inEnvironment && onCommit) tiers.push([inEnvironment, onCommit]);
  if (inEnvironment) tiers.push([inEnvironment]);
  if (onCommit) tiers.push([onCommit]);
  tiers.push([]);
  let chosen: ExecutionEnvironmentRow | null = null;
  for (const extra of tiers) {
    const candidates = await selectExecutionEnvironment(db, and(...base, ...extra)).limit(BASELINE_CANDIDATES);
    chosen =
      rankBaselineCandidates(
        { environment: null, branch: opts.branch },
        candidates.map((row) => ({ ...scopeOf(row), row })),
      )[0]?.row ?? null;
    if (chosen) break;
  }
  if (!chosen) return null;
  const snapshots = await loadRunsSnapshots(db, [chosen.runId]);
  const snapshot = toSnapshot(chosen, snapshots.get(chosen.runId) ?? []);
  const worktree = (chosen.runMetadata as RunMetadataLens | null)?.scm?.worktree;
  return {
    executionId: chosen.id,
    runId: chosen.runId,
    startTime: chosen.startTime instanceof Date ? chosen.startTime.getTime() : (chosen.startTime ?? null),
    environmentId: chosen.runEnvironmentId ?? null,
    environmentLabel: chosen.runEnvironment ?? null,
    branch: scopeOf(chosen).branch ?? null,
    commit: chosen.runCommit ?? null,
    worktree: worktree === 'clean' || worktree === 'dirty' ? worktree : null,
    sameCommit: opts.commit !== null && sameCommit(chosen.runCommit ?? null, opts.commit),
    snapshot: { values: snapshot.values, inferred: [...snapshot.inferred] },
  };
}
