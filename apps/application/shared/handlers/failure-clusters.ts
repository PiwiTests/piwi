import {
  failureClusters,
  failureDiagnoses,
  testRuns,
  testRunsCases,
  testCases,
  projects,
  entityLinks,
  clusterMergeSuggestions,
  projectIntegrations,
} from '../../server/database/schema';
import { eq, and, desc, gte, sql, inArray, or, isNull, lte } from 'drizzle-orm';
import { makeTimeBuckets } from './analytics/common';
import { isLabRun } from './probes';

import type { DrizzleDB } from './db';
import type { HandbackActor } from '../handback-outcomes';
import type { ClusterLatestHeadline, OpenFailureCluster, OccurrenceSeriesPoint } from '../../types/api';
import { splitFailureCluster } from './failure-cluster-ops';
import { clusterIssueFilings, clusterKnownIssues, isTrackerLink } from './known-issues';
import { readRunIncident } from '../run-incident';
import {
  getQuarantinedCaseIds,
  countQuarantinedClusterTests,
  listQuarantine,
  addQuarantine,
  releaseQuarantine,
} from './quarantine';
import { clusterClue, computeSnooze, DEFAULT_NEEDS_TICKET_AFTER_DAYS, type SnoozeOption } from '../inbox-queues';
import { resolveProjectIntegration } from '#shared/integrations/binding';
import { parsePlaywrightError } from '#shared/error-parse';
import { failingStepParams } from '#shared/describe-failure';
import { caseHeadline } from '#shared/failure-verdict';
import { computeClusterState, failureGoesOn, ticketReconcileKey, type ClusterState } from '#shared/cluster-state';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { computeNextStep, type FlakeLabStepFacts, type NextStep } from '#shared/next-step';
import { getFlakeLabStepFacts } from './flake-lab';
import { mayHaveFlakeSuspects } from './flake-profile';
import { isCapabilityHidden, isPassiveCapabilityDeclined } from './capabilities';
import { getLocatorHealing } from '../../server/utils/locator-healing';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import {
  patchApplies,
  patchStillAppliesAtFix,
  storedPatchValidation,
  storedPatchValidationAtFix,
  type PatchValidationStatus,
} from '#shared/patch';
import type { BisectResult } from '@piwitests/core/bisect';
import type { BisectedCommit } from '#shared/reproduce';

/**
 * The cluster's completed diagnosis reduced to the facts the cluster state and
 * the next-step policy read: whether a completed diagnosis exists, its one-line
 * summary, the file its patch touches, whether it has a patch and how that
 * patch validated against the code the model was shown, and whether it still
 * applied at the commit of the cluster's verified fix.
 */
export interface ClusterPatchFacts {
  diagnosisCompleted: boolean;
  summary: string | null;
  patchFile: string | null;
  hasPatch: boolean;
  patchValidationStatus: PatchValidationStatus | null;
  patchAppliesCleanly: boolean;
  /** The patch still applied at the commit of the fix that landed in `fixLandedRunId`, its change not there. */
  patchAppliesAtFix: boolean;
}

export async function getClusterPatchFacts(
  db: DrizzleDB,
  clusterId: number,
  cluster: { fixLandedRunId?: number | null } = {},
): Promise<ClusterPatchFacts> {
  const [diag] = await db
    .select({ status: failureDiagnoses.status, summary: failureDiagnoses.summary, details: failureDiagnoses.details })
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')));
  if (!diag || diag.status !== 'completed') {
    return {
      diagnosisCompleted: false,
      summary: null,
      patchFile: null,
      hasPatch: false,
      patchValidationStatus: null,
      patchAppliesCleanly: false,
      patchAppliesAtFix: false,
    };
  }
  const details = (diag.details ?? null) as {
    suggestedFix?: { patch?: unknown; file?: unknown; description?: unknown };
  } | null;
  const sf = details?.suggestedFix ?? null;
  const hasPatch = typeof sf?.patch === 'string' && sf.patch.trim() !== '';
  const validationStatus = storedPatchValidation(details)?.status ?? null;
  return {
    diagnosisCompleted: true,
    summary: diag.summary ?? (typeof sf?.description === 'string' ? sf.description : null),
    patchFile: typeof sf?.file === 'string' ? sf.file : null,
    hasPatch,
    patchValidationStatus: hasPatch ? validationStatus : null,
    patchAppliesCleanly: hasPatch && patchApplies(validationStatus),
    patchAppliesAtFix: hasPatch && patchStillAppliesAtFix(storedPatchValidationAtFix(details), cluster.fixLandedRunId),
  };
}

/**
 * The headline of a cluster's latest occurrence, read from its stored error and
 * steps; the cluster's sample error, kept from its first occurrence, when that
 * execution has none. Null when neither carries an error.
 */
export function clusterLatestHeadline(
  cluster: { sampleError: string | null; lastSeenRunId: number; firstSeenRunId: number },
  latestExec: { error: string | null; steps: unknown } | null,
): ClusterLatestHeadline | null {
  const latest = latestExec?.error ? caseHeadline({ error: latestExec.error, steps: latestExec.steps }) : null;
  if (latest) return { parts: latest.parts, detail: latest.detail, source: 'latest', runId: cluster.lastSeenRunId };
  const first = cluster.sampleError ? caseHeadline({ error: cluster.sampleError }) : null;
  return first ? { parts: first.parts, detail: first.detail, source: 'first', runId: cluster.firstSeenRunId } : null;
}

/** The locator-healing facts the next-step policy reads. */
export interface HealingStepFacts {
  hasHealingRecommendation: boolean;
  healingEditAvailable: boolean;
}

/**
 * The next-step facts of one execution's locator healing: a usable
 * recommendation, counted only in a project that shows locator healing (the
 * capability neither declined nor inapplicable, the rule its Locator fix section
 * follows), and whether it comes with a git-applyable edit of the failing line.
 */
export async function getHealingStepFacts(
  db: DrizzleDB,
  projectId: number | null | undefined,
  healing: LocatorHealingResult | null,
): Promise<HealingStepFacts> {
  const recommends = Boolean(healing && healing.applicable !== false && healing.recommendation?.recommended);
  const shown =
    recommends && projectId != null && !(await isCapabilityHidden(db, projectId, 'locator-healing').catch(() => false));
  return {
    hasHealingRecommendation: shown,
    healingEditAvailable: shown && Boolean(healing?.edit?.unifiedDiff),
  };
}

type ProjectScope = 'all' | Set<number>;

const VALID_STATUSES = ['open', 'resolved', 'ignored'];

/** Affected tests the cluster detail payload lists; `affectedTests` carries the full count. */
export const CLUSTER_DETAIL_TESTS_LIMIT = 50;

export async function getFailureCluster(
  db: DrizzleDB,
  clusterId: number,
  // `aiConfigured` and `ciRerunAvailable` are server-only signals the next-step
  // policy reads; the demo and MCP callers omit them (a demo instance configures
  // neither AI nor a CI re-run). `affectedTestsLimit` bounds the listed affected
  // tests, and `null` lists every one.
  opts: {
    aiConfigured?: boolean;
    ciRerunAvailable?: boolean;
    /** Whether a Flake Lab CI target can run a test's experiment (server only). */
    flakeLabCiAvailable?: (testCaseId: number) => Promise<boolean>;
    now?: Date;
    affectedTestsLimit?: number | null;
  } = {},
) {
  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const { affectedTestsLimit = CLUSTER_DETAIL_TESTS_LIMIT } = opts;
  const affectedTestsQuery = db
    .select({
      testCaseId: testCases.id,
      title: testCases.title,
      externalId: testCases.externalId,
      displayTitle: testCases.displayTitle,
      filePath: testCases.filePath,
      owner: testCases.owner,
      runCount: sql<number>`count(${testRunsCases.id})`,
      recentTestRunsCaseId: sql<number>`max(${testRunsCases.id})`,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .groupBy(
      testCases.id,
      testCases.title,
      testCases.externalId,
      testCases.displayTitle,
      testCases.filePath,
      testCases.owner,
    )
    .orderBy(desc(sql`count(${testRunsCases.id})`))
    .$dynamic();

  const [[countRow], [lastRun], [firstSeenRun], [diag], [project], affectedTestCases, [latestOccurrence]] =
    await Promise.all([
      db
        .select({ affectedTests: sql<number>`count(distinct ${testRunsCases.testCaseId})` })
        .from(testRunsCases)
        .where(eq(testRunsCases.failureClusterId, clusterId)),

      db
        .select({ status: testRuns.status, startTime: testRuns.startTime })
        .from(testRuns)
        .where(eq(testRuns.id, cluster.lastSeenRunId)),

      db.select({ startTime: testRuns.startTime }).from(testRuns).where(eq(testRuns.id, cluster.firstSeenRunId)),

      db
        .select()
        .from(failureDiagnoses)
        .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster'))),

      db
        .select({ id: projects.id, name: projects.name, label: projects.label, externalIdUrl: projects.externalIdUrl })
        .from(projects)
        .where(eq(projects.id, cluster.projectId)),

      affectedTestsLimit === null ? affectedTestsQuery : affectedTestsQuery.limit(affectedTestsLimit),

      // The cluster's latest occurrence: an execution in the last-seen run, so the
      // page can default its evidence and headline to the newest failure rather
      // than the highest execution id (which need not be the most recent run).
      db
        .select({ id: testRunsCases.id, testCaseId: testRunsCases.testCaseId })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.failureClusterId, clusterId), eq(testRunsCases.testRunId, cluster.lastSeenRunId)))
        .orderBy(desc(testRunsCases.id))
        .limit(1),
    ]);

  // Which affected tests are currently quarantined — drives the "Quarantined"
  // chip and the per-test / "Quarantine all affected" actions on the page.
  const quarantinedIds = await getQuarantinedCaseIds(db, cluster.projectId);

  // Known-issue links pinned to this cluster (Jira / GitHub issue, etc.), and
  // whether a filing for it waits on the tracker or failed for good.
  // Newest first, so every reader that takes the first agrees with the known issue.
  const [links, filings, knownIssues] = await Promise.all([
    db.select().from(entityLinks).where(eq(entityLinks.failureClusterId, clusterId)).orderBy(desc(entityLinks.id)),
    clusterIssueFilings(db, [clusterId]),
    clusterKnownIssues(db, [clusterId]),
  ]);

  // The cluster's known issue — the newest tracker link, one rule for every
  // surface — and its status, which drives the ticket-done state (the reconcile
  // once the failure stopped).
  const knownIssue = knownIssues.get(clusterId) ?? null;
  const reconcileKnownIssue = knownIssue ? { key: knownIssue.key, statusCategory: knownIssue.statusCategory } : null;

  // The cluster's owner from the representative test's `piwi:owner` annotation
  // (the most-affected test wins). The server route adds the CODEOWNERS owner when
  // no annotation exists; the execution page resolves it the same way through
  // `getTestRunCase`'s `resolveOwner`.
  const annotationOwner = (affectedTestCases[0] as { owner?: string | null } | undefined)?.owner ?? null;
  const owner = annotationOwner
    ? { name: annotationOwner, source: 'annotation' as const }
    : (null as { name: string; source: 'annotation' | 'codeowners' } | null);

  // The project's recent runs, newest first — the frame for both the occurrence
  // sparkline (last 20) and the "still failing / quiet" decision.
  const projectRuns = await db
    .select({ id: testRuns.id, startedAt: testRuns.startTime, status: testRuns.status })
    .from(testRuns)
    .where(eq(testRuns.projectId, cluster.projectId))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(50);
  const seriesRuns = projectRuns.slice(0, 20);
  const seriesRunIds = seriesRuns.map((r) => r.id);
  const occurrenceRows =
    seriesRunIds.length > 0
      ? await db
          .select({ runId: testRunsCases.testRunId, occurrences: sql<number>`count(*)` })
          .from(testRunsCases)
          .where(and(eq(testRunsCases.failureClusterId, clusterId), inArray(testRunsCases.testRunId, seriesRunIds)))
          .groupBy(testRunsCases.testRunId)
      : [];
  const occurrencesByRun = new Map(occurrenceRows.map((r: any) => [r.runId, Number(r.occurrences)]));
  // Oldest first, one point per run with 0 where the cluster did not occur.
  const occurrenceSeries: OccurrenceSeriesPoint[] = seriesRuns
    .map((r) => ({ runId: r.id, startedAt: r.startedAt, occurrences: occurrencesByRun.get(r.id) ?? 0 }))
    .reverse();

  const quarantinedCount = await countQuarantinedClusterTests(db, cluster.projectId, clusterId);

  // Whether the failure goes on in the project's latest finished run, and the Done
  // ticket to reconcile once it stopped: the rules the execution page follows too.
  const latestFinishedRun =
    projectRuns.find((r) => !(UNFINISHED_RUN_STATUSES as readonly string[]).includes(r.status)) ?? null;
  const goesOn = failureGoesOn(
    lastRun ? { id: cluster.lastSeenRunId, startTime: lastRun.startTime } : null,
    latestFinishedRun ? { id: latestFinishedRun.id, startTime: latestFinishedRun.startedAt } : null,
  );
  const ticketDoneKey = ticketReconcileKey(
    {
      status: cluster.status ?? 'open',
      fixVerification: cluster.fixVerification ?? null,
      snoozedUntil: cluster.snoozedUntil ?? null,
      snoozeMode: cluster.snoozeMode ?? null,
      knownIssue: reconcileKnownIssue,
    },
    { failureGoesOn: goesOn, now: opts.now },
  );

  // The cluster's diagnosed patch: whether it still applied at the verified fix's
  // commit decides both whether that fix is confirmed and the next step.
  const patchFacts = await getClusterPatchFacts(db, clusterId, { fixLandedRunId: cluster.fixLandedRunId });

  const clusterState: ClusterState = computeClusterState(
    {
      status: cluster.status ?? 'open',
      assignee: cluster.assignee ?? null,
      fixVerification: cluster.fixVerification ?? null,
      fixCommit: cluster.fixCommit ?? null,
      fixLandedRunId: cluster.fixLandedRunId ?? null,
      flakeEvidenceRunId: cluster.flakeEvidenceRunId ?? null,
      lastSeenRunId: cluster.lastSeenRunId,
      lastSeenAt: lastRun?.startTime ?? null,
      updatedAt: cluster.updatedAt ?? null,
      triageNote: cluster.triageNote ?? null,
      snoozedUntil: cluster.snoozedUntil ?? null,
      snoozeMode: cluster.snoozeMode ?? null,
      affectedTests: Number(countRow?.affectedTests ?? 0),
      quarantinedTests: quarantinedCount,
      knownIssue: reconcileKnownIssue,
      diagnosedPatchApplies: patchFacts.patchAppliesAtFix,
    },
    { runIdsNewestFirst: projectRuns.map((r) => r.id), failureGoesOn: goesOn, now: opts.now },
  );

  // The next-step policy runs on the cluster's latest occurrence: its locator
  // healing and error kind, plus the cluster's diagnosed patch and fix state.
  let healingFacts: HealingStepFacts = { hasHealingRecommendation: false, healingEditAvailable: false };
  let latestErrorKind: ReturnType<typeof parsePlaywrightError>['kind'] | null = null;
  let flakeLab: FlakeLabStepFacts | null = null;
  // The latest occurrence's stored error and steps also give the page its headline.
  let latestExec: { error: string | null; steps: unknown } | null = null;
  if (latestOccurrence?.id) {
    const [healing, [execRow]] = await Promise.all([
      getLocatorHealing(db, latestOccurrence.id).catch(() => null),
      db
        .select({
          error: testRunsCases.error,
          steps: testRunsCases.steps,
          status: testRunsCases.status,
          retries: testRunsCases.retries,
        })
        .from(testRunsCases)
        .where(eq(testRunsCases.id, latestOccurrence.id)),
    ]);
    latestExec = execRow ?? null;
    healingFacts = await getHealingStepFacts(db, cluster.projectId, healing);
    if (execRow?.error) {
      latestErrorKind = parsePlaywrightError(execRow.error, {
        stepParams: failingStepParams(
          Array.isArray(execRow.steps) ? (execRow.steps as Parameters<typeof failingStepParams>[0]) : null,
          execRow.error,
        ),
      }).kind;
    }
    // The latest occurrence passed on a retry, or its test's history both fails and
    // passes: the Flake Lab may hold the next step.
    const testCaseId = latestOccurrence.testCaseId;
    const retryPassed = execRow?.status === 'passed' && (execRow.retries ?? 0) > 0;
    if (
      testCaseId != null &&
      (retryPassed || (await mayHaveFlakeSuspects(db, testCaseId).catch(() => false))) &&
      !(await isPassiveCapabilityDeclined(db, cluster.projectId, 'flake-lab'))
    ) {
      const ciAvailable = opts.flakeLabCiAvailable
        ? await opts.flakeLabCiAvailable(testCaseId).catch(() => false)
        : false;
      flakeLab = await getFlakeLabStepFacts(db, testCaseId, { ciAvailable, now: opts.now }).catch(() => null);
    }
  }

  const nextStep: NextStep = computeNextStep({
    status: cluster.status ?? 'open',
    clusterStatus: cluster.status ?? 'open',
    fixVerification: cluster.fixVerification ?? null,
    fixLandedRunId: cluster.fixLandedRunId ?? null,
    fixCommit: cluster.fixCommit ?? null,
    ticketDoneKey,
    ...healingFacts,
    diagnosisCompleted: patchFacts.diagnosisCompleted,
    diagnosisSummary: patchFacts.summary,
    patchFile: patchFacts.patchFile,
    hasPatch: patchFacts.hasPatch,
    patchValidationStatus: patchFacts.patchValidationStatus,
    patchAppliesCleanly: patchFacts.patchAppliesCleanly,
    patchAppliesAtFix: patchFacts.patchAppliesAtFix,
    errorKind: latestErrorKind,
    aiConfigured: opts.aiConfigured ?? false,
    ciRerunAvailable: opts.ciRerunAvailable ?? false,
    flakeLab,
    clusterId,
    executionId: latestOccurrence?.id ?? null,
  });

  return {
    ...cluster,
    latestHeadline: clusterLatestHeadline(cluster, latestExec),
    affectedTests: Number(countRow?.affectedTests ?? 0),
    lastSeenRunStatus: lastRun?.status ?? null,
    lastSeenAt: lastRun?.startTime ?? null,
    firstSeenAt: firstSeenRun?.startTime ?? null,
    latestTestRunsCaseId: latestOccurrence?.id ?? null,
    latestTestCaseId: latestOccurrence?.testCaseId ?? null,
    diagnosis: diag
      ? {
          status: diag.status,
          category: diag.category,
          confidence: diag.confidence,
          summary: diag.summary,
          provider: diag.provider,
        }
      : null,
    project: project ?? null,
    affectedTestCases: affectedTestCases.map((t: any) => ({
      testCaseId: t.testCaseId,
      title: t.title,
      filePath: t.filePath,
      owner: (t.owner as string | null) ?? null,
      runCount: Number(t.runCount),
      recentTestRunsCaseId: t.recentTestRunsCaseId,
      quarantined: quarantinedIds.has(t.testCaseId),
    })),
    links,
    knownIssue,
    issueFilingQueued: filings.queued.has(clusterId),
    issueFilingFailure: filings.failures.get(clusterId) ?? null,
    owner,
    failureGoesOn: goesOn,
    clusterState,
    occurrenceSeries,
    nextStep,
  };
}

export async function getClusterDiagnosis(db: DrizzleDB, clusterId: number) {
  const [diag] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')));
  const [cluster] = await db
    .select({ manualBaseCommit: failureClusters.manualBaseCommit })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  return {
    diagnosis: diag ?? null,
    manualBaseCommit: cluster?.manualBaseCommit ?? null,
  };
}

/**
 * The stored execution-scoped AI diagnosis for a single test-run case, if any.
 * Mirrors `getClusterDiagnosis` but keyed on the execution instead of a cluster,
 * so the test-run-case page can restore a diagnosis after a reload. Shared by the
 * server endpoint and the demo router so the two never drift.
 */
export async function getExecutionDiagnosis(db: DrizzleDB, testRunsCaseId: number) {
  const [diag] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.testRunsCaseId, testRunsCaseId), eq(failureDiagnoses.scope, 'execution')));
  return { diagnosis: diag ?? null };
}

/**
 * Set a cluster's triage status. The triage note is kept unless one is given:
 * a string replaces it (empty clears it), `null` clears it.
 */
export async function patchClusterStatus(db: DrizzleDB, clusterId: number, status: string, triageNote?: string | null) {
  if (!status || !VALID_STATUSES.includes(status)) {
    return null;
  }

  const [cluster] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const note = triageNote === undefined ? {} : { triageNote: triageNote?.trim() ? triageNote : null };
  await db
    .update(failureClusters)
    .set({ status, ...note, updatedAt: new Date() })
    .where(eq(failureClusters.id, clusterId));

  const [updated] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  return { success: true, cluster: updated };
}

/**
 * Assign (or unassign) a cluster. The stored `assignee` overrides the owner the
 * row derives from the test annotation, and drives the *Mine* queue. An empty or
 * whitespace value clears the assignment.
 */
export async function patchClusterAssignee(db: DrizzleDB, clusterId: number, assignee?: string | null) {
  const [cluster] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const value = typeof assignee === 'string' && assignee.trim() ? assignee.trim() : null;
  await db
    .update(failureClusters)
    .set({ assignee: value, updatedAt: new Date() })
    .where(eq(failureClusters.id, clusterId));

  const [updated] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  return { success: true, cluster: updated };
}

/**
 * Snooze a cluster (hiding it from every inbox queue) or, with a null option,
 * unsnooze it. Snooze never touches `status` — a snoozed cluster is still open,
 * just out of sight until its deadline passes or (in "until it recurs" mode) a
 * new run adds an occurrence. Unsnoozing clears the "snoozed, back" marker too.
 */
export async function patchClusterSnooze(
  db: DrizzleDB,
  clusterId: number,
  option: SnoozeOption | null,
  now: Date = new Date(),
) {
  const [cluster] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const fields = option ? computeSnooze(option, now) : { snoozedUntil: null, snoozeMode: null };
  await db
    .update(failureClusters)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(failureClusters.id, clusterId));

  const [updated] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  return { success: true, cluster: updated };
}

/**
 * Quarantine every test currently in a cluster — the "quarantine the cluster's
 * tests" inbox action, applying the same exit-ramp quarantine the cluster page's
 * "Quarantine all affected" button uses, but keyed on the cluster so the inbox
 * need not carry the test-case ids. Idempotent per test.
 */
export async function quarantineClusterTests(
  db: DrizzleDB,
  clusterId: number,
  opts: { createdBy?: number | null; reason?: string } = {},
) {
  const [cluster] = await db
    .select({ id: failureClusters.id, projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const rows = await db
    .selectDistinct({ testCaseId: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId));

  let quarantined = 0;
  for (const row of rows) {
    const { created } = await addQuarantine(db, cluster.projectId, row.testCaseId, {
      reason: opts.reason,
      source: 'manual',
      createdBy: opts.createdBy ?? null,
    });
    if (created) quarantined += 1;
  }
  return { success: true, projectId: cluster.projectId, tests: rows.length, quarantined };
}

/**
 * Release every test currently in a cluster from quarantine, through the same
 * per-test release the project's quarantine table applies. The quarantine rows
 * stay as history. A test that is not quarantined is left as it is.
 */
export async function releaseClusterTests(
  db: DrizzleDB,
  clusterId: number,
  opts: { reason?: string | null; actor?: HandbackActor } = {},
) {
  const [cluster] = await db
    .select({ id: failureClusters.id, projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const rows = await db
    .selectDistinct({ testCaseId: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId));

  let released = 0;
  for (const row of rows) {
    const result = await releaseQuarantine(db, cluster.projectId, row.testCaseId, opts.reason ?? null, opts.actor);
    if (result.released) released += 1;
  }
  return { success: true, projectId: cluster.projectId, tests: rows.length, released };
}

/** A single bulk-triage action applied to a set of already-authorized clusters. */
export type BulkTriage =
  | { action: 'status'; status: string }
  | { action: 'assign'; assignee: string | null }
  | { action: 'snooze'; snooze: SnoozeOption | null };

/**
 * Apply one triage action to many clusters at once, sharing the validation the
 * single-cluster endpoints use. The caller has already narrowed `ids` to the
 * clusters the user may write. A status change keeps each cluster's triage
 * note. Returns null on an invalid status.
 */
export async function bulkTriageClusters(
  db: DrizzleDB,
  ids: number[],
  patch: BulkTriage,
  now: Date = new Date(),
): Promise<{ updated: number } | null> {
  if (ids.length === 0) return { updated: 0 };

  let set: Record<string, unknown>;
  if (patch.action === 'status') {
    if (!VALID_STATUSES.includes(patch.status)) return null;
    set = { status: patch.status, updatedAt: new Date() };
  } else if (patch.action === 'assign') {
    const value = typeof patch.assignee === 'string' && patch.assignee.trim() ? patch.assignee.trim() : null;
    set = { assignee: value, updatedAt: new Date() };
  } else {
    const fields = patch.snooze ? computeSnooze(patch.snooze, now) : { snoozedUntil: null, snoozeMode: null };
    set = { ...fields, updatedAt: new Date() };
  }

  await db.update(failureClusters).set(set).where(inArray(failureClusters.id, ids));
  return { updated: ids.length };
}

export async function patchClusterBaseCommit(db: DrizzleDB, clusterId: number, commit?: string | null) {
  const [cluster] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const manualBaseCommit = typeof commit === 'string' && commit.trim() ? commit.trim() : null;
  await db
    .update(failureClusters)
    .set({ manualBaseCommit, updatedAt: new Date() })
    .where(eq(failureClusters.id, clusterId));

  const [updated] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  return { success: true, cluster: updated };
}

/**
 * Record the first bad commit a bisect found on a cluster, so it reaches the
 * fix plan (its endpoint, the Markdown export and `get_fix_plan`). Null when
 * the cluster does not exist. The commit URL is derived when the plan is read.
 */
export async function recordClusterBisect(
  db: DrizzleDB,
  clusterId: number,
  result: BisectResult,
): Promise<BisectedCommit | null> {
  const bisectedCommit: BisectedCommit = { ...result, commitUrl: null };
  const updated = await db
    .update(failureClusters)
    .set({ bisectResult: bisectedCommit, updatedAt: new Date() })
    .where(eq(failureClusters.id, clusterId))
    .returning({ id: failureClusters.id });
  return updated.length ? bisectedCommit : null;
}

export async function extractClusterCases(
  db: DrizzleDB,
  clusterId: number,
  testCaseIds: number[],
  triageNote?: string,
) {
  if (!testCaseIds || !Array.isArray(testCaseIds) || testCaseIds.length === 0) {
    return null;
  }

  const split = await splitFailureCluster(db, clusterId, testCaseIds, triageNote);
  if (!split) return null;

  if (split.clusterId != null) {
    const [source] = await db
      .select({ triageNote: failureClusters.triageNote })
      .from(failureClusters)
      .where(eq(failureClusters.id, clusterId));
    const line = `Moved ${split.testCount} test${split.testCount === 1 ? '' : 's'} to cluster #${split.clusterId}.`;
    await db
      .update(failureClusters)
      .set({ triageNote: source?.triageNote ? `${source.triageNote}\n${line}` : line, updatedAt: new Date() })
      .where(eq(failureClusters.id, clusterId));
  }

  const [remaining] = await db
    .select({ occurrences: failureClusters.occurrences })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  return {
    success: true,
    extractedCount: split.testCount,
    remainingOccurrences: remaining?.occurrences ?? 0,
    clusterId: split.clusterId,
  };
}

/**
 * Open failure clusters across every project the caller can see, newest first
 * by last seen — the Home failure inbox. Each row carries everything the inbox
 * queues and rows need in one pass (no N+1): the fields `describeCluster` names
 * a cluster from, the owning project, the affected-test count, first/last seen,
 * the annotation owner (the most-affected test wins, mirroring `getFailureCluster`)
 * and any assignee, a one-line cause hint, the pinned known-issue link, the
 * regression / fix-didn't-hold / quarantine-readiness / merge-suggestion signals
 * the queues filter on, and the snooze state.
 *
 * Currently-snoozed clusters are excluded (they leave every queue until the
 * deadline passes); an "until it recurs" snooze that has recurred returns here
 * with `snoozeMode` still set and `snoozedUntil` cleared, so the card can badge
 * it "snoozed, back".
 */
export async function getOpenFailureClusters(
  db: DrizzleDB,
  scope: ProjectScope = 'all',
  limit = 50,
  now: Date = new Date(),
): Promise<OpenFailureCluster[]> {
  const allowed = scope === 'all' ? 'all' : [...scope];
  if (allowed !== 'all' && allowed.length === 0) return [];

  // Open, and not currently snoozed (null deadline, or a deadline already past —
  // which is how an "until it recurs" wake and an expired timed snooze both read).
  const notSnoozed = or(isNull(failureClusters.snoozedUntil), lte(failureClusters.snoozedUntil, now));
  const where =
    allowed === 'all'
      ? and(eq(failureClusters.status, 'open'), notSnoozed)
      : and(eq(failureClusters.status, 'open'), inArray(failureClusters.projectId, allowed), notSnoozed);

  const clusters: any[] = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      title: failureClusters.title,
      signature: failureClusters.signature,
      errorType: failureClusters.errorType,
      selector: failureClusters.selector,
      sampleError: failureClusters.sampleError,
      status: failureClusters.status,
      firstSeenRunId: failureClusters.firstSeenRunId,
      lastSeenRunId: failureClusters.lastSeenRunId,
      occurrences: failureClusters.occurrences,
      assignee: failureClusters.assignee,
      fixVerification: failureClusters.fixVerification,
      snoozedUntil: failureClusters.snoozedUntil,
      snoozeMode: failureClusters.snoozeMode,
    })
    .from(failureClusters)
    .where(where)
    .orderBy(desc(failureClusters.lastSeenRunId))
    .limit(Math.min(200, Math.max(1, limit)));

  if (clusters.length === 0) return [];

  const clusterIds: number[] = clusters.map((c) => c.id);
  const projectIds: number[] = [...new Set(clusters.map((c) => c.projectId))];
  const seenRunIds: number[] = [
    ...new Set(clusters.flatMap((c) => [c.lastSeenRunId, c.firstSeenRunId]).filter((id) => id != null)),
  ];

  const [projectRows, counts, seenRuns, ownerRows, linkRows, regressionRows, mergeRows] = await Promise.all([
    db
      .select({ id: projects.id, name: projects.name, label: projects.label, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(inArray(projects.id, projectIds)),

    db
      .select({
        clusterId: testRunsCases.failureClusterId,
        affectedTests: sql<number>`count(distinct ${testRunsCases.testCaseId})`,
      })
      .from(testRunsCases)
      .where(inArray(testRunsCases.failureClusterId, clusterIds))
      .groupBy(testRunsCases.failureClusterId),

    db
      .select({
        id: testRuns.id,
        status: testRuns.status,
        startTime: testRuns.startTime,
        branch: testRuns.branch,
        metadata: testRuns.metadata,
      })
      .from(testRuns)
      .where(inArray(testRuns.id, seenRunIds)),

    // One row per (cluster, test): the most-affected test names the cluster when
    // the sample error has no frame and supplies the `piwi:owner` annotation. The
    // test-case ids also feed the quarantine-readiness cross-reference below.
    db
      .select({
        clusterId: testRunsCases.failureClusterId,
        testCaseId: testCases.id,
        filePath: testCases.filePath,
        owner: testCases.owner,
        runCount: sql<number>`count(${testRunsCases.id})`,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(inArray(testRunsCases.failureClusterId, clusterIds))
      .groupBy(testRunsCases.failureClusterId, testCases.id, testCases.filePath, testCases.owner),

    db
      .select({
        clusterId: entityLinks.failureClusterId,
        url: entityLinks.url,
        provider: entityLinks.provider,
        key: entityLinks.key,
        connectionId: entityLinks.connectionId,
      })
      .from(entityLinks)
      .where(inArray(entityLinks.failureClusterId, clusterIds))
      .orderBy(desc(entityLinks.id)),

    // Clusters that ever regressed (passed in baseline, then failed) and on which
    // branch — paired below with the cluster's last-seen branch to decide whether
    // it is a regression still failing on the default branch.
    db
      .select({ clusterId: testRunsCases.failureClusterId, branch: testRuns.branch })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
      .where(and(inArray(testRunsCases.failureClusterId, clusterIds), eq(testRunsCases.isNewRegression, 1)))
      .groupBy(testRunsCases.failureClusterId, testRuns.branch),

    // Pending merge suggestions touching any of these clusters.
    db
      .select({ a: clusterMergeSuggestions.clusterAId, b: clusterMergeSuggestions.clusterBId })
      .from(clusterMergeSuggestions)
      .where(
        and(
          eq(clusterMergeSuggestions.status, 'pending'),
          or(
            inArray(clusterMergeSuggestions.clusterAId, clusterIds),
            inArray(clusterMergeSuggestions.clusterBId, clusterIds),
          ),
        ),
      ),
  ]);

  const projectById = new Map(projectRows.map((p: any) => [p.id, p]));
  const affectedById = new Map(counts.map((c: any) => [c.clusterId, Number(c.affectedTests)]));
  const runById = new Map(
    seenRuns.map((r: any) => [
      r.id,
      { status: r.status, startTime: r.startTime, branch: r.branch, incident: readRunIncident(r.metadata) },
    ]),
  );

  // Keep the most-affected test per cluster for the name fallback and owner, and
  // collect every affected test-case id per cluster for the quarantine lookup.
  const repByCluster = new Map<number, { filePath: string | null; owner: string | null; runCount: number }>();
  const caseIdsByCluster = new Map<number, number[]>();
  for (const row of ownerRows as any[]) {
    const prev = repByCluster.get(row.clusterId);
    if (!prev || Number(row.runCount) > prev.runCount) {
      repByCluster.set(row.clusterId, {
        filePath: row.filePath ?? null,
        owner: row.owner ?? null,
        runCount: Number(row.runCount),
      });
    }
    const list = caseIdsByCluster.get(row.clusterId) ?? [];
    list.push(row.testCaseId);
    caseIdsByCluster.set(row.clusterId, list);
  }

  // Newest known-issue link wins (rows come back id-descending).
  const issueByCluster = new Map<number, { url: string; provider: string; key: string | null }>();
  // A cluster "has a ticket" when a tracker link (Jira, or any link that carries
  // a connection) has a key — that is what excludes it from the needs-ticket queue.
  const hasKnownIssueByCluster = new Set<number>();
  for (const row of linkRows as any[]) {
    if (row.clusterId != null && !issueByCluster.has(row.clusterId)) {
      issueByCluster.set(row.clusterId, { url: row.url, provider: row.provider, key: row.key ?? null });
    }
    if (row.clusterId != null && isTrackerLink(row)) {
      hasKnownIssueByCluster.add(row.clusterId);
    }
  }

  // The needs-ticket age threshold per project, from each binding (default 2 days).
  const bindingRows = await db
    .select({ projectId: projectIntegrations.projectId, policies: projectIntegrations.policies })
    .from(projectIntegrations)
    .where(inArray(projectIntegrations.projectId, projectIds));
  const needsTicketDaysByProject = new Map<number, number>();
  for (const row of bindingRows as any[]) {
    needsTicketDaysByProject.set(
      row.projectId,
      resolveProjectIntegration({ policies: row.policies }).policies.needsTicketAfterDays,
    );
  }

  // The branches each cluster regressed on.
  const regressionBranchesByCluster = new Map<number, Set<string>>();
  for (const row of regressionRows as any[]) {
    if (row.branch == null) continue;
    const set = regressionBranchesByCluster.get(row.clusterId) ?? new Set<string>();
    set.add(row.branch);
    regressionBranchesByCluster.set(row.clusterId, set);
  }

  const mergeSuggestionClusterIds = new Set<number>();
  for (const row of mergeRows as any[]) {
    if (row.a != null) mergeSuggestionClusterIds.add(row.a);
    if (row.b != null) mergeSuggestionClusterIds.add(row.b);
  }

  // Quarantine readiness per project — reuse the exit-ramp streak engine. Only
  // the projects present here are scanned; the map is test-case id → readiness.
  const quarantineByProject = new Map<number, { active: Set<number>; ready: Set<number> }>();
  await Promise.all(
    projectIds.map(async (projectId) => {
      const { entries } = await listQuarantine(db, projectId);
      const active = new Set<number>();
      const ready = new Set<number>();
      for (const entry of entries) {
        active.add(entry.testCaseId);
        if (entry.releaseProposed) ready.add(entry.testCaseId);
      }
      quarantineByProject.set(projectId, { active, ready });
    }),
  );

  return clusters.map((c): OpenFailureCluster => {
    const project = projectById.get(c.projectId);
    const run = runById.get(c.lastSeenRunId) as { status: string; startTime: Date; branch: string | null } | undefined;
    const firstRun = runById.get(c.firstSeenRunId) as
      | { startTime: Date; incident: ReturnType<typeof readRunIncident> }
      | undefined;
    const rep = repByCluster.get(c.id);

    // A regression still failing on the default branch: last seen there, and it
    // began as a regression (passed in baseline) on that same branch.
    const effectiveDefault = project?.defaultBranch ?? 'main';
    const regressionOnDefault =
      run?.branch === effectiveDefault && !!regressionBranchesByCluster.get(c.id)?.has(effectiveDefault);

    // Quarantine readiness: a quarantined member test is ready to release when its
    // streak has cleared the threshold, or the cluster's fix has verified as held
    // (its failures stopped) — either way the quarantine is safe to lift.
    const quarantine = quarantineByProject.get(c.projectId);
    const caseIds = caseIdsByCluster.get(c.id) ?? [];
    const fixHeld = c.fixVerification === 'stopped-failing' || c.fixVerification === 'diagnosis-verified';
    const quarantinedCount = quarantine ? caseIds.filter((id) => quarantine.active.has(id)).length : 0;
    const quarantineReadyCount = quarantine
      ? caseIds.filter((id) => quarantine.active.has(id) && (fixHeld || quarantine.ready.has(id))).length
      : 0;

    return {
      id: c.id,
      projectId: c.projectId,
      projectName: project?.name ?? `Project ${c.projectId}`,
      projectLabel: project?.label ?? null,
      title: c.title ?? null,
      signature: c.signature,
      errorType: c.errorType ?? null,
      selector: c.selector ?? null,
      sampleError: c.sampleError ?? null,
      filePath: rep?.filePath ?? null,
      status: c.status,
      affectedTests: affectedById.get(c.id) ?? 0,
      occurrences: c.occurrences ?? 0,
      firstSeenAt: firstRun?.startTime ?? null,
      lastSeenAt: run?.startTime ?? null,
      lastSeenRunId: c.lastSeenRunId,
      lastSeenRunStatus: run?.status ?? null,
      owner: rep?.owner ? { name: rep.owner, source: 'annotation' } : null,
      assignee: c.assignee ?? null,
      issueLink: issueByCluster.get(c.id) ?? null,
      topClue: clusterClue(c),
      fixVerification: c.fixVerification ?? null,
      regressionOnDefault,
      onDefaultBranch: run?.branch === effectiveDefault,
      hasKnownIssue: hasKnownIssueByCluster.has(c.id),
      needsTicketAfterDays: needsTicketDaysByProject.get(c.projectId) ?? DEFAULT_NEEDS_TICKET_AFTER_DAYS,
      quarantinedCount,
      quarantineReadyCount,
      mergeSuggestionPending: mergeSuggestionClusterIds.has(c.id),
      snoozedUntil: c.snoozedUntil ?? null,
      snoozeMode: c.snoozeMode ?? null,
      incidentRun: firstRun?.incident
        ? {
            runId: c.firstSeenRunId,
            reason: firstRun.incident.reason,
            host: firstRun.incident.host,
            startedAt: firstRun.startTime ?? null,
          }
        : null,
    };
  });
}

// ─── getClusterOccurrenceTrend ───────────────────────────────────

/** How far back a cluster's occurrence trend reaches by default. */
export const CLUSTER_TREND_DEFAULT_DAYS = 90;

export interface ClusterOccurrenceTrend {
  clusterId: number;
  /** Days one bucket spans (1 daily, 7 weekly, 30 for calendar months). */
  bucketDays: number;
  /** Failing executions of the cluster, and the distinct tests behind them, per UTC bucket. */
  buckets: Array<{ date: string; occurrences: number; tests: number }>;
  /** When the fix landed (every affected test passed again); null while none has. */
  fixLandedAt: string | null;
  /** The first occurrence after the fix, when the fix did not hold. */
  regressedAt: string | null;
}

/** The start of a `days`-day trend window ending at `now`: the UTC start of its first day. */
export function clusterTrendStart(now: number, days: number): number {
  return Date.parse(`${new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
}

/**
 * A cluster's occurrences over time: its failing executions per UTC day, week
 * or month over the last `days` days (lab runs left out), with the moment
 * its fix landed and the first occurrence after it, if the fix regressed.
 */
export async function getClusterOccurrenceTrend(
  db: DrizzleDB,
  clusterId: number,
  options: { days?: number; now?: number } = {},
): Promise<ClusterOccurrenceTrend> {
  const [cluster] = await db
    .select({ id: failureClusters.id, fixLandedAt: failureClusters.fixLandedAt })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) throw new Error('Failure cluster not found');
  const days = Math.min(3650, Math.max(1, Math.round(options.days ?? CLUSTER_TREND_DEFAULT_DAYS)));
  const now = options.now ?? Date.now();
  const from = clusterTrendStart(now, days);

  const rows: Array<{ testCaseId: number; startTime: Date; metadata: unknown }> = await db
    .select({ testCaseId: testRunsCases.testCaseId, startTime: testRuns.startTime, metadata: testRuns.metadata })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(eq(testRunsCases.failureClusterId, clusterId), gte(testRuns.startTime, new Date(from))));

  const buckets = makeTimeBuckets(from, now + 1, 'auto');
  const tally = new Map<string, { occurrences: number; tests: Set<number> }>();
  const fixMs = cluster.fixLandedAt ? new Date(cluster.fixLandedAt).getTime() : null;
  let regressedMs: number | null = null;
  for (const row of rows) {
    if (isLabRun(row.metadata)) continue;
    const at = new Date(row.startTime).getTime();
    if (fixMs !== null && at > fixMs && (regressedMs === null || at < regressedMs)) regressedMs = at;
    const key = buckets.keyFor(at);
    if (!key) continue;
    const t = tally.get(key) ?? { occurrences: 0, tests: new Set<number>() };
    t.occurrences += 1;
    t.tests.add(row.testCaseId);
    tally.set(key, t);
  }
  return {
    clusterId,
    bucketDays: buckets.bucketDays,
    buckets: buckets.keys.map((date) => ({
      date,
      occurrences: tally.get(date)?.occurrences ?? 0,
      tests: tally.get(date)?.tests.size ?? 0,
    })),
    fixLandedAt: fixMs !== null ? new Date(fixMs).toISOString() : null,
    regressedAt: regressedMs !== null ? new Date(regressedMs).toISOString() : null,
  };
}
