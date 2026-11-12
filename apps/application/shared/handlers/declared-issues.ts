/**
 * The link step's core, shared by the server's finalize and the demo: the keys a run's failing tests name in
 * the bound Jira project, one bulk lookup, and the links it writes. The server's `linkDeclaredIssues`
 * (`server/utils/integrations/declared-issues.ts`) decides whether a run gets the step and supplies the connection;
 * the demo supplies a canned one.
 *
 * Only issues of the bound Jira project are linked: a key in the issue-key shape whose project part is the binding's
 * `projectKey`, and a looked-up issue still in that project under the key the test named. Anything else is dropped,
 * never stored as a plain link.
 *
 * A test names an issue with a `piwi:issue` annotation, or, when the project has an issue key pattern for tags, with
 * a tag that pattern matches. A key from a tag is linked only when the looked-up issue's type is one the tag source
 * accepts; a key from an annotation is linked whatever its type. A key both name is linked as from the annotation.
 */
import { and, eq, gt, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { sanitizeTestMetadata } from '@piwitests/core/test-meta';
import { matchTagKeys } from '../integrations/tag-keys';
import { finalAttemptSql } from './test-case-aggregates';
import { entityLinkDismissals, entityLinks, failureClusters, testRunsCases } from '../../server/database/schema';
import type { IssueTracker, TrackerIssue } from '../../server/utils/integrations/types';
import type { DrizzleDB } from './db';
import { isDeclaredLink } from './known-issues';

/** The most links from the tests a cluster keeps; links pinned by hand or created by Piwi do not count. */
export const MAX_DECLARED_LINKS_PER_CLUSTER = 10;
/** The most distinct keys one run looks up. */
export const MAX_DECLARED_KEYS_PER_RUN = 50;

/** A Jira issue key: an upper-case project part, a dash and a number without a leading zero. */
const ISSUE_KEY_SHAPE = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;

/** Whether `key` is in the issue-key shape with `projectKey` as its project part. */
function isKeyOfProject(key: string, projectKey: string): boolean {
  return ISSUE_KEY_SHAPE.test(key) && key.slice(0, key.lastIndexOf('-')) === projectKey;
}

/** What the step did, for its callers and tests. */
export interface DeclaredLinksResult {
  /** Why nothing was looked up, when it was not. */
  skipped?: 'ineligible' | 'unbound' | 'no-project-key' | 'out-of-scope' | 'no-lookup' | 'nothing-named';
  /** The keys sent to the lookup. */
  looked: string[];
  /** The links inserted, as cluster id and key. */
  linked: { clusterId: number; key: string }[];
  /** The lookup failed or ran past the deadline, so nothing was written. */
  failed?: 'lookup' | 'deadline';
}

/**
 * The key a `piwi:issue` value names in the bound project, or null: a bare key, or a URL the connection's
 * `parseIssueUrl` reads, in the key shape and with `projectKey` as its project part.
 */
export function declaredIssueKey(value: string, projectKey: string, tracker: Pick<IssueTracker, 'parseIssueUrl'>) {
  const key = /^https?:\/\//i.test(value) ? tracker.parseIssueUrl(value)?.key : value;
  return key && isKeyOfProject(key, projectKey) ? key : null;
}

/**
 * Whether a looked-up issue is of one of the types in `accepted`. An entry of digits is a type id and is compared with
 * the issue's type id; any other entry is a type name, compared with the issue's type name ignoring case. A binding
 * stores either, since the tracker takes both. An issue whose type the tracker did not say is of no type.
 */
export function isIssueTypeAccepted(
  issue: Pick<TrackerIssue, 'issueType' | 'issueTypeId'>,
  accepted: string[],
): boolean {
  return accepted.some((entry) =>
    /^\d+$/.test(entry)
      ? issue.issueTypeId === entry
      : issue.issueType != null && issue.issueType.toLowerCase() === entry.toLowerCase(),
  );
}

interface ClusterState {
  /** The keys the cluster's failing tests name by any source, with the tests that name each. */
  named: Map<string, Set<number>>;
  /** The keys a `piwi:issue` annotation names, with the first test that names each. */
  annotated: Map<string, number>;
  /** The keys a tag names, with the first test and the tag (with its `@`) that name each. */
  tagged: Map<string, { testCaseId: number; tag: string }>;
  /** Keys the cluster links by any origin, or has dismissed. */
  taken: Set<string>;
  /** Jira issue ids the cluster has dismissed. */
  dismissedIds: Set<string>;
  /** Links from the tests the cluster holds. */
  declared: number;
  /** The keys still to link, most-named first. */
  candidates: string[];
}

/** The keys a lookup did not return, remembered for a while; a `TtlCache<true>` fits. */
export interface UnreturnedKeys {
  get(key: string): true | undefined;
  set(key: string, value: true): void;
  delete(key: string): void;
}

/** The connection the step reads through: the bound one on the server, a canned one in the demo. */
export interface DeclaredIssuesLookup {
  projectKey: string;
  connectionId: number | null;
  tracker: Pick<IssueTracker, 'parseIssueUrl'> & Required<Pick<IssueTracker, 'getIssues'>>;
  /**
   * The tag source: the project's issue key pattern and the issue types it links. Left out, or with no type, the tests'
   * tags name nothing.
   */
  tagSource?: { pattern: string | null; issueTypes: string[] | null };
  /** The keys earlier lookups of this connection and project did not return; the demo passes none. */
  unreturned?: UnreturnedKeys;
  /** Aborts the step; once it fires nothing more is written. */
  deadline: AbortSignal;
}

/**
 * Links the run's failing tests' named issues to their clusters: one bulk lookup for at most
 * {@link MAX_DECLARED_KEYS_PER_RUN} keys, the ones the most failing tests name first and the keys earlier lookups did
 * not return last, leaving out a key a cluster already links or has dismissed and the keys of a cluster at the cap. Each cluster's `declared_issues_more` is set to
 * the keys it names and does not link, and to 0 for a failing cluster that names none this run.
 *
 * The links and dismissals of the clusters with a key to link are read again once the lookup returns, so one made during
 * the lookup is respected and counts toward the cap; one made between that read and an insert is not seen.
 * The writes come after the lookup, each only while the deadline has not fired: once it fires the lookup is aborted
 * and nothing more is written. A lookup that fails links nothing; the next failing run that names the key tries again.
 */
export async function linkNamedIssues(
  db: DrizzleDB,
  runId: number,
  { projectKey, connectionId, tracker, tagSource, unreturned, deadline }: DeclaredIssuesLookup,
): Promise<DeclaredLinksResult> {
  const result: DeclaredLinksResult = { looked: [], linked: [] };
  if (deadline.aborted) return { ...result, failed: 'deadline' };
  const tagTypes = tagSource?.pattern && tagSource.issueTypes?.length ? tagSource.issueTypes : null;
  const tagPattern = tagTypes ? (tagSource?.pattern ?? null) : null;
  const { clusters, failing } = await readClusterStates(db, runId, projectKey, tracker, tagPattern);
  const unnamed = failing.filter((id) => !clusters.has(id));
  if (clusters.size === 0 && unnamed.length === 0) return { ...result, skipped: 'nothing-named' };

  const memory = (key: string) => `${connectionId ?? ''}:${projectKey}:${key}`;
  const keys = pickLookupKeys(clusters, (key) => unreturned?.get(memory(key)) === true);
  result.looked = keys;
  let found: TrackerIssue[] = [];
  if (keys.length > 0) {
    try {
      found = (await tracker.getIssues(keys, { signal: deadline })).issues;
    } catch (err) {
      if (deadline.aborted) return { ...result, failed: 'deadline' };
      console.error('[integrations] the declared-issue lookup failed', err);
      return { ...result, failed: 'lookup' };
    }
  }
  if (deadline.aborted) return { ...result, failed: 'deadline' };
  if (unreturned) {
    const returned = new Set(found.map((issue) => issue.key));
    for (const key of keys) {
      if (returned.has(key)) unreturned.delete(memory(key));
      else unreturned.set(memory(key), true);
    }
  }

  // An issue counts only under the key the test named and in the bound project.
  const asked = new Set(keys);
  const byKey = new Map<string, TrackerIssue>();
  for (const issue of found) {
    if (asked.has(issue.key) && issue.projectKey === projectKey && issue.id) byKey.set(issue.key, issue);
  }

  const stopped = () => ({ ...result, failed: 'deadline' as const });
  // The clusters' links and dismissals are read again after the lookup, before the first write.
  const ready = [...clusters].filter(([, state]) => state.candidates.some((key) => byKey.has(key)));
  await readLinkState(
    db,
    clusters,
    ready.map(([id]) => id),
  );
  if (unnamed.length > 0) {
    if (deadline.aborted) return stopped();
    await db
      .update(failureClusters)
      .set({ declaredIssuesMore: 0 })
      .where(and(inArray(failureClusters.id, unnamed), gt(failureClusters.declaredIssuesMore, 0)));
  }
  const now = new Date();
  for (const [clusterId, state] of clusters) {
    let room = MAX_DECLARED_LINKS_PER_CLUSTER - state.declared;
    for (const key of state.candidates) {
      if (room <= 0) break;
      const issue = byKey.get(key);
      if (!issue) continue;
      const annotated = state.annotated.get(key);
      // A key only a tag names is linked for the issue types the tag source accepts; the cluster still counts it.
      if (annotated === undefined && !isIssueTypeAccepted(issue, tagTypes ?? [])) continue;
      if (state.dismissedIds.has(issue.id as string)) {
        state.taken.add(key);
        continue;
      }
      if (deadline.aborted) return stopped();
      const inserted = await db
        .insert(entityLinks)
        .values({
          failureClusterId: clusterId,
          url: issue.url,
          provider: 'jira',
          key,
          title: issue.title,
          statusText: issue.status,
          statusColor: issue.statusColor,
          metadata: {
            ...(issue.statusCategory ? { statusCategory: issue.statusCategory } : {}),
            source:
              annotated !== undefined
                ? { testCaseId: annotated }
                : { testCaseId: state.tagged.get(key)?.testCaseId ?? null, tag: state.tagged.get(key)?.tag ?? null },
          } as never,
          unfurledAt: now,
          connectionId,
          externalId: issue.id,
          origin: annotated !== undefined ? 'annotation' : 'tag',
          createdBy: null,
        })
        .onConflictDoNothing()
        .returning({ id: entityLinks.id });
      if (inserted.length === 0) continue;
      state.taken.add(key);
      state.declared++;
      room--;
      result.linked.push({ clusterId, key });
    }
    // The keys named and still not linked or dismissed: left out at the cap, past the run's budget, or not found.
    const more = state.candidates.filter((k) => !state.taken.has(k)).length;
    if (deadline.aborted) return stopped();
    await db.update(failureClusters).set({ declaredIssuesMore: more }).where(eq(failureClusters.id, clusterId));
  }
  return clusters.size === 0 ? { ...result, skipped: 'nothing-named' } : result;
}

/**
 * The clusters of the run's failing tests that name an issue of the bound project, with what each holds. A test
 * counts by the final attempt of each of its results, so a test whose retry passed names nothing.
 */
async function readClusterStates(
  db: DrizzleDB,
  runId: number,
  projectKey: string,
  tracker: Pick<IssueTracker, 'parseIssueUrl'>,
  tagPattern: string | null,
): Promise<{ clusters: Map<number, ClusterState>; failing: number[] }> {
  const rows = await db
    .select({
      clusterId: testRunsCases.failureClusterId,
      testCaseId: testRunsCases.testCaseId,
      testMeta: testRunsCases.testMeta,
      tags: testRunsCases.tags,
    })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        isNotNull(testRunsCases.failureClusterId),
        finalAttemptSql(),
        notInArray(testRunsCases.status, ['passed', 'skipped', 'didnotrun']),
      ),
    );
  const clusters = new Map<number, ClusterState>();
  const failing = new Set<number>();
  for (const row of rows) {
    if (row.clusterId == null) continue;
    failing.add(row.clusterId);
    const clusterId = row.clusterId;
    const name = (key: string, tag: string | null) => {
      let state = clusters.get(clusterId);
      if (!state) {
        state = {
          named: new Map(),
          annotated: new Map(),
          tagged: new Map(),
          taken: new Set(),
          dismissedIds: new Set(),
          declared: 0,
          candidates: [],
        };
        clusters.set(clusterId, state);
      }
      const tests = state.named.get(key);
      if (tests) tests.add(row.testCaseId);
      else state.named.set(key, new Set([row.testCaseId]));
      if (tag === null) {
        if (!state.annotated.has(key)) state.annotated.set(key, row.testCaseId);
      } else if (!state.tagged.has(key)) {
        state.tagged.set(key, { testCaseId: row.testCaseId, tag });
      }
    };
    for (const value of sanitizeTestMetadata(row.testMeta)?.issues ?? []) {
      const key = declaredIssueKey(value, projectKey, tracker);
      if (key) name(key, null);
    }
    if (tagPattern && Array.isArray(row.tags)) {
      const tags = (row.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string');
      for (const tag of matchTagKeys(tags, tagPattern)) {
        const key = tag.replace(/^@/, '');
        if (isKeyOfProject(key, projectKey)) name(key, `@${key}`);
      }
    }
  }
  if (clusters.size === 0) return { clusters, failing: [...failing] };
  await readLinkState(db, clusters, [...clusters.keys()]);
  return { clusters, failing: [...failing] };
}

/**
 * Reads what the clusters `ids` hold now (the keys they link or have dismissed, the Jira ids they have dismissed and
 * their links from the tests) and works out the keys still to link, most-named first. Links and dismissals written
 * after this read are not seen.
 */
async function readLinkState(db: DrizzleDB, clusters: Map<number, ClusterState>, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    const state = clusters.get(id)!;
    state.taken = new Set();
    state.dismissedIds = new Set();
    state.declared = 0;
  }
  const links = await db
    .select({ clusterId: entityLinks.failureClusterId, key: entityLinks.key, origin: entityLinks.origin })
    .from(entityLinks)
    .where(inArray(entityLinks.failureClusterId, ids));
  for (const link of links) {
    const state = clusters.get(link.clusterId as number);
    if (!state) continue;
    if (link.key) state.taken.add(link.key.toUpperCase());
    if (isDeclaredLink(link)) state.declared++;
  }
  const dismissals = await db
    .select({
      clusterId: entityLinkDismissals.failureClusterId,
      key: entityLinkDismissals.key,
      externalId: entityLinkDismissals.externalId,
    })
    .from(entityLinkDismissals)
    .where(inArray(entityLinkDismissals.failureClusterId, ids));
  for (const dismissal of dismissals) {
    const state = clusters.get(dismissal.clusterId);
    if (!state) continue;
    state.taken.add(dismissal.key.toUpperCase());
    if (dismissal.externalId) state.dismissedIds.add(dismissal.externalId);
  }
  for (const id of ids) {
    const state = clusters.get(id)!;
    state.candidates = [...state.named]
      .filter(([key]) => !state.taken.has(key))
      .sort(([a, x], [b, y]) => y.size - x.size || a.localeCompare(b))
      .map(([key]) => key);
  }
}

/**
 * The keys to look up: those of the clusters below the cap, the keys `wasUnreturned` last and then the ones the most
 * failing tests name first, at most {@link MAX_DECLARED_KEYS_PER_RUN}.
 */
function pickLookupKeys(clusters: Map<number, ClusterState>, wasUnreturned: (key: string) => boolean): string[] {
  const tests = new Map<string, Set<number>>();
  for (const state of clusters.values()) {
    if (state.declared >= MAX_DECLARED_LINKS_PER_CLUSTER) continue;
    for (const key of state.candidates) {
      const naming = tests.get(key) ?? new Set<number>();
      for (const id of state.named.get(key) ?? []) naming.add(id);
      tests.set(key, naming);
    }
  }
  return [...tests]
    .map(([key, naming]) => ({ key, count: naming.size, unreturned: wasUnreturned(key) }))
    .sort((a, b) => Number(a.unreturned) - Number(b.unreturned) || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, MAX_DECLARED_KEYS_PER_RUN)
    .map((entry) => entry.key);
}
