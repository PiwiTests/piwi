/**
 * The write-backs a cluster's evolution triggers on its ticket — fix landed,
 * regressed, still failing, diagnosed, merged — and the description updates of
 * an issue Piwi filed. Each is an outbox action (comment, transition or
 * update-issue) with a dedupe key, so it is retried, deduped and listed like
 * every other integration write.
 *
 * A policy runs only when the cluster carries a tracker link and the project's
 * binding turns that policy on; both default off, so nothing writes to a
 * tracker until an administrator opts in. It writes only through the connection
 * the project is bound to: a ticket linked through another connection gets
 * nothing (`bound-connection.ts`). A write a run triggers also needs the
 * run to drive tracker writes (the `tracker` run use) and to be in the
 * binding's run scope (`policies.scope`: branches, environments). Every comment
 * is built through the message catalog in the issue's language.
 */
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { entityLinks, testCases, testRuns, testRunsCases } from '../../database/schema';
import type { DbClient } from '../../database';
import type { EntityLink } from '../../database/schema';
import { t, type IssueLocale } from '#shared/integrations/messages';
import { doc } from '#shared/integrations/document';
import { notLabRun } from '#shared/run-eligibility';
import { noteWindow } from '#shared/integrations/automation';
import type { DiagnosisCompletedPayload } from '#shared/notification-events';
import {
  buildFixComment,
  buildRegressionComment,
  buildStillFailingComment,
  buildDiagnosisComment,
  buildMergeComment,
  type FixCommentVerification,
} from '#shared/integrations/policy-comments';
import type { ResolvedProjectIntegration } from '#shared/integrations/binding';
import {
  fixCommentKey,
  fixTransitionKey,
  regressionCommentKey,
  reopenTransitionKey,
  occurrencesCommentKey,
  mergeCommentKey,
  bugLooksFixedCommentKey,
  bugFixTransitionKey,
  diagnosisCommentKey,
  updateIssueKey,
  dailyUpdateReason,
} from '#shared/integrations/action-keys';
import type {
  CommentActionPayload,
  FiledIssueMeta,
  TransitionActionPayload,
  UpdateIssueActionPayload,
} from './actions';
import { enqueueAction, findActionByKey, runActionNow } from './actions';
import { bindingLocale, readProjectIntegration } from './binding';
import { getConnectionRow } from './connections';
import { getClusterTrackerLink } from './known-issue';
import { mergeEntityLinkMetadata } from './entity-links';
import { buildClusterIssue } from './documents';
import { loadTrackerRun, runDrivesWrites, type TrackerRun } from './tracker-run';

/** Everything a policy needs: the writable link, the binding, and the ticket language. */
interface PolicyContext {
  link: EntityLink;
  binding: ResolvedProjectIntegration;
  locale: IssueLocale;
  clusterUrl: string | null;
}

/** The dashboard base URL, trailing slash trimmed, or null when unset. */
function siteBase(): string | null {
  const raw = process.env.PIWI_SITE_URL?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

/** Whether Piwi may write to a link's ticket for a project: it has a key and sits on the bound connection. */
function writableLink(
  link: EntityLink | null | undefined,
  binding: ResolvedProjectIntegration,
): link is EntityLink & { key: string; connectionId: number } {
  return !!link?.key && link.connectionId != null && link.connectionId === binding.connectionId;
}

/** Gather the context for a cluster, or null when there is nothing to write to. */
async function policyContext(db: DbClient, clusterId: number, projectId: number): Promise<PolicyContext | null> {
  const link = await getClusterTrackerLink(db, clusterId);
  if (!link?.key || link.connectionId == null) return null;
  const binding = await readProjectIntegration(db, projectId);
  if (!writableLink(link, binding)) return null;
  const connection = await getConnectionRow(db, link.connectionId);
  const base = siteBase();
  return {
    link,
    binding,
    locale: bindingLocale(binding, connection?.config ?? null),
    clusterUrl: base ? `${base}/failure-clusters/${clusterId}` : null,
  };
}

/** The run behind a write when it may drive one under the binding's scope, else null. */
async function scopedRun(db: DbClient, runId: number, binding: ResolvedProjectIntegration): Promise<TrackerRun | null> {
  const run = await loadTrackerRun(db, runId);
  return runDrivesWrites(run, binding.policies.scope) ? run : null;
}

/** Enqueue one action and make an immediate best-effort attempt (the click path). */
async function enqueueAndKick(db: DbClient, input: Parameters<typeof enqueueAction>[1]): Promise<void> {
  const action = await enqueueAction(db, input);
  await runActionNow(db, action.id).catch(() => null);
}

/** Comment (and optionally transition) on the ticket when a cluster's fix is verified. */
export async function enqueueFixPolicies(
  db: DbClient,
  facts: {
    clusterId: number;
    projectId: number;
    runId: number;
    commit: string | null;
    verification: FixCommentVerification;
  },
): Promise<void> {
  const ctx = await policyContext(db, facts.clusterId, facts.projectId);
  if (!ctx) return;
  const { link, binding, locale, clusterUrl } = ctx;
  const transition = binding.policies.transitionOnFix && binding.policies.fixTransitionId;
  if (!binding.policies.commentOnFix && !transition) return;
  if (!(await scopedRun(db, facts.runId, binding))) return;

  if (binding.policies.commentOnFix) {
    const document = buildFixComment(locale, {
      runNumber: facts.runId,
      commit: facts.commit,
      verification: facts.verification,
      clusterUrl,
    });
    await enqueueAndKick(db, {
      connectionId: link.connectionId!,
      projectId: facts.projectId,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: facts.clusterId,
      dedupeKey: fixCommentKey(facts.clusterId, facts.runId),
      payload: { issueKey: link.key!, document } satisfies CommentActionPayload,
    });
  }

  if (transition) {
    await enqueueAndKick(db, {
      connectionId: link.connectionId!,
      projectId: facts.projectId,
      kind: 'transition',
      entityType: 'failure_cluster',
      entityId: facts.clusterId,
      dedupeKey: fixTransitionKey(facts.clusterId, facts.runId),
      payload: {
        issueKey: link.key!,
        transitionId: binding.policies.fixTransitionId,
        statusName: binding.policies.fixTransitionId,
        fields: binding.policies.fixTransitionFields,
      } satisfies TransitionActionPayload,
    });
  }
}

/** Comment (and optionally reopen) on the ticket when a cluster regresses. */
export async function enqueueRegressionPolicies(
  db: DbClient,
  facts: { clusterId: number; projectId: number; runId: number },
): Promise<void> {
  const ctx = await policyContext(db, facts.clusterId, facts.projectId);
  if (!ctx) return;
  const { link, binding, locale, clusterUrl } = ctx;
  if (!binding.policies.commentOnRegression && !binding.policies.reopenTransitionId) return;
  if (!(await scopedRun(db, facts.runId, binding))) return;

  if (binding.policies.commentOnRegression) {
    const document = buildRegressionComment(locale, { runNumber: facts.runId, clusterUrl });
    await enqueueAndKick(db, {
      connectionId: link.connectionId!,
      projectId: facts.projectId,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: facts.clusterId,
      dedupeKey: regressionCommentKey(facts.clusterId, facts.runId),
      payload: { issueKey: link.key!, document } satisfies CommentActionPayload,
    });
  }

  if (binding.policies.reopenTransitionId) {
    await enqueueAndKick(db, {
      connectionId: link.connectionId!,
      projectId: facts.projectId,
      kind: 'transition',
      entityType: 'failure_cluster',
      entityId: facts.clusterId,
      dedupeKey: reopenTransitionKey(facts.clusterId, facts.runId),
      payload: {
        issueKey: link.key!,
        transitionId: binding.policies.reopenTransitionId,
        statusName: binding.policies.reopenTransitionId,
        fields: binding.policies.reopenTransitionFields,
      } satisfies TransitionActionPayload,
    });
  }
}

/** Bookkeeping the still-failing policy keeps on the link's metadata. */
interface OccurrenceMeta {
  lastCommentedOccurrences?: number;
  lastCommentedRunId?: number;
}

/** What changed in a cluster's failures after a run. */
interface ClusterNews {
  /** Distinct runs it failed in after the run. */
  runs: number;
  /** Tests, branches and environments whose first failure in the cluster came after the run. */
  tests: string[];
  branches: string[];
  environments: string[];
}

/** What changed in a cluster's failures after `sinceRunId`; lab runs are left out. */
async function clusterNewsSince(db: DbClient, clusterId: number, sinceRunId: number): Promise<ClusterNews> {
  const failing = and(eq(testRunsCases.failureClusterId, clusterId), notLabRun(testRuns.origin));
  const [runRows, places] = await Promise.all([
    db
      .selectDistinct({ runId: testRunsCases.testRunId })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(and(failing, gt(testRunsCases.testRunId, sinceRunId))),
    db
      .select({
        testCaseId: testRunsCases.testCaseId,
        title: testCases.title,
        branch: testRuns.branch,
        environment: testRuns.environment,
        firstRunId: sql<number>`min(${testRunsCases.testRunId})`,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(failing)
      .groupBy(testRunsCases.testCaseId, testCases.title, testRuns.branch, testRuns.environment),
  ]);

  /** Each value with the first run it failed in, then the values whose first run came after `sinceRunId`. */
  const firstAfter = (pick: (row: (typeof places)[number]) => string | null): string[] => {
    const first = new Map<string, number>();
    for (const row of places) {
      const value = pick(row);
      if (!value) continue;
      const runId = Number(row.firstRunId);
      if (!first.has(value) || runId < first.get(value)!) first.set(value, runId);
    }
    return [...first].filter(([, runId]) => runId > sinceRunId).map(([value]) => value);
  };

  // Without a starting run nothing reads as new, only counted.
  const known = sinceRunId > 0;
  const titles = new Map(places.map((row) => [String(row.testCaseId), row.title]));
  return {
    runs: Math.max(1, runRows.length),
    tests: known ? firstAfter((row) => String(row.testCaseId)).map((id) => titles.get(id) ?? id) : [],
    branches: known ? firstAfter((row) => row.branch) : [],
    environments: known ? firstAfter((row) => row.environment) : [],
  };
}

/**
 * Comment on an open ticket when new occurrences land, at most once per note
 * window (a day or a week) and only once at least `newOccurrencesMin` arrived
 * since the last note: how many, over how many runs, where it last failed, and
 * the tests, branches and environments it reached since. The baseline is
 * recorded the first time and reported against on the next note.
 */
export async function enqueueStillFailingPolicy(
  db: DbClient,
  facts: { clusterId: number; projectId: number; latestRunId: number; occurrences: number },
): Promise<void> {
  const ctx = await policyContext(db, facts.clusterId, facts.projectId);
  if (!ctx || !ctx.binding.policies.commentOnNewOccurrences) return;
  const { link, binding, locale, clusterUrl } = ctx;
  const run = await scopedRun(db, facts.latestRunId, binding);
  if (!run) return;

  const meta = (link.metadata as OccurrenceMeta | null) ?? {};
  const baseline = meta.lastCommentedOccurrences;
  if (baseline == null) {
    // First observation with the policy on — record where we are, do not comment.
    await mergeEntityLinkMetadata(db, link.id, {
      lastCommentedOccurrences: facts.occurrences,
      lastCommentedRunId: facts.latestRunId,
    });
    return;
  }

  const addedOccurrences = facts.occurrences - baseline;
  if (addedOccurrences <= 0 || addedOccurrences < binding.policies.newOccurrencesMin) return;

  // At most one note per window, enforced by the window in the dedupe key.
  const dedupeKey = occurrencesCommentKey(
    facts.clusterId,
    noteWindow(binding.policies.newOccurrencesEvery, new Date()),
  );
  if (await findActionByKey(db, dedupeKey)) return;

  const news = await clusterNewsSince(db, facts.clusterId, meta.lastCommentedRunId ?? 0);
  const document = buildStillFailingComment(locale, {
    addedOccurrences,
    runs: news.runs,
    latestRun: facts.latestRunId,
    latestBranch: run.branch,
    latestEnvironment: run.environment,
    newTests: news.tests,
    newBranches: news.branches,
    newEnvironments: news.environments,
    clusterUrl,
  });
  await enqueueAndKick(db, {
    connectionId: link.connectionId!,
    projectId: facts.projectId,
    kind: 'comment',
    entityType: 'failure_cluster',
    entityId: facts.clusterId,
    dedupeKey,
    payload: { issueKey: link.key!, document } satisfies CommentActionPayload,
  });
  await mergeEntityLinkMetadata(db, link.id, {
    lastCommentedOccurrences: facts.occurrences,
    lastCommentedRunId: facts.latestRunId,
  });
}

/**
 * Queue a rebuild of the title and description of the issue Piwi filed for a
 * cluster, when the binding keeps descriptions current and the link holds what
 * Piwi wrote: the body in the language and with the toggles it was filed with,
 * its share link reused. The title is rebuilt only for an issue a rule filed; a
 * person chose the title of one they filed. The update itself checks that
 * nobody edited the issue in the tracker.
 */
export async function enqueueDescriptionUpdate(
  db: DbClient,
  facts: { clusterId: number; projectId: number; reason: string },
  known?: PolicyContext | null,
): Promise<void> {
  const ctx = known ?? (await policyContext(db, facts.clusterId, facts.projectId));
  if (!ctx || !ctx.binding.policies.updateDescription) return;
  const { link, binding } = ctx;
  const meta = (link.metadata as FiledIssueMeta | null) ?? {};
  if (!meta.written || meta.descriptionEdited) return;
  const dedupeKey = updateIssueKey(facts.clusterId, facts.reason);
  if (await findActionByKey(db, dedupeKey)) return;

  const built = await buildClusterIssue(db, facts.clusterId, {
    ...(meta.include ?? binding.include),
    locale: meta.locale ?? ctx.locale,
    siteUrl: siteBase(),
    shareUrl: meta.shareUrl ?? null,
    automatic: meta.automatic ?? null,
  });
  if (!built) return;
  await enqueueAndKick(db, {
    connectionId: link.connectionId!,
    projectId: facts.projectId,
    kind: 'update-issue',
    entityType: 'failure_cluster',
    entityId: facts.clusterId,
    dedupeKey,
    payload: {
      issueKey: link.key!,
      linkId: link.id,
      title: meta.automatic ? built.title : null,
      document: built.document,
    } satisfies UpdateIssueActionPayload,
  });
}

/** The daily description updates a run triggers, for the tracked clusters that failed in it. */
export async function enqueueRunDescriptionUpdates(
  db: DbClient,
  facts: { projectId: number; runId: number; clusterIds: number[] },
): Promise<void> {
  if (facts.clusterIds.length === 0) return;
  const binding = await readProjectIntegration(db, facts.projectId);
  if (!binding.policies.updateDescription) return;
  if (!(await scopedRun(db, facts.runId, binding))) return;
  const reason = dailyUpdateReason(new Date());
  for (const clusterId of facts.clusterIds) {
    await enqueueDescriptionUpdate(db, { clusterId, projectId: facts.projectId, reason }).catch((e) =>
      console.error('[integrations] description update failed', e),
    );
  }
}

/**
 * When a cluster's diagnosis completes: comment with it, and rebuild the
 * description of the issue Piwi filed, as the binding asks. Both need the
 * binding to carry diagnoses in tickets. A diagnosis of one failure in the
 * cluster is about that failure, so only the cluster's own diagnosis counts.
 */
export async function enqueueDiagnosisPolicies(db: DbClient, event: DiagnosisCompletedPayload): Promise<void> {
  if (event.executionId != null) return;
  const ctx = await policyContext(db, event.clusterId, event.projectId);
  if (!ctx || !ctx.binding.include.includeDiagnosis) return;
  const { link, binding, locale, clusterUrl } = ctx;
  const completedAt = event.completedAt ?? Date.now();

  if (binding.policies.commentOnDiagnosis && (event.summary || event.rootCause)) {
    const document = buildDiagnosisComment(locale, {
      summary: event.summary ?? null,
      rootCause: event.rootCause ?? null,
      category: event.category ?? null,
      confidence: event.confidence ?? null,
      clusterUrl,
    });
    await enqueueAndKick(db, {
      connectionId: link.connectionId!,
      projectId: event.projectId,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: event.clusterId,
      dedupeKey: diagnosisCommentKey(event.clusterId, completedAt),
      payload: { issueKey: link.key!, document } satisfies CommentActionPayload,
    });
  }
  await enqueueDescriptionUpdate(
    db,
    { clusterId: event.clusterId, projectId: event.projectId, reason: `diagnosis:${completedAt}` },
    ctx,
  );
}

/**
 * Comment on both issues when one cluster is merged into another — the survivor
 * absorbs the victim, the victim points at the survivor. The survivor inheriting
 * the victim's links is the merge handler's job; this only writes the notes.
 */
export async function enqueueMergePolicies(
  db: DbClient,
  facts: { survivorId: number; victimId: number; projectId: number },
): Promise<void> {
  const binding = await readProjectIntegration(db, facts.projectId);
  if (!binding.policies.commentOnMerge || binding.connectionId == null) return;

  const survivorLink = await getClusterTrackerLink(db, facts.survivorId);
  const victimLink = await getClusterTrackerLink(db, facts.victimId);
  const connection = await getConnectionRow(db, binding.connectionId);
  const locale = bindingLocale(binding, connection?.config ?? null);
  const base = siteBase();

  if (writableLink(victimLink, binding) && survivorLink?.key) {
    const document = buildMergeComment(locale, {
      direction: 'into',
      otherKey: survivorLink.key,
      clusterUrl: base ? `${base}/failure-clusters/${facts.survivorId}` : null,
    });
    await enqueueAndKick(db, {
      connectionId: victimLink.connectionId,
      projectId: facts.projectId,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: facts.victimId,
      dedupeKey: mergeCommentKey(facts.victimId, facts.survivorId),
      payload: { issueKey: victimLink.key, document } satisfies CommentActionPayload,
    });
  }

  if (writableLink(survivorLink, binding) && victimLink?.key) {
    const document = buildMergeComment(locale, {
      direction: 'absorbed',
      otherKey: victimLink.key,
      clusterUrl: base ? `${base}/failure-clusters/${facts.survivorId}` : null,
    });
    await enqueueAndKick(db, {
      connectionId: survivorLink.connectionId,
      projectId: facts.projectId,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: facts.survivorId,
      dedupeKey: mergeCommentKey(facts.survivorId, facts.victimId),
      payload: { issueKey: survivorLink.key, document } satisfies CommentActionPayload,
    });
  }
}

/**
 * When a bug report looks fixed (its `test.fail()` test passed), comment on its
 * ticket and move it along, as a cluster's verified fix does: the binding's
 * `commentOnFix` and `transitionOnFix`, for a run in the binding's scope. The
 * ticket is the report's newest one on the connection the project is bound to.
 */
export async function enqueueBugLooksFixedPolicies(
  db: DbClient,
  facts: { bugReportId: number; projectId: number; runId: number },
): Promise<void> {
  const binding = await readProjectIntegration(db, facts.projectId);
  const transition = binding.policies.transitionOnFix && binding.policies.fixTransitionId;
  if (!binding.policies.commentOnFix && !transition) return;
  if (binding.connectionId == null) return;
  const [link] = await db
    .select()
    .from(entityLinks)
    .where(
      and(
        eq(entityLinks.bugReportId, facts.bugReportId),
        eq(entityLinks.connectionId, binding.connectionId),
        isNotNull(entityLinks.key),
      ),
    )
    .orderBy(desc(entityLinks.id))
    .limit(1);
  if (!writableLink(link, binding)) return;
  if (!(await scopedRun(db, facts.runId, binding))) return;
  const connection = await getConnectionRow(db, link.connectionId);
  const locale = bindingLocale(binding, connection?.config ?? null);

  if (binding.policies.commentOnFix) {
    const document = doc()
      .paragraph(t(locale, 'comment.bugLooksFixed', { run: facts.runId }))
      .build();
    await enqueueAndKick(db, {
      connectionId: link.connectionId,
      projectId: facts.projectId,
      kind: 'comment',
      entityType: 'bug_report',
      entityId: facts.bugReportId,
      dedupeKey: bugLooksFixedCommentKey(facts.bugReportId, facts.runId),
      payload: { issueKey: link.key, document } satisfies CommentActionPayload,
    });
  }
  if (transition) {
    await enqueueAndKick(db, {
      connectionId: link.connectionId,
      projectId: facts.projectId,
      kind: 'transition',
      entityType: 'bug_report',
      entityId: facts.bugReportId,
      dedupeKey: bugFixTransitionKey(facts.bugReportId, facts.runId),
      payload: {
        issueKey: link.key,
        transitionId: binding.policies.fixTransitionId,
        statusName: binding.policies.fixTransitionId,
        fields: binding.policies.fixTransitionFields,
      } satisfies TransitionActionPayload,
    });
  }
}
