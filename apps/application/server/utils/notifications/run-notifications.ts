import { testTextLabel } from '#shared/utils/test-label';
import { eq, and, lt, desc, inArray, isNull, or } from 'drizzle-orm';

/** Failures scanned for ownership; well past what any comment or digest lists. */
const OWNER_LOOKUP_LIMIT = 200;
/** Prior runs fetched per project when looking for same-branch baseline runs. */
const BASELINE_FETCH_LIMIT = 25;
import { projects, testRuns, failureClusters, testRunsCases, testCases } from '../../database/schema';
import { emitNotification } from './emit';
import {
  buildTopFailures,
  errorExcerpt,
  computePerfBaseline,
  truncateExcerpt,
  TOP_FAILURES_LIMIT,
  PERF_BASELINE_RUNS,
  PERF_REGRESSION_MIN_PCT,
  RUN_HISTORY_LIMIT,
} from '#shared/notification-events';
import { resolveOwners } from '../scm/ownership';
import { resolveDefaultBranch } from '../scm/default-branch';
import { resolveRunBranch } from '../run-branch';
import { inlineCasePayloads } from '../case-payloads';
import { FAILED_STATUS_KEYS, isFailedStatus, testKey, testOutcomes } from '#shared/utils/test-counts';
import { describeCluster } from '#shared/describe-cluster';
import { looksFixedTests } from '#shared/status-classify';
import { eligibleRunSql, isEligibleRun, runCommit } from '#shared/run-eligibility';
import { commitUrl } from '#shared/scm-urls';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { parseSourceSnippet } from '#shared/source-snippet';
import { TERMINAL_RUN_STATUSES } from '#shared/handlers/analytics/common';
import { getClusterKnownIssue } from '../integrations/known-issue';
import type { DbClient } from '../../database';
import type {
  FailureSource,
  HistoryOutcome,
  LooksFixedTest,
  RunCommit,
  RunHistoryEntry,
} from '#shared/notification-events';
import type { TestMetadata } from '#shared/types';
import { readRunIncident } from '#shared/run-incident';

/**
 * The run's `test.fail()` tests that passed in every browser project that ran
 * them, with the bug report and ticket each names: the tests whose bug looks
 * fixed.
 */
export async function loadLooksFixedTests(db: DbClient, runId: number): Promise<LooksFixedTest[]> {
  const rows = await db
    .select({
      title: testCases.title,
      externalId: testCases.externalId,
      displayTitle: testCases.displayTitle,
      filePath: testCases.filePath,
      executionId: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      testMeta: testRunsCases.testMeta,
      status: testRunsCases.status,
      expectedStatus: testRunsCases.expectedStatus,
      retries: testRunsCases.retries,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      browserName: testRunsCases.browserName,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        inArray(
          testRunsCases.testCaseId,
          db
            .select({ id: testRunsCases.testCaseId })
            .from(testRunsCases)
            .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.expectedStatus, 'failed'))),
        ),
      ),
    );
  return looksFixedTests(rows).map((row) => {
    const meta = (row.testMeta ?? null) as TestMetadata | null;
    return {
      title: testTextLabel(row),
      filePath: row.filePath,
      executionId: row.executionId,
      testCaseId: row.testCaseId,
      ...(meta?.bug ? { bugId: Number(meta.bug) } : {}),
      ...(meta?.link ? { link: meta.link } : {}),
    };
  });
}

/**
 * The run's looks-fixed tests (`loadLooksFixedTests`) that did not already look
 * fixed on the previous completed run of the same project and branch: the
 * tests whose bug started looking fixed with this run. Every looks-fixed test
 * counts when the branch has no earlier run.
 */
export async function loadNewlyLooksFixedTests(
  db: DbClient,
  run: { id: number; projectId: number },
  branch: string | undefined,
): Promise<LooksFixedTest[]> {
  const current = await loadLooksFixedTests(db, run.id);
  if (current.length === 0) return current;
  const priorRuns = await db
    .select({ id: testRuns.id, branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, run.projectId),
        lt(testRuns.id, run.id),
        inArray(testRuns.status, ['passed', 'failed']),
      ),
    )
    .orderBy(desc(testRuns.id))
    .limit(BASELINE_FETCH_LIMIT);
  const previous = priorRuns.find((r) => (r.branch ?? resolveRunBranch(r.metadata) ?? undefined) === branch);
  if (!previous) return current;
  const already = new Set((await loadLooksFixedTests(db, previous.id)).map((t) => t.testCaseId));
  return current.filter((t) => !already.has(t.testCaseId));
}

/**
 * The run and the runs before it on its branch and environment that send
 * notifications, at most {@link RUN_HISTORY_LIMIT}, oldest first.
 */
async function loadRunHistory(
  db: DbClient,
  run: { id: number; projectId: number; status: string; failedTests: number; environment: string | null },
  branch: string | undefined,
): Promise<RunHistoryEntry[]> {
  // A run stored without the branch column names its branch in its metadata only.
  const sameBranch = branch ? or(eq(testRuns.branch, branch), isNull(testRuns.branch)) : isNull(testRuns.branch);
  const prior = await db
    .select({
      id: testRuns.id,
      status: testRuns.status,
      failedTests: testRuns.failedTests,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, run.projectId),
        lt(testRuns.id, run.id),
        sameBranch,
        run.environment ? eq(testRuns.environment, run.environment) : isNull(testRuns.environment),
        inArray(testRuns.status, TERMINAL_RUN_STATUSES),
        eligibleRunSql('notifications'),
      ),
    )
    .orderBy(desc(testRuns.id))
    .limit(BASELINE_FETCH_LIMIT);
  const earlier = prior
    .filter((r) => (r.branch ?? resolveRunBranch(r.metadata) ?? undefined) === branch)
    .slice(0, RUN_HISTORY_LIMIT - 1)
    .reverse();
  return [...earlier, run].map((r) => ({ runId: r.id, status: r.status, failedTests: r.failedTests }));
}

/** A test's outcome in a run, from its deciding attempt there (`testOutcomes`). */
function historyOutcome(row: { status: string; retries: number | null } | undefined): HistoryOutcome {
  if (!row) return null;
  if (isFailedStatus(row.status)) return 'failed';
  if (row.status === 'passed') return (row.retries ?? 0) > 0 ? 'flaky' : 'passed';
  if (row.status === 'skipped' || row.status === 'didnotrun') return row.status;
  if (row.status === 'interrupted') return 'didnotrun';
  return null;
}

/** Each test's outcome in each run of the history: `test case id, browser` (`testKey`) to one entry per run. */
async function loadTestHistories(
  db: DbClient,
  history: RunHistoryEntry[],
  tests: Array<{ testCaseId: number; browserName: string | null }>,
): Promise<Map<string, HistoryOutcome[]>> {
  const result = new Map<string, HistoryOutcome[]>();
  if (tests.length === 0) return result;
  const rows = await db
    .select({
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
    })
    .from(testRunsCases)
    .where(
      and(
        inArray(
          testRunsCases.testRunId,
          history.map((h) => h.runId),
        ),
        inArray(testRunsCases.testCaseId, [...new Set(tests.map((t) => t.testCaseId))]),
      ),
    );
  const outcomeIn = new Map<string, (typeof rows)[number]>();
  for (const entry of history) {
    for (const row of testOutcomes(rows.filter((r) => r.testRunId === entry.runId))) {
      outcomeIn.set(`${entry.runId}\x00${testKey(row)}`, row);
    }
  }
  for (const test of tests) {
    const key = testKey(test);
    result.set(
      key,
      history.map((entry) => historyOutcome(outcomeIn.get(`${entry.runId}\x00${key}`))),
    );
  }
  return result;
}

/**
 * The code each execution failed at: the innermost in-project frame the
 * reporter captured, else the snippet of the test file around its failing line.
 */
async function loadFailureSources(
  db: DbClient,
  failures: Array<{ executionId: number; filePath: string }>,
): Promise<Map<number, FailureSource>> {
  const result = new Map<number, FailureSource>();
  if (failures.length === 0) return result;
  const rows = await db
    .select({
      id: testRunsCases.id,
      testSource: testRunsCases.testSource,
      testSourcePayloadId: testRunsCases.testSourcePayloadId,
      testSourceFrames: testRunsCases.testSourceFrames,
      testSourceFramesPayloadId: testRunsCases.testSourceFramesPayloadId,
    })
    .from(testRunsCases)
    .where(
      inArray(
        testRunsCases.id,
        failures.map((f) => f.executionId),
      ),
    );
  for (const stored of rows) {
    const row = await inlineCasePayloads(db, stored);
    const [frame] = Array.isArray(row.testSourceFrames) ? (row.testSourceFrames as unknown[]) : [];
    const { file, line, snippet } = (frame ?? {}) as Partial<FailureSource>;
    const marked = typeof snippet === 'string' && parseSourceSnippet(snippet).some((r) => r.failing);
    if (typeof file === 'string' && typeof line === 'number' && typeof snippet === 'string' && marked) {
      result.set(row.id, { file, line, snippet });
      continue;
    }
    const filePath = failures.find((f) => f.executionId === row.id)?.filePath;
    const failingLine = row.testSource ? parseSourceSnippet(row.testSource).find((r) => r.failing)?.line : null;
    if (filePath && row.testSource && failingLine != null) {
      result.set(row.id, { file: filePath, line: failingLine, snippet: row.testSource });
    }
  }
  return result;
}

/** The commit a run tested, from its metadata, linked on the project's repository when its host is known. */
function runCommitOf(metadata: unknown, repositoryUrl: string | null): RunCommit | undefined {
  const sha = runCommit(metadata);
  if (!sha) return undefined;
  const scm = (metadata as { scm?: { author?: unknown; commitMessage?: unknown } } | null)?.scm;
  const line = (value: unknown, max: number) =>
    typeof value === 'string' ? truncateExcerpt(value.split('\n')[0], max) : undefined;
  const message = line(scm?.commitMessage, 120);
  const author = line(scm?.author, 80);
  const url = commitUrl(repositoryUrl, sha);
  return { sha, ...(message ? { message } : {}), ...(author ? { author } : {}), ...(url ? { url } : {}) };
}

/** The CI page a run's metadata names: its build, else its pipeline, else its job, as the reporter picks it. */
function runCiUrl(metadata: unknown): string | undefined {
  const ci = (metadata as { ci?: { buildUrl?: unknown; pipelineUrl?: unknown; jobUrl?: unknown } } | null)?.ci;
  const pick = (value: unknown) => (typeof value === 'string' ? safeHttpUrl(value) : null);
  return pick(ci?.buildUrl) ?? pick(ci?.pipelineUrl) ?? pick(ci?.jobUrl) ?? undefined;
}

/**
 * The run, its project and the payload every run event carries: counts, branch,
 * environment, commit, history, the first failures and the owners of every
 * failure. Null when the run or its project is gone.
 */
export async function loadRunPayload(db: DbClient, runId: number) {
  const [runRow] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!runRow) return null;

  const [project] = await db.select().from(projects).where(eq(projects.id, runRow.projectId));
  if (!project) return null;

  const branch = runRow.branch ?? resolveRunBranch(runRow.metadata) ?? undefined;
  const environment = runRow.environment ?? undefined;
  const defaultBranch = await resolveDefaultBranch(db, project, runRow.metadata);
  const isDefaultBranch = branch ? branch === defaultBranch : false;

  // Ownership reads every failed attempt: a flaky test's failed first attempt
  // and an attempt that failed into a cluster route `flakiness.spike` and
  // `cluster.new` to their owners. The notification still names only the first
  // few failures, but ownership is resolved across all of them — a
  // subscription scoped to one team must not miss a run just because that
  // team's failure ranked seventh.
  const failedAttempts = await db
    .select({ filePath: testCases.filePath, owner: testCases.owner, clusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(and(eq(testRunsCases.testRunId, runId), inArray(testRunsCases.status, [...FAILED_STATUS_KEYS])))
    .limit(OWNER_LOOKUP_LIMIT);

  // The failures a notification names are the tests whose deciding attempt
  // failed: a test that passed on a retry is flaky, and the attempts before a
  // test's last are no test of their own.
  const attempts = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
    })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        inArray(
          testRunsCases.testCaseId,
          db
            .select({ id: testRunsCases.testCaseId })
            .from(testRunsCases)
            .where(and(eq(testRunsCases.testRunId, runId), inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]))),
        ),
      ),
    );
  const failing = testOutcomes(attempts)
    .filter((row) => isFailedStatus(row.status))
    .sort((a, b) => a.id - b.id);
  const topIds = failing.slice(0, TOP_FAILURES_LIMIT).map((row) => row.id);

  // A few failing tests (title + error excerpt + deep-link ids) so a
  // notification carries enough context to start debugging without opening
  // the dashboard first.
  // Each failure is named by its external ID and label, the way the team knows it.
  const top =
    topIds.length === 0
      ? []
      : (
          await db
            .select({
              title: testCases.title,
              externalId: testCases.externalId,
              displayTitle: testCases.displayTitle,
              filePath: testCases.filePath,
              suitePath: testCases.suitePath,
              line: testRunsCases.line,
              browserName: testRunsCases.browserName,
              error: testRunsCases.error,
              testCaseId: testRunsCases.testCaseId,
              executionId: testRunsCases.id,
              owner: testCases.owner,
            })
            .from(testRunsCases)
            .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
            .where(inArray(testRunsCases.id, topIds))
        )
          .sort((a, b) => a.executionId - b.executionId)
          .map((row) => ({ ...row, title: testTextLabel(row) }));

  const history = await loadRunHistory(db, runRow, branch);
  const [resolvedOwners, sources, testHistories] = await Promise.all([
    resolveOwners<{ filePath: string; owner: string | null }>(db, runRow.projectId, [...failedAttempts, ...top]).catch(
      () => new Map(),
    ),
    loadFailureSources(db, top),
    loadTestHistories(db, history, top),
  ]);
  const topFailures = buildTopFailures(
    top.map((row) => ({
      ...row,
      owner: resolvedOwners.get(row)?.owner,
      source: sources.get(row.executionId),
      history: testHistories.get(testKey(row)),
    })),
  );
  const ownersOf = (rows: typeof failedAttempts) => [
    ...new Set(rows.map((row) => resolvedOwners.get(row)?.owner).filter((owner): owner is string => Boolean(owner))),
  ];
  const owners = ownersOf(failedAttempts);
  /** The owners of the tests that failed into one cluster in this run. */
  const clusterOwners = (clusterId: number) => ownersOf(failedAttempts.filter((row) => row.clusterId === clusterId));

  const commit = runCommitOf(runRow.metadata, project.repositoryUrl);
  const ciUrl = runCiUrl(runRow.metadata);
  const runPayload = {
    runId,
    projectId: runRow.projectId,
    projectName: project.label || project.name,
    status: runRow.status,
    totalTests: runRow.totalTests,
    failedTests: runRow.failedTests,
    passedTests: runRow.passedTests,
    flakyTests: runRow.flakyTests,
    skippedTests: runRow.skippedTests,
    didNotRunTests: runRow.didNotRunTests,
    flakinessRate: runRow.totalTests > 0 ? runRow.flakyTests / runRow.totalTests : 0,
    durationMs: runRow.duration ?? undefined,
    branch,
    environment,
    isDefaultBranch,
    topFailures,
    failingTestCount: failing.length,
    owners,
    ...(commit ? { commit } : {}),
    ...(ciUrl ? { ciUrl } : {}),
    origin: runRow.origin,
    history,
  };
  return { runRow, project, runPayload, branch, environment, isDefaultBranch, clusterOwners };
}

/**
 * Emit `run.interrupted` for a run the stale-run sweep reaped: its reporter
 * stopped sending before the end. A run the `notifications` use leaves out
 * stays silent, as at finalize: a lab run, a run from an editor, a bisect step
 * or a reproduction, a run of part of the suite from a developer's machine or
 * the desktop app.
 */
export async function emitRunInterrupted(db: DbClient, runId: number): Promise<void> {
  try {
    const loaded = await loadRunPayload(db, runId);
    if (!loaded || !isEligibleRun(loaded.runRow, 'notifications')) return;
    await emitNotification(db, 'run.interrupted', loaded.runPayload);
  } catch (e) {
    console.error('[notifications] emitRunInterrupted failed', e);
  }
}

/**
 * Emit the notifications of a run flagged as an environment incident:
 * `run.finished`, and one `environment.incident` in place of the run's
 * failure, flakiness, performance, new-cluster and looks-fixed events. The
 * incident names no failing test and no owner.
 */
export async function emitIncidentNotification(db: DbClient, runId: number): Promise<void> {
  const [runRow] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  const incident = runRow ? readRunIncident(runRow.metadata) : null;
  if (!runRow || !incident) return;
  const [project] = await db.select().from(projects).where(eq(projects.id, runRow.projectId));
  if (!project) return;

  const branch = runRow.branch ?? resolveRunBranch(runRow.metadata) ?? undefined;
  const defaultBranch = await resolveDefaultBranch(db, project, runRow.metadata);
  const base = {
    runId,
    projectId: runRow.projectId,
    projectName: project.label || project.name,
    status: runRow.status,
    totalTests: runRow.totalTests,
    failedTests: runRow.failedTests,
    branch,
    environment: runRow.environment ?? undefined,
    isDefaultBranch: branch ? branch === defaultBranch : false,
    origin: runRow.origin,
  };
  await emitNotification(db, 'run.finished', {
    ...base,
    passedTests: runRow.passedTests,
    flakyTests: runRow.flakyTests,
    skippedTests: runRow.skippedTests,
    didNotRunTests: runRow.didNotRunTests,
    durationMs: runRow.duration ?? undefined,
  });
  await emitNotification(db, 'environment.incident', {
    ...base,
    rule: incident.rule,
    reason: incident.reason,
    host: incident.host ?? undefined,
    otherProjects: incident.projects.length,
    incidentKey: `${incident.host ?? 'run'}:${incident.firstRunId}`,
  });
}

/**
 * Emit run.finished / run.failed / run.failed.default_branch notifications for a completed run,
 * plus flakiness.spike / perf.regression when the run qualifies, and cluster.new
 * for any failure clusters first seen in this run.
 * Call this after the run status is finalized.
 */
export async function emitRunNotifications(db: DbClient, runId: number): Promise<void> {
  try {
    const loaded = await loadRunPayload(db, runId);
    if (!loaded) return;
    const { runRow, project, runPayload, branch, environment, isDefaultBranch, clusterOwners } = loaded;

    await emitNotification(db, 'run.finished', runPayload);

    if (runRow.status === 'failed' || runRow.failedTests > 0) {
      await emitNotification(db, 'run.failed', runPayload);
      if (isDefaultBranch) {
        await emitNotification(db, 'run.failed.default_branch', runPayload);
      }
    }

    // Flaky tests in the run: subscriptions filter on flakinessRate via their
    // flakinessThreshold, so the event fires for any flaky run and the
    // per-subscription threshold decides delivery.
    if (runRow.flakyTests > 0) {
      await emitNotification(db, 'flakiness.spike', runPayload);
    }

    // Perf regression: the run is markedly slower than the median of prior
    // completed runs on the same branch and in the same environment.
    if (runRow.duration && runRow.duration > 0) {
      const priorRuns = await db
        .select({
          duration: testRuns.duration,
          branch: testRuns.branch,
          environment: testRuns.environment,
          metadata: testRuns.metadata,
        })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.projectId, runRow.projectId),
            lt(testRuns.id, runId),
            inArray(testRuns.status, ['passed', 'failed']),
          ),
        )
        .orderBy(desc(testRuns.id))
        .limit(BASELINE_FETCH_LIMIT);

      const priorDurations = priorRuns
        .filter((r) => (r.branch ?? resolveRunBranch(r.metadata)) === branch)
        .filter((r) => (r.environment ?? null) === (runRow.environment ?? null))
        .map((r) => r.duration ?? 0)
        .filter((d) => d > 0)
        .slice(0, PERF_BASELINE_RUNS);

      const baseline = computePerfBaseline(priorDurations, runRow.duration);
      if (baseline && baseline.regressionPct >= PERF_REGRESSION_MIN_PCT) {
        await emitNotification(db, 'perf.regression', {
          ...runPayload,
          baselineDurationMs: baseline.baselineDurationMs,
          regressionPct: Math.round(baseline.regressionPct),
        });
      }
    }

    // Emit cluster.new for any clusters first seen in this run
    const newClusters = await db
      .select({
        id: failureClusters.id,
        signature: failureClusters.signature,
        title: failureClusters.title,
        errorType: failureClusters.errorType,
        selector: failureClusters.selector,
        sampleError: failureClusters.sampleError,
      })
      .from(failureClusters)
      .where(and(eq(failureClusters.firstSeenRunId, runId), eq(failureClusters.projectId, runRow.projectId)));

    for (const cluster of newClusters) {
      const affected = await db
        .select({ id: testRunsCases.id })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.failureClusterId, cluster.id)));

      const knownIssue = (await getClusterKnownIssue(db, cluster.id).catch(() => null)) ?? undefined;
      await emitNotification(db, 'cluster.new', {
        clusterId: cluster.id,
        projectId: runRow.projectId,
        projectName: project.label || project.name,
        signature: cluster.signature,
        title: describeCluster(cluster),
        runId,
        branch,
        environment,
        sampleErrorExcerpt: errorExcerpt(cluster.sampleError),
        affectedCases: affected.length,
        knownIssue: knownIssue ? { key: knownIssue.key, url: knownIssue.url } : undefined,
        owners: clusterOwners(cluster.id),
      });
    }

    const looksFixed = await loadNewlyLooksFixedTests(db, runRow, branch);
    if (looksFixed.length > 0) {
      await emitNotification(db, 'bug.looks_fixed', {
        projectId: runRow.projectId,
        projectName: project.label || project.name,
        runId,
        branch,
        environment,
        tests: looksFixed,
      });
    }
  } catch (e) {
    console.error('[notifications] emitRunNotifications error', e);
  }
}
