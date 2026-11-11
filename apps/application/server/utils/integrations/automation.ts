/**
 * Automatic creation: after a run, file an issue for each cluster that failed
 * in it and that the project's rules now qualify, with no person clicking.
 * It runs once the run's fix verification is done, so a regression's reopen
 * transition is already queued when the rules read whether an issue tracks
 * the cluster.
 *
 * The rules and guards live in `#shared/integrations/automation` and read the
 * facts `gatherAutoCreateFacts` collects. On top of them, this holds to the
 * daily cap, leaves alone a failure an open issue in the tracker already
 * carries the labels of (a person links that one; the activity list and the
 * failure pages' Issue line say so, and an issue the cluster already links is
 * left to the sync to read back), and files through the same `createIssue`
 * path a click takes, so the per-cluster dedupe (a Done issue or a removed link
 * no longer answers), owner routes, required fields and the outbox apply
 * unchanged. The issue opens with what the rule counted.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { entityLinks, projects, testRuns, testRunsCases } from '../../database/schema';
import type { DbClient } from '../../database';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';
import { automaticFiling, evaluateAutoCreate } from '#shared/integrations/automation';
import { issueLabels } from '#shared/integrations/build-issue';
import { createIssueKey, syncResultsDedupeKey } from '#shared/integrations/action-keys';
import { pickOwnerRoute } from '#shared/integrations/binding';
import {
  countAutomaticCreates,
  gatherAutoCreateFacts,
  previewAutoCreate,
  type AutoCreateFactsOptions,
  type AutoCreatePreview,
} from '#shared/handlers/tracker-automation';
import { missingRequiredFields } from '#shared/integrations/fields';
import type { ResolvedProjectIntegration } from '#shared/integrations/binding';
import type { IssueTracker, TrackerIssue } from './types';
import { createIssue } from './create';
import {
  enqueueAction,
  findActionByKey,
  recordRefusedAction,
  retireAction,
  runActionNow,
  type CreateIssueResult,
} from './actions';
import type { IntegrationAction } from '../../database/schema';
import { filedIssueStillTracks } from './entity-links';
import { bindingLocale, readProjectIntegration } from './binding';
import { createTracker, getConnectionRow } from './connections';
import { getCreateFields } from './fields';
import { loadTrackerRun, runDrivesWrites } from './tracker-run';
import { readTestManagementBinding } from './test-management/binding';
import { prepareRunSync } from './test-management/sync';
import { resolveOwners } from '../scm/ownership';
import { resolveDefaultBranch } from '../scm/default-branch';

/** An open issue already carrying the cluster's or its fingerprint's label, else null. */
async function openLabeledIssue(
  tracker: IssueTracker,
  clusterId: number,
  fingerprint: string,
): Promise<TrackerIssue | null> {
  const [, clusterLabel, fingerprintLabel] = issueLabels(clusterId, fingerprint);
  for (const label of [clusterLabel!, fingerprintLabel!]) {
    const found = await tracker.search({ labels: [label], limit: 5 });
    const open = found.find((issue) => issue.statusCategory !== 'done');
    if (open) return open;
  }
  return null;
}

/** Whether the cluster already links an issue with this key. */
async function clusterLinksKey(db: DbClient, clusterId: number, key: string): Promise<boolean> {
  const [row] = await db
    .select({ id: entityLinks.id })
    .from(entityLinks)
    .where(and(eq(entityLinks.failureClusterId, clusterId), eq(entityLinks.key, key)))
    .limit(1);
  return !!row;
}

/**
 * Retire the cluster's filing once the issue it filed no longer tracks the
 * cluster (Done, or its link removed), as a new create would: a skip recorded
 * under the filing's key then gets its own row instead of leaving the old
 * filing in place.
 */
async function retireUntrackedFiling(db: DbClient, dedupeKey: string, clusterId: number): Promise<void> {
  const filed = await findActionByKey(db, dedupeKey);
  if (filed?.status !== 'done') return;
  const result = filed.result as CreateIssueResult | null;
  if (!(await filedIssueStillTracks(db, 'failure_cluster', clusterId, result))) await retireAction(db, filed.id);
}

/** CODEOWNERS for a file, the owner of a cluster nobody was assigned and whose tests declare none. */
function codeownersFallback(db: DbClient, projectId: number): NonNullable<AutoCreateFactsOptions['ownerFallback']> {
  return async (filePath) => {
    const test = { filePath, owner: null };
    const resolved = await resolveOwners(db, projectId, [test]);
    return resolved.get(test)?.owner ?? null;
  };
}

/** A binding that can file issues: a connection, a tracker project and an issue type. */
function canFile(binding: ResolvedProjectIntegration): binding is ResolvedProjectIntegration & {
  connectionId: number;
  projectKey: string;
  issueType: string;
} {
  return binding.connectionId != null && !!binding.projectKey && !!binding.issueType;
}

/**
 * File the issues a finished run qualifies under the project's rules. Returns
 * how many it filed. A run the `tracker` use leaves out, or a project whose
 * binding has automatic creation off or cannot file, files nothing.
 */
export async function runTrackerAutomation(db: DbClient, runId: number): Promise<number> {
  const [row] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (!row) return 0;
  const binding = await readProjectIntegration(db, row.projectId);
  if (!binding.autoCreate.enabled || !canFile(binding)) return 0;
  const run = await loadTrackerRun(db, runId);
  if (!run?.eligible) return 0;
  const connection = await getConnectionRow(db, binding.connectionId);
  if (!connection) return 0;

  const failing = await db
    .selectDistinct({ clusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        isNotNull(testRunsCases.failureClusterId),
        inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]),
      ),
    );
  const clusterIds = failing.map((row) => row.clusterId).filter((id): id is number => id != null);
  if (clusterIds.length === 0) return 0;

  const now = new Date();
  const facts = await gatherAutoCreateFacts(db, clusterIds, {
    defaultBranch: run.defaultBranch,
    now,
    ownerFallback: codeownersFallback(db, run.projectId),
  });
  let capacity = binding.autoCreate.dailyCap - (await countAutomaticCreates(db, run.projectId, now));
  const locale = bindingLocale(binding, connection.config);
  let tracker: IssueTracker | null | undefined;
  let filed = 0;

  for (const clusterId of clusterIds) {
    const cluster = facts.get(clusterId);
    if (!cluster) continue;
    const decision = evaluateAutoCreate(binding.autoCreate, binding.ownerRoutes, cluster, {
      now: now.getTime(),
      currentRunId: runId,
    });
    if (decision.verdict !== 'file') continue;
    if (capacity <= 0) {
      console.warn(`[integrations] automatic creation for project ${run.projectId} reached its daily cap`);
      break;
    }

    tracker ??= await createTracker(db, binding.connectionId).catch(() => null);
    if (!tracker) return filed;
    // When the tracker cannot be searched, nothing is filed: the next failure tries again.
    const existing = await openLabeledIssue(tracker, clusterId, cluster.fingerprint).catch(() => undefined);
    if (existing === undefined) continue;
    if (existing) {
      // One of the cluster's own issues, open in the tracker though the last
      // sync read it Done: it tracks the cluster, and the next sync says so.
      if (await clusterLinksKey(db, clusterId, existing.key)) continue;
      const dedupeKey = createIssueKey('failure_cluster', clusterId, binding.connectionId);
      await retireUntrackedFiling(db, dedupeKey, clusterId);
      await recordRefusedAction(db, {
        connectionId: binding.connectionId,
        projectId: run.projectId,
        kind: 'create-issue',
        entityType: 'failure_cluster',
        entityId: clusterId,
        dedupeKey,
        payload: { automatic: null, existingKey: existing.key },
        requestedBy: null,
        status: 'skipped',
        error: `${existing.key} already carries this failure's labels: link it from the cluster page`,
      });
      continue;
    }

    const route = pickOwnerRoute(binding.ownerRoutes, cluster.owner);
    const rule = binding.autoCreate.rules[decision.progress.ruleIndex];
    const outcome = await createIssue(db, {
      entityType: 'failure_cluster',
      entityId: clusterId,
      connectionId: binding.connectionId,
      projectKey: route?.projectKey ?? binding.projectKey,
      issueType: binding.issueType,
      labels: [...binding.labels, ...(rule?.labels ?? [])],
      assignee: route?.assigneeAccountId ?? binding.defaultAssignee,
      locale,
      include: binding.include,
      requestedBy: null,
      siteUrl: process.env.PIWI_SITE_URL ?? null,
      automatic: automaticFiling(decision.progress),
    }).catch((e) => {
      console.error(`[integrations] automatic creation for cluster ${clusterId} failed`, e);
      return null;
    });
    // An issue already filed for the cluster is not a new one.
    if ((outcome?.status === 'done' && !outcome.alreadyFiled) || outcome?.status === 'pending') {
      capacity--;
      filed++;
    }
  }
  return filed;
}

/**
 * Queue the end-of-run sync of a finished run to the project's test management tool and send it once. A project whose
 * binding is off, a run the `test-management` use or the binding's run scope leaves out, and a sync already queued for
 * the run queue nothing. A run whose results cannot be sent (the catalog was never read, no test carries a key the
 * catalog holds) is recorded as skipped with the reason, so the activity list says why. Returns the action, or null
 * when nothing was queued or recorded.
 */
export async function runTestManagementSync(db: DbClient, runId: number): Promise<IntegrationAction | null> {
  const [row] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (!row) return null;
  const binding = await readTestManagementBinding(db, row.projectId);
  const { connectionId, providerProjectKey } = binding;
  if (!binding.enabled || connectionId === null || providerProjectKey === null) return null;
  const run = await loadTrackerRun(db, runId, 'test-management');
  if (!runDrivesWrites(run, binding.runScope)) return null;

  const dedupeKey = syncResultsDedupeKey(runId, connectionId);
  if (await findActionByKey(db, dedupeKey)) return null;
  const prepared = await prepareRunSync(db, run, { ...binding, connectionId, providerProjectKey });
  const input = {
    connectionId,
    projectId: run.projectId,
    kind: 'sync-results',
    entityType: 'test_run',
    entityId: runId,
    dedupeKey,
    payload: prepared.payload,
    requestedBy: null,
  };
  if (prepared.skip !== null) return recordRefusedAction(db, { ...input, status: 'skipped', error: prepared.skip });
  const action = await enqueueAction(db, input);
  await runActionNow(db, action.id);
  return action;
}

/**
 * The settings preview for a project, with an unsaved binding: the open,
 * untracked clusters as the rules see them, and the tracker fields an
 * automatic create would still leave empty.
 */
export async function previewProjectAutoCreate(
  db: DbClient,
  projectId: number,
  binding: ResolvedProjectIntegration,
): Promise<AutoCreatePreview> {
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId));
  const defaultBranch = project ? await resolveDefaultBranch(db, project).catch(() => null) : null;
  const preview = await previewAutoCreate(db, projectId, binding, {
    defaultBranch,
    ownerFallback: codeownersFallback(db, projectId),
  });
  if (!canFile(binding)) return preview;
  const screen = await getCreateFields(db, binding.connectionId, binding.projectKey, binding.issueType).catch(
    () => null,
  );
  const missing = screen
    ? missingRequiredFields(screen, binding.fieldDefaults, { assignee: !!binding.defaultAssignee, components: false })
    : [];
  return { ...preview, missingFields: missing.map((field) => field.name) };
}
