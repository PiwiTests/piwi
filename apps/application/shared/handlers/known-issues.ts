import { and, desc, eq, inArray, isNotNull, like } from 'drizzle-orm';
import { entityLinks, integrationActions, testRunsCases } from '../../server/database/schema';
import { isProviderOfKind } from '../integrations/registry';
import { toEpochMs } from '../relative-time';
import type { DrizzleDB } from './db';

/**
 * The tracker issue a failure cluster is known by, as the surfaces around an
 * execution show it: the execution page, a run's test rows, a test's recent
 * executions. An issue created from a failing test is attached to the test's
 * cluster, so every execution of that cluster carries it.
 */
export interface KnownIssueRef {
  key: string;
  url: string;
  provider: string;
  /** The issue's summary as last synced from the tracker. */
  title: string | null;
  /** The issue's status as last synced from the tracker, e.g. "In Progress". */
  status: string | null;
  /** The badge color token resolved from the status category. */
  statusColor: string | null;
  /** The tracker's status category as last synced (`new`, `indeterminate`, `done`). */
  statusCategory: string | null;
  /** The issue's assignee in the tracker, as last synced. */
  assignee: string | null;
  /** `created` when Piwi filed the issue, `annotation` or `tag` when the tests named it, else a link a person pinned. */
  origin: string | null;
  /** When the link was made: the filing, or the pin. */
  linkedAt: string | null;
}

/**
 * Whether a link is a tracker issue Piwi can write back through: it carries a
 * key and is a Jira link or sits on a connection. A test cycle a results sync
 * made sits on a connection too, and is not an issue. The newest such link on
 * a cluster is the cluster's known issue.
 */
export function isTrackerLink(link: { provider: string; key: string | null; connectionId: number | null }): boolean {
  if (!link.key || isProviderOfKind(link.provider, 'test-management')) return false;
  return link.provider === 'jira' || link.connectionId != null;
}

/** The `origin` values of links the tests declare (`piwi:issue`, a key tag): Piwi never writes through them. */
export const DECLARED_LINK_ORIGINS = ['annotation', 'tag'] as const;

/** Whether a link was declared by the tests (its `origin` is one of {@link DECLARED_LINK_ORIGINS}). */
export function isDeclaredLink(link: { origin?: string | null }): boolean {
  return link.origin === 'annotation' || link.origin === 'tag';
}

/**
 * Whether a cluster's known issue still tracks its failure, the rule a new
 * filing follows: an issue that is not Done does, and so does a Done one while
 * the regression policy's reopen transition is moving it out of Done
 * (`clusterReopenings`).
 */
export function knownIssueTracks(
  issue: Pick<KnownIssueRef, 'statusCategory'> | null | undefined,
  opts: { reopening: boolean },
): boolean {
  if (!issue) return false;
  return issue.statusCategory !== 'done' || opts.reopening;
}

/**
 * The clusters whose Done known issue the regression policy is moving out of
 * Done: a reopen transition on that issue waits on the tracker, or went
 * through after the link was last read back. Once the sync reads the issue
 * again its status says where it stands, so a transition that did not take
 * (unavailable in the workflow, or the issue closed again) holds a new filing
 * back until that read at most. One query for the transitions, one for the links.
 */
export async function clusterReopenings(db: DrizzleDB, knownIssues: Map<number, KnownIssueRef>): Promise<Set<number>> {
  const out = new Set<number>();
  const done = [...knownIssues].filter(([, issue]) => issue.statusCategory === 'done');
  if (done.length === 0) return out;
  const ids = done.map(([id]) => id);
  const [moves, links] = await Promise.all([
    db
      .select({
        clusterId: integrationActions.entityId,
        status: integrationActions.status,
        finishedAt: integrationActions.finishedAt,
        payload: integrationActions.payload,
      })
      .from(integrationActions)
      .where(
        and(
          eq(integrationActions.kind, 'transition'),
          eq(integrationActions.entityType, 'failure_cluster'),
          inArray(integrationActions.entityId, ids),
          like(integrationActions.dedupeKey, '%:reopen:%'),
          inArray(integrationActions.status, ['pending', 'processing', 'done']),
        ),
      ),
    db
      .select({ clusterId: entityLinks.failureClusterId, key: entityLinks.key, unfurledAt: entityLinks.unfurledAt })
      .from(entityLinks)
      .where(
        and(
          inArray(entityLinks.failureClusterId, ids),
          inArray(
            entityLinks.key,
            done.map(([, issue]) => issue.key),
          ),
        ),
      ),
  ]);
  // When each cluster's known issue was last read back from the tracker.
  const readBack = new Map<number, number>();
  for (const link of links) {
    if (link.clusterId == null || link.key !== knownIssues.get(link.clusterId)?.key) continue;
    const ms = toEpochMs(link.unfurledAt as Date | null);
    if (ms != null) readBack.set(link.clusterId, Math.max(readBack.get(link.clusterId) ?? 0, ms));
  }
  for (const move of moves) {
    const issue = knownIssues.get(move.clusterId);
    if (!issue || (move.payload as { issueKey?: unknown } | null)?.issueKey !== issue.key) continue;
    if (move.status !== 'done') {
      out.add(move.clusterId);
      continue;
    }
    const finished = toEpochMs(move.finishedAt as Date | null);
    const refreshed = readBack.get(move.clusterId);
    if (finished != null && refreshed != null && finished >= refreshed) out.add(move.clusterId);
  }
  return out;
}

/**
 * The known issue of each cluster that has one, keyed by cluster id, in one query: the cluster's newest tracker link
 * pinned or created, else its oldest link from the tests whose issue is not Done, else its oldest link from the tests.
 * With `declared` false, links from the tests are left out, as for an issue body Piwi writes.
 */
export async function clusterKnownIssues(
  db: DrizzleDB,
  clusterIds: number[],
  opts: { declared?: boolean } = {},
): Promise<Map<number, KnownIssueRef>> {
  const out = new Map<number, KnownIssueRef>();
  const ids = [...new Set(clusterIds.filter((id): id is number => typeof id === 'number'))];
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      clusterId: entityLinks.failureClusterId,
      key: entityLinks.key,
      url: entityLinks.url,
      provider: entityLinks.provider,
      connectionId: entityLinks.connectionId,
      title: entityLinks.title,
      statusText: entityLinks.statusText,
      statusColor: entityLinks.statusColor,
      metadata: entityLinks.metadata,
      origin: entityLinks.origin,
      createdAt: entityLinks.createdAt,
    })
    .from(entityLinks)
    .where(and(inArray(entityLinks.failureClusterId, ids), isNotNull(entityLinks.key)))
    .orderBy(desc(entityLinks.id));
  const declared = new Map<number, (typeof rows)[number]>();
  const toRef = (row: (typeof rows)[number]): KnownIssueRef => {
    const meta = (row.metadata ?? null) as { statusCategory?: string | null; assignee?: string | null } | null;
    return {
      key: row.key!,
      url: row.url,
      provider: row.provider,
      title: row.title ?? null,
      status: row.statusText ?? null,
      statusColor: row.statusColor ?? null,
      statusCategory: meta?.statusCategory ?? null,
      assignee: meta?.assignee ?? null,
      origin: row.origin ?? null,
      linkedAt: row.createdAt ? new Date(row.createdAt as unknown as string | number | Date).toISOString() : null,
    };
  };
  const isDone = (row: (typeof rows)[number]) =>
    (row.metadata as { statusCategory?: string | null } | null)?.statusCategory === 'done';
  for (const row of rows) {
    if (row.clusterId == null || out.has(row.clusterId) || !isTrackerLink(row)) continue;
    if (!isDeclaredLink(row)) {
      out.set(row.clusterId, toRef(row));
      continue;
    }
    if (opts.declared === false) continue;
    // Rows come newest first, so the last one kept is the oldest, an open issue before a Done one.
    const kept = declared.get(row.clusterId);
    if (!kept || !isDone(row) || isDone(kept)) declared.set(row.clusterId, row);
  }
  for (const [clusterId, row] of declared) if (!out.has(clusterId)) out.set(clusterId, toRef(row));
  return out;
}

/**
 * An issue filing that ended for good, because the tracker refused it, every
 * retry failed, or Piwi could not send it: no retry is coming, and filing again
 * replaces it.
 */
export interface IssueFilingFailure {
  /** Why, as the tracker answered or as Piwi recorded it. */
  error: string | null;
  /** When its last attempt ended. */
  at: string | null;
  /** Set when a rule left the filing to a person: the open issue it found carrying the failure's labels. */
  existingKey?: string;
}

/** Where the issue filings of some clusters stand, by cluster id. */
export interface ClusterIssueFilings {
  /** A filing waits on the tracker: the outbox retries it, and filing again re-runs it at once. */
  queued: Set<number>;
  /** The newest filing failed for good, with its reason. */
  failures: Map<number, IssueFilingFailure>;
}

/**
 * Where each cluster's issue filings stand, in two queries: the `create-issue`
 * actions recorded for the cluster and for its executions, since a filing asked
 * from an execution counts for its cluster. A cluster's filing is queued while
 * one of them waits on the tracker, and failed while the newest of them failed
 * or was skipped (a rule that left the filing to a person names the open issue
 * it found). The failure pages show both where they name the ticket.
 */
export async function clusterIssueFilings(db: DrizzleDB, clusterIds: number[]): Promise<ClusterIssueFilings> {
  const out: ClusterIssueFilings = { queued: new Set(), failures: new Map() };
  const ids = [...new Set(clusterIds.filter((id): id is number => typeof id === 'number'))];
  if (ids.length === 0) return out;
  const columns = {
    id: integrationActions.id,
    status: integrationActions.status,
    error: integrationActions.error,
    createdAt: integrationActions.createdAt,
    finishedAt: integrationActions.finishedAt,
  };
  const createIssue = eq(integrationActions.kind, 'create-issue');
  const [onCluster, onExecution] = await Promise.all([
    db
      .select({ ...columns, clusterId: integrationActions.entityId })
      .from(integrationActions)
      .where(
        and(
          createIssue,
          eq(integrationActions.entityType, 'failure_cluster'),
          inArray(integrationActions.entityId, ids),
        ),
      ),
    db
      .select({ ...columns, clusterId: testRunsCases.failureClusterId })
      .from(integrationActions)
      .innerJoin(testRunsCases, eq(testRunsCases.id, integrationActions.entityId))
      .where(
        and(
          createIssue,
          eq(integrationActions.entityType, 'test_runs_case'),
          inArray(testRunsCases.failureClusterId, ids),
        ),
      ),
  ]);
  const newest = new Map<number, (typeof onExecution)[number]>();
  for (const row of [...onCluster, ...onExecution]) {
    if (row.clusterId == null) continue;
    if (row.status === 'pending' || row.status === 'processing') out.queued.add(row.clusterId);
    const seen = newest.get(row.clusterId);
    if (!seen || row.id > seen.id) newest.set(row.clusterId, row);
  }
  const skippedIds = [...newest.values()].filter((row) => row.status === 'skipped').map((row) => row.id);
  const skippedPayloads = skippedIds.length
    ? await db
        .select({ id: integrationActions.id, payload: integrationActions.payload })
        .from(integrationActions)
        .where(inArray(integrationActions.id, skippedIds))
    : [];
  const existingKeys = new Map(
    skippedPayloads.map((row) => [row.id, (row.payload as { existingKey?: unknown } | null)?.existingKey]),
  );
  for (const [clusterId, row] of newest) {
    if (row.status !== 'failed' && row.status !== 'skipped') continue;
    const at = row.finishedAt ?? row.createdAt;
    const existingKey = existingKeys.get(row.id);
    out.failures.set(clusterId, {
      error: row.error ?? null,
      at: at ? new Date(at as unknown as string | number | Date).toISOString() : null,
      ...(typeof existingKey === 'string' && existingKey ? { existingKey } : {}),
    });
  }
  return out;
}
