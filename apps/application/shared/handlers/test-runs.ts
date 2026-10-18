import { eq, sql, desc, and, isNotNull, inArray, or, notInArray, count, lt, getTableColumns } from 'drizzle-orm';
import {
  testRuns,
  testCases,
  testRunsCases,
  testSuites,
  projects,
  files,
  failureClusters,
  failureDiagnoses,
  entityLinks,
  networkRequests,
  markers,
  users,
} from '../../server/database/schema';
import { fetchAndFormatSuites, splitSuitePath } from '../utils/suites';
import { FAILED_STATUS_KEYS } from '../utils/test-counts';
import { normalizeRoute } from '../utils/route';
import { percentile } from '../utils/stats';
import { computeWastedMs, DEFAULT_WASTED_WAIT_PATTERNS } from '../utils/wasted-waits';
import { buildCommitRange, computeMetadataDiff } from '../utils/run-metadata';
import type { TestStepEvent } from '../types';
import type { EndpointSummary, DiagnosisCompact } from '../../types/api';

import type { DrizzleDB } from './db';
import { parseRunOriginRef, type RunOriginKind } from '@piwitests/core/wire';
import { runOrigin, runOriginIs, runOriginRef } from '#shared/run-eligibility';
import { clusterKnownIssues } from './known-issues';
import { keepRun, releaseRun } from './run-keep';
import { normalizeGitUrl } from '../../server/utils/scm/git-url';
import { selectBaselineRun } from '../../server/utils/branch-baseline';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { readProjectDefaultBranch, resolveFallbackBranch } from './baseline-scope';
import { notLabRun } from './probes';
import { isPassiveCapabilityDeclined } from './capabilities';
import { hasResourceReport } from './resource-reports';
import { describeRunBaseline } from '#shared/run-baseline';
import { getLocatorHealingBatch } from '../../server/utils/locator-healing';
import { publicRunColumns } from './public-run';

type ProjectScope = 'all' | Set<number>;

/**
 * The most recent test run for a project (id + status only), or null if none.
 * With `origin`, the most recent one its launcher stamped with that kind and
 * ref (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`): the desktop app finds the run a local
 * process of its own produced.
 */
export async function getProjectLatestRun(
  db: DrizzleDB,
  projectId: number,
  origin: { kind: RunOriginKind; ref: string } | null = null,
) {
  if (origin) {
    const ref = parseRunOriginRef(origin.ref);
    if (!ref) return null;
    const rows = await db
      .select({ id: testRuns.id, status: testRuns.status, metadata: testRuns.metadata })
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, projectId),
          runOriginIs({ origin: testRuns.origin, metadata: testRuns.metadata }, origin.kind, ref),
        ),
      )
      .orderBy(desc(testRuns.startTime), desc(testRuns.id))
      .limit(20);
    const found = rows.find((r) => runOrigin(r.metadata) === origin.kind && runOriginRef(r.metadata) === ref);
    return found ? { id: found.id, status: found.status } : null;
  }
  const rows = await db
    .select({ id: testRuns.id, status: testRuns.status })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    // Rank by start_time (id as a deterministic tiebreaker): rows can be
    // ingested out of chronological order (historical uploads on the server;
    // the demo seed inserts runs newest-first). Matches `listProjects`.
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(1);
  return rows[0] ?? null;
}

// ─── getTestRun — full test run detail ───────────────────────────────────────

export async function getTestRun(
  db: DrizzleDB,
  id: number,
  // Custom wasted-wait patterns; null = the defaults are in effect, so the
  // stored per-case wasted_time_ms (computed at ingest) is authoritative.
  wastedPatterns: readonly string[] | null = null,
) {
  const testRunResults = await db.select().from(testRuns).where(eq(testRuns.id, id));
  const testRun = testRunResults[0];
  if (!testRun) return null;

  const projectResults = await db.select().from(projects).where(eq(projects.id, testRun.projectId));
  const project = projectResults[0];

  const latestRunResult = await db
    .select({ id: testRuns.id, status: testRuns.status })
    .from(testRuns)
    .where(eq(testRuns.projectId, testRun.projectId))
    // Rank by start_time (see getProjectLatestRun) so the "Newer run" pill points
    // at the chronologically newest run, not MAX(id).
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(1);
  const latestRunId = latestRunResult[0]?.id ?? null;
  const latestRunStatus = latestRunResult[0]?.status ?? null;

  const reportResults = await db
    .select()
    .from(files)
    .where(sql`${files.testRunId} = ${id} AND ${files.type} = 'report'`);

  const storageStatsResult = await db
    .select({
      totalFiles: count(),
      totalSize: sql<number>`coalesce(sum(${files.size}), 0)`,
      testCaseFilesSize: sql<number>`coalesce(sum(case when ${files.type} != 'report' then ${files.size} else 0 end), 0)`,
      testCaseFilesCount: sql<number>`count(case when ${files.type} != 'report' then 1 end)`,
    })
    .from(files)
    .where(eq(files.testRunId, id));

  const reportSizes = reportResults.map((r) => ({
    label: r.label || r.subtype || r.type,
    size: r.size ?? 0,
  }));

  const storageStats = {
    totalFiles: Number(storageStatsResult[0]?.totalFiles ?? 0),
    totalSize: Number(storageStatsResult[0]?.totalSize ?? 0),
    reportSizes,
    testCaseFilesSize: Number(storageStatsResult[0]?.testCaseFilesSize ?? 0),
    testCaseFilesCount: Number(storageStatsResult[0]?.testCaseFilesCount ?? 0),
  };

  const runsCases = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      error: testRunsCases.error,
      failureClusterId: testRunsCases.failureClusterId,
      retries: testRunsCases.retries,
      attempts: testRunsCases.attempts,
      line: testRunsCases.line,
      column: testRunsCases.column,
      slowestStep: testRunsCases.slowestStep,
      slowestStepDuration: testRunsCases.slowestStepDuration,
      wastedTimeMs: testRunsCases.wastedTimeMs,
      stepEvents: testRunsCases.stepEvents,
      workerIndex: testRunsCases.workerIndex,
      shardIndex: testRunsCases.shardIndex,
      startedAt: testRunsCases.startedAt,
      browser: testRunsCases.browser,
      title: testCases.title,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      testAnnotations: testRunsCases.testAnnotations,
      tags: testRunsCases.tags,
      locks: testRunsCases.locks,
      testMeta: testRunsCases.testMeta,
      isNewRegression: testRunsCases.isNewRegression,
      isNewFlaky: testRunsCases.isNewFlaky,
      didNotRunReason: testRunsCases.didNotRunReason,
      expectedStatus: testRunsCases.expectedStatus,
      blockedBy: testRunsCases.blockedBy,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, id));

  // The run's spec files, the run's executions and their links are selected
  // through the run, never as a list of ids: a large run would pass the
  // database's limit on bound parameters (32,766 in SQLite).
  const runFilePaths = db
    .selectDistinct({ filePath: testCases.filePath })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, id));
  const suites = await fetchAndFormatSuites(db, testSuites, testRun.projectId, runFilePaths, eq, and, inArray);

  const formattedTestCases = runsCases.map((tc: any) => ({
    executionId: tc.id,
    testCaseId: tc.testCaseId,
    title: tc.title,
    filePath: tc.filePath,
    suitePath: splitSuitePath(tc.suitePath),
    testAnnotations: (tc.testAnnotations as any) ?? null,
    tags: (tc.tags as string[] | null) ?? null,
    locks: (tc.locks as string[] | null) ?? null,
    testMeta: (tc.testMeta as any) ?? null,
    status: tc.status,
    duration: tc.duration,
    location: tc.line && tc.column ? `${tc.filePath}:${tc.line}:${tc.column}` : tc.filePath,
    error: tc.error,
    failureClusterId: tc.failureClusterId,
    retries: tc.retries,
    attempts: tc.attempts ?? null,
    slowestStep: tc.slowestStep,
    slowestStepDuration: tc.slowestStepDuration,
    // With custom patterns configured, wasted time is recomputed from the
    // stored wait events so the new allowlist re-classifies existing runs.
    // With the defaults in effect the stored column is authoritative
    // (recomputed only for a row where it is null).
    wastedTimeMs: wastedPatterns
      ? tc.stepEvents != null
        ? computeWastedMs(tc.stepEvents as TestStepEvent[], wastedPatterns)
        : (tc.wastedTimeMs ?? null)
      : (tc.wastedTimeMs ??
        (tc.stepEvents != null
          ? computeWastedMs(tc.stepEvents as TestStepEvent[], DEFAULT_WASTED_WAIT_PATTERNS)
          : null)),
    stepEvents: (tc as { stepEvents?: unknown }).stepEvents ?? null,
    workerIndex: tc.workerIndex,
    shardIndex: tc.shardIndex,
    startedAt: tc.startedAt,
    browser: tc.browser,
    isNewRegression: tc.isNewRegression ?? null,
    isNewFlaky: tc.isNewFlaky ?? null,
    didNotRunReason: (tc.didNotRunReason as string | null) ?? null,
    expectedStatus: (tc.expectedStatus as string | null) ?? null,
    blockedBy: (tc.blockedBy as string | null) ?? null,
  }));

  const linksForRun = await db.select().from(entityLinks).where(eq(entityLinks.testRunId, id));

  const linksForCases = await db
    .select(getTableColumns(entityLinks))
    .from(entityLinks)
    .innerJoin(testRunsCases, eq(entityLinks.testRunsCaseId, testRunsCases.id))
    .where(eq(testRunsCases.testRunId, id));

  const caseLinksMap = new Map<number, typeof linksForCases>();
  for (const link of linksForCases) {
    if (link.testRunsCaseId != null) {
      if (!caseLinksMap.has(link.testRunsCaseId)) {
        caseLinksMap.set(link.testRunsCaseId, []);
      }
      caseLinksMap.get(link.testRunsCaseId)!.push(link);
    }
  }

  const { streamToken: _streamToken, ...testRunPublic } = testRun;

  let keptByName: string | null = null;
  if (testRun.keptBy) {
    const [keeper] = await db
      .select({ name: users.name, username: users.username })
      .from(users)
      .where(eq(users.id, testRun.keptBy));
    keptByName = keeper ? keeper.name || keeper.username : null;
  }

  let projectPublic;
  if (project) {
    const { scmToken: _scmToken, ...projectRest } = project;
    projectPublic = { ...projectRest, latestRunId, latestRunStatus };
  }

  // Nearest timeline marker before this run's start, scoped to the run's
  // environment (or global markers with no environment) — surfaced as context.
  const precedingMarkerCandidates = await db
    .select()
    .from(markers)
    .where(and(eq(markers.projectId, testRun.projectId), lt(markers.occurredAt, testRun.startTime)))
    .orderBy(desc(markers.occurredAt))
    .limit(10);
  const precedingMarker =
    precedingMarkerCandidates.find((m) => m.environment == null || m.environment === testRun.environment) ?? null;

  // Distinct endpoints seen by the run — feeds the "Slow endpoints (n)" tab
  // count from the run payload, so the strip never shows a bare label. Uses
  // the same method + normalized-route grouping as getNetworkRequests, so the
  // label counts the table's rows, not the raw request rows.
  //
  // `selectDistinct` collapses duplicate (method, url) tuples in the database,
  // so the rows transferred scale with the number of distinct endpoints, not
  // with raw request volume. The `normalizeRoute` fallback (for rows the
  // reporter left without a `normalizedUrl`) still runs in JS, but only over
  // that already-deduplicated set.
  const endpointRows = await db
    .selectDistinct({
      method: networkRequests.method,
      normalizedUrl: networkRequests.normalizedUrl,
      url: networkRequests.url,
    })
    .from(networkRequests)
    .where(eq(networkRequests.testRunId, id));
  const endpointCount = new Set(
    endpointRows.map((r) => `${r.method}|${r.normalizedUrl ?? (r.url ? normalizeRoute(r.url) : r.method)}`),
  ).size;

  return {
    ...testRunPublic,
    keptByName,
    precedingMarker,
    isFullRun: testRun.isFullRun === 1,
    hasResources:
      (await hasResourceReport(db, id)) && !(await isPassiveCapabilityDeclined(db, testRun.projectId, 'resources')),
    project: projectPublic,
    networkRequestCount: endpointCount,
    reports: reportResults.map((r: any) => ({
      id: r.id,
      type: r.subtype || r.type,
      label: r.label || r.type,
      path: r.path,
      size: r.size,
    })),
    links: linksForRun,
    testCases: formattedTestCases.map((tc: any) => ({
      ...tc,
      links: caseLinksMap.get(tc.executionId) ?? [],
    })),
    suites,
    storageStats,
    wastedWaitPatterns: [...(wastedPatterns ?? DEFAULT_WASTED_WAIT_PATTERNS)],
  };
}

// ─── getRecentTestRuns — active + 30 most recent completed, lab runs left out ─

const ACTIVE_STATUSES = ['running', 'initializing', 'finalizing'] as const;

const RECENT_FIELDS = {
  id: testRuns.id,
  projectId: testRuns.projectId,
  projectName: projects.name,
  projectLabel: projects.label,
  status: testRuns.status,
  startTime: testRuns.startTime,
  totalTests: testRuns.totalTests,
  passedTests: testRuns.passedTests,
  failedTests: testRuns.failedTests,
  skippedTests: testRuns.skippedTests,
  didNotRunTests: testRuns.didNotRunTests,
  flakyTests: testRuns.flakyTests,
  duration: testRuns.duration,
  avgTestDuration: testRuns.avgTestDuration,
  p90TestDuration: testRuns.p90TestDuration,
  playwrightVersion: testRuns.playwrightVersion,
  reporterVersion: testRuns.reporterVersion,
  isFullRun: testRuns.isFullRun,
  environment: testRuns.environment,
  branch: testRuns.branch,
};

export async function getRecentTestRuns(db: DrizzleDB, scope: ProjectScope = 'all') {
  if (scope !== 'all' && scope.size === 0) return [];
  // Filtered before the limit, so runs of other projects never crowd out the caller's.
  const inScope = scope === 'all' ? undefined : inArray(testRuns.projectId, [...scope]);
  const [activeRuns, recentRuns] = await Promise.all([
    db
      .select(RECENT_FIELDS)
      .from(testRuns)
      .innerJoin(projects, eq(testRuns.projectId, projects.id))
      .where(and(or(...ACTIVE_STATUSES.map((s) => eq(testRuns.status, s))), inScope))
      .orderBy(desc(testRuns.startTime)),
    db
      .select(RECENT_FIELDS)
      .from(testRuns)
      .innerJoin(projects, eq(testRuns.projectId, projects.id))
      .where(and(notInArray(testRuns.status, [...ACTIVE_STATUSES]), notLabRun(testRuns.origin), inScope))
      .orderBy(desc(testRuns.startTime))
      .limit(30),
  ]);

  const seen = new Set<number>();
  const result: typeof activeRuns = [];
  for (const run of [...activeRuns, ...recentRuns]) {
    if (!seen.has(run.id)) {
      seen.add(run.id);
      result.push(run);
    }
  }
  return result;
}

/**
 * Currently-active runs (initializing / running / finalizing) across the scope,
 * with their live counts — the snapshot the desktop shell seeds its OS
 * progress from before it starts streaming deltas.
 */
export async function getActiveTestRuns(db: DrizzleDB, scope: ProjectScope = 'all') {
  if (scope !== 'all' && scope.size === 0) return [];
  const runs = await db
    .select(RECENT_FIELDS)
    .from(testRuns)
    .innerJoin(projects, eq(testRuns.projectId, projects.id))
    .where(or(...ACTIVE_STATUSES.map((s) => eq(testRuns.status, s))))
    .orderBy(desc(testRuns.startTime));
  return scope === 'all' ? runs : runs.filter((run) => scope.has(run.projectId));
}

// ─── getTestRunSummary — lightweight summary ─────────────────────────────────

export async function getTestRunSummary(db: DrizzleDB, id: number) {
  const [testRun] = await db.select().from(testRuns).where(eq(testRuns.id, id));
  if (!testRun) return null;

  const runsCases = await db
    .select({
      title: testCases.title,
      location: testCases.filePath,
      line: testRunsCases.line,
      column: testRunsCases.column,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, id));

  const { streamToken: _streamToken, ...testRunPublic } = testRun;

  return {
    ...testRunPublic,
    testCases: runsCases.map((tc) => ({
      title: tc.title,
      status: tc.status,
      duration: tc.duration,
      location: tc.line && tc.column ? `${tc.location}:${tc.line}:${tc.column}` : tc.location,
    })),
  };
}

// ─── patchTestRun — update label, keep or release ────────────────────────────

export interface TestRunPatch {
  label?: string | null;
  /** `true` keeps the run forever; `false` releases it back to retention. */
  keep?: boolean;
  /** Reason recorded with a keep; only accepted alongside `keep: true`. */
  keepReason?: string | null;
}

/** Validate a PATCH body. Returns the patch, or the message of a 400. */
export function parseTestRunPatch(body: unknown): TestRunPatch | string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const patch: TestRunPatch = {};
  if (b.label !== undefined) {
    if (b.label !== null && typeof b.label !== 'string') return 'label must be a string or null';
    patch.label = b.label as string | null;
  }
  if (b.keep !== undefined) {
    if (typeof b.keep !== 'boolean') return 'keep must be a boolean';
    patch.keep = b.keep;
  }
  if (b.keepReason !== undefined) {
    if (b.keepReason !== null && typeof b.keepReason !== 'string') return 'keepReason must be a string or null';
    if (patch.keep !== true) return 'keepReason is only accepted with keep: true';
    patch.keepReason = b.keepReason as string | null;
  }
  if (Object.keys(patch).length === 0) return 'No fields to update';
  return patch;
}

export async function patchTestRun(
  db: DrizzleDB,
  id: number,
  patch: TestRunPatch,
  actor: { userId?: number | null } = {},
) {
  const existing = await db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.id, id));
  if (!existing[0]) throw new Error('Test run not found');

  if (patch.label !== undefined) {
    await db
      .update(testRuns)
      .set({
        label: patch.label ?? null,
        updatedAt: new Date(),
      })
      .where(eq(testRuns.id, id));
  }
  if (patch.keep === true) {
    await keepRun(db, id, { source: 'user', userId: actor.userId, reason: patch.keepReason });
  } else if (patch.keep === false) {
    await releaseRun(db, id);
  }

  const [testRun] = await db.select(publicRunColumns()).from(testRuns).where(eq(testRuns.id, id));
  return { success: true, testRun };
}

// ─── getNetworkRequests — aggregated network endpoint stats ──────────────────

export async function getNetworkRequests(db: DrizzleDB, runId: number) {
  const runResults = await db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.id, runId));
  if (!runResults[0]) return null;

  const rows = await db
    .select({
      method: networkRequests.method,
      normalizedUrl: networkRequests.normalizedUrl,
      url: networkRequests.url,
      status: networkRequests.status,
      duration: networkRequests.duration,
      startTime: networkRequests.startTime,
      title: testCases.title,
    })
    .from(networkRequests)
    .innerJoin(testRunsCases, eq(networkRequests.testRunsCaseId, testRunsCases.id))
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(networkRequests.testRunId, runId));

  return buildEndpointSummaries(
    rows.map((r) => ({
      method: r.method,
      route: r.normalizedUrl ?? (r.url ? normalizeRoute(r.url) : r.method),
      duration: r.duration ?? 0,
      status: r.status,
      startTime: r.startTime ?? null,
      title: r.title,
    })),
  );
}

function buildEndpointSummaries(
  rows: Array<{
    method: string;
    route: string;
    duration: number;
    status: number;
    startTime: number | null;
    title: string;
  }>,
): EndpointSummary[] {
  const grouped = new Map<
    string,
    {
      method: string;
      route: string;
      durations: number[];
      statuses: number[];
      firstStartTime: number | null;
      lastStartTime: number | null;
      testCases: Set<string>;
    }
  >();

  for (const row of rows) {
    const key = `${row.method}|${row.route}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        method: row.method,
        route: row.route,
        durations: [],
        statuses: [],
        firstStartTime: null,
        lastStartTime: null,
        testCases: new Set(),
      });
    }
    const group = grouped.get(key)!;
    group.durations.push(row.duration);
    group.statuses.push(row.status);
    if (row.startTime != null) {
      group.firstStartTime =
        group.firstStartTime == null ? row.startTime : Math.min(group.firstStartTime, row.startTime);
      group.lastStartTime = group.lastStartTime == null ? row.startTime : Math.max(group.lastStartTime, row.startTime);
    }
    group.testCases.add(row.title);
  }

  const summaries: EndpointSummary[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group.durations].sort((a, b) => a - b);
    const sum = group.durations.reduce((a, b) => a + b, 0);
    const errorCount = group.statuses.filter((s) => s >= 400 || s === 0).length;

    summaries.push({
      method: group.method,
      route: group.route,
      count: group.durations.length,
      avgDuration: Math.round(sum / group.durations.length),
      maxDuration: sorted[sorted.length - 1] ?? 0,
      minDuration: sorted[0] ?? 0,
      p90Duration: percentile(sorted, 90),
      errorRate: group.durations.length > 0 ? Math.round((errorCount / group.durations.length) * 100) : 0,
      firstStartTime: group.firstStartTime,
      lastStartTime: group.lastStartTime,
      testCases: Array.from(group.testCases),
    });
  }

  summaries.sort((a, b) => b.avgDuration - a.avgDuration);
  return summaries;
}

// ─── getFailureGroups — clustered failures for a run ─────────────────────────

interface GroupCase {
  executionId: number;
  testCaseId: number;
  title: string;
  filePath: string;
  retries: number;
  workerIndex: number | null;
  passedOnRetry: boolean;
}

interface FailureGroup {
  clusterId: number;
  signature: string;
  title: string | null;
  errorType: string | null;
  selector: string | null;
  status: string;
  triageNote: string | null;
  caseCount: number;
  isNew: boolean;
  firstSeenRunId: number;
  firstSeenAt: Date | null;
  occurrences: number;
  flaky: boolean;
  workerCorrelated: boolean;
  cases: GroupCase[];
  diagnosis: DiagnosisCompact | null;
}

export async function getFailureGroups(db: DrizzleDB, runId: number) {
  const runResults = await db.select({ id: testRuns.id }).from(testRuns).where(eq(testRuns.id, runId));
  if (!runResults[0]) return [];

  const allRows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      workerIndex: testRunsCases.workerIndex,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.testRunId, runId));

  const passedCaseIds = new Set(allRows.filter((r: any) => r.status === 'passed').map((r: any) => r.testCaseId));
  const runWorkers = new Set(allRows.map((r: any) => r.workerIndex).filter((w: any) => w !== null));

  const clusteredRows = await db
    .select({
      executionId: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      retries: testRunsCases.retries,
      workerIndex: testRunsCases.workerIndex,
      title: testCases.title,
      filePath: testCases.filePath,
      clusterId: failureClusters.id,
      signature: failureClusters.signature,
      clusterTitle: failureClusters.title,
      errorType: failureClusters.errorType,
      selector: failureClusters.selector,
      status: failureClusters.status,
      triageNote: failureClusters.triageNote,
      firstSeenRunId: failureClusters.firstSeenRunId,
      occurrences: failureClusters.occurrences,
    })
    .from(testRunsCases)
    .innerJoin(failureClusters, eq(testRunsCases.failureClusterId, failureClusters.id))
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(and(eq(testRunsCases.testRunId, runId), isNotNull(testRunsCases.failureClusterId)));

  if (clusteredRows.length === 0) return [];

  const firstSeenRunIds = [...new Set(clusteredRows.map((r: any) => r.firstSeenRunId))];
  const firstSeenRuns = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime })
    .from(testRuns)
    .where(inArray(testRuns.id, firstSeenRunIds as any[]));
  const firstSeenAtById = new Map(firstSeenRuns.map((r: any) => [r.id, r.startTime]));

  const groups = new Map<number, FailureGroup & { caseById: Map<number, GroupCase> }>();

  for (const row of clusteredRows) {
    let group = groups.get(row.clusterId);
    if (!group) {
      group = {
        clusterId: row.clusterId,
        signature: row.signature,
        title: row.clusterTitle ?? null,
        errorType: row.errorType,
        selector: row.selector,
        status: row.status ?? 'open',
        triageNote: row.triageNote ?? null,
        caseCount: 0,
        isNew: row.firstSeenRunId === runId,
        firstSeenRunId: row.firstSeenRunId,
        firstSeenAt: (firstSeenAtById.get(row.firstSeenRunId) ?? null) as Date | null,
        occurrences: row.occurrences,
        flaky: false,
        workerCorrelated: false,
        cases: [],
        diagnosis: null,
        caseById: new Map(),
      };
      groups.set(row.clusterId, group);
    }

    const g = group;
    const existing = g.caseById.get(row.testCaseId);
    if (existing) {
      if ((row.retries ?? 0) > existing.retries) {
        existing.retries = row.retries ?? 0;
        existing.executionId = row.executionId;
        existing.workerIndex = row.workerIndex;
      }
    } else {
      g.caseById.set(row.testCaseId, {
        executionId: row.executionId,
        testCaseId: row.testCaseId,
        title: row.title,
        filePath: row.filePath,
        retries: row.retries ?? 0,
        workerIndex: row.workerIndex,
        passedOnRetry: passedCaseIds.has(row.testCaseId),
      });
    }
  }

  const result: FailureGroup[] = [];
  for (const group of groups.values()) {
    const { caseById, ...rest } = group;
    const cases = [...caseById.values()].sort((a, b) => a.title.localeCompare(b.title));
    const caseWorkers = new Set(cases.map((c) => c.workerIndex).filter((w) => w !== null));

    result.push({
      ...rest,
      cases,
      caseCount: cases.length,
      flaky: cases.some((c) => c.passedOnRetry),
      workerCorrelated: cases.length >= 2 && caseWorkers.size === 1 && runWorkers.size > 1,
    });
  }

  result.sort((a, b) => b.caseCount - a.caseCount);

  const allClusterIds = result.map((g) => g.clusterId);
  const diagnosisRows =
    allClusterIds.length > 0
      ? await db
          .select({
            clusterId: failureDiagnoses.clusterId,
            status: failureDiagnoses.status,
            category: failureDiagnoses.category,
            confidence: failureDiagnoses.confidence,
            summary: failureDiagnoses.summary,
          })
          .from(failureDiagnoses)
          .where(inArray(failureDiagnoses.clusterId, allClusterIds))
      : [];
  const diagnosisById = new Map(diagnosisRows.map((d: any) => [d.clusterId, d]));

  // Attach "locator fix available" to the most impactful groups (sorted by case
  // count). Capped so the run page stays cheap — one batch call over the
  // representative failing case of each top group.
  const HEALING_GROUP_CAP = 10;
  const reps = result
    .slice(0, HEALING_GROUP_CAP)
    .map((g) => ({ clusterId: g.clusterId, repId: g.cases[0]?.executionId }))
    .filter((r): r is { clusterId: number; repId: number } => r.repId != null);
  const healingByCluster = new Map<number, { recommended: string; source: string; healed: boolean }>();
  if (reps.length > 0) {
    const healingMap = await getLocatorHealingBatch(
      db,
      reps.map((r) => r.repId),
    );
    for (const { clusterId, repId } of reps) {
      const h = healingMap.get(repId);
      const rec = h?.recommendation?.recommended;
      if (h && h.applicable !== false && h.source !== 'none' && rec) {
        healingByCluster.set(clusterId, {
          recommended: rec.locator,
          source: h.source,
          healed: h.healedInRunId != null,
        });
      }
    }
  }

  const knownIssues = await clusterKnownIssues(db, allClusterIds);

  return result.map((g) => ({
    ...g,
    diagnosis: diagnosisById.get(g.clusterId) ?? null,
    locatorHealing: healingByCluster.get(g.clusterId) ?? null,
    knownIssue: knownIssues.get(g.clusterId) ?? null,
  }));
}

// ─── computeRegressionContextForRun — regression vs last green run ────────────

const FAIL_STATUSES = new Set<string>(FAILED_STATUS_KEYS);

export async function computeRegressionContextForRun(db: DrizzleDB, runId: number) {
  const runResults = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      status: testRuns.status,
      startTime: testRuns.startTime,
      environment: testRuns.environment,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));

  const run = runResults[0];
  if (!run) return null;

  // The same ladder the Changes tab walks: the run's environment first, and
  // within it its own branch, the branch it forked from, then any branch.
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const fallback = resolveFallbackBranch(run.metadata, await readProjectDefaultBranch(db, run.projectId, run.metadata));
  const selection = await selectBaselineRun(db, {
    projectId: run.projectId,
    before: run.startTime,
    branch,
    environment: run.environment ?? null,
    fallbackBranch: fallback.branch,
  });
  if (!selection) return { hasGreen: false };
  const lastGreen = selection.run;
  const baselineNote = describeRunBaseline({
    run: { branch, environment: run.environment ?? null },
    baseline: { branch: lastGreen.branch ?? null, environment: lastGreen.environment ?? null },
    match: selection.match,
    fallback,
  });

  const currMeta = run.metadata as any;
  const greenMeta = lastGreen.metadata as any;
  const currentCommit: string | null = currMeta?.scm?.commit ?? null;
  const lastGreenCommit: string | null = greenMeta?.scm?.commit ?? null;
  const remoteUrl: string | null = currMeta?.scm?.remoteUrl ?? greenMeta?.scm?.remoteUrl ?? null;

  const repositoryUrl = normalizeGitUrl(remoteUrl);

  const commitRange = buildCommitRange(repositoryUrl, lastGreenCommit, currentCommit);

  const metadataDiff = computeMetadataDiff(greenMeta, currMeta, lastGreen.environment, run.environment);

  const [greenCases, currentCases] = await Promise.all([
    db
      .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, lastGreen.id)),
    db
      .select({ testCaseId: testRunsCases.testCaseId, status: testRunsCases.status })
      .from(testRunsCases)
      .where(eq(testRunsCases.testRunId, run.id)),
  ]);

  const greenBestStatus = new Map<number, string>();
  for (const c of greenCases) {
    if (!greenBestStatus.has(c.testCaseId) || c.status === 'passed') {
      greenBestStatus.set(c.testCaseId, c.status);
    }
  }

  const currentWorstStatus = new Map<number, string>();
  for (const c of currentCases) {
    const existing = currentWorstStatus.get(c.testCaseId);
    if (!existing || (FAIL_STATUSES.has(c.status) && !FAIL_STATUSES.has(existing))) {
      currentWorstStatus.set(c.testCaseId, c.status);
    }
  }

  let newFailures = 0;
  for (const [tcId, status] of currentWorstStatus) {
    if (FAIL_STATUSES.has(status) && greenBestStatus.get(tcId) === 'passed') newFailures++;
  }

  return {
    hasGreen: true,
    lastGreenRunId: lastGreen.id,
    lastGreenRunAt: lastGreen.startTime,
    lastGreenCommit,
    lastGreenBranch: greenMeta?.scm?.branch ?? null,
    baselineNote,
    currentCommit,
    currentBranch: currMeta?.scm?.branch ?? null,
    commitRange,
    metadataDiff,
    newFailures,
  };
}
