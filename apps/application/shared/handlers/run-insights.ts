import { eq, and, desc, inArray, lt } from 'drizzle-orm';
import { testRuns, testRunsCases, testCases, failureClusters } from '../../server/database/schema';
import type { TestRun } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { listBaselineBranches, selectBaselineRun } from '../../server/utils/branch-baseline';
import { normalizeGitUrl } from '../../server/utils/scm/git-url';
import { buildCommitRange, computeMetadataDiff, type CommitRange, type MetaDiffEntry } from '../utils/run-metadata';
import { readProjectDefaultBranch, resolveFallbackBranch } from './baseline-scope';
import { finalAttempts, flakyFinalAttempts, testKey, testOutcomes } from '../utils/test-counts';
import { passRatePercent } from '../utils/pass-rate';
import { notLabRun } from './probes';
import { isVisibleRun } from '../run-eligibility';
import { TERMINAL_STATUSES } from './projects';
import { describeRunBaseline, type RunBaselineFallback, type RunBaselineMatch } from '#shared/run-baseline';
import { liveWorkerName } from '#shared/live-view';
import { workerKey, workerNumber } from '#shared/worker-lane';
import { loadRunsSnapshots } from './environment-snapshots';
import { comparableSnapshots, disagreeingFields } from '#shared/environment-snapshots';

interface TestCaseEntry {
  executionId: number;
  title: string;
  filePath: string;
  duration: number | null;
}

interface PerfChangeEntry {
  executionId: number;
  title: string;
  filePath: string;
  durationBefore: number;
  durationAfter: number;
  pctChange: number;
}

/** The chosen baseline run, echoed so the Changes tab can name it in its selector. */
export interface InsightsBaseline {
  id: number;
  startTime: Date;
  status: string;
  label: string | null;
  branch: string | null;
  environment: string | null;
}

/** An earlier run the Changes tab offers to compare with. */
export interface InsightsEarlierRun {
  id: number;
  startTime: Date;
  status: string;
  label: string | null;
  branch: string | null;
  environment: string | null;
  isFullRun: boolean;
}

/** How the baseline was picked: the automatic ladder, a run, or a base branch someone chose. */
export type InsightsBaselineSource = 'auto' | 'run' | 'branch';

/**
 * How many test results one worker ran, within the shard `shardIndex` names in a sharded run (null otherwise):
 * `worker` is its lane from 1 as the run page names it (`Worker 2`), whichever processes Playwright started in it; a
 * result without a lane, from an older reporter, counts under its worker process, `workerIndex`, and `worker` is null.
 */
export interface WorkerTestCount {
  worker: number | null;
  workerIndex: number | null;
  shardIndex: number | null;
  count: number;
}

/** How many earlier runs the Changes tab offers to compare with. */
const EARLIER_RUN_LIMIT = 50;

export interface RunInsightsResult {
  hasBaseline: boolean;
  /** The baseline this comparison used (the automatic choice, or the one asked for). */
  baseline: InsightsBaseline | null;
  baselineSource: InsightsBaselineSource;
  /** How the baseline relates to this run; null when a specific run was asked for. */
  baselineMatch: RunBaselineMatch | null;
  /** Why this baseline — the sentence the Changes tab shows under the selector. */
  baselineNote: string | null;
  /** The run being compared, so the selector can say which branch and environment it is on. */
  run: { branch: string | null; environment: string | null };
  /** The branch the automatic ladder falls back to, and where that came from. */
  fallbackBranch: RunBaselineFallback;
  /** The base branch asked for, echoed even when it yielded no baseline. */
  baseBranch: string | null;
  /** Branches a baseline can be taken from (an earlier passing full run, or a failed one with `failedFallback`). */
  baseBranches: string[];
  /** The project's finished runs before this one, newest first, lab runs left out — the runs on offer. */
  earlierRuns: InsightsEarlierRun[];
  /** Tests that passed in the baseline and fail here — the one "new failures" set. */
  newFailures: number;
  commitRange: CommitRange | null;
  metadataDiff: MetaDiffEntry[];
  /** The runner fields this run's shards disagree on (another time zone, another image), by label. */
  shardDisagreement: string[];
  totalTests: number;
  passedTests: number;
  failedTests: number;
  /** Whole percent (`passRatePercent`); null when no test passed or failed. */
  passRate: number | null;
  baselinePassRate: number | null;
  /** Points this run's pass rate is above the baseline's; null when either has none. */
  passRateDelta: number | null;
  avgDurationDelta: number | null;
  newRegressions: TestCaseEntry[];
  recurrences: TestCaseEntry[];
  recovered: TestCaseEntry[];
  newFlaky: TestCaseEntry[];
  slowestTests: Array<{ executionId: number; title: string; filePath: string; duration: number }>;
  mostImproved: PerfChangeEntry[];
  mostRegressed: PerfChangeEntry[];
  workerImbalance: WorkerTestCount[];
  /** Names the busiest worker and the least busy one when it ran at least 1.5 times as many tests. */
  workerImbalanceWarning: string | null;
  flakyOnRetry: Array<{ executionId: number; title: string; filePath: string; retries: number }>;
  clusterNew: Array<{
    clusterId: number;
    signature: string;
    title: string | null;
    errorType: string | null;
    selector: string | null;
  }>;
}

const FAIL_STATUSES: ReadonlySet<string> = new Set(['failed', 'timedOut', 'timedout']);

export async function computeRunInsights(
  db: DrizzleDB,
  runId: number,
  options?: {
    baselineId?: number | null;
    baseBranch?: string | null;
    /** Take the last failed run as the baseline when no earlier full run passed. */
    failedFallback?: boolean;
  },
): Promise<RunInsightsResult> {
  const runResults: any[] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      status: testRuns.status,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
      environment: testRuns.environment,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));

  const run = runResults[0];
  if (!run) throw new Error('Run not found');

  // The run's attempts; its test results are their final attempts, one per (test case, browser, repetition).
  const currentRows: any[] = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      retries: testRunsCases.retries,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      workerIndex: testRunsCases.workerIndex,
      parallelIndex: testRunsCases.parallelIndex,
      shardIndex: testRunsCases.shardIndex,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId));
  const currentCases = finalAttempts(currentRows);
  const currentFlaky = flakyFinalAttempts(currentRows);

  // The baseline ladder: a passing full run in this run's environment, on its
  // own branch, else on the branch it forked from (the pull request's target
  // when the reporter captured one, else the project's default branch), else
  // any branch; then the same three rungs without the environment. With
  // `failedFallback`, the same ladder again for the last failed full run.
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const environment: string | null = run.environment ?? null;
  const fallbackBranch = resolveFallbackBranch(
    run.metadata,
    await readProjectDefaultBranch(db, run.projectId, run.metadata),
  );
  const failedFallback = options?.failedFallback === true;
  const baseBranches = await listBaselineBranches(db, {
    projectId: run.projectId,
    before: run.startTime,
    fullRunOnly: true,
    failedFallback,
  });

  const earlierRunRows = await db
    .select({
      id: testRuns.id,
      startTime: testRuns.startTime,
      status: testRuns.status,
      label: testRuns.label,
      branch: testRuns.branch,
      environment: testRuns.environment,
      isFullRun: testRuns.isFullRun,
    })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, run.projectId),
        lt(testRuns.startTime, run.startTime),
        inArray(testRuns.status, TERMINAL_STATUSES),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRuns.startTime))
    .limit(EARLIER_RUN_LIMIT);
  const earlierRuns: InsightsEarlierRun[] = earlierRunRows.map((r) => ({
    ...r,
    label: r.label ?? null,
    branch: r.branch ?? null,
    environment: r.environment ?? null,
    isFullRun: r.isFullRun === 1,
  }));

  // An explicit baseline (the `?baseline=` selection on the Changes tab) wins,
  // as long as it is a different run in the same project. Then a chosen base
  // branch restricts the ladder to that branch. Otherwise the automatic choice.
  const chosenBranch = options?.baseBranch?.trim() || null;
  let baselineRun: TestRun | null = null;
  let baselineSource: InsightsBaselineSource = 'auto';
  let baselineMatch: RunBaselineMatch | null = null;
  if (options?.baselineId != null && options.baselineId !== runId) {
    const [picked] = await db.select().from(testRuns).where(eq(testRuns.id, options.baselineId));
    // A private run is never a baseline: the page that picks one is read by the whole project.
    if (picked && picked.projectId === run.projectId && isVisibleRun(picked, null)) {
      baselineRun = picked as TestRun;
      baselineSource = 'run';
    }
  }
  if (!baselineRun) {
    const selection = await selectBaselineRun(db, {
      projectId: run.projectId,
      before: run.startTime,
      branch,
      environment,
      fallbackBranch: fallbackBranch.branch,
      baseBranch: chosenBranch,
      fullRunOnly: true,
      failedFallback,
    });
    if (selection) {
      baselineRun = selection.run;
      baselineMatch = selection.match;
      baselineSource = chosenBranch ? 'branch' : 'auto';
    }
  }
  const scope = { run: { branch, environment }, fallbackBranch, baseBranch: chosenBranch, baseBranches, earlierRuns };
  const empty = {
    hasBaseline: false,
    baseline: null,
    baselineSource,
    baselineMatch: null,
    baselineNote: null,
    ...scope,
    newFailures: 0,
    commitRange: null,
    metadataDiff: [],
    shardDisagreement: [],
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    passRate: null,
    baselinePassRate: null,
    passRateDelta: null,
    avgDurationDelta: null,
    newRegressions: [],
    recurrences: [],
    recovered: [],
    newFlaky: [],
    slowestTests: [],
    mostImproved: [],
    mostRegressed: [],
    workerImbalance: [],
    workerImbalanceWarning: null,
    flakyOnRetry: [],
    clusterNew: [],
  };

  // Shards that disagree say so whether or not a baseline exists.
  const snapshots = await loadRunsSnapshots(db, baselineRun ? [baselineRun.id, run.id] : [run.id]);
  const currentSnapshots = snapshots.get(run.id) ?? [];
  const shardDisagreement = disagreeingFields(
    comparableSnapshots(currentSnapshots).filter((s) => s.kind === 'runner'),
  ).map((f) => f.label);
  if (!baselineRun) return { ...empty, shardDisagreement };

  const baselineRows: any[] = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      retries: testRunsCases.retries,
      passedAfterFailure: testRunsCases.passedAfterFailure,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, baselineRun.id));
  const baselineCases = finalAttempts(baselineRows);
  const baselineFlaky = flakyFinalAttempts(baselineRows);
  // Each test is compared with the baseline through its outcome in either run, whatever their repetitions.
  const baselineByTest = new Map<string, any>(testOutcomes(baselineRows).map((bc) => [testKey(bc), bc]));

  const newRegressions: TestCaseEntry[] = [];
  const recurrences: TestCaseEntry[] = [];
  const recovered: TestCaseEntry[] = [];
  const newFlaky: TestCaseEntry[] = [];
  const flakyOnRetry: Array<{ executionId: number; title: string; filePath: string; retries: number }> = [];
  const perfChanges: PerfChangeEntry[] = [];

  for (const cc of testOutcomes(currentRows)) {
    const bc = baselineByTest.get(testKey(cc));

    // Status changes
    if (bc) {
      const wasFail = FAIL_STATUSES.has(bc.status);
      const isFail = FAIL_STATUSES.has(cc.status);

      if (!wasFail && isFail) {
        newRegressions.push({ executionId: cc.id, title: cc.title, filePath: cc.filePath, duration: cc.duration });
      } else if (wasFail && !isFail) {
        recovered.push({ executionId: cc.id, title: cc.title, filePath: cc.filePath, duration: cc.duration });
      } else if (wasFail && isFail) {
        recurrences.push({ executionId: cc.id, title: cc.title, filePath: cc.filePath, duration: cc.duration });
      }
    }

    // Flaky detection
    if (bc) {
      const wasStable = bc.status === 'passed' && !baselineFlaky.has(bc);
      const isNowFlaky = currentFlaky.has(cc);
      if (wasStable && isNowFlaky) {
        newFlaky.push({ executionId: cc.id, title: cc.title, filePath: cc.filePath, duration: cc.duration });
      }
    }

    // Duration changes
    if (bc && cc.duration != null && bc.duration != null && bc.status === 'passed' && cc.status === 'passed') {
      const before = bc.duration;
      const after = cc.duration;
      if (before > 0) {
        const pctChange = Math.round(((after - before) / before) * 100);
        perfChanges.push({
          executionId: cc.id,
          title: cc.title,
          filePath: cc.filePath,
          durationBefore: before,
          durationAfter: after,
          pctChange,
        });
      }
    }
  }

  // Flaky on retry (passed after an earlier attempt failed): once per test, with the repetition that needed the most retries
  const flakyByTest = new Map<string, (typeof flakyOnRetry)[number]>();
  for (const cc of currentCases) {
    if (!currentFlaky.has(cc)) continue;
    const known = flakyByTest.get(testKey(cc));
    if (!known || (cc.retries ?? 0) > known.retries) {
      flakyByTest.set(testKey(cc), {
        executionId: cc.id,
        title: cc.title,
        filePath: cc.filePath,
        retries: cc.retries ?? 0,
      });
    }
  }
  flakyOnRetry.push(...flakyByTest.values());

  // Summary stats, one per test result
  const totalTests = currentCases.length;
  const passedTests = currentCases.filter((c: any) => c.status === 'passed').length;
  const failedTests = currentCases.filter((c: any) => FAIL_STATUSES.has(c.status)).length;
  const passRate = passRatePercent({ passed: passedTests, failed: failedTests });

  const baselinePassRate = passRatePercent({
    passed: baselineCases.filter((bc: any) => bc.status === 'passed').length,
    failed: baselineCases.filter((bc: any) => FAIL_STATUSES.has(bc.status)).length,
  });
  const passRateDelta = passRate !== null && baselinePassRate !== null ? passRate - baselinePassRate : null;

  // Average duration change across all comparable passing tests
  const avgDurationDelta =
    perfChanges.length > 0
      ? Math.round(perfChanges.reduce((sum, c) => sum + c.pctChange, 0) / perfChanges.length)
      : null;

  // Slowest tests (top 5 by duration in current run)
  const slowestTests = [...currentCases]
    .filter((c) => c.duration != null)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, 5)
    .map((c) => ({ executionId: c.id, title: c.title, filePath: c.filePath, duration: c.duration }));

  // Split by direction so "slower" only holds tests that got slower and "faster"
  // only those that got faster — the ten largest each way.
  const mostRegressed = perfChanges
    .filter((c) => c.pctChange > 0)
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, 10);
  const mostImproved = perfChanges
    .filter((c) => c.pctChange < 0)
    .sort((a, b) => a.pctChange - b.pctChange)
    .slice(0, 10);

  // Worker imbalance: test results per worker, a lane in its shard
  const workerCounts = new Map<string, WorkerTestCount>();
  for (const cc of currentCases) {
    const key = workerKey(cc);
    if (key === null) continue;
    const known = workerCounts.get(key);
    if (known) known.count++;
    else {
      const worker = workerNumber(cc.parallelIndex);
      workerCounts.set(key, {
        worker,
        workerIndex: worker === null ? (cc.workerIndex ?? null) : null,
        shardIndex: cc.shardIndex ?? null,
        count: 1,
      });
    }
  }
  const shown = (w: WorkerTestCount) => w.worker ?? w.workerIndex ?? 0;
  const workerImbalance = [...workerCounts.values()].sort(
    (a, b) =>
      (a.shardIndex ?? -1) - (b.shardIndex ?? -1) ||
      Number(a.worker === null) - Number(b.worker === null) ||
      shown(a) - shown(b),
  );

  let workerImbalanceWarning: string | null = null;
  if (workerImbalance.length > 1) {
    const busiest = workerImbalance.reduce((max, w) => (w.count > max.count ? w : max));
    const idlest = workerImbalance.reduce((min, w) => (w.count < min.count ? w : min));
    if (busiest.count >= idlest.count * 1.5) {
      const name = (w: WorkerTestCount) => liveWorkerName({ shard: w.shardIndex, worker: shown(w) });
      const ratio = Math.round((busiest.count / idlest.count) * 10) / 10;
      const sentence = `${name(busiest)} ran ${ratio}\u00d7 more tests than ${name(idlest)}`;
      workerImbalanceWarning = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }
  }

  // Commit span and environment diff between the baseline and this run, so the
  // Changes tab shows "commits since the baseline" and "environment changes"
  // against the same baseline every other section uses.
  const currMeta = run.metadata as any;
  const baseMeta = (baselineRun as any).metadata ?? null;
  const remoteUrl: string | null = currMeta?.scm?.remoteUrl ?? baseMeta?.scm?.remoteUrl ?? null;
  const commitRange = buildCommitRange(
    normalizeGitUrl(remoteUrl),
    baseMeta?.scm?.commit ?? null,
    currMeta?.scm?.commit ?? null,
  );
  const metadataDiff = computeMetadataDiff(baseMeta, currMeta, baselineRun.environment, run.environment, {
    before: { playwrightVersion: baselineRun.playwrightVersion, snapshots: snapshots.get(baselineRun.id) ?? [] },
    after: { playwrightVersion: run.playwrightVersion, snapshots: currentSnapshots },
  });

  // New clusters (firstSeenRunId === runId)
  const clusterRows: any[] = await db
    .select({
      id: failureClusters.id,
      signature: failureClusters.signature,
      title: failureClusters.title,
      errorType: failureClusters.errorType,
      selector: failureClusters.selector,
    })
    .from(failureClusters)
    .where(and(eq(failureClusters.firstSeenRunId, runId)))
    .limit(20);

  const baselineScope = {
    branch: baselineRun.branch ?? resolveRunBranch(baselineRun.metadata),
    environment: baselineRun.environment ?? null,
  };
  const baselineNote =
    baselineSource === 'run'
      ? 'The run you picked.'
      : describeRunBaseline({
          run: scope.run,
          baseline: baselineScope,
          match: baselineMatch!,
          fallback: fallbackBranch,
        });

  return {
    hasBaseline: true,
    baseline: {
      id: baselineRun.id,
      startTime: baselineRun.startTime,
      status: baselineRun.status,
      label: baselineRun.label ?? null,
      ...baselineScope,
    },
    baselineSource,
    baselineMatch,
    baselineNote,
    ...scope,
    newFailures: newRegressions.length,
    commitRange,
    metadataDiff,
    shardDisagreement,
    totalTests,
    passedTests,
    failedTests,
    passRate,
    baselinePassRate,
    passRateDelta,
    avgDurationDelta,
    newRegressions,
    recurrences,
    recovered,
    newFlaky,
    slowestTests,
    mostImproved,
    mostRegressed,
    workerImbalance,
    workerImbalanceWarning,
    flakyOnRetry,
    clusterNew: clusterRows.map((c: any) => ({
      clusterId: c.id,
      signature: c.signature,
      title: c.title ?? null,
      errorType: c.errorType ?? null,
      selector: c.selector ?? null,
    })),
  };
}
