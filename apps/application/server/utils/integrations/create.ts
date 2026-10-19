/**
 * Turn a create-issue request (from the modal's POST or the MCP tool) into a
 * queued action and one immediate attempt, so a click resolves in a single
 * round-trip when Jira is up. The body and labels are rebuilt server-side from
 * the entity — the client's edits pick the fields, never the evidence — and the
 * dedupe key makes a second click a no-op once an issue exists. The key is the
 * cluster's for a cluster and every one of its executions, so filing from the
 * cluster page and from an execution never files twice; an issue whose link was
 * removed, or that is Done, no longer counts, and the next create files a new one.
 *
 * The fields the tracker requires are checked first: the project's field
 * defaults and the request's own values fill them, and a create that would still
 * leave one empty is refused with the field names before the tracker is called
 * (an automatic create, with no person to tell, records the refusal as a failed
 * action). A request that failed before is replaced by the new one rather than
 * replayed.
 */
import { eq } from 'drizzle-orm';
import { failureClusters, testRunsCases } from '../../database/schema';
import type { DbClient } from '../../database';
import { DEFAULT_ISSUE_OPTS, issueLabels } from '#shared/integrations/build-issue';
import type { AutomaticFiling } from '#shared/integrations/automation';
import { DEFAULT_LOCALE, type IssueLocale } from '#shared/integrations/messages';
import type { IssueIncludeOptions } from '#shared/integrations/types';
import { buildBugReportIssue, buildClusterIssue, buildExecutionIssue } from './documents';
import { clusterShareTokenMinter } from './share-url';
import {
  enqueueOrReplaceAction,
  findActionByKey,
  recordRefusedAction,
  retireAction,
  runActionNow,
  type CreateIssueActionPayload,
  type CreateIssueResult,
} from './actions';
import { forgetCreateFields, getCreateFields } from './fields';
import { filedIssueStillTracks } from './entity-links';
import {
  fieldPayload,
  hasFieldValue,
  missingFieldsMessage,
  missingRequiredFields,
  type FieldValues,
  type TrackerField,
} from '#shared/integrations/fields';
import type { IssueFieldProblem } from '#shared/integrations/types';
import { readProjectIntegration } from './binding';
import { pickOwnerRoute, type ResolvedProjectIntegration } from '#shared/integrations/binding';
import { createIssueKey } from '#shared/integrations/action-keys';
import { resolveClusterOwner } from './owner';
import type { DraftEntityType } from './draft';

export interface CreateIssueParams {
  entityType: DraftEntityType;
  entityId: number;
  connectionId: number;
  projectKey: string;
  issueType: string;
  title?: string;
  labels?: string[];
  assignee?: string | null;
  locale?: IssueLocale;
  include?: Partial<IssueIncludeOptions>;
  /** Values for tracker fields, over the project's field defaults. */
  fields?: FieldValues;
  requestedBy?: number | null;
  siteUrl?: string | null;
  /** Set when a rule files the issue: the body opens with what it counted. */
  automatic?: AutomaticFiling | null;
}

export interface CreateIssueOutcome {
  /** The queued action; null when the create was refused before anything was queued. */
  actionId: number | null;
  status: 'done' | 'pending' | 'failed' | 'skipped';
  key?: string;
  url?: string;
  /** The issue was filed earlier for the same cluster (or bug report); nothing new was filed. */
  alreadyFiled?: boolean;
  error?: string;
  /** Required fields the create would leave empty — nothing was sent to the tracker. */
  missingFields?: IssueFieldProblem[];
  /** The tracker's own per-field refusals, with the fields' names. */
  fieldErrors?: IssueFieldProblem[];
  projectId: number;
}

/** The request's values over the project defaults, dropping any left empty. */
function mergeFieldValues(defaults: FieldValues, requested: FieldValues | undefined): FieldValues {
  const merged: FieldValues = { ...defaults };
  for (const [id, entry] of Object.entries(requested ?? {})) {
    if (hasFieldValue(entry?.value)) merged[id] = entry;
    else delete merged[id];
  }
  return merged;
}

/** The tracker's per-field refusals, named from the create screen when it is known. */
function namedFieldErrors(errors: Record<string, string>, screen: TrackerField[] | null): IssueFieldProblem[] {
  const names = new Map((screen ?? []).map((f) => [f.id, f.name]));
  return Object.entries(errors).map(([id, message]) => ({ id, name: names.get(id) ?? id, message }));
}

/** The create screen's fields, or null when the tracker cannot be asked; a create never waits on it failing. */
async function screenFields(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  issueType: string,
): Promise<TrackerField[] | null> {
  try {
    return await getCreateFields(db, connectionId, projectKey, issueType);
  } catch {
    return null;
  }
}

/** The cluster an entity belongs to, plus the project it lives in. */
async function resolveTarget(
  db: DbClient,
  entityType: DraftEntityType,
  entityId: number,
): Promise<{ clusterId: number; projectId: number } | null> {
  if (entityType === 'bug_report') return null;
  const clusterId =
    entityType === 'failure_cluster'
      ? entityId
      : ((
          await db
            .select({ clusterId: testRunsCases.failureClusterId })
            .from(testRunsCases)
            .where(eq(testRunsCases.id, entityId))
        )[0]?.clusterId ?? null);
  if (clusterId == null) return null;
  const [cluster] = await db
    .select({ projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;
  return { clusterId, projectId: cluster.projectId };
}

export async function createIssue(db: DbClient, params: CreateIssueParams): Promise<CreateIssueOutcome | null> {
  if (params.entityType === 'bug_report') return createBugReportIssue(db, params);
  const target = await resolveTarget(db, params.entityType, params.entityId);
  if (!target) return null;

  const include = { ...DEFAULT_ISSUE_OPTS, ...(params.include ?? {}) };
  const locale = params.locale ?? DEFAULT_LOCALE;
  // A filing asked again before it was done keeps the share link of its first attempt.
  const prior = await findActionByKey(db, createIssueKey('failure_cluster', target.clusterId, params.connectionId));
  const priorShareUrl =
    prior && prior.status !== 'done' ? (prior.payload as CreateIssueActionPayload | null)?.shareUrl : null;
  const opts = {
    ...include,
    locale,
    siteUrl: params.siteUrl,
    mintShareToken: clusterShareTokenMinter(db, params.requestedBy ?? null),
    ...(priorShareUrl ? { shareUrl: priorShareUrl } : {}),
    automatic: params.automatic ?? null,
  };
  const built =
    params.entityType === 'failure_cluster'
      ? await buildClusterIssue(db, params.entityId, opts)
      : await buildExecutionIssue(db, params.entityId, opts);
  if (!built) return null;

  const [cluster] = await db
    .select({ fingerprint: failureClusters.fingerprint })
    .from(failureClusters)
    .where(eq(failureClusters.id, target.clusterId));
  const standardLabels = issueLabels(target.clusterId, cluster?.fingerprint ?? '');

  // The owner route contributes a Jira component the modal never asks for, plus
  // any labels the route adds; project key and assignee already ride in on the
  // prefilled request, so the route only fills what the request could not carry.
  const binding = await readProjectIntegration(db, target.projectId);
  const owner = await resolveClusterOwner(db, target.clusterId).catch(() => null);
  const route = pickOwnerRoute(binding.ownerRoutes, owner);

  const labels = [...new Set([...(params.labels ?? built.labels), ...(route?.labels ?? []), ...standardLabels])];

  return fileIssue(db, params, binding, {
    projectId: target.projectId,
    title: built.title,
    document: built.document,
    labels,
    componentId: route?.componentId ?? null,
    // The created known-issue link always attaches to the cluster, so the chip
    // shows on the cluster page and the inbox regardless of the entity clicked,
    // and the filing is deduplicated on the cluster for the same reason.
    linkEntityType: 'failure_cluster',
    linkEntityId: target.clusterId,
    include,
    shareUrl: built.shareUrl,
  });
}

/**
 * File an issue for a bug report: the report's own document and labels, no
 * cluster, the created link on the report. Its screenshots follow as `attach`
 * actions once the issue exists (see `applyCreateIssue`).
 */
async function createBugReportIssue(db: DbClient, params: CreateIssueParams): Promise<CreateIssueOutcome | null> {
  const locale = params.locale ?? DEFAULT_LOCALE;
  const built = await buildBugReportIssue(db, params.entityId, { locale, siteUrl: params.siteUrl });
  if (!built) return null;
  const binding = await readProjectIntegration(db, built.projectId);
  const labels = [...new Set([...(params.labels ?? binding.labels), ...built.labels])];

  return fileIssue(db, params, binding, {
    projectId: built.projectId,
    title: built.title,
    document: built.document,
    labels,
    componentId: null,
    linkEntityType: 'bug_report',
    linkEntityId: params.entityId,
    include: null,
    shareUrl: null,
  });
}

/** What an issue is filed with, once the entity it is filed for is resolved. */
interface IssueToFile {
  projectId: number;
  /** The title used when the request names none. */
  title: string;
  document: CreateIssueActionPayload['document'];
  labels: string[];
  componentId: string | null;
  /** The entity the issue is filed for and linked to: the cluster, or the bug report. */
  linkEntityType: CreateIssueActionPayload['linkEntityType'];
  linkEntityId: number;
  include: CreateIssueActionPayload['include'];
  shareUrl: string | null;
}

/**
 * File the issue: the one already filed for the cluster (or bug report) while
 * it still tracks it, else a refusal naming the required fields still empty
 * (recorded on the cluster as a failed action when a rule asked), else a
 * `create-issue` action enqueued and run now, its outcome mapped for the
 * caller. A filing whose link a person removed, or whose issue is Done, is
 * retired first, so the request files a new issue instead of answering with it.
 */
async function fileIssue(
  db: DbClient,
  params: CreateIssueParams,
  binding: ResolvedProjectIntegration,
  issue: IssueToFile,
): Promise<CreateIssueOutcome> {
  // An issue already filed for this cluster is the answer, whatever the request
  // says, while it still tracks the cluster.
  const dedupeKey = createIssueKey(issue.linkEntityType, issue.linkEntityId, params.connectionId);
  // A filing recorded against the execution it was asked from still answers for it.
  const filed =
    (await findActionByKey(db, dedupeKey)) ??
    (params.entityType === 'test_runs_case'
      ? await findActionByKey(db, createIssueKey('test_runs_case', params.entityId, params.connectionId))
      : null);
  // A skipped filing (no usable connection, or a rule that left the failure to
  // a person) never blocks a new one.
  if (filed?.status === 'skipped') await retireAction(db, filed.id);
  if (filed?.status === 'done') {
    const result = filed.result as CreateIssueResult | null;
    if (await filedIssueStillTracks(db, issue.linkEntityType, issue.linkEntityId, result)) {
      return {
        actionId: filed.id,
        status: 'done',
        key: result?.key,
        url: result?.url,
        alreadyFiled: true,
        projectId: issue.projectId,
      };
    }
    await retireAction(db, filed.id);
  }

  const values = mergeFieldValues(binding.fieldDefaults, params.fields);
  const screen = await screenFields(db, params.connectionId, params.projectKey, params.issueType);
  const payload: CreateIssueActionPayload = {
    projectKey: params.projectKey,
    issueType: params.issueType,
    title: params.title?.trim() || issue.title,
    document: issue.document,
    labels: issue.labels,
    assigneeId: params.assignee ?? null,
    componentId: issue.componentId,
    fields: fieldPayload(values, screen),
    locale: params.locale ?? DEFAULT_LOCALE,
    linkEntityType: issue.linkEntityType,
    linkEntityId: issue.linkEntityId,
    automatic: params.automatic ?? null,
    include: issue.include,
    shareUrl: issue.shareUrl,
  };

  // Required fields: refuse before calling the tracker when the defaults and
  // the request still leave one empty, naming them.
  if (screen) {
    const missing = missingRequiredFields(screen, values, {
      assignee: !!params.assignee,
      components: !!issue.componentId,
    });
    if (missing.length) {
      const error = missingFieldsMessage(missing);
      const refused = params.automatic
        ? await recordRefusedAction(db, {
            connectionId: params.connectionId,
            projectId: issue.projectId,
            kind: 'create-issue',
            entityType: issue.linkEntityType,
            entityId: issue.linkEntityId,
            dedupeKey,
            payload,
            requestedBy: null,
            error,
          })
        : null;
      return {
        actionId: refused?.id ?? null,
        status: 'failed',
        error,
        missingFields: missing.map((f) => ({ id: f.id, name: f.name })),
        projectId: issue.projectId,
      };
    }
  }

  const action = await enqueueOrReplaceAction(db, {
    connectionId: params.connectionId,
    projectId: issue.projectId,
    kind: 'create-issue',
    entityType: issue.linkEntityType,
    entityId: issue.linkEntityId,
    dedupeKey,
    payload,
    requestedBy: params.requestedBy ?? null,
  });

  const outcome = await runActionNow(db, action.id);
  const base: CreateIssueOutcome = { actionId: action.id, status: 'pending', projectId: issue.projectId };
  if (!outcome) return base;
  if (outcome.status === 'done') {
    const result = outcome.result as CreateIssueResult | undefined;
    return { ...base, status: 'done', key: result?.key, url: result?.url };
  }
  // The tracker did not answer and the outbox tries again: the filing is queued.
  if (outcome.status === 'failed' && outcome.retrying && !outcome.fieldErrors) {
    return { ...base, status: 'pending', error: outcome.error };
  }
  if (outcome.status === 'failed') {
    // A refusal naming fields means the cached screen may be stale.
    if (outcome.fieldErrors) forgetCreateFields(params.connectionId, params.projectKey, params.issueType);
    return {
      ...base,
      status: 'failed',
      error: outcome.error,
      ...(outcome.fieldErrors ? { fieldErrors: namedFieldErrors(outcome.fieldErrors, screen) } : {}),
    };
  }
  if (outcome.status === 'skipped') return { ...base, status: 'skipped', error: outcome.reason };
  return base;
}
