import {
  testCases,
  testRunsCases,
  testRuns,
  projects,
  files,
  failureClusters,
  failureDiagnoses,
  entityLinks,
  networkRequests,
  quarantinedTests,
} from '../../server/database/schema';
import { eq, and, or, desc, gt, gte, ne, sql, inArray, isNull, isNotNull, notInArray } from 'drizzle-orm';
import { makeTimeBuckets } from './analytics/common';
import type { Granularity } from '../analytics/period';
import { computeWastedMs, DEFAULT_WASTED_WAIT_PATTERNS } from '../utils/wasted-waits';
import { splitSuitePath } from '../utils/suites';
import { inlineCasePayloads } from '../../server/utils/case-payloads';
import { buildFailureVerdict } from '../failure-verdict';
import { buildSituation } from '../situation';
import { summarizeNewerExecutions, type NewerExecutionRow } from '../latest-execution';
import { computeNextStep } from '../next-step';
import { describeDidNotRun } from '../did-not-run';
import { failureGoesOn, ticketReconcileKey } from '#shared/cluster-state';
import { getClusterPatchFacts, getHealingStepFacts } from './failure-clusters';
import { isLabRun, notLabExecution, notLabRun } from './probes';
import { eligibleRunSql, UNFINISHED_RUN_STATUSES } from '../run-eligibility';
import { getFlakeProfile, mayHaveFlakeSuspects } from './flake-profile';
import { getFlakeLabStepFacts, getFlakeSuspectResults, type FlakeSuspectResult } from './flake-lab';
import { isPassiveCapabilityDeclined } from './capabilities';
import { sanitizeExecutionResources } from '../resource-report';
import { FAILED_STATUS_KEYS, finalAttempts, isFailedStatus } from '../utils/test-counts';
import { buildFailureTimeline, type FailureTimeline, type TimelineCallsite } from '../failure-timeline';
import {
  attachUsualDurations,
  buildUsualDurations,
  USUAL_MIN_SAMPLES,
  type UsualDurations,
  type UsualRequestRow,
} from '../duration-standout';
import {
  buildFailureClues,
  type FailureClue,
  type FailureStory,
  type FailureClueInput,
  type FailureCluePageDiff,
} from '../failure-clues';
import { parsePlaywrightError } from '../error-parse';
import { failingStepParams } from '../describe-failure';
import { failureHookContext, type FailureHookContext, type TreeStepLike } from '../step-tree';
import { diffAttempts, type AttemptDiffEntry, type AttemptEvidence } from '../attempt-diff';
import { getLocatorHealing } from '../../server/utils/locator-healing';
import { getEnvironmentDiff } from '../../server/utils/environment-diff';
import { getPageDiff } from '../../server/utils/page-diff';
import type { PageStateLike } from '../page-state';
import type { TestStepEvent } from '../types';
import type { TestMetadata } from '@piwitests/core/test-meta';
import type { FlatStep } from '@piwitests/core/step-analysis';
import type { RunMetadata } from '../../server/utils/run-json-types';

import type { DrizzleDB } from './db';
import { clusterIssueFilings, clusterKnownIssues } from './known-issues';

/**
 * A test case with its header stats, recent executions and clusters. Executions
 * of lab runs (probes, flake experiments) replay the test under injected
 * conditions, so they never count toward the stats nor show as its history.
 */
export async function getTestCase(db: DrizzleDB, id: number) {
  const [testCase] = await db.select().from(testCases).where(eq(testCases.id, id));
  if (!testCase) return null;
  const realExecution = and(eq(testRunsCases.testCaseId, id), notLabExecution(testRunsCases.testRunId));

  const [[project], aggResult, [lastExecution]] = await Promise.all([
    db
      .select()
      .from(projects)
      .where(eq(projects.id, testCase.projectId))
      .then((r: any[]) => (r.length > 0 ? [r[0]] : [undefined])),
    // PostgreSQL returns COUNT and SUM (int8) and AVG (numeric) as strings, and
    // a timestamp aggregate unparsed: each is mapped so both dialects agree.
    db
      .select({
        totalRuns: sql<number>`COUNT(${testRunsCases.id})`.mapWith(Number),
        passedRuns: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' THEN 1 ELSE 0 END)`.mapWith(Number),
        failedRuns: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'failed' THEN 1 ELSE 0 END)`.mapWith(Number),
        skippedRuns: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'skipped' THEN 1 ELSE 0 END)`.mapWith(Number),
        timedOutRuns:
          sql<number>`SUM(CASE WHEN ${testRunsCases.status} IN ('timedOut', 'timedout') THEN 1 ELSE 0 END)`.mapWith(
            Number,
          ),
        flakyRuns:
          sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' AND ${testRunsCases.retries} > 0 THEN 1 ELSE 0 END)`.mapWith(
            Number,
          ),
        recentFlakyRuns: sql<number>`(
          SELECT COUNT(*) FROM (
            SELECT ${testRunsCases.status} AS s, ${testRunsCases.retries} AS r
            FROM ${testRunsCases}
            WHERE ${testRunsCases.testCaseId} = ${testCases.id}
              AND ${notLabExecution(testRunsCases.testRunId)}
            ORDER BY ${testRunsCases.createdAt} DESC
            LIMIT 10
          ) AS recent WHERE s = 'passed' AND r > 0
        )`.mapWith(Number),
        avgDuration: sql<number>`AVG(${testRunsCases.duration})`.mapWith(Number),
        lastRunAt: sql<Date>`MAX(${testRunsCases.createdAt})`.mapWith(testRunsCases.createdAt),
      })
      .from(testRunsCases)
      .where(realExecution),
    db
      .select({ id: testRunsCases.id })
      .from(testRunsCases)
      .where(realExecution)
      .orderBy(desc(testRunsCases.createdAt))
      .limit(1)
      .then((r: any[]) => (r.length > 0 ? [r[0]] : [undefined])),
  ]);

  const [recentExecutions, clusterRows, links] = await Promise.all([
    db
      .select({
        id: testRunsCases.id,
        status: testRunsCases.status,
        duration: testRunsCases.duration,
        error: testRunsCases.error,
        retries: testRunsCases.retries,
        attempts: testRunsCases.attempts,
        workerIndex: testRunsCases.workerIndex,
        browser: testRunsCases.browser,
        runId: testRuns.id,
        runStatus: testRuns.status,
        runLabel: testRuns.label,
        startTime: testRuns.startTime,
        isNewRegression: testRunsCases.isNewRegression,
        isNewFlaky: testRunsCases.isNewFlaky,
        failureClusterId: testRunsCases.failureClusterId,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(and(eq(testRunsCases.testCaseId, id), notLabRun(testRuns.origin)))
      .orderBy(desc(testRuns.startTime))
      .limit(20),
    db
      .selectDistinct({
        id: failureClusters.id,
        signature: failureClusters.signature,
        title: failureClusters.title,
        selector: failureClusters.selector,
        errorType: failureClusters.errorType,
        status: failureClusters.status,
        occurrences: failureClusters.occurrences,
      })
      .from(failureClusters)
      .innerJoin(testRunsCases, eq(testRunsCases.failureClusterId, failureClusters.id))
      .where(eq(testRunsCases.testCaseId, id)),
    db.select().from(entityLinks).where(eq(entityLinks.testCaseId, id)),
  ]);

  const totalRuns = aggResult[0]?.totalRuns ?? 0;
  const knownIssues = await clusterKnownIssues(
    db,
    recentExecutions
      .map((e: { failureClusterId: number | null }) => e.failureClusterId)
      .filter((c): c is number => c != null),
  );

  return {
    id: testCase.id,
    filePath: testCase.filePath,
    suitePath: testCase.suitePath,
    title: testCase.title,
    externalId: testCase.externalId ?? null,
    displayTitle: testCase.displayTitle ?? null,
    tags: (testCase.tags as string[] | null) ?? null,
    locks: (testCase.locks as string[] | null) ?? null,
    project: project
      ? { id: project.id, name: project.name, label: project.label, externalIdUrl: project.externalIdUrl ?? null }
      : null,
    totalRuns,
    passedRuns: aggResult[0]?.passedRuns ?? 0,
    failedRuns: aggResult[0]?.failedRuns ?? 0,
    skippedRuns: aggResult[0]?.skippedRuns ?? 0,
    timedOutRuns: aggResult[0]?.timedOutRuns ?? 0,
    flakyRuns: aggResult[0]?.flakyRuns ?? 0,
    recentFlakyRuns: aggResult[0]?.recentFlakyRuns ?? 0,
    avgDuration: aggResult[0]?.avgDuration ?? null,
    passRate:
      totalRuns > 0
        ? Math.round((((aggResult[0]?.passedRuns ?? 0) + (aggResult[0]?.skippedRuns ?? 0)) / totalRuns) * 100)
        : null,
    lastRunAt: aggResult[0]?.lastRunAt ?? null,
    lastExecutionId: lastExecution?.id ?? null,
    failureClusters: clusterRows.map((c: any) => ({
      ...c,
      status: c.status ?? 'open',
    })),
    recentExecutions: recentExecutions.map((e: { failureClusterId: number | null }) => ({
      ...e,
      knownIssue: e.failureClusterId != null ? (knownIssues.get(e.failureClusterId) ?? null) : null,
    })),
    links,
  };
}

export async function getTestCaseHistory(db: DrizzleDB, testCaseId: number) {
  // Lab runs replay a test with an injected fault or condition, so their executions never
  // appear in a test's history.
  return db
    .select({
      id: testRunsCases.id,
      runId: testRuns.id,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      error: testRunsCases.error,
      retries: testRunsCases.retries,
      attempts: testRunsCases.attempts,
      startTime: testRuns.startTime,
      runStatus: testRuns.status,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(eq(testRunsCases.testCaseId, testCaseId), notLabRun(testRuns.origin)))
    .orderBy(desc(testRuns.startTime))
    .limit(50);
}

/**
 * The executions of a test newer than one execution: the later attempts of its
 * own repetition in the same run, and every attempt in a run that started later
 * (a tie on the start time goes to the higher run id), newest first. Every
 * Playwright project and every branch, lab runs left out;
 * `summarizeNewerExecutions` keeps the execution's own project. Fifty rows at
 * most.
 */
export async function getNewerExecutions(
  db: DrizzleDB,
  ref: { testCaseId: number; runId: number; runStartTime: Date | null; repeatEachIndex: number; retries: number },
): Promise<NewerExecutionRow[]> {
  const laterRun = ref.runStartTime
    ? or(
        gt(testRuns.startTime, ref.runStartTime),
        and(eq(testRuns.startTime, ref.runStartTime), gt(testRuns.id, ref.runId)),
      )
    : gt(testRuns.id, ref.runId);
  return db
    .select({
      id: testRunsCases.id,
      runId: testRuns.id,
      status: testRunsCases.status,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      browserName: testRunsCases.browserName,
      failureClusterId: testRunsCases.failureClusterId,
      startTime: testRuns.startTime,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, ref.testCaseId),
        notLabRun(testRuns.origin),
        or(
          laterRun,
          and(
            eq(testRuns.id, ref.runId),
            eq(testRunsCases.repeatEachIndex, ref.repeatEachIndex),
            gt(testRunsCases.retries, ref.retries),
          ),
        ),
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id), desc(testRunsCases.retries))
    .limit(50);
}

export async function getTestRunCase(
  db: DrizzleDB,
  id: number,
  // Custom wasted-wait patterns; null = the defaults are in effect, so the
  // stored wasted_time_ms (computed at ingest) is authoritative.
  wastedPatterns: readonly string[] | null = null,
  // Server-only signals the next-step policy reads, and the owner of a spec file
  // the repository's CODEOWNERS names; the demo omits them all, the MCP tools
  // pass only the owner.
  opts: {
    aiConfigured?: boolean;
    ciRerunAvailable?: boolean;
    flakeLabCiAvailable?: boolean;
    resolveOwner?: (filePath: string) => Promise<string | null>;
    now?: Date;
  } = {},
) {
  const [trc] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
  if (!trc) return null;

  // Large evidence payloads are content-addressed; a row may still keep them inline.
  const evidence = await inlineCasePayloads(db, trc);

  // Every attempt is its own execution row (unique on run + test case + repeat
  // + retries + browser), so each stored attempt maps to the sibling row of the
  // same repetition that holds it.
  const siblingRows = await db
    .select({ id: testRunsCases.id, retries: testRunsCases.retries, status: testRunsCases.status })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, trc.testRunId),
        eq(testRunsCases.testCaseId, trc.testCaseId),
        eq(testRunsCases.repeatEachIndex, trc.repeatEachIndex),
        trc.browserName ? eq(testRunsCases.browserName, trc.browserName) : sql`${testRunsCases.browserName} IS NULL`,
      ),
    );
  const executionByRetry = new Map(siblingRows.map((r: any) => [r.retries ?? 0, r.id as number]));
  const attempts = Array.isArray(trc.attempts)
    ? (trc.attempts as Array<{ retry: number }>).map((a) => ({
        ...a,
        executionId: executionByRetry.get(a.retry) ?? null,
      }))
    : null;

  // A pass that needed a retry has no error of its own: its headline, steps and
  // `why` come from the last failed attempt of the same run, test, browser and
  // repetition.
  const retries = trc.retries ?? 0;
  const passedOnRetry = trc.status === 'passed' && retries > 0;
  const failedSibling = passedOnRetry
    ? (siblingRows as Array<{ id: number; retries: number | null; status: string }>)
        .filter((r) => (r.retries ?? 0) < retries && isFailedStatus(r.status))
        .sort((a, b) => (b.retries ?? 0) - (a.retries ?? 0))[0]
    : undefined;
  const [failedAttempt] = failedSibling
    ? await db
        .select({
          id: testRunsCases.id,
          retries: testRunsCases.retries,
          error: testRunsCases.error,
          steps: testRunsCases.steps,
        })
        .from(testRunsCases)
        .where(eq(testRunsCases.id, failedSibling.id))
    : [];

  const [[testCase], [testRun], reportList, attachmentList] = await Promise.all([
    db
      .select()
      .from(testCases)
      .where(eq(testCases.id, trc.testCaseId))
      .then((r: any[]) => (r.length > 0 ? [r[0]] : [undefined])),
    db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, trc.testRunId))
      .then((r: any[]) => (r.length > 0 ? [r[0]] : [undefined])),
    db
      .select()
      .from(files)
      .where(sql`${files.testRunId} = ${trc.testRunId} AND ${files.type} = 'report'`)
      .then((r: any[]) =>
        r.map((rep: any) => ({
          id: rep.id,
          type: rep.subtype || rep.type,
          label: rep.label || rep.type,
          path: rep.path,
          size: rep.size,
        })),
      ),
    db
      .select()
      .from(files)
      .where(sql`${files.testRunsCaseId} = ${trc.id} AND ${files.type} = 'attachment'`)
      .orderBy(files.id)
      .then((r: any[]) =>
        r.map((att: any) => ({
          id: att.id,
          name: att.subtype,
          contentType: att.label,
          path: att.path,
          size: att.size,
        })),
      ),
  ]);

  let project = null;
  if (testRun) {
    const [projectResult] = await db.select().from(projects).where(eq(projects.id, testRun.projectId));
    if (projectResult) {
      const { scmToken: _scmToken, ...projectPublic } = projectResult;
      project = projectPublic;
    }
  }

  let failureCluster = null;
  let ticketDoneKey: string | null = null;
  if (trc.failureClusterId) {
    const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, trc.failureClusterId));
    if (cluster) {
      const [sameRun] = await db
        .select({
          count: sql<number>`count(distinct ${testRunsCases.testCaseId})`,
        })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.testRunId, trc.testRunId), eq(testRunsCases.failureClusterId, cluster.id)));

      const [firstSeenRun] = await db
        .select({ startTime: testRuns.startTime })
        .from(testRuns)
        .where(eq(testRuns.id, cluster.firstSeenRunId));

      const [diagnosis] = await db
        .select({
          status: failureDiagnoses.status,
          category: failureDiagnoses.category,
          confidence: failureDiagnoses.confidence,
          summary: failureDiagnoses.summary,
          provider: failureDiagnoses.provider,
        })
        .from(failureDiagnoses)
        .where(and(eq(failureDiagnoses.clusterId, cluster.id), eq(failureDiagnoses.scope, 'cluster')));

      // The cluster's issue, where its filings stand, and its own links, newest
      // first as the cluster page lists them: the execution's Details shows them
      // beside its own, read-only.
      const [knownIssues, filings, clusterLinks] = await Promise.all([
        clusterKnownIssues(db, [cluster.id]),
        clusterIssueFilings(db, [cluster.id]),
        db.select().from(entityLinks).where(eq(entityLinks.failureClusterId, cluster.id)).orderBy(desc(entityLinks.id)),
      ]);
      const knownIssue = knownIssues.get(cluster.id) ?? null;

      // A Done issue on a failure that goes on calls for a new issue, and on one
      // that stopped, for marking the cluster resolved: the rules the cluster page
      // follows. Read only when the issue is Done.
      let goesOn: boolean | null = null;
      if (knownIssue?.statusCategory === 'done') {
        const [latestFinished] = await db
          .select({ id: testRuns.id, startTime: testRuns.startTime })
          .from(testRuns)
          .where(
            and(eq(testRuns.projectId, cluster.projectId), notInArray(testRuns.status, [...UNFINISHED_RUN_STATUSES])),
          )
          .orderBy(desc(testRuns.startTime), desc(testRuns.id))
          .limit(1);
        const [lastSeen] = await db
          .select({ id: testRuns.id, startTime: testRuns.startTime })
          .from(testRuns)
          .where(eq(testRuns.id, cluster.lastSeenRunId));
        goesOn = failureGoesOn(lastSeen ?? null, latestFinished ?? null);
      }
      ticketDoneKey =
        goesOn === null
          ? null
          : ticketReconcileKey(
              {
                status: cluster.status ?? 'open',
                fixVerification: cluster.fixVerification ?? null,
                snoozedUntil: cluster.snoozedUntil ?? null,
                snoozeMode: cluster.snoozeMode ?? null,
                knownIssue,
              },
              { failureGoesOn: goesOn, now: opts.now },
            );

      failureCluster = {
        id: cluster.id,
        signature: cluster.signature,
        title: cluster.title,
        errorType: cluster.errorType,
        selector: cluster.selector,
        status: cluster.status ?? 'open',
        triageNote: cluster.triageNote ?? null,
        occurrences: cluster.occurrences,
        firstSeenRunId: cluster.firstSeenRunId,
        firstSeenAt: firstSeenRun?.startTime ?? null,
        isNew: cluster.firstSeenRunId === trc.testRunId,
        sameRunCaseCount: Number(sameRun?.count ?? 0),
        diagnosis: diagnosis ?? null,
        fixVerification: cluster.fixVerification ?? null,
        fixCommit: cluster.fixCommit ?? null,
        fixLandedRunId: cluster.fixLandedRunId ?? null,
        fixLandedAt: cluster.fixLandedAt ?? null,
        assignee: cluster.assignee ?? null,
        knownIssue,
        failureGoesOn: goesOn,
        issueFilingQueued: filings.queued.has(cluster.id),
        issueFilingFailure: filings.failures.get(cluster.id) ?? null,
        links: clusterLinks,
      };
    }
  }

  const [networkRequestRows, linksForCaseRun, linksForTestCase, linksForRun, quarantineRows] = await Promise.all([
    db.select().from(networkRequests).where(eq(networkRequests.testRunsCaseId, trc.id)),
    db.select().from(entityLinks).where(eq(entityLinks.testRunsCaseId, trc.id)),
    testCase ? db.select().from(entityLinks).where(eq(entityLinks.testCaseId, testCase.id)) : Promise.resolve([]),
    db.select().from(entityLinks).where(eq(entityLinks.testRunId, trc.testRunId)),
    db
      .select({ id: quarantinedTests.id })
      .from(quarantinedTests)
      .where(and(eq(quarantinedTests.testCaseId, trc.testCaseId), isNull(quarantinedTests.releasedAt))),
  ]);

  // Whether this execution's stable test case is currently quarantined — lets the
  // failure page offer "Quarantine" / "Release" and mark the row without a
  // separate request to the project quarantine list.
  const quarantined = quarantineRows.length > 0;

  const networkRequestsData = networkRequestRows.map((nr) => ({
    method: nr.method,
    url: nr.url,
    status: nr.status,
    duration: nr.duration,
    startTime: nr.startTime ?? undefined,
    resourceType: nr.resourceType,
    contentType: nr.contentType,
    serverLogs: nr.serverLogs,
    serverTraces: nr.serverTraces,
    failure: nr.failure ?? null,
    fulfilled: nr.fulfilled ?? null,
  }));

  // Cause ↔ effect for did-not-run cascades, both scoped to this run:
  //  - `blockedTests`: the downstream tests this execution stopped from running
  //    (they carry `blocked_by = this execution's location`).
  //  - `blockedByCase`: the failing execution that blocked THIS one (only set on
  //    a `previous-failure` case, resolved from its `blocked_by` location).
  const ownLocation =
    testCase?.filePath && trc.line != null && trc.column != null
      ? `${testCase.filePath}:${trc.line}:${trc.column}`
      : null;

  type BlockedCaseRef = { id: number; title: string; location: string; status: string };
  const toRef = (r: {
    id: number;
    title: string;
    filePath: string;
    line: number | null;
    column: number | null;
    status: string;
  }): BlockedCaseRef => ({
    id: r.id,
    title: r.title,
    location: r.line != null && r.column != null ? `${r.filePath}:${r.line}:${r.column}` : r.filePath,
    status: r.status,
  });
  const blockedRefColumns = {
    id: testRunsCases.id,
    title: testCases.title,
    filePath: testCases.filePath,
    line: testRunsCases.line,
    column: testRunsCases.column,
    status: testRunsCases.status,
  };

  let blockedTests: BlockedCaseRef[] = [];
  if (ownLocation) {
    const rows = await db
      .select(blockedRefColumns)
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(and(eq(testRunsCases.testRunId, trc.testRunId), eq(testRunsCases.blockedBy, ownLocation)));
    blockedTests = rows.map(toRef);
  }

  // The blocking execution also says where it failed: a failing beforeAll hook
  // skips the rest of its group just as a serial-group failure does.
  let blockedByCase: (BlockedCaseRef & { failedIn: FailureHookContext | null }) | null = null;
  if (trc.blockedBy) {
    const m = /^(.*):(\d+):(\d+)$/.exec(trc.blockedBy);
    if (m) {
      const [row] = await db
        .select({ ...blockedRefColumns, steps: testRunsCases.steps, error: testRunsCases.error })
        .from(testRunsCases)
        .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
        .where(
          and(
            eq(testRunsCases.testRunId, trc.testRunId),
            eq(testCases.filePath, m[1]!),
            eq(testRunsCases.line, Number(m[2])),
            eq(testRunsCases.column, Number(m[3])),
          ),
        );
      if (row) {
        const steps = Array.isArray(row.steps) ? (row.steps as TreeStepLike[]) : [];
        blockedByCase = { ...toRef(row), failedIn: failureHookContext(steps, row.error) };
      }
    }
  }

  const { streamToken: _streamToken, ...testRunPublic } = testRun ?? {};

  // The one-line verdict on a failing execution — headline, why, since when,
  // cluster and owner — built from what is already loaded above, and for a retry
  // pass from its failed attempt, with no cluster: that attempt's page carries
  // it. The owner is the test's own annotation, else the one `resolveOwner`
  // finds for its spec file.
  const scm = ((testRun?.metadata as RunMetadata | null)?.scm ?? null) as {
    commit?: string | null;
    branch?: string | null;
    author?: string | null;
    commitMessage?: string | null;
  } | null;
  const verdictError = failedAttempt ? failedAttempt.error : trc.error;
  const codeOwner =
    verdictError?.trim() && !testCase?.owner && testCase?.filePath && opts.resolveOwner
      ? await opts.resolveOwner(testCase.filePath)
      : null;
  const verdict = buildFailureVerdict({
    error: verdictError,
    steps: failedAttempt ? failedAttempt.steps : trc.steps,
    status: trc.status,
    retries: trc.retries,
    isNewRegression: trc.isNewRegression,
    isNewFlaky: trc.isNewFlaky,
    runId: trc.testRunId,
    scm,
    cluster:
      failureCluster && !failedAttempt
        ? { ...failureCluster, sampleError: null, filePath: testCase?.filePath ?? null }
        : null,
    owner: testCase?.owner || (codeOwner ? { name: codeOwner, source: 'codeowners' } : null),
    fromAttempt: failedAttempt ? { retry: failedAttempt.retries ?? 0, executionId: failedAttempt.id } : null,
  });
  // A retry pass is one with or without its failed attempt stored: the policy
  // reads it from the status alone when there is no verdict.
  const why = verdict?.why ?? (passedOnRetry ? 'passed-on-retry' : null);

  // The situation lines and the single next step, built from the verdict and
  // the same healing / diagnosis facts the toolbox reads, so the top of the page
  // says what to do without re-deriving it in the UI.
  const healing = await getLocatorHealing(db, id).catch(() => null);
  const healingFacts = await getHealingStepFacts(db, testCase?.projectId, healing);
  const patchFacts = failureCluster
    ? await getClusterPatchFacts(db, failureCluster.id, { fixLandedRunId: failureCluster.fixLandedRunId })
    : null;
  // Whether a newer execution of the test, in the same Playwright project,
  // failed again or passed: sent for every execution, and said under a failing
  // one's headline.
  const latest = testRun
    ? summarizeNewerExecutions(
        { runId: trc.testRunId, browserName: trc.browserName ?? null, failureClusterId: trc.failureClusterId ?? null },
        await getNewerExecutions(db, {
          testCaseId: trc.testCaseId,
          runId: trc.testRunId,
          runStartTime: testRun.startTime ?? null,
          repeatEachIndex: trc.repeatEachIndex,
          retries: trc.retries ?? 0,
        }),
      )
    : null;
  const situation = verdict
    ? buildSituation({
        why: verdict.why,
        since: verdict.since,
        cluster: verdict.cluster,
        owner: verdict.owner,
        clusterStatus: failureCluster?.status ?? null,
        assignee: failureCluster?.assignee ?? null,
        latest,
        attempt: verdict.attempt
          ? { failedRetry: verdict.attempt.retry, failedExecutionId: verdict.attempt.executionId, passedRetry: retries }
          : null,
        newFlaky: Boolean(trc.isNewFlaky),
        now: opts.now,
      })
    : null;
  // A flaky failure's next step can be the Flake Lab's: reproduce it, or verify its
  // fix. Flaky: a retry pass, or a failure that is not a new regression of a test
  // whose history both fails and passes.
  const flaked =
    why === 'passed-on-retry' ||
    why === 'new-flaky' ||
    (isFailedStatus(trc.status) &&
      why !== 'new-regression' &&
      trc.testCaseId != null &&
      (await mayHaveFlakeSuspects(db, trc.testCaseId).catch(() => false)));
  const flakeLab =
    flaked &&
    trc.testCaseId != null &&
    testCase &&
    !(await isPassiveCapabilityDeclined(db, testCase.projectId, 'flake-lab'))
      ? await getFlakeLabStepFacts(db, trc.testCaseId, { ciAvailable: opts.flakeLabCiAvailable, now: opts.now }).catch(
          () => null,
        )
      : null;
  // A test that did not run gives its reason as one sentence, and its next step
  // opens what stopped it: the blocking failure, the run's one failure, or the run.
  const didNotRun =
    trc.status === 'didnotrun'
      ? describeDidNotRun({
          reason: trc.didNotRunReason,
          blockedByCase,
          runFailedTests: testRun?.failedTests ?? null,
        })
      : null;
  // The run's one failed test, when a max-failures cutoff has a single one to
  // open, counted like the sentence's failed count: one final attempt per test,
  // browser and repetition. A test that failed on every retry opens its last
  // attempt; a test that passed on retry is not a failure. The failed rows and
  // the retries are the only rows that can be or replace a final failed attempt.
  const runFailedFinals =
    trc.status === 'didnotrun' &&
    !blockedByCase &&
    trc.didNotRunReason === 'max-failures' &&
    (testRun?.failedTests ?? 0) <= 1
      ? finalAttempts(
          await db
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
                eq(testRunsCases.testRunId, trc.testRunId),
                or(inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]), gt(testRunsCases.retries, 0)),
              ),
            ),
        ).filter((r) => isFailedStatus(r.status))
      : [];
  const nextStep = computeNextStep({
    status: trc.status,
    blockedByCase: blockedByCase ? { id: blockedByCase.id, title: blockedByCase.title } : null,
    didNotRunReason: trc.didNotRunReason ?? null,
    runId: trc.testRunId,
    runFailedExecutionId: runFailedFinals.length === 1 ? runFailedFinals[0]!.id : null,
    clusterStatus: failureCluster?.status ?? null,
    fixVerification: failureCluster?.fixVerification ?? null,
    fixLandedRunId: failureCluster?.fixLandedRunId ?? null,
    fixCommit: failureCluster?.fixCommit ?? null,
    ticketDoneKey,
    ...healingFacts,
    diagnosisCompleted: patchFacts?.diagnosisCompleted ?? false,
    diagnosisSummary: patchFacts?.summary ?? null,
    patchFile: patchFacts?.patchFile ?? null,
    hasPatch: patchFacts?.hasPatch ?? false,
    patchValidationStatus: patchFacts?.patchValidationStatus ?? null,
    patchAppliesCleanly: patchFacts?.patchAppliesCleanly ?? false,
    patchAppliesAtFix: patchFacts?.patchAppliesAtFix ?? false,
    why,
    errorKind: verdict?.kind ?? null,
    aiConfigured: opts.aiConfigured ?? false,
    ciRerunAvailable: opts.ciRerunAvailable ?? false,
    flakeLab,
    clusterId: failureCluster?.id ?? null,
    executionId: trc.id,
  });

  return {
    id: trc.id,
    testCaseId: trc.testCaseId,
    title: testCase?.title,
    externalId: testCase?.externalId ?? null,
    displayTitle: testCase?.displayTitle ?? null,
    filePath: testCase?.filePath ?? null,
    suitePath: splitSuitePath(testCase?.suitePath),
    line: trc.line ?? null,
    location: trc.line && trc.column ? `${testCase?.filePath}:${trc.line}:${trc.column}` : testCase?.filePath,
    status: trc.status,
    duration: trc.duration,
    error: trc.error,
    retries: trc.retries,
    attempts,
    steps: trc.steps,
    testSource: evidence.testSource,
    testSourceFrames: evidence.testSourceFrames,
    testAnnotations: trc.testAnnotations,
    tags: (trc.tags as string[] | null) ?? null,
    locks: (trc.locks as string[] | null) ?? null,
    testMeta: (trc.testMeta as TestMetadata | null) ?? null,
    startedAt: trc.startedAt,
    slowestStep: trc.slowestStep,
    slowestStepDuration: trc.slowestStepDuration,
    wastedTimeMs: wastedPatterns
      ? trc.stepEvents != null
        ? computeWastedMs(trc.stepEvents as TestStepEvent[], wastedPatterns)
        : trc.wastedTimeMs
      : (trc.wastedTimeMs ??
        (trc.stepEvents != null
          ? computeWastedMs(trc.stepEvents as TestStepEvent[], DEFAULT_WASTED_WAIT_PATTERNS)
          : null)),
    networkRequests: networkRequestsData,
    webVitals: trc.webVitals,
    resources:
      trc.resources != null && testCase && !(await isPassiveCapabilityDeclined(db, testCase.projectId, 'resources'))
        ? sanitizeExecutionResources(trc.resources)
        : null,
    pageState: trc.pageState,
    aiUsage: trc.aiUsage,
    consoleLogs: trc.consoleLogs,
    ariaSnapshot: evidence.ariaSnapshot,
    evidenceSources: trc.evidenceSources,
    workerIndex: trc.workerIndex,
    shardIndex: trc.shardIndex,
    browser: trc.browser,
    isNewRegression: trc.isNewRegression ?? null,
    isNewFlaky: trc.isNewFlaky ?? null,
    didNotRunReason: trc.didNotRunReason ?? null,
    expectedStatus: trc.expectedStatus ?? null,
    blockedBy: trc.blockedBy ?? null,
    blockedByCase,
    blockedTests,
    didNotRun,
    failureCluster,
    verdict,
    situation,
    latest,
    nextStep,
    quarantined,
    testRun: testRun ? { ...testRunPublic, project, reports: reportList, links: linksForRun } : testRun,
    attachments: attachmentList,
    links: linksForCaseRun,
    stableLinks: linksForTestCase,
  };
}

/**
 * The last passing execution's captured page state for a test case, from a run
 * eligible as a baseline (pinned to the same browser when known) — the baseline for the app-state diff. Shared
 * by the server AI-context builder and the demo mirror.
 */
export async function getLastPassPageState(
  db: DrizzleDB,
  opts: { testCaseId: number; browserName?: string | null },
): Promise<unknown | null> {
  const conds = [
    eq(testRunsCases.testCaseId, opts.testCaseId),
    eq(testRunsCases.status, 'passed'),
    sql`${testRunsCases.pageState} IS NOT NULL`,
    eligibleRunSql('baseline'),
  ];
  if (opts.browserName) conds.push(eq(testRunsCases.browserName, opts.browserName));
  const rows = await db
    .select({ pageState: testRunsCases.pageState })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .orderBy(desc(testRuns.startTime), desc(testRunsCases.id))
    .limit(1);
  return rows[0]?.pageState ?? null;
}

/**
 * The failure timeline for one execution: its steps, console entries, network
 * requests and backend log entries placed on a single clock around the moment
 * of failure, with each action attributed to the method or `test.step` it was
 * called from. Loads the same rows the execution detail reads and hands them to
 * the pure `buildFailureTimeline`; shared by the REST endpoint and the demo
 * mirror. Returns an empty timeline when the execution does not exist.
 *
 * Callers may pass `traceCallsites` (parsed from the stored trace, server-side)
 * to attach function names and the caller chain to each action; without them,
 * call sites come from the reporter's own `location` (file and line only).
 *
 * The stored trace records action times on a monotonic clock the execution's
 * epoch timestamps cannot be mixed with, so no trace anchor is fed here —
 * `failureAt` comes from the failed step (or `startedAt + duration`), and the
 * card links out to the trace viewer instead.
 *
 * Each step and request carries its usual duration (`getUsualDurations`), the
 * baseline a duration that stands out is compared with.
 */
export async function getFailureTimeline(
  db: DrizzleDB,
  id: number,
  opts: { traceCallsites?: TimelineCallsite[] | null } = {},
): Promise<FailureTimeline> {
  const [trc] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
  if (!trc) return buildFailureTimeline({});

  const [networkRequestRows, [testCase]] = await Promise.all([
    db.select().from(networkRequests).where(eq(networkRequests.testRunsCaseId, id)),
    db.select({ filePath: testCases.filePath }).from(testCases).where(eq(testCases.id, trc.testCaseId)),
  ]);

  const requests = networkRequestRows.map((nr) => ({
    method: nr.method,
    url: nr.url,
    status: nr.status,
    duration: nr.duration,
    startTime: nr.startTime ?? undefined,
    serverLogs: nr.serverLogs,
    serverTraces: nr.serverTraces,
  }));
  const timeline = buildFailureTimeline({
    startedAt: trc.startedAt,
    duration: trc.duration,
    timeout: trc.timeout,
    status: trc.status,
    error: trc.error,
    steps: trc.steps,
    stepEvents: trc.stepEvents,
    consoleLogs: trc.consoleLogs,
    dialogs: trc.dialogs,
    specFile: testCase?.filePath ?? null,
    traceCallsites: opts.traceCallsites ?? null,
    networkRequests: requests,
  });
  if (timeline.lanes.steps.length === 0 && timeline.lanes.network.length === 0) return timeline;

  const usual = await getUsualDurations(db, {
    testCaseId: trc.testCaseId,
    browserName: trc.browserName ?? null,
    excludeId: id,
  });
  return attachUsualDurations(timeline, { steps: trc.steps, networkRequests: requests }, usual);
}

/** How many of a test's last passing executions its usual durations read. */
const USUAL_DURATION_EXECUTIONS = 5;

/**
 * The usual duration of each step and request route of one test: the median
 * over its last `USUAL_DURATION_EXECUTIONS` passing executions on the same
 * browser, in runs eligible as a baseline (no lab or investigation run, no
 * environment incident), the execution being read left out. Two bounded
 * queries: the executions' steps, then their requests.
 */
export async function getUsualDurations(
  db: DrizzleDB,
  opts: { testCaseId: number; browserName: string | null; excludeId: number },
): Promise<UsualDurations> {
  const conds = [
    eq(testRunsCases.testCaseId, opts.testCaseId),
    sql`${testRunsCases.status} = 'passed'`,
    ne(testRunsCases.id, opts.excludeId),
    eligibleRunSql('baseline'),
  ];
  if (opts.browserName) conds.push(eq(testRunsCases.browserName, opts.browserName));
  const past: Array<{ id: number; steps: unknown }> = await db
    .select({ id: testRunsCases.id, steps: testRunsCases.steps })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(...conds))
    .orderBy(desc(testRunsCases.createdAt), desc(testRunsCases.id))
    .limit(USUAL_DURATION_EXECUTIONS);
  if (past.length < USUAL_MIN_SAMPLES) return buildUsualDurations([]);

  const requestRows: Array<UsualRequestRow & { testRunsCaseId: number }> = await db
    .select({
      testRunsCaseId: networkRequests.testRunsCaseId,
      method: networkRequests.method,
      url: networkRequests.url,
      status: networkRequests.status,
      duration: networkRequests.duration,
    })
    .from(networkRequests)
    .where(
      inArray(
        networkRequests.testRunsCaseId,
        past.map((row) => row.id),
      ),
    );
  const requestsByExecution = new Map<number, UsualRequestRow[]>();
  for (const row of requestRows) {
    const list = requestsByExecution.get(row.testRunsCaseId) ?? [];
    list.push(row);
    requestsByExecution.set(row.testRunsCaseId, list);
  }
  return buildUsualDurations(
    past.map((row) => ({ steps: row.steps, networkRequests: requestsByExecution.get(row.id) ?? [] })),
  );
}

/** One execution's flattened steps plus the timing the timeline positions them against. */
export interface ExecutionSteps {
  steps: FlatStep[];
  /** Absolute start time in ms, or null when the reporter recorded none. */
  startedAt: number | null;
  /** Total duration in ms. */
  duration: number | null;
  status: string | null;
}

/**
 * The flattened step list for one execution (the `steps` column), loaded on
 * demand when a worker-timeline row is expanded into its per-step waterfall.
 * Kept separate from the run detail payload, which omits `steps` to stay light.
 * Returns an empty list when the execution does not exist.
 */
export async function getExecutionSteps(db: DrizzleDB, id: number): Promise<ExecutionSteps> {
  const [trc] = await db
    .select({
      steps: testRunsCases.steps,
      startedAt: testRunsCases.startedAt,
      duration: testRunsCases.duration,
      status: testRunsCases.status,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, id));
  if (!trc) return { steps: [], startedAt: null, duration: null, status: null };
  return {
    steps: (trc.steps as FlatStep[] | null) ?? [],
    startedAt: trc.startedAt ?? null,
    duration: trc.duration ?? null,
    status: trc.status ?? null,
  };
}

/** What the clue engine returns for one execution, plus the failure anchor the UI needs. */
export interface FailureCluesResult {
  clues: FailureClue[];
  /** The story chaining the clues into one sentence, or null when no combination matches. */
  story: FailureStory | null;
  /** The moment of failure, in ms relative to the timeline origin — the `t+0` the card counts back from. */
  failureAt: number | null;
}

/** Reduce a page-diff result to the change (if any) at the failing locator's node, for the clue engine. */
function pageDiffLocatorChange(pageDiff: Awaited<ReturnType<typeof getPageDiff>> | null): FailureCluePageDiff | null {
  if (pageDiff?.status !== 'ok') return null;
  const hunk = pageDiff.hunks?.find((h) => h.matchesLocator);
  if (!hunk) return null;
  return { locatorChange: { type: hunk.type, role: hunk.role, name: hunk.name, oldName: hunk.oldName ?? null } };
}

/**
 * Load everything the clue engine reads for one failing execution — the parsed
 * error, the timeline, network requests, the ARIA snapshot, locator healing,
 * app state, the environment diff, the run's sibling and same-worker
 * executions, and the cluster's fix history — as the pure `FailureClueInput`.
 * Returns null when the execution does not exist. Separating the loading from
 * `buildFailureClues` lets a fixture capture the exact input the seeded database
 * produces, so a unit test can pin the ranking without a database.
 *
 * `slowRequestMs` lets the server pass the configured slow-request threshold;
 * without it the engine uses its 1500 ms default.
 */
export async function loadFailureClueInput(
  db: DrizzleDB,
  id: number,
  opts: { slowRequestMs?: number | null } = {},
): Promise<FailureClueInput | null> {
  const [trc] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
  if (!trc) return null;

  const evidence = await inlineCasePayloads(db, trc);

  const [networkRequestRows, [testCase]] = await Promise.all([
    db.select().from(networkRequests).where(eq(networkRequests.testRunsCaseId, id)),
    db
      .select({ filePath: testCases.filePath, projectId: testCases.projectId })
      .from(testCases)
      .where(eq(testCases.id, trc.testCaseId)),
  ]);

  const networkForClues = networkRequestRows.map((nr) => ({
    method: nr.method,
    url: nr.url,
    status: nr.status,
    duration: nr.duration,
    startTime: nr.startTime ?? undefined,
    failure: nr.failure,
    serverLogs: (nr.serverLogs ?? null) as Array<{
      level?: string | null;
      message?: string | null;
      timestamp?: number | null;
    }> | null,
  }));

  const timeline = buildFailureTimeline({
    startedAt: trc.startedAt,
    duration: trc.duration,
    timeout: trc.timeout,
    status: trc.status,
    error: trc.error,
    steps: trc.steps,
    stepEvents: trc.stepEvents,
    consoleLogs: trc.consoleLogs,
    dialogs: trc.dialogs,
    specFile: testCase?.filePath ?? null,
    networkRequests: networkForClues,
  });

  // Lock holders in this run are only needed when this execution declared a
  // lock — the two lock rules can then correlate against the other holders.
  const selfLocks = Array.isArray(trc.locks) ? (trc.locks as string[]) : [];

  // Run-level facts and the two derived analyses the engine cites, loaded in
  // parallel. Healing and the environment diff resolve their own baselines.
  const [healing, environmentDiff, pageDiff, browserPeers, workerExecutions, clusterFix, lockHolders, flakeSuspects] =
    await Promise.all([
      getLocatorHealing(db, id).catch(() => null),
      getEnvironmentDiff(db, id).catch(() => null),
      getPageDiff(db, id).catch(() => null),
      db
        .select({
          browserName: testRunsCases.browserName,
          status: testRunsCases.status,
        })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.testRunId, trc.testRunId), eq(testRunsCases.testCaseId, trc.testCaseId))),
      trc.workerIndex != null
        ? db
            .select({
              id: testRunsCases.id,
              testCaseId: testRunsCases.testCaseId,
              title: testCases.title,
              status: testRunsCases.status,
              startedAt: testRunsCases.startedAt,
            })
            .from(testRunsCases)
            .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
            .where(
              and(
                eq(testRunsCases.testRunId, trc.testRunId),
                eq(testRunsCases.workerIndex, trc.workerIndex),
                trc.shardIndex != null
                  ? eq(testRunsCases.shardIndex, trc.shardIndex)
                  : isNull(testRunsCases.shardIndex),
              ),
            )
        : Promise.resolve(
            [] as Array<{
              id: number;
              testCaseId: number;
              title: string | null;
              status: string;
              startedAt: number | null;
            }>,
          ),
      trc.failureClusterId
        ? db
            .select({
              fixCommit: failureClusters.fixCommit,
              fixLandedRunId: failureClusters.fixLandedRunId,
              fixVerification: failureClusters.fixVerification,
            })
            .from(failureClusters)
            .where(eq(failureClusters.id, trc.failureClusterId))
            .then((r: any[]) => r[0] ?? null)
        : Promise.resolve(null),
      selfLocks.length > 0
        ? db
            .select({
              id: testRunsCases.id,
              title: testCases.title,
              status: testRunsCases.status,
              startedAt: testRunsCases.startedAt,
              duration: testRunsCases.duration,
              shardIndex: testRunsCases.shardIndex,
              locks: testRunsCases.locks,
            })
            .from(testRunsCases)
            .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
            .where(and(eq(testRunsCases.testRunId, trc.testRunId), isNotNull(testRunsCases.locks)))
        : Promise.resolve(
            [] as Array<{
              id: number;
              title: string | null;
              status: string;
              startedAt: number | null;
              duration: number | null;
              shardIndex: number | null;
              locks: unknown;
            }>,
          ),
      loadFlakeSuspectsForClue(db, trc.status, trc.testCaseId, testCase?.projectId ?? null),
    ]);

  return {
    execution: {
      id: trc.id,
      testCaseId: trc.testCaseId,
      status: trc.status,
      duration: trc.duration,
      browserName: trc.browserName,
      startedAt: startedAtMs(trc.startedAt),
      locks: selfLocks,
      shardIndex: trc.shardIndex ?? null,
    },
    parsedError: trc.error
      ? parsePlaywrightError(trc.error, {
          stepParams: failingStepParams(
            Array.isArray(trc.steps) ? (trc.steps as Parameters<typeof failingStepParams>[0]) : null,
            trc.error,
          ),
        })
      : null,
    timeline,
    healing,
    ariaSnapshot: evidence.ariaSnapshot ?? null,
    ariaSnapshotJson: evidence.ariaSnapshotJson ?? null,
    appState: (trc.pageState as PageStateLike | null) ?? null,
    environmentDiff,
    pageDiff: pageDiffLocatorChange(pageDiff),
    networkRequests: networkForClues,
    consoleLogs:
      (trc.consoleLogs as Array<{ type?: string | null; text?: string | null; timestamp?: number | null }> | null) ??
      [],
    dialogs:
      (trc.dialogs as Array<{
        type?: string | null;
        message?: string | null;
        defaultValue?: string | null;
        closedAt?: number | null;
      }> | null) ?? null,
    browserPeers,
    workerExecutions: workerExecutions.map((w) => ({ ...w, startedAt: startedAtMs(w.startedAt) })),
    lockHolders: lockHolders.map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      startedAt: startedAtMs(h.startedAt),
      duration: h.duration,
      shardIndex: h.shardIndex,
      locks: Array.isArray(h.locks) ? (h.locks as string[]) : [],
    })),
    cluster: clusterFix,
    timeout: trc.timeout ?? null,
    slowRequestMs: opts.slowRequestMs ?? null,
    flakeSuspects,
  };
}

/**
 * The test's flake suspects, for a failing execution of a project that has not
 * declined flake suspects; an empty list otherwise. A history that cannot name
 * a suspect (fewer than 3 failures, or no pass) costs one count, not a profile:
 * the AI diagnosis reads the clues of every candidate cluster.
 */
async function loadFlakeSuspectsForClue(
  db: DrizzleDB,
  status: string,
  testCaseId: number,
  projectId: number | null,
): Promise<FailureClueInput['flakeSuspects']> {
  if (!isFailedStatus(status) || projectId == null) return [];
  if (await isPassiveCapabilityDeclined(db, projectId, 'flake-lab')) return [];
  if (!(await mayHaveFlakeSuspects(db, testCaseId).catch(() => false))) return [];
  const [profile, results] = await Promise.all([
    getFlakeProfile(db, testCaseId, { summary: true }).catch(() => null),
    getFlakeSuspectResults(db, testCaseId).catch(() => new Map<string, FlakeSuspectResult>()),
  ]);
  return (profile?.suspects ?? []).map((s) => {
    const lab = results.get(s.id);
    return lab?.verdict === 'reproduced'
      ? {
          ...s,
          reproduced: {
            label: lab.label,
            matchingFailures: lab.matchingFailures,
            runs: lab.runs,
            controlMatchingFailures: lab.controlMatchingFailures,
            controlRuns: lab.controlRuns,
            pValue: lab.pValue,
          },
        }
      : s;
  });
}

/**
 * The ranked deterministic clues for one failing execution, the story that
 * chains them when a combination matches, and the failure anchor the UI counts
 * back from. Shared by the REST endpoint, the demo mirror, the AI-context
 * builder and the MCP tools. Returns an empty list when the execution does not
 * exist.
 */
export async function getFailureClues(
  db: DrizzleDB,
  id: number,
  opts: { slowRequestMs?: number | null } = {},
): Promise<FailureCluesResult> {
  const input = await loadFailureClueInput(db, id, opts);
  if (!input) return { clues: [], story: null, failureAt: null };
  const { clues, story } = buildFailureClues(input);
  return { clues, story, failureAt: input.timeline ? input.timeline.failureAt : null };
}

/** Coerce a stored `startedAt` (epoch ms number or Date) to epoch ms. */
function startedAtMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A per-attempt summary for the compared pair. */
export interface AttemptDiffSummary {
  /** The sibling execution row for this attempt, or null when it was not stored separately. */
  executionId: number | null;
  retry: number;
  status: string;
  duration: number | null;
}

/** One attempt's recorded outcome, as stored in the row's `attempts` JSON. */
interface AttemptMeta {
  retry: number;
  status: string;
  duration?: number | null;
}

export interface AttemptDiffResult {
  /** True only when a failing attempt and a passing attempt could be paired. */
  applicable: boolean;
  /** Why a diff could not be produced. */
  reason?: 'not-found' | 'single-attempt' | 'no-pair';
  /** Every attempt of this execution, retry-ascending — the strip's source of truth. */
  attempts: AttemptDiffSummary[];
  /** The failing attempt of the pair. */
  failing?: AttemptDiffSummary;
  /** The passing attempt of the pair. */
  passing?: AttemptDiffSummary;
  /** Which attempt the opened execution is, so the UI can mark "this one". */
  currentExecutionId?: number;
  /** The test case, so a network row can link to its flake suspect. */
  testCaseId?: number;
  /** The ordered differences; empty when not applicable. */
  differences: AttemptDiffEntry[];
}

function isFailingStatus(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'timedout';
}

/** Load one attempt's evidence from its execution row and network rows. */
async function loadAttemptEvidence(
  db: DrizzleDB,
  row: {
    id: number;
    error: string | null;
    steps: unknown;
    consoleLogs: unknown;
    pageState: unknown;
    duration: number | null;
  },
): Promise<AttemptEvidence> {
  const [evidence, networkRequestRows] = await Promise.all([
    inlineCasePayloads(db, row as any),
    db.select().from(networkRequests).where(eq(networkRequests.testRunsCaseId, row.id)),
  ]);
  return {
    error: row.error,
    parsedError: row.error
      ? parsePlaywrightError(row.error, {
          stepParams: failingStepParams(
            Array.isArray(row.steps) ? (row.steps as Parameters<typeof failingStepParams>[0]) : null,
            row.error,
          ),
        })
      : null,
    steps: (row.steps as AttemptEvidence['steps']) ?? null,
    networkRequests: networkRequestRows.map((nr) => ({
      method: nr.method,
      url: nr.url,
      status: nr.status,
      duration: nr.duration,
      resourceType: nr.resourceType,
      failure: nr.failure,
    })),
    consoleLogs: (row.consoleLogs as AttemptEvidence['consoleLogs']) ?? null,
    pageState: (row.pageState as AttemptEvidence['pageState']) ?? null,
    ariaSnapshot: evidence.ariaSnapshot ?? null,
    duration: row.duration ?? null,
  };
}

/**
 * Diff the failing and passing attempts of one flaky execution. The per-attempt
 * outcomes come from the row's `attempts` JSON (recorded on every attempt row);
 * a real reporter run also stores each attempt as its own execution row, so its
 * full evidence — error, network, console, page state, ARIA — is loaded through
 * the same helpers the execution detail reads. When only the final attempt was
 * stored (the demo/dev seed collapses retries), the missing attempt contributes
 * just its recorded duration, so a timing difference still shows.
 *
 * Pairs the failing attempt with the passing one — the failing attempt this id
 * belongs to against the first later attempt that passed, or, when this id is
 * the passing one, the last prior failing attempt — and hands the pair to the
 * pure `diffAttempts`. Returns `applicable: false` when there is only one
 * attempt or no failing/passing pair exists. Shared by the REST endpoint and
 * the demo mirror. Never 404s: "not applicable" is a valid answer.
 */
export async function getAttemptDiff(db: DrizzleDB, id: number): Promise<AttemptDiffResult> {
  const [current] = await db.select().from(testRunsCases).where(eq(testRunsCases.id, id));
  if (!current) return { applicable: false, reason: 'not-found', attempts: [], differences: [] };

  // The attempts of the execution's own repetition: each `--repeat-each` repetition retries on its own.
  const siblingRows = await db
    .select()
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, current.testRunId),
        eq(testRunsCases.testCaseId, current.testCaseId),
        eq(testRunsCases.repeatEachIndex, current.repeatEachIndex),
        current.browserName
          ? eq(testRunsCases.browserName, current.browserName)
          : sql`${testRunsCases.browserName} IS NULL`,
      ),
    );
  const rowByRetry = new Map<number, (typeof siblingRows)[number]>(siblingRows.map((r: any) => [r.retries ?? 0, r]));

  // The attempt outcomes, keyed by retry. A real reporter run stores each
  // attempt as its own row, so the physical rows already list every attempt;
  // the demo/dev seed collapses retries into the final row, so the full sequence
  // survives only in the `attempts` JSON — and the reporter fills that JSON in
  // progressively, so the richest copy (the most entries) sits on the final
  // attempt. Union both sources: a physical row is authoritative (it carries
  // evidence), a JSON-only attempt contributes its recorded outcome.
  const byRetry = new Map<number, AttemptMeta>();
  for (const r of siblingRows) {
    byRetry.set(r.retries ?? 0, { retry: r.retries ?? 0, status: r.status, duration: r.duration ?? null });
  }
  let richestMeta: AttemptMeta[] = [];
  for (const r of siblingRows) {
    const list = Array.isArray(r.attempts) ? (r.attempts as AttemptMeta[]) : [];
    if (list.length > richestMeta.length) richestMeta = list;
  }
  for (const m of richestMeta) {
    if (!byRetry.has(m.retry)) byRetry.set(m.retry, { retry: m.retry, status: m.status, duration: m.duration ?? null });
  }
  const attemptsMeta = [...byRetry.values()].sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0));

  const summarize = (attempt: AttemptMeta): AttemptDiffSummary => ({
    executionId: rowByRetry.get(attempt.retry)?.id ?? null,
    retry: attempt.retry,
    status: attempt.status,
    duration: attempt.duration ?? rowByRetry.get(attempt.retry)?.duration ?? null,
  });
  const attempts = attemptsMeta.map(summarize);

  if (attemptsMeta.length < 2)
    return {
      applicable: false,
      reason: 'single-attempt',
      attempts,
      differences: [],
      currentExecutionId: id,
      testCaseId: current.testCaseId,
    };

  const currentRetry = current.retries ?? 0;
  let failing: AttemptMeta | undefined;
  let passing: AttemptMeta | undefined;

  if (isFailingStatus(current.status)) {
    failing = attemptsMeta.find((a) => a.retry === currentRetry) ?? { retry: currentRetry, status: current.status };
    passing = attemptsMeta.find((a) => a.retry > currentRetry && a.status === 'passed');
  } else if (current.status === 'passed') {
    passing = attemptsMeta.find((a) => a.retry === currentRetry) ?? { retry: currentRetry, status: current.status };
    failing = [...attemptsMeta].reverse().find((a) => a.retry < currentRetry && isFailingStatus(a.status));
  }

  if (!failing || !passing)
    return {
      applicable: false,
      reason: 'no-pair',
      attempts,
      differences: [],
      currentExecutionId: id,
      testCaseId: current.testCaseId,
    };

  const evidenceFor = async (attempt: AttemptMeta): Promise<AttemptEvidence> => {
    const row = rowByRetry.get(attempt.retry);
    if (row) return loadAttemptEvidence(db, row);
    // The attempt was not stored as its own row — only its recorded duration is known.
    return { error: null, duration: attempt.duration ?? null };
  };

  const [failingEvidence, passingEvidence] = await Promise.all([evidenceFor(failing), evidenceFor(passing)]);

  const differences = diffAttempts(failingEvidence, passingEvidence);

  return {
    applicable: true,
    attempts,
    failing: summarize(failing),
    passing: summarize(passing),
    currentExecutionId: id,
    testCaseId: current.testCaseId,
    differences,
  };
}

export async function getTestRunCaseTraces(db: DrizzleDB, id: number) {
  const traceRows = await db
    .select()
    .from(files)
    .where(sql`${files.testRunsCaseId} = ${id} AND ${files.type} = 'trace'`);

  return traceRows.map((t: any) => ({
    id: t.id,
    filePath: t.path,
    createdAt: t.createdAt,
    size: t.size ?? null,
  }));
}

/** How far back the stability trend of a test case reaches by default. */
export const STABILITY_TREND_DEFAULT_DAYS = 90;

export interface TestCaseStabilityBucket {
  /** Bucket start (`YYYY-MM-DD`, UTC). */
  date: string;
  /** Executions in the bucket. */
  totalRuns: number;
  /** Passed executions over executions, 0–1; null without an execution. */
  passRate: number | null;
  /** Executions that passed only on a retry over executions, 0–1; null without an execution. */
  flakyRate: number | null;
  /** Average duration of the bucket's executions in ms; null without a duration. */
  avgDuration: number | null;
}

export interface TestCaseStabilityTrend {
  testCaseId: number;
  /** Days one bucket spans (1 daily, 7 weekly, 30 for calendar months). */
  bucketDays: number;
  buckets: TestCaseStabilityBucket[];
}

/**
 * Stability of a single test case over time: its executions of the last
 * `days` days (lab runs left out) in UTC time buckets, each with its pass
 * rate, flaky rate and average duration. The buckets follow the analytics
 * granularity (`auto` keeps about 31 of them), and a bucket without an
 * execution is a gap. Shared by the REST stability-trend endpoint, the Trend
 * tab of the test page and the MCP `get_test_stability_trend` tool.
 */
export async function getTestCaseStabilityTrend(
  db: DrizzleDB,
  testCaseId: number,
  options: { days?: number; granularity?: Granularity; now?: number } = {},
): Promise<TestCaseStabilityTrend> {
  const days = Math.min(3650, Math.max(1, Math.round(options.days ?? STABILITY_TREND_DEFAULT_DAYS)));
  const now = options.now ?? Date.now();
  const tcRows: any[] = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.id, testCaseId));
  if (tcRows.length === 0) throw new Error('Test case not found');

  const from = Date.parse(`${new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
  const rawRows: any[] = await db
    .select({
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      retries: testRunsCases.retries,
      startTime: testRuns.startTime,
      runMetadata: testRuns.metadata,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(eq(testRunsCases.testCaseId, testCaseId), gte(testRuns.startTime, new Date(from))));

  const buckets = makeTimeBuckets(from, now + 1, options.granularity ?? 'auto');
  const tally = new Map<string, { total: number; passed: number; flaky: number; durations: number[] }>();
  for (const row of rawRows) {
    // Lab runs replay a test with an injected fault or condition, so they never shape the trend.
    if (isLabRun(row.runMetadata)) continue;
    const key = buckets.keyFor(row.startTime);
    if (!key) continue;
    const t = tally.get(key) ?? { total: 0, passed: 0, flaky: 0, durations: [] };
    t.total += 1;
    if (row.status === 'passed') {
      t.passed += 1;
      if ((row.retries ?? 0) > 0) t.flaky += 1;
    }
    if (row.duration != null) t.durations.push(row.duration);
    tally.set(key, t);
  }
  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) / 100 : null);
  return {
    testCaseId,
    bucketDays: buckets.bucketDays,
    buckets: buckets.keys.map((date) => {
      const t = tally.get(date);
      return {
        date,
        totalRuns: t?.total ?? 0,
        passRate: t ? rate(t.passed, t.total) : null,
        flakyRate: t ? rate(t.flaky, t.total) : null,
        avgDuration:
          t && t.durations.length > 0 ? Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length) : null,
      };
    }),
  };
}
