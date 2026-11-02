/**
 * Shared failure-cluster and run-cancellation operations used by both server
 * and demo reporter implementations.
 */

import { eq, ne, and, or, inArray, sql, isNull, count, asc, desc, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  testRuns,
  testRunsCases,
  failureClusters,
  failureClusterAliases,
  failureClusterTestRoutes,
  clusterMergeSuggestions,
  failureDiagnoses,
  failureDiagnosisVersions,
  entityLinks,
  handbackOutcomes,
  integrationActions,
  mcpToolCalls,
} from '../../server/database/schema';
import { preferExemplar } from '../prefer-exemplar';
import { isCurrentlySnoozed, wakeOnRecurrence, type SnoozeState } from '../inbox-queues';
import { eligibleRunSql, isEligibleRun } from '../run-eligibility';
import type { DrizzleDB } from './db';

/** Per-fingerprint accumulator for the batch being persisted. */
export interface PendingCluster {
  fp: {
    fingerprint: string;
    signature: string;
    errorType: string | null;
    selector: string | null;
  };
  sampleError: string;
  count: number;
}

/**
 * Prefix of the fingerprint given to a cluster made by moving tests out of
 * another. It matches no computed fingerprint, so only the per-test routes
 * lead failures to that cluster.
 */
export const SPLIT_FINGERPRINT_PREFIX = 'split:';

export function isSplitFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith(SPLIT_FINGERPRINT_PREFIX);
}

/** How a batch of failures bumps the clusters it joins. */
interface BumpOptions {
  /** False leaves an "until it recurs" snooze in place. */
  wakeSnoozed?: boolean;
  /** Whether the run's failures count as occurrences; read from the run when unset. */
  countsOccurrences?: boolean;
}

/**
 * Whether run `testRunId`'s failures count as occurrences of their clusters
 * (the `cluster-occurrences` use). A run that is not stored counts.
 */
async function runCountsOccurrences(db: DrizzleDB, testRunId: number): Promise<boolean> {
  const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, testRunId));
  return !run || isEligibleRun(run, 'cluster-occurrences');
}

/**
 * Set `failureClusterId` on a batch's rows: a test moved out of a cluster
 * follows its route for that fingerprint; every other row goes through
 * {@link getOrCreateFailureClusters}. `fingerprints[i]` belongs to `rows[i]`.
 * Routed rows are taken out of `pending` before the clusters are bumped.
 * `wakeSnoozed` applies to routed clusters as to the others. A run whose
 * failures do not count as occurrences (from an editor, a bisect step, a
 * reproduction) joins them to their clusters without bumping them.
 */
export async function assignFailureClusters(
  db: DrizzleDB,
  projectId: number,
  testRunId: number,
  pending: Map<string, PendingCluster>,
  rows: Array<{ testCaseId: number; failureClusterId?: number | null }>,
  fingerprints: Array<{ fingerprint: string } | null>,
  options: BumpOptions = {},
): Promise<void> {
  const bump = {
    ...options,
    countsOccurrences: options.countsOccurrences ?? (await runCountsOccurrences(db, testRunId)),
  };
  const routed = await routeMovedTests(db, projectId, testRunId, pending, rows, fingerprints, bump);
  const clusterIds = await getOrCreateFailureClusters(db, projectId, testRunId, pending, bump);
  rows.forEach((row, i) => {
    const fingerprint = fingerprints[i];
    if (fingerprint) row.failureClusterId = routed.get(i) ?? clusterIds.get(fingerprint.fingerprint) ?? null;
  });
}

/** The start time of run `runId`, as a SQL subquery. */
function runStart(runId: SQL | AnyColumn | number): SQL {
  return sql`(select ${testRuns.startTime} from ${testRuns} where ${testRuns.id} = ${runId})`;
}

/**
 * A cluster's first and last seen runs once run `testRunId` saw it: the last
 * seen run moves only to a run that started later (a historical import leaves
 * it where it is), and the first seen run moves back to a run that started
 * earlier. A seen run that no longer exists is replaced as the last one.
 */
function seenInRun(testRunId: number) {
  return {
    lastSeenRunId: sql`case when coalesce(${runStart(failureClusters.lastSeenRunId)} <= ${runStart(testRunId)}, true) then ${testRunId} else ${failureClusters.lastSeenRunId} end`,
    firstSeenRunId: sql`case when ${runStart(failureClusters.firstSeenRunId)} > ${runStart(testRunId)} then ${testRunId} else ${failureClusters.firstSeenRunId} end`,
  };
}

/**
 * The `updatedAt` a new occurrence or a merge writes: an open cluster's moves,
 * and a resolved or ignored cluster's stays at the moment it was triaged, which
 * reopening it on a recurrence and the analytics read.
 */
function touchedByOccurrence(status: string | null | undefined): { updatedAt?: Date } {
  return status === 'open' ? { updatedAt: new Date() } : {};
}

/** Row index → cluster for the rows whose test has a route for its fingerprint; bumps each routed cluster. */
async function routeMovedTests(
  db: DrizzleDB,
  projectId: number,
  testRunId: number,
  pending: Map<string, PendingCluster>,
  rows: Array<{ testCaseId: number }>,
  fingerprints: Array<{ fingerprint: string } | null>,
  options: BumpOptions,
): Promise<Map<number, number>> {
  const routedRows = new Map<number, number>();
  if (pending.size === 0) return routedRows;
  const testCaseIds = [...new Set(rows.filter((_, i) => fingerprints[i]).map((row) => row.testCaseId))];
  const routes = await db
    .select({
      fingerprint: failureClusterTestRoutes.fingerprint,
      testCaseId: failureClusterTestRoutes.testCaseId,
      clusterId: failureClusterTestRoutes.clusterId,
    })
    .from(failureClusterTestRoutes)
    .where(
      and(
        eq(failureClusterTestRoutes.projectId, projectId),
        inArray(failureClusterTestRoutes.fingerprint, [...pending.keys()]),
        inArray(failureClusterTestRoutes.testCaseId, testCaseIds),
      ),
    );
  if (routes.length === 0) return routedRows;

  const routeOf = new Map(routes.map((r) => [`${r.fingerprint}\u0000${r.testCaseId}`, r.clusterId]));
  const countByCluster = new Map<number, number>();
  rows.forEach((row, i) => {
    const fingerprint = fingerprints[i]?.fingerprint;
    if (!fingerprint) return;
    const clusterId = routeOf.get(`${fingerprint}\u0000${row.testCaseId}`);
    if (clusterId === undefined) return;
    routedRows.set(i, clusterId);
    countByCluster.set(clusterId, (countByCluster.get(clusterId) ?? 0) + 1);
    const p = pending.get(fingerprint)!;
    p.count--;
    if (p.count === 0) pending.delete(fingerprint);
  });
  if (options.countsOccurrences === false) return routedRows;

  const clusters = await db
    .select({
      id: failureClusters.id,
      status: failureClusters.status,
      snoozedUntil: failureClusters.snoozedUntil,
      snoozeMode: failureClusters.snoozeMode,
    })
    .from(failureClusters)
    .where(inArray(failureClusters.id, [...countByCluster.keys()]));
  await Promise.all(
    clusters.map((cluster) =>
      db
        .update(failureClusters)
        .set({
          ...seenInRun(testRunId),
          occurrences: sql`${failureClusters.occurrences} + ${countByCluster.get(cluster.id)!}`,
          ...touchedByOccurrence(cluster.status),
          ...(options.wakeSnoozed !== false
            ? (wakeOnRecurrence({ snoozedUntil: cluster.snoozedUntil, snoozeMode: cluster.snoozeMode }) ?? {})
            : {}),
        })
        .where(eq(failureClusters.id, cluster.id)),
    ),
  );
  return routedRows;
}

/**
 * Move the given tests' executions out of a cluster into a new cluster, and
 * route their later failures with any fingerprint leading to the source
 * cluster (its own and its aliases) to the new one. The pair is recorded as a
 * rejected merge, so reconciliation never folds it back. Both clusters' seen
 * runs and occurrences are then recomputed from the executions each holds.
 * Returns null when the cluster does not exist, and no cluster when none of
 * the tests has an execution in it.
 */
export async function splitFailureCluster(
  db: DrizzleDB,
  sourceId: number,
  testCaseIds: number[],
  triageNote?: string | null,
): Promise<{ clusterId: number | null; testCount: number } | null> {
  const [source] = await db
    .select({
      projectId: failureClusters.projectId,
      fingerprint: failureClusters.fingerprint,
      signature: failureClusters.signature,
      errorType: failureClusters.errorType,
      selector: failureClusters.selector,
      sampleError: failureClusters.sampleError,
    })
    .from(failureClusters)
    .where(eq(failureClusters.id, sourceId));
  if (!source) return null;

  const moved = await db
    .select({
      id: testRunsCases.id,
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      error: testRunsCases.error,
    })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.failureClusterId, sourceId), inArray(testRunsCases.testCaseId, testCaseIds)));
  if (moved.length === 0) return { clusterId: null, testCount: 0 };

  const runIds = moved.map((r) => r.testRunId);
  const latest = moved.reduce((a, b) => (b.testRunId > a.testRunId ? b : a));
  const movedTests = [...new Set(moved.map((r) => r.testCaseId))];
  const aliases = await db
    .select({ fingerprint: failureClusterAliases.fingerprint })
    .from(failureClusterAliases)
    .where(eq(failureClusterAliases.clusterId, sourceId));
  const routedFingerprints = [source.fingerprint, ...aliases.map((a) => a.fingerprint)].filter(
    (fingerprint) => !isSplitFingerprint(fingerprint),
  );

  const clusterId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(failureClusters)
      .values({
        projectId: source.projectId,
        fingerprint: `${SPLIT_FINGERPRINT_PREFIX}${globalThis.crypto.randomUUID()}`,
        signature: source.signature,
        errorType: source.errorType,
        selector: source.selector,
        sampleError: latest.error ?? source.sampleError,
        firstSeenRunId: Math.min(...runIds),
        lastSeenRunId: Math.max(...runIds),
        occurrences: moved.length,
        triageNote: triageNote || null,
      })
      .returning({ id: failureClusters.id });
    const newId = created!.id;

    await tx
      .update(testRunsCases)
      .set({ failureClusterId: newId })
      .where(
        inArray(
          testRunsCases.id,
          moved.map((r) => r.id),
        ),
      );

    // Routes that already led these tests to the source cluster now lead to the new one.
    await tx
      .update(failureClusterTestRoutes)
      .set({ clusterId: newId })
      .where(
        and(eq(failureClusterTestRoutes.clusterId, sourceId), inArray(failureClusterTestRoutes.testCaseId, movedTests)),
      );
    for (const fingerprint of routedFingerprints) {
      await tx
        .insert(failureClusterTestRoutes)
        .values(
          movedTests.map((testCaseId) => ({ projectId: source.projectId, fingerprint, testCaseId, clusterId: newId })),
        )
        .onConflictDoUpdate({
          target: [
            failureClusterTestRoutes.projectId,
            failureClusterTestRoutes.fingerprint,
            failureClusterTestRoutes.testCaseId,
          ],
          set: { clusterId: newId },
        });
    }

    await tx
      .insert(clusterMergeSuggestions)
      .values({
        projectId: source.projectId,
        clusterAId: Math.min(sourceId, newId),
        clusterBId: Math.max(sourceId, newId),
        method: 'split',
        status: 'rejected',
      })
      .onConflictDoNothing();
    return newId;
  });

  await recomputeClusterBounds(db, sourceId);
  await recomputeClusterBounds(db, clusterId);
  return { clusterId, testCount: movedTests.length };
}

/**
 * Get-or-create the `failure_clusters` rows for a batch of fingerprints and
 * return fingerprint → cluster id. Existing clusters get their occurrences
 * bumped and their first and last seen runs moved to this run when it started
 * before or after them; new ones start at this run. Insert races with
 * concurrent streaming batches are resolved via the unique
 * (projectId, fingerprint) index + onConflictDoNothing. With `wakeSnoozed`
 * false, a recurrence leaves an "until it recurs" snooze in place. A run whose
 * failures do not count as occurrences (`cluster-occurrences`) leaves existing
 * clusters as they are, and a cluster it creates counts none.
 */
export async function getOrCreateFailureClusters(
  db: DrizzleDB,
  projectId: number,
  testRunId: number,
  pending: Map<string, PendingCluster>,
  options: BumpOptions = {},
): Promise<Map<string, number>> {
  const wakeSnoozed = options.wakeSnoozed !== false;
  const ids = new Map<string, number>();
  if (pending.size === 0) return ids;
  const counts = options.countsOccurrences ?? (await runCountsOccurrences(db, testRunId));

  // Bump a re-hit cluster: count the occurrences, move its first and last seen
  // runs to this run when it started before or after them, and refresh
  // the display exemplar (sampleError + its derived signature/errorType/selector)
  // to this occurrence when it is a better one. The fingerprint and the frozen
  // fingerprintSample are deliberately left untouched, so refreshing the display
  // can never destabilize re-fingerprinting.
  const bumpExisting = async (
    clusterId: number,
    p: PendingCluster,
    current: { sampleError: string | null; status: string; snoozedUntil: Date | null; snoozeMode: string | null },
  ) => {
    if (!counts) return;
    await db
      .update(failureClusters)
      .set({
        ...seenInRun(testRunId),
        occurrences: sql`${failureClusters.occurrences} + ${p.count}`,
        ...touchedByOccurrence(current.status),
        // A fresh occurrence wakes an "until it recurs" snooze — the cluster
        // returns to the inbox (its "snoozed, back" marker is the surviving mode).
        ...(wakeSnoozed ? (wakeOnRecurrence(current) ?? {}) : {}),
        ...(preferExemplar(current.sampleError ?? '', p.sampleError)
          ? {
              sampleError: p.sampleError,
              signature: p.fp.signature,
              errorType: p.fp.errorType,
              selector: p.fp.selector,
              // Drop the stale vector so the post-run reconciler re-embeds from
              // the new sample instead of scoring the old one. Its backfill
              // treats a null embedding as "needs a vector" (embeddingModel is
              // left as-is; it's overwritten together with the new vector).
              embedding: null,
            }
          : {}),
      })
      .where(eq(failureClusters.id, clusterId));
  };

  const existing = await db
    .select({
      id: failureClusters.id,
      fingerprint: failureClusters.fingerprint,
      sampleError: failureClusters.sampleError,
      status: failureClusters.status,
      snoozedUntil: failureClusters.snoozedUntil,
      snoozeMode: failureClusters.snoozeMode,
    })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), inArray(failureClusters.fingerprint, [...pending.keys()])));

  await Promise.all(
    existing.map(async (cluster) => {
      const p = pending.get(cluster.fingerprint);
      if (!p) return;
      ids.set(cluster.fingerprint, cluster.id);
      await bumpExisting(cluster.id, p, cluster);
    }),
  );

  // Route fingerprints that were absorbed by a prior merge to their surviving
  // cluster (instead of forking a fresh one), via the alias table.
  const unmatched = [...pending.keys()].filter((fp) => !ids.has(fp));
  if (unmatched.length > 0) {
    const aliases = await db
      .select({
        fingerprint: failureClusterAliases.fingerprint,
        clusterId: failureClusterAliases.clusterId,
        sampleError: failureClusters.sampleError,
        status: failureClusters.status,
        snoozedUntil: failureClusters.snoozedUntil,
        snoozeMode: failureClusters.snoozeMode,
      })
      .from(failureClusterAliases)
      .innerJoin(failureClusters, eq(failureClusters.id, failureClusterAliases.clusterId))
      .where(
        and(eq(failureClusterAliases.projectId, projectId), inArray(failureClusterAliases.fingerprint, unmatched)),
      );
    await Promise.all(
      aliases.map(async (a) => {
        const p = pending.get(a.fingerprint);
        if (!p || ids.has(a.fingerprint)) return;
        ids.set(a.fingerprint, a.clusterId);
        await bumpExisting(a.clusterId, p, a);
      }),
    );
  }

  const newFingerprints = [...pending.keys()].filter((fp) => !ids.has(fp));
  await Promise.all(
    newFingerprints.map(async (fingerprint) => {
      const p = pending.get(fingerprint)!;
      const inserted = await db
        .insert(failureClusters)
        .values({
          projectId,
          fingerprint,
          signature: p.fp.signature,
          errorType: p.fp.errorType,
          selector: p.fp.selector,
          sampleError: p.sampleError,
          // Immutable fingerprint source: seeded from the same error as the
          // display sample, its secrets hidden in a way that leaves its
          // fingerprint the same (`hideSecretsInError`), but never refreshed, so
          // re-fingerprinting on a version bump stays independent of later
          // exemplar refreshes.
          fingerprintSample: p.sampleError,
          firstSeenRunId: testRunId,
          lastSeenRunId: testRunId,
          occurrences: counts ? p.count : 0,
        })
        .onConflictDoNothing()
        .returning({ id: failureClusters.id });

      if (inserted[0]) {
        ids.set(fingerprint, inserted[0].id);
        return;
      }

      const winner = await db
        .select({
          id: failureClusters.id,
          sampleError: failureClusters.sampleError,
          status: failureClusters.status,
          snoozedUntil: failureClusters.snoozedUntil,
          snoozeMode: failureClusters.snoozeMode,
        })
        .from(failureClusters)
        .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.fingerprint, fingerprint)));
      if (winner[0]) {
        ids.set(fingerprint, winner[0].id);
        await bumpExisting(winner[0].id, p, winner[0]);
      }
    }),
  );

  return ids;
}

/** The triage fields the merge policy reads from both clusters. */
interface MergedTriage extends SnoozeState {
  status: string;
}

/**
 * The survivor's status and snooze once the victim merged into it. A live
 * failure is never buried: when either cluster is open and not snoozed, the
 * survivor ends open, its resolved or ignored status, or its snooze, cleared;
 * otherwise it keeps its status and snooze.
 */
export function mergedTriage(survivor: MergedTriage, victim: MergedTriage, now: Date = new Date()) {
  const live = (c: MergedTriage) => c.status === 'open' && !isCurrentlySnoozed(c, now);
  return {
    ...(live(survivor) || !live(victim)
      ? {}
      : {
          status: 'open',
          ...(isCurrentlySnoozed(survivor, now) ? { snoozedUntil: null, snoozeMode: null } : {}),
        }),
  };
}

/**
 * SQL: the survivor's assignee once the victim merged into it: its own, else
 * the victim's. It reads the assignee of the row the UPDATE changes, so an
 * assignment made meanwhile is kept.
 */
function mergedAssignee(victimAssignee: string | null): SQL {
  const assignee = failureClusters.assignee;
  return sql`case when trim(coalesce(${assignee}, '')) <> '' then ${assignee} else cast(${victimAssignee} as text) end`;
}

/**
 * SQL: the survivor's triage note once the victim merged into it, the
 * victim's note appended below it when the survivor's does not hold it already
 * (`appendedTriageNote`). It reads the note of the row the UPDATE changes, so
 * an edit or a line Piwi added meanwhile is kept.
 */
function mergedTriageNote(victimNote: string): SQL {
  const note = sql`coalesce(${failureClusters.triageNote}, '')`;
  return sql`case when replace(${note}, cast(${victimNote} as text), '') = ${note} then ${appendedTriageNote(victimNote)} else ${failureClusters.triageNote} end`;
}

/**
 * Merge one failure cluster into another. The `survivorId` cluster keeps its
 * manual base commit, takes the status `mergedTriage` gives it, the victim's
 * assignee when it has none and the victim's note when it lacks it, and absorbs
 * the victim: all linked test-run cases and diagnoses are re-pointed, with the
 * victim's links, fix attempts, its tracker writes and agent calls, and the
 * merges a person or the adjudicator decided against; occurrence counts are
 * summed and the seen-run bounds widened to cover both, then the victim row is
 * deleted.
 *
 * Used by the re-fingerprinting backfill (when two distinct clusters map onto
 * the same fingerprint), cluster reconciliation and approved merge suggestions,
 * which apply the policy to the clusters' triage at the moment they merge.
 */
export async function mergeFailureClusters(db: DrizzleDB, survivorId: number, victimId: number): Promise<void> {
  if (survivorId === victimId) return;

  // All-or-nothing: a partially-applied merge (cases re-pointed but the victim
  // still alive with stale counts, or the victim gone before its alias is
  // recorded) would corrupt occurrence counts and mis-route future
  // fingerprints. All supported drivers — libSQL, postgres.js, and the demo's
  // sqlite-proxy over sql.js — implement `transaction`.
  await db.transaction(async (tx) => {
    // Re-point per-run case links.
    await tx
      .update(testRunsCases)
      .set({ failureClusterId: survivorId })
      .where(eq(testRunsCases.failureClusterId, victimId));

    // The survivor inherits the victim's external links, so a ticket Piwi filed
    // (or a pinned issue) keeps tracking the failure across the merge rather than
    // being cascade-deleted with the victim cluster.
    await tx
      .update(entityLinks)
      .set({ failureClusterId: survivorId })
      .where(eq(entityLinks.failureClusterId, victimId));

    // Execution-scope diagnoses are keyed by test-run-case and stay meaningful —
    // move them to the survivor. A cluster-scope diagnosis on the victim is
    // redundant with the survivor's own, so drop it (cascade on delete) unless
    // the survivor has none, in which case keep the victim's.
    const [survivorClusterDiag] = await tx
      .select({ id: failureDiagnoses.id })
      .from(failureDiagnoses)
      .where(and(eq(failureDiagnoses.clusterId, survivorId), eq(failureDiagnoses.scope, 'cluster')));

    await tx
      .update(failureDiagnoses)
      .set({ clusterId: survivorId })
      .where(
        and(
          eq(failureDiagnoses.clusterId, victimId),
          survivorClusterDiag ? eq(failureDiagnoses.scope, 'execution') : sql`1 = 1`,
        ),
      );
    await tx
      .update(failureDiagnosisVersions)
      .set({ clusterId: survivorId })
      .where(eq(failureDiagnosisVersions.clusterId, victimId));

    // The victim's history follows it: the fix attempts reported on it, what
    // Piwi wrote to its tracker issue, and what agents did to it.
    await tx
      .update(handbackOutcomes)
      .set({ subjectId: survivorId })
      .where(
        and(
          eq(handbackOutcomes.kind, 'fix-attempt'),
          eq(handbackOutcomes.subjectType, 'cluster'),
          eq(handbackOutcomes.subjectId, victimId),
        ),
      );
    await tx
      .update(integrationActions)
      .set({ entityId: survivorId })
      .where(and(eq(integrationActions.entityType, 'failure_cluster'), eq(integrationActions.entityId, victimId)));
    await tx
      .update(mcpToolCalls)
      .set({ subjectId: survivorId })
      .where(and(eq(mcpToolCalls.subjectType, 'cluster'), eq(mcpToolCalls.subjectId, victimId)));

    // Combine the two clusters' aggregates.
    const triageFields = {
      status: failureClusters.status,
      assignee: failureClusters.assignee,
      triageNote: failureClusters.triageNote,
      snoozedUntil: failureClusters.snoozedUntil,
      snoozeMode: failureClusters.snoozeMode,
    };
    const [survivor] = await tx
      .select({
        ...triageFields,
        occurrences: failureClusters.occurrences,
        firstSeenRunId: failureClusters.firstSeenRunId,
        lastSeenRunId: failureClusters.lastSeenRunId,
      })
      .from(failureClusters)
      .where(eq(failureClusters.id, survivorId));
    const [victim] = await tx
      .select({
        ...triageFields,
        projectId: failureClusters.projectId,
        fingerprint: failureClusters.fingerprint,
        fingerprintSample: failureClusters.fingerprintSample,
        sampleError: failureClusters.sampleError,
        occurrences: failureClusters.occurrences,
        firstSeenRunId: failureClusters.firstSeenRunId,
        lastSeenRunId: failureClusters.lastSeenRunId,
      })
      .from(failureClusters)
      .where(eq(failureClusters.id, victimId));

    // A merge decided against with the victim (a person's rejection, a split, the
    // adjudicator's "no") holds for the survivor, which carries its failures.
    if (victim) {
      const decided = await tx
        .select()
        .from(clusterMergeSuggestions)
        .where(
          and(
            inArray(clusterMergeSuggestions.status, ['rejected', 'declined']),
            or(eq(clusterMergeSuggestions.clusterAId, victimId), eq(clusterMergeSuggestions.clusterBId, victimId)),
          ),
        );
      for (const pair of decided) {
        const otherId = pair.clusterAId === victimId ? pair.clusterBId : pair.clusterAId;
        if (otherId === survivorId) continue;
        await tx
          .insert(clusterMergeSuggestions)
          .values({
            projectId: pair.projectId,
            clusterAId: Math.min(survivorId, otherId),
            clusterBId: Math.max(survivorId, otherId),
            score: pair.score,
            method: pair.method,
            llmConfidence: pair.llmConfidence,
            llmReason: pair.llmReason,
            status: pair.status,
          })
          .onConflictDoNothing();
      }
    }

    // Record the victim's fingerprint → survivor so future failures with that
    // fingerprint attach to the survivor, and re-home any aliases that pointed
    // at the victim (keeps chained merges consistent). The alias keeps the
    // error the fingerprint was computed from, so a version bump computes it
    // again as it does the clusters'.
    if (victim) {
      await tx
        .insert(failureClusterAliases)
        .values({
          projectId: victim.projectId,
          fingerprint: victim.fingerprint,
          fingerprintSample: isSplitFingerprint(victim.fingerprint)
            ? null
            : (victim.fingerprintSample ?? victim.sampleError),
          clusterId: survivorId,
        })
        .onConflictDoNothing();
      await tx
        .update(failureClusterAliases)
        .set({ clusterId: survivorId })
        .where(eq(failureClusterAliases.clusterId, victimId));
    }
    // Tests routed to the victim follow it into the survivor.
    await tx
      .update(failureClusterTestRoutes)
      .set({ clusterId: survivorId })
      .where(eq(failureClusterTestRoutes.clusterId, victimId));

    if (survivor && victim) {
      const triage = mergedTriage(survivor, victim);
      const victimNote = victim.triageNote?.trim();
      await tx
        .update(failureClusters)
        .set({
          ...triage,
          assignee: mergedAssignee(victim.assignee),
          ...(victimNote ? { triageNote: mergedTriageNote(victimNote) } : {}),
          occurrences: (survivor.occurrences ?? 0) + (victim.occurrences ?? 0),
          firstSeenRunId: Math.min(survivor.firstSeenRunId, victim.firstSeenRunId),
          lastSeenRunId: Math.max(survivor.lastSeenRunId, victim.lastSeenRunId),
          ...touchedByOccurrence(triage.status ?? survivor.status),
        })
        .where(eq(failureClusters.id, survivorId));
    }

    await tx.delete(failureClusters).where(eq(failureClusters.id, victimId));
  });
}

/**
 * SQL: a cluster's triage note with a line appended below it: what a person
 * wrote stays, trimmed, and an empty note becomes the line. It reads the note
 * of the row the UPDATE changes, so an edit made meanwhile is kept.
 */
export function appendedTriageNote(line: string): SQL {
  const note = failureClusters.triageNote;
  return sql`case when trim(coalesce(${note}, '')) = '' then cast(${line} as text) else trim(${note}) || cast(${`\n${line}`} as text) end`;
}

/**
 * Move a cluster from triage status `from` to `to`, with a line Piwi writes
 * appended to its note, in one conditional UPDATE: nothing changes when the
 * status differs from `from` (a person triaged it meanwhile), and the line
 * joins the note as it is stored at that moment. `where` narrows the
 * condition. True when the cluster moved.
 */
export async function transitionClusterStatus(
  db: DrizzleDB,
  clusterId: number,
  move: { from: string; to: string; line: string; where?: SQL },
): Promise<boolean> {
  const moved = await db
    .update(failureClusters)
    .set({ status: move.to, triageNote: appendedTriageNote(move.line), updatedAt: new Date() })
    .where(and(eq(failureClusters.id, clusterId), eq(failureClusters.status, move.from), move.where))
    .returning({ id: failureClusters.id });
  return moved.length > 0;
}

/**
 * Recompute a cluster's occurrence counter from the test-run-cases still
 * linked to it, in the runs whose failures count as occurrences
 * (`cluster-occurrences`). Must run after the case rows have actually been
 * deleted or unlinked (not before), otherwise the count still includes rows
 * that are about to disappear.
 */
export async function recomputeClusterOccurrences(db: DrizzleDB, clusterId: number): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(and(eq(testRunsCases.failureClusterId, clusterId), eligibleRunSql('cluster-occurrences')));
  const occurrences = Number(row?.count ?? 0);

  await db.update(failureClusters).set({ occurrences }).where(eq(failureClusters.id, clusterId));
  // Only an open cluster's `updatedAt` moves (`touchedByOccurrence`): a resolved or ignored one keeps its triage time.
  await db
    .update(failureClusters)
    .set({ updatedAt: new Date() })
    .where(and(eq(failureClusters.id, clusterId), eq(failureClusters.status, 'open')));

  return occurrences;
}

/**
 * Recompute a cluster's first and last seen runs and its occurrences from the
 * executions still linked to it, in the runs whose failures count as
 * occurrences (`cluster-occurrences`): the earliest and the latest of those
 * runs by start time, then by id. With none left, the seen runs stay.
 */
export async function recomputeClusterBounds(db: DrizzleDB, clusterId: number): Promise<void> {
  const seen = (first: boolean) =>
    db
      .select({ runId: testRuns.id })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
      .where(and(eq(testRunsCases.failureClusterId, clusterId), eligibleRunSql('cluster-occurrences')))
      .orderBy(...(first ? [asc(testRuns.startTime), asc(testRuns.id)] : [desc(testRuns.startTime), desc(testRuns.id)]))
      .limit(1);
  const [[firstSeen], [lastSeen]] = await Promise.all([seen(true), seen(false)]);
  if (firstSeen && lastSeen) {
    await db
      .update(failureClusters)
      .set({ firstSeenRunId: firstSeen.runId, lastSeenRunId: lastSeen.runId })
      .where(eq(failureClusters.id, clusterId));
  }
  await recomputeClusterOccurrences(db, clusterId);
}

/**
 * Cancel stale in-progress runs for a given project + instanceId: the ones initializing or running. A finalizing
 * run is left alone: it holds every result of its run and settles once its files are in, or by the stale-run sweep.
 * Returns the cancelled runs so callers can publish their own lifecycle events.
 */
export async function cancelInstanceRuns(
  db: DrizzleDB,
  projectId: number,
  instanceId: string | null,
  excludeRunId?: number,
  isShardedRun?: boolean,
): Promise<Array<{ id: number; projectId: number }>> {
  if (!instanceId) return [];

  const conditions = [
    eq(testRuns.projectId, projectId),
    eq(testRuns.instanceId, instanceId),
    or(eq(testRuns.status, 'running'), eq(testRuns.status, 'initializing')),
  ];

  if (excludeRunId !== undefined) {
    conditions.push(ne(testRuns.id, excludeRunId));
  }

  if (isShardedRun) {
    conditions.push(isNull(testRuns.shardTotal));
  }

  return db
    .update(testRuns)
    .set({ status: 'cancelled', streamToken: null, updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: testRuns.id, projectId: testRuns.projectId });
}
