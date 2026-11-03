/**
 * Non-destructive re-fingerprinting of existing failure clusters.
 *
 * When the fingerprint algorithm changes (FINGERPRINT_VERSION bump in
 * shared/error-fingerprint.ts), clusters created under the old algorithm carry
 * stale fingerprints and would no longer match incoming failures — so new runs
 * would silently fork brand-new clusters and orphan all the triage history
 * (status, notes, diagnoses) attached to the old ones.
 *
 * This backfill recomputes each cluster's fingerprint from its immutable
 * `fingerprintSample` (the error its first failure was fingerprinted from,
 * falling back to `sampleError` for rows created before that column existed)
 * and migrates in place. Reading the frozen sample rather than the display
 * `sampleError` keeps the re-fingerprint deterministic even after the display
 * exemplar has been refreshed to a later occurrence:
 *  - unchanged fingerprint  → already current, skip (keeps the pass idempotent)
 *  - recomputed fingerprint leads to another cluster of the project (its own
 *    or an alias's) → the two merge, the one first seen earlier surviving with
 *    its triage
 *  - otherwise → update the fingerprint + derived fields on the row
 * Each merge alias is then recomputed the same way from the sample it keeps,
 * so the failures a merge sent to a cluster keep reaching it. Per-test routes
 * keyed by a changed fingerprint, a cluster's or an alias's, move to the new
 * one, or for a generic failure to those the routed test's own errors carry.
 * A cluster made by moving tests out of another has no computed
 * fingerprint and is left as-is, as is an alias with no sample.
 *
 * Runs once on startup after migrations; safe to run repeatedly.
 */

import { eq, and, asc, desc, gt, inArray, isNull, isNotNull } from 'drizzle-orm';
import {
  failureClusters,
  failureClusterAliases,
  failureClusterTestRoutes,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import { computeErrorFingerprint, isGenericFailure, type ErrorFingerprint } from '../error-fingerprint';
import { errorFingerprintV4 } from '../error-fingerprint-v4';
import { isSplitFingerprint, mergeFailureClusters } from './failure-cluster-ops';
import type { DrizzleDB } from './db';

/** The app setting that records that {@link backfillAliasSamples} ran on this instance. */
export const ALIAS_SAMPLES_BACKFILLED_SETTING = 'failure_cluster_alias_samples_backfilled_at';

/** How many executions of a cluster {@link backfillAliasSamples} reads at a time. */
const BACKFILL_PAGE_SIZE = 200;

/** How many of a routed test's most recent executions {@link routedTestFingerprints} reads. */
const ROUTED_TEST_ERROR_LIMIT = 50;

/**
 * The errors an alias of cluster `clusterId` may have been computed from: the
 * cluster's own samples, then its executions' errors, oldest first. A merge
 * moves the absorbed cluster's executions to the survivor, so they hold the
 * errors that made its fingerprint.
 */
async function* aliasSampleCandidates(db: DrizzleDB, clusterId: number): AsyncGenerator<string> {
  const [cluster] = await db
    .select({ fingerprintSample: failureClusters.fingerprintSample, sampleError: failureClusters.sampleError })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  for (const sample of new Set([cluster?.fingerprintSample, cluster?.sampleError])) if (sample) yield sample;
  let after = 0;
  for (;;) {
    const page = await db
      .select({ id: testRunsCases.id, error: testRunsCases.error })
      .from(testRunsCases)
      .where(
        and(eq(testRunsCases.failureClusterId, clusterId), gt(testRunsCases.id, after), isNotNull(testRunsCases.error)),
      )
      .orderBy(asc(testRunsCases.id))
      .limit(BACKFILL_PAGE_SIZE);
    for (const error of new Set(page.map((row) => row.error))) if (error) yield error;
    if (page.length < BACKFILL_PAGE_SIZE) return;
    after = page[page.length - 1]!.id;
  }
}

/**
 * Give each alias stored without a sample the error its fingerprint was
 * computed from: among its cluster's samples and executions, the first whose
 * fingerprint, by the algorithm that wrote the alias (`FINGERPRINT_VERSION` 4,
 * the last before aliases kept their sample), is the alias's. An alias with no
 * match keeps a null sample, and {@link reclusterFailureFingerprints} leaves it
 * as it is. Run at startup before the recluster. Returns the number of aliases
 * given a sample.
 */
export async function backfillAliasSamples(db: DrizzleDB): Promise<number> {
  const aliases = await db
    .select({
      id: failureClusterAliases.id,
      fingerprint: failureClusterAliases.fingerprint,
      clusterId: failureClusterAliases.clusterId,
    })
    .from(failureClusterAliases)
    .where(isNull(failureClusterAliases.fingerprintSample));
  // Cluster id → fingerprint → id of the alias still looking for its sample.
  const wanted = new Map<number, Map<string, number>>();
  for (const alias of aliases) {
    if (isSplitFingerprint(alias.fingerprint)) continue;
    const ofCluster = wanted.get(alias.clusterId) ?? new Map<string, number>();
    ofCluster.set(alias.fingerprint, alias.id);
    wanted.set(alias.clusterId, ofCluster);
  }

  let found = 0;
  for (const [clusterId, ofCluster] of wanted) {
    for await (const candidate of aliasSampleCandidates(db, clusterId)) {
      const fingerprint = await errorFingerprintV4(candidate);
      const aliasId = ofCluster.get(fingerprint);
      if (aliasId === undefined) continue;
      await db
        .update(failureClusterAliases)
        .set({ fingerprintSample: candidate })
        .where(eq(failureClusterAliases.id, aliasId));
      found++;
      ofCluster.delete(fingerprint);
      if (ofCluster.size === 0) break;
    }
  }
  return found;
}

/**
 * The fingerprints a routed test's failures carry, for a generic failure
 * `fp` hashes with the file it failed in: those of the test's errors in the
 * route's cluster that share `fp`'s signature, from its most recent
 * executions. Empty when none of them does.
 */
async function routedTestFingerprints(
  db: DrizzleDB,
  testCaseId: number,
  clusterId: number,
  fp: ErrorFingerprint,
): Promise<string[]> {
  const rows = await db
    .select({ error: testRunsCases.error })
    .from(testRunsCases)
    .where(
      and(
        eq(testRunsCases.failureClusterId, clusterId),
        eq(testRunsCases.testCaseId, testCaseId),
        isNotNull(testRunsCases.error),
      ),
    )
    .orderBy(desc(testRunsCases.id))
    .limit(ROUTED_TEST_ERROR_LIMIT);
  const fingerprints = new Set<string>();
  for (const error of new Set(rows.map((row) => row.error))) {
    if (!error) continue;
    const own = await computeErrorFingerprint(error);
    const sameSignature =
      own.errorType === fp.errorType && own.normalizedMessage === fp.normalizedMessage && own.selector === fp.selector;
    if (sameSignature) fingerprints.add(own.fingerprint);
  }
  return [...fingerprints];
}

/**
 * Move a project's per-test routes from one fingerprint to the one `fp`
 * computed; a route already on the new one wins. A generic failure's
 * fingerprint holds the file it failed in, so each routed test takes the
 * fingerprints of its own errors, and `fp`'s when none is stored.
 */
async function renameRouteFingerprint(
  db: DrizzleDB,
  projectId: number,
  from: string,
  fp: ErrorFingerprint,
): Promise<void> {
  const where = and(eq(failureClusterTestRoutes.projectId, projectId), eq(failureClusterTestRoutes.fingerprint, from));
  const routes = await db
    .select({ testCaseId: failureClusterTestRoutes.testCaseId, clusterId: failureClusterTestRoutes.clusterId })
    .from(failureClusterTestRoutes)
    .where(where);
  if (routes.length === 0) return;
  const generic = isGenericFailure(fp);
  const values: Array<typeof failureClusterTestRoutes.$inferInsert> = [];
  for (const { testCaseId, clusterId } of routes) {
    const own = generic ? await routedTestFingerprints(db, testCaseId, clusterId, fp) : [];
    for (const fingerprint of own.length ? own : [fp.fingerprint]) {
      values.push({ projectId, fingerprint, testCaseId, clusterId });
    }
  }
  await db.insert(failureClusterTestRoutes).values(values).onConflictDoNothing();
  await db.delete(failureClusterTestRoutes).where(where);
}

/**
 * The cluster a failure with `fingerprint` joins in project `projectId`: the
 * cluster that has it, else the one an alias with it leads to.
 */
async function clusterOf(db: DrizzleDB, projectId: number, fingerprint: string): Promise<number | null> {
  const [cluster] = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(and(eq(failureClusters.projectId, projectId), eq(failureClusters.fingerprint, fingerprint)));
  if (cluster) return cluster.id;
  const [alias] = await db
    .select({ clusterId: failureClusterAliases.clusterId })
    .from(failureClusterAliases)
    .where(and(eq(failureClusterAliases.projectId, projectId), eq(failureClusterAliases.fingerprint, fingerprint)));
  return alias?.clusterId ?? null;
}

/**
 * Merge two clusters a recomputed fingerprint shows to be one failure. The
 * cluster first seen earlier survives with its triage: the one whose first
 * seen run started first (its creation standing in for a run that is gone),
 * then the lower id. Returns the survivor.
 */
async function mergeIntoOlder(db: DrizzleDB, a: number, b: number): Promise<number> {
  const rows = await db
    .select({ id: failureClusters.id, createdAt: failureClusters.createdAt, firstSeenAt: testRuns.startTime })
    .from(failureClusters)
    .leftJoin(testRuns, eq(testRuns.id, failureClusters.firstSeenRunId))
    .where(inArray(failureClusters.id, [a, b]));
  const firstSeen = (id: number) => {
    const row = rows.find((r) => r.id === id);
    return (row?.firstSeenAt ?? row?.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  };
  const [survivor, victim] = firstSeen(a) < firstSeen(b) || (firstSeen(a) === firstSeen(b) && a < b) ? [a, b] : [b, a];
  await mergeFailureClusters(db, survivor, victim);
  return survivor;
}

/**
 * Give cluster `id` its recomputed fingerprint and the fields derived from it.
 * An alias of the cluster with that fingerprint has nothing left to lead to.
 */
async function rewriteClusterFingerprint(
  db: DrizzleDB,
  id: number,
  projectId: number,
  fp: ErrorFingerprint,
): Promise<void> {
  await db
    .delete(failureClusterAliases)
    .where(
      and(
        eq(failureClusterAliases.projectId, projectId),
        eq(failureClusterAliases.fingerprint, fp.fingerprint),
        eq(failureClusterAliases.clusterId, id),
      ),
    );
  await db
    .update(failureClusters)
    .set({ fingerprint: fp.fingerprint, signature: fp.signature, errorType: fp.errorType, selector: fp.selector })
    .where(eq(failureClusters.id, id));
}

export async function reclusterFailureFingerprints(db: DrizzleDB): Promise<{ updated: number; merged: number }> {
  let updated = 0;
  let merged = 0;

  // Clusters oldest first.
  const clusters = await db
    .select({
      id: failureClusters.id,
      projectId: failureClusters.projectId,
      fingerprint: failureClusters.fingerprint,
      sampleError: failureClusters.sampleError,
      fingerprintSample: failureClusters.fingerprintSample,
    })
    .from(failureClusters)
    .orderBy(asc(failureClusters.id));
  // The clusters a merge of this pass absorbed.
  const absorbed = new Set<number>();
  for (const cluster of clusters) {
    const { id } = cluster;
    if (absorbed.has(id) || isSplitFingerprint(cluster.fingerprint)) continue;
    // Prefer the frozen fingerprint source; older rows only have sampleError.
    const source = cluster.fingerprintSample ?? cluster.sampleError;
    if (!source) continue; // nothing to recompute from — leave as-is

    const fp = await computeErrorFingerprint(source);
    if (fp.fingerprint === cluster.fingerprint) continue; // already on the current algorithm

    // Merge before rewriting the fingerprint: rewriting first would duplicate
    // (projectId, fingerprint) and trip the unique index. A survivor other than
    // this cluster already reaches the fingerprint, as its own or an alias's.
    const owner = await clusterOf(db, cluster.projectId, fp.fingerprint);
    let survivor = id;
    if (owner !== null && owner !== id) {
      survivor = await mergeIntoOlder(db, owner, id);
      absorbed.add(survivor === id ? owner : id);
      merged++;
    }
    if (survivor === id) {
      await rewriteClusterFingerprint(db, id, cluster.projectId, fp);
      updated++;
    }
    await renameRouteFingerprint(db, cluster.projectId, cluster.fingerprint, fp);
  }

  // Then the aliases, from the sample each keeps; one with none, or with a
  // split cluster's fingerprint, stays as it is.
  const aliasRows = await db
    .select({
      id: failureClusterAliases.id,
      fingerprint: failureClusterAliases.fingerprint,
      fingerprintSample: failureClusterAliases.fingerprintSample,
    })
    .from(failureClusterAliases)
    .orderBy(asc(failureClusterAliases.id));
  for (const { id, fingerprint, fingerprintSample } of aliasRows) {
    if (!fingerprintSample || isSplitFingerprint(fingerprint)) continue;

    const fp = await computeErrorFingerprint(fingerprintSample);
    if (fp.fingerprint === fingerprint) continue;

    // Read again: a merge of this pass may have moved it to another cluster, or removed it.
    const [alias] = await db
      .select({ projectId: failureClusterAliases.projectId, clusterId: failureClusterAliases.clusterId })
      .from(failureClusterAliases)
      .where(eq(failureClusterAliases.id, id));
    if (!alias) continue;

    const owner = await clusterOf(db, alias.projectId, fp.fingerprint);
    if (owner === null) {
      await db
        .update(failureClusterAliases)
        .set({ fingerprint: fp.fingerprint })
        .where(eq(failureClusterAliases.id, id));
    } else {
      // Another cluster holds the failure too: the two are one.
      if (owner !== alias.clusterId) {
        await mergeIntoOlder(db, owner, alias.clusterId);
        merged++;
      }
      // The survivor reaches the fingerprint through the cluster or alias that has it.
      await db.delete(failureClusterAliases).where(eq(failureClusterAliases.id, id));
    }
    await renameRouteFingerprint(db, alias.projectId, fingerprint, fp);
    updated++;
  }

  return { updated, merged };
}
