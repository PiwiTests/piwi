/**
 * What the automatic-creation rules read about a project's clusters, from the
 * database: the runs each failed in (branch, environment, start, failures), its
 * tests' tags, its owner, whether an issue still tracks it (as a new filing
 * reads it) or a filing for it is queued, whether it is snoozed and whether its
 * tests show flakiness. Shared by the server's run trigger and
 * settings preview and by the demo's preview, so all decide on the same facts
 * through `#shared/integrations/automation`.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { failureClusters, integrationActions, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import {
  describeAutoCreateDecision,
  evaluateAutoCreate,
  type AutoCreateDecision,
  type AutoCreateFacts,
  type ClusterFailureRun,
} from '../integrations/automation';
import type { ResolvedProjectIntegration } from '../integrations/binding';
import { eligibleRunSql } from '../run-eligibility';
import { FAILED_STATUS_KEYS } from '../utils/test-counts';
import { isCurrentlySnoozed } from '../inbox-queues';
import { describeCluster } from '../describe-cluster';
import { clusterIssueFilings, clusterKnownIssues, clusterReopenings, knownIssueTracks } from './known-issues';
import type { DrizzleDB } from './db';
import { flakyResultSql } from './test-case-aggregates';

/** Failing (cluster, run) rows read per call, newest first: well past what a threshold needs. */
const FAILURE_ROWS_LIMIT = 5000;
/** Clusters the settings preview evaluates, most recently seen first. */
const PREVIEW_CLUSTERS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rules' facts about one cluster, with what the caller needs to file it. */
export interface ClusterAutoCreateFacts extends AutoCreateFacts {
  clusterId: number;
  projectId: number;
  fingerprint: string;
  title: string;
  lastSeenRunId: number;
}

export interface AutoCreateFactsOptions {
  /** The project's default branch, to tell which runs ran on it. */
  defaultBranch: string | null;
  now?: Date;
  /**
   * The owner of a cluster nobody was assigned and whose tests declare none,
   * from its most-affected test's file (CODEOWNERS on the server).
   */
  ownerFallback?: (filePath: string) => Promise<string | null>;
}

function epochMs(value: unknown): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The rules' facts for each cluster that exists, keyed by cluster id. */
export async function gatherAutoCreateFacts(
  db: DrizzleDB,
  clusterIds: number[],
  opts: AutoCreateFactsOptions,
): Promise<Map<number, ClusterAutoCreateFacts>> {
  const out = new Map<number, ClusterAutoCreateFacts>();
  const ids = [...new Set(clusterIds)];
  if (ids.length === 0) return out;
  const now = opts.now ?? new Date();

  const clusters = await db.select().from(failureClusters).where(inArray(failureClusters.id, ids));
  if (clusters.length === 0) return out;

  const [knownIssues, filings, failureRows, testRows] = await Promise.all([
    clusterKnownIssues(db, ids),
    clusterIssueFilings(db, ids),
    db
      .select({
        clusterId: testRunsCases.failureClusterId,
        runId: testRunsCases.testRunId,
        occurrences: sql<number>`count(*)`,
        branch: testRuns.branch,
        environment: testRuns.environment,
        startTime: testRuns.startTime,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(
        and(
          inArray(testRunsCases.failureClusterId, ids),
          inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]),
          eligibleRunSql('tracker'),
        ),
      )
      .groupBy(
        testRunsCases.failureClusterId,
        testRunsCases.testRunId,
        testRuns.branch,
        testRuns.environment,
        testRuns.startTime,
      )
      .orderBy(desc(testRunsCases.testRunId))
      .limit(FAILURE_ROWS_LIMIT),
    db
      .select({
        clusterId: testRunsCases.failureClusterId,
        testCaseId: testRunsCases.testCaseId,
        failures: sql<number>`count(*)`,
      })
      .from(testRunsCases)
      .where(inArray(testRunsCases.failureClusterId, ids))
      .groupBy(testRunsCases.failureClusterId, testRunsCases.testCaseId),
  ]);

  const reopenings = await clusterReopenings(db, knownIssues);
  const testIds = [...new Set(testRows.map((row) => row.testCaseId))];
  const [tests, retryPasses] = testIds.length
    ? await Promise.all([
        db
          .select({ id: testCases.id, tags: testCases.tags, owner: testCases.owner, filePath: testCases.filePath })
          .from(testCases)
          .where(inArray(testCases.id, testIds)),
        // The latest pass after a failed attempt of each test, in a run flakiness reads.
        db
          .select({ testCaseId: testRunsCases.testCaseId, runId: sql<number>`max(${testRunsCases.testRunId})` })
          .from(testRunsCases)
          .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
          .where(and(inArray(testRunsCases.testCaseId, testIds), flakyResultSql(), eligibleRunSql('flakiness')))
          .groupBy(testRunsCases.testCaseId),
      ])
    : [[], []];
  const testById = new Map(tests.map((test) => [test.id, test]));
  const retryPassRun = new Map(retryPasses.map((row) => [row.testCaseId, Number(row.runId)]));

  for (const cluster of clusters) {
    const failures: ClusterFailureRun[] = failureRows
      .filter((row) => row.clusterId === cluster.id)
      .map((row) => ({
        runId: row.runId,
        startedAt: epochMs(row.startTime),
        occurrences: Number(row.occurrences),
        branch: row.branch ?? null,
        environment: row.environment ?? null,
        isDefaultBranch: row.branch != null && row.branch === opts.defaultBranch,
      }));
    const clusterTests = testRows
      .filter((row) => row.clusterId === cluster.id)
      .sort((a, b) => Number(b.failures) - Number(a.failures));
    const tags = [
      ...new Set(
        clusterTests.flatMap((row) => {
          const value = testById.get(row.testCaseId)?.tags;
          return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
        }),
      ),
    ];
    const representative = clusterTests[0] ? testById.get(clusterTests[0].testCaseId) : undefined;
    const owner =
      cluster.assignee?.trim() ||
      representative?.owner ||
      (representative && opts.ownerFallback
        ? await opts.ownerFallback(representative.filePath).catch(() => null)
        : null) ||
      null;
    // Flakiness: every affected test passed at the commit the cluster failed at,
    // or one of them passed on a retry since the cluster first failed.
    const flaky =
      cluster.flakeEvidenceRunId != null ||
      clusterTests.some((row) => (retryPassRun.get(row.testCaseId) ?? 0) >= cluster.firstSeenRunId);
    // Tracked as a new filing reads it: an issue that still tracks the cluster
    // (a Done one no longer does, unless a reopen is moving it out of Done), or
    // a filing the tracker has not answered yet.
    const tracked =
      filings.queued.has(cluster.id) ||
      knownIssueTracks(knownIssues.get(cluster.id), { reopening: reopenings.has(cluster.id) });

    out.set(cluster.id, {
      clusterId: cluster.id,
      projectId: cluster.projectId,
      fingerprint: cluster.fingerprint,
      title: describeCluster(cluster),
      lastSeenRunId: cluster.lastSeenRunId,
      status: cluster.status,
      snoozed: isCurrentlySnoozed(cluster, now),
      tracked,
      flaky,
      tags,
      owner,
      failures,
    });
  }
  return out;
}

/** Issues a rule filed for a project in the 24 hours before `now`, against the daily cap. */
export async function countAutomaticCreates(db: DrizzleDB, projectId: number, now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ payload: integrationActions.payload })
    .from(integrationActions)
    .where(
      and(
        eq(integrationActions.projectId, projectId),
        eq(integrationActions.kind, 'create-issue'),
        inArray(integrationActions.status, ['pending', 'processing', 'done']),
        gte(integrationActions.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return rows.filter((row) => (row.payload as { automatic?: unknown } | null)?.automatic).length;
}

/** One cluster in the settings preview: what automatic creation does with it, and why. */
export interface AutoCreatePreviewItem {
  clusterId: number;
  title: string;
  decision: AutoCreateDecision;
  /** The decision in words. */
  description: string;
}

/** What the settings preview shows: the project's open, untracked clusters as the rules see them. */
export interface AutoCreatePreview {
  /** Files first, then waits, then skips; most recently seen first within each. */
  items: AutoCreatePreviewItem[];
  /** Issues filed automatically in the last 24 hours, and the cap. */
  filedLastDay: number;
  dailyCap: number;
  /** Fields the tracker requires that the binding leaves empty: an automatic create would be refused. */
  missingFields: string[];
}

const VERDICT_ORDER: Record<AutoCreateDecision['verdict'], number> = { file: 0, wait: 1, skip: 2 };

/**
 * The project's open clusters with no tracker issue, the most recently seen
 * first, each evaluated against the binding's rules as if automatic creation
 * were on and the cluster failed again in a run every rule counts.
 */
export async function previewAutoCreate(
  db: DrizzleDB,
  projectId: number,
  binding: ResolvedProjectIntegration,
  opts: AutoCreateFactsOptions,
): Promise<AutoCreatePreview> {
  const now = opts.now ?? new Date();
  const candidates = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.status, 'open')))
    .orderBy(desc(failureClusters.lastSeenRunId))
    .limit(PREVIEW_CLUSTERS * 2);
  const facts = await gatherAutoCreateFacts(
    db,
    candidates.map((c) => c.id),
    { ...opts, now },
  );
  const policy = { ...binding.autoCreate, enabled: true };
  const items = [...facts.values()]
    .filter((f) => !f.tracked)
    .slice(0, PREVIEW_CLUSTERS)
    .map((f) => {
      const decision = evaluateAutoCreate(policy, binding.ownerRoutes, f, { now: now.getTime() });
      return {
        clusterId: f.clusterId,
        title: f.title,
        lastSeenRunId: f.lastSeenRunId,
        decision,
        description: describeAutoCreateDecision(decision, policy),
      };
    })
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.decision.verdict] - VERDICT_ORDER[b.decision.verdict] || b.lastSeenRunId - a.lastSeenRunId,
    )
    .map(({ lastSeenRunId: _lastSeenRunId, ...item }) => item);
  return {
    items,
    filedLastDay: await countAutomaticCreates(db, projectId, now),
    dailyCap: binding.autoCreate.dailyCap,
    missingFields: [],
  };
}
