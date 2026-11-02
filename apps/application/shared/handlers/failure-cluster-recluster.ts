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
 * `fingerprintSample` (the raw error captured at creation, falling back to
 * `sampleError` for rows created before that column existed) and migrates in
 * place. Reading the frozen sample rather than the display `sampleError` keeps
 * the re-fingerprint deterministic even after the display exemplar has been
 * refreshed to a later occurrence:
 *  - unchanged fingerprint  → already current, skip (keeps the pass idempotent)
 *  - fingerprint now equals another cluster in the same project → merge into it
 *    (the older/lower id wins so the longest-lived triage state survives)
 *  - otherwise → update the fingerprint + derived fields on the row
 * Per-test routes keyed by a changed fingerprint move to the new one. A cluster
 * made by moving tests out of another has no computed fingerprint and is left
 * as-is.
 *
 * Runs once on startup after migrations; safe to run repeatedly.
 */

import { eq, and, ne, asc, gt, isNull, isNotNull } from 'drizzle-orm';
import {
  failureClusters,
  failureClusterAliases,
  failureClusterTestRoutes,
  testRunsCases,
} from '../../server/database/schema';
import { computeErrorFingerprint } from '../error-fingerprint';
import { isSplitFingerprint, mergeFailureClusters } from './failure-cluster-ops';
import type { DrizzleDB } from './db';

/** The app setting that records that {@link backfillAliasSamples} ran on this instance. */
export const ALIAS_SAMPLES_BACKFILLED_SETTING = 'failure_cluster_alias_samples_backfilled_at';

/** How many executions of a cluster {@link backfillAliasSamples} reads at a time. */
const BACKFILL_PAGE_SIZE = 200;

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
 * fingerprint, by the algorithm that wrote the alias, is the alias's. An alias
 * with no match keeps a null sample, and {@link reclusterFailureFingerprints}
 * leaves it as it is. Run at startup before the recluster. Returns the number
 * of aliases given a sample.
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
      const { fingerprint } = await computeErrorFingerprint(candidate);
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

/** Move a project's per-test routes from one fingerprint to another; a route already on the new one wins. */
async function renameRouteFingerprint(db: DrizzleDB, projectId: number, from: string, to: string): Promise<void> {
  const where = and(eq(failureClusterTestRoutes.projectId, projectId), eq(failureClusterTestRoutes.fingerprint, from));
  const routes = await db
    .select({ testCaseId: failureClusterTestRoutes.testCaseId, clusterId: failureClusterTestRoutes.clusterId })
    .from(failureClusterTestRoutes)
    .where(where);
  if (routes.length === 0) return;
  await db
    .insert(failureClusterTestRoutes)
    .values(routes.map((r) => ({ projectId, fingerprint: to, testCaseId: r.testCaseId, clusterId: r.clusterId })))
    .onConflictDoNothing();
  await db.delete(failureClusterTestRoutes).where(where);
}

export async function reclusterFailureFingerprints(db: DrizzleDB): Promise<{ updated: number; merged: number }> {
  // Process oldest-first so a re-fingerprinted cluster that becomes the merge
  // target already exists by the time later duplicates are visited.
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

  let updated = 0;
  let merged = 0;

  for (const cluster of clusters) {
    // Prefer the frozen fingerprint source; older rows only have sampleError.
    const source = cluster.fingerprintSample ?? cluster.sampleError;
    if (!source) continue; // nothing to recompute from — leave as-is
    if (isSplitFingerprint(cluster.fingerprint)) continue;

    const fp = await computeErrorFingerprint(source);
    if (fp.fingerprint === cluster.fingerprint) continue; // already on the current algorithm

    const [survivor] = await db
      .select({ id: failureClusters.id })
      .from(failureClusters)
      .where(
        and(
          eq(failureClusters.projectId, cluster.projectId),
          eq(failureClusters.fingerprint, fp.fingerprint),
          ne(failureClusters.id, cluster.id),
        ),
      );

    if (survivor) {
      // Keep the lower id so the longest-lived cluster (and its triage) wins.
      // Merge BEFORE rewriting the fingerprint: updating the row first could
      // momentarily duplicate (projectId, fingerprint) and trip the unique index.
      const [keep, drop] = survivor.id < cluster.id ? [survivor.id, cluster.id] : [cluster.id, survivor.id];
      await mergeFailureClusters(db, keep, drop);
      merged++;
      await renameRouteFingerprint(db, cluster.projectId, cluster.fingerprint, fp.fingerprint);
      // The surviving row may still hold the old fingerprint (when it was this
      // cluster). Normalize it to the current algorithm — safe now that the
      // duplicate is gone.
      await db
        .update(failureClusters)
        .set({
          fingerprint: fp.fingerprint,
          signature: fp.signature,
          errorType: fp.errorType,
          selector: fp.selector,
          updatedAt: new Date(),
        })
        .where(eq(failureClusters.id, keep));
      continue;
    }

    await db
      .update(failureClusters)
      .set({
        fingerprint: fp.fingerprint,
        signature: fp.signature,
        errorType: fp.errorType,
        selector: fp.selector,
        updatedAt: new Date(),
      })
      .where(eq(failureClusters.id, cluster.id));
    await renameRouteFingerprint(db, cluster.projectId, cluster.fingerprint, fp.fingerprint);
    updated++;
  }

  return { updated, merged };
}
