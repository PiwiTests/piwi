import { and, count, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getDialect } from '../database';
import type { DbClient } from '../database';
import {
  analyticsDashboards,
  casePayloads,
  coverageFragments,
  coverageReports,
  entityLinks,
  failureClusters,
  failureDiagnoses,
  failureDiagnosisVersions,
  files,
  handbackOutcomes,
  healActions,
  integrationActions,
  locatorSnapshots,
  networkRequests,
  notificationDeliveries,
  reportSnapshots,
  runCoverage,
  runLocatorBreaks,
  shareLinks,
  subscriptions,
  testRuns,
  testRunsCases,
} from '../database/schema';
import { deleteFileRow, deleteRunStorageDir, gcTraceBlobs } from './delete-run-files';
import { deleteGraphRowsForRuns } from './graph-ingest';
import { unreferencedFragments } from './coverage';
import { recomputeClusterOccurrences } from '#shared/handlers/failure-cluster-ops';
import { archiveRunsIntoRollups, recomputeRollupCells } from '#shared/handlers/analytics/rollups';
import { dayKey } from '#shared/handlers/analytics/common';
import type { DrizzleDB } from '#shared/handlers/db';
import { deleteDashboardRows } from '#shared/handlers/dashboards';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Max ids per IN (...) list — stays well under SQLite's bound-variable limit. */
const ID_BATCH_SIZE = 500;

function* batches<T>(items: T[], size = ID_BATCH_SIZE): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

/**
 * Runs deleted per transaction: each slice archives, deletes and recomputes its own runs, so the rollups
 * are exact at every commit, and a first purge of years of history never holds SQLite's write lock (or a
 * long PostgreSQL transaction) for the whole aggregation while runs keep arriving.
 */
const PURGE_SLICE_RUNS = 100;

export interface DeleteRunsResult {
  deletedRuns: number;
  deletedCases: number;
}

/**
 * Delete a set of test runs by id, including their stored files, their
 * deduplicated trace blobs (once nothing else references them) and every
 * dependent row. The single deletion path shared by the per-run delete endpoint
 * and the age-based sweep, so both behave identically.
 *
 * Child rows are deleted explicitly, in FK order, rather than relying on
 * ON DELETE actions: SQLite foreign-key enforcement is a per-connection
 * pragma that not every client opening the file sets, and file/blob cleanup
 * needs the rows before they disappear. The result is identical on both
 * dialects.
 *
 * Trace-blob storage is freed by {@link gcTraceBlobs} AFTER the `files` rows are
 * gone, so a blob shared by several deleted rows (or by another run) is counted
 * correctly.
 *
 * The daily rollups follow in the transaction that deletes the run rows: the
 * retained rows of the touched days are recomputed from the runs that stay.
 * With `archiveRollups` (age-based deletion) the deleted runs' numbers are
 * first added to their cells' archived rows, so the day keeps them; without it
 * (deleting a run by hand) the run's numbers leave the day.
 */
export async function deleteRunsByIds(
  db: DbClient,
  runIds: number[],
  options: { archiveRollups?: boolean; sliceRuns?: number } = {},
): Promise<DeleteRunsResult> {
  if (runIds.length === 0) return { deletedRuns: 0, deletedCases: 0 };

  const runs: { id: number; projectId: number; startTime: Date }[] = [];
  for (const batch of batches(runIds)) {
    runs.push(
      ...(await db
        .select({ id: testRuns.id, projectId: testRuns.projectId, startTime: testRuns.startTime })
        .from(testRuns)
        .where(inArray(testRuns.id, batch))),
    );
  }
  if (runs.length === 0) return { deletedRuns: 0, deletedCases: 0 };
  const presentRunIds = runs.map((r) => r.id);

  const runsCases: { id: number; failureClusterId: number | null }[] = [];
  for (const batch of batches(presentRunIds)) {
    runsCases.push(
      ...(await db
        .select({ id: testRunsCases.id, failureClusterId: testRunsCases.failureClusterId })
        .from(testRunsCases)
        .where(inArray(testRunsCases.testRunId, batch))),
    );
  }
  const caseIds = runsCases.map((c) => c.id);
  const affectedClusterIds = [...new Set(runsCases.filter((c) => c.failureClusterId).map((c) => c.failureClusterId!))];

  // Content-addressed payloads referenced by the doomed rows — candidates for
  // GC once the rows are gone (other runs may still reference them).
  const candidatePayloadIds = new Set<number>();
  for (const batch of batches(caseIds)) {
    const refs = await db
      .select({
        aria: testRunsCases.ariaSnapshotPayloadId,
        ariaJson: testRunsCases.ariaSnapshotJsonPayloadId,
        source: testRunsCases.testSourcePayloadId,
        frames: testRunsCases.testSourceFramesPayloadId,
        inventory: testRunsCases.pageInventoryPayloadId,
        locatorPages: testRunsCases.locatorPagesPayloadId,
        codeReach: testRunsCases.codeReachPayloadId,
        coverage: testRunsCases.coveragePayloadId,
      })
      .from(testRunsCases)
      .where(inArray(testRunsCases.id, batch));
    for (const ref of refs) {
      if (ref.aria != null) candidatePayloadIds.add(ref.aria);
      if (ref.ariaJson != null) candidatePayloadIds.add(ref.ariaJson);
      if (ref.source != null) candidatePayloadIds.add(ref.source);
      if (ref.frames != null) candidatePayloadIds.add(ref.frames);
      if (ref.inventory != null) candidatePayloadIds.add(ref.inventory);
      if (ref.locatorPages != null) candidatePayloadIds.add(ref.locatorPages);
      if (ref.codeReach != null) candidatePayloadIds.add(ref.codeReach);
      if (ref.coverage != null) candidatePayloadIds.add(ref.coverage);
    }
  }

  // Files: delete each row's own storage, delete the rows, then GC any trace
  // blob those rows were the last to reference. The blob ids are collected
  // before deletion but reference-counted after, so the count is honest.
  const candidateBlobIds: Array<number | null> = [];
  for (const batch of batches(caseIds)) {
    const caseFiles = await db.select().from(files).where(inArray(files.testRunsCaseId, batch));
    for (const file of caseFiles) {
      candidateBlobIds.push(file.blobId);
      await deleteFileRow(file);
    }
    await db.delete(files).where(inArray(files.testRunsCaseId, batch));
  }
  for (const batch of batches(presentRunIds)) {
    const runFiles = await db.select().from(files).where(inArray(files.testRunId, batch));
    for (const file of runFiles) {
      candidateBlobIds.push(file.blobId);
      await deleteFileRow(file);
    }
    await db.delete(files).where(inArray(files.testRunId, batch));
  }
  await gcTraceBlobs(db, candidateBlobIds);

  // Sweep each run's storage directory to remove any run-scoped object not
  // tracked in `files` (or orphaned by an earlier failed cleanup). Shared
  // deduplicated blobs and trace resources live outside these directories.
  for (const run of runs) {
    await deleteRunStorageDir(run.projectId, run.id);
  }

  // Dependent rows of the doomed cases/runs.
  for (const batch of batches(presentRunIds)) {
    await db.delete(networkRequests).where(inArray(networkRequests.testRunId, batch));
    await db.delete(entityLinks).where(inArray(entityLinks.testRunId, batch));
    await db.delete(runLocatorBreaks).where(inArray(runLocatorBreaks.runId, batch));
    await db.delete(runCoverage).where(inArray(runCoverage.runId, batch));
  }
  for (const batch of batches(caseIds)) {
    await db.delete(entityLinks).where(inArray(entityLinks.testRunsCaseId, batch));
  }

  // Execution-scoped diagnoses (and their version history) die with the case.
  const doomedDiagnosisIds: number[] = [];
  for (const batch of batches(caseIds)) {
    const rows = await db
      .select({ id: failureDiagnoses.id })
      .from(failureDiagnoses)
      .where(inArray(failureDiagnoses.testRunsCaseId, batch));
    doomedDiagnosisIds.push(...rows.map((r) => r.id));
  }
  for (const batch of batches(doomedDiagnosisIds)) {
    await db.delete(failureDiagnosisVersions).where(inArray(failureDiagnosisVersions.diagnosisId, batch));
  }
  for (const batch of batches(caseIds)) {
    await db.delete(failureDiagnosisVersions).where(inArray(failureDiagnosisVersions.testRunsCaseId, batch));
  }
  for (const batch of batches(doomedDiagnosisIds)) {
    await db.delete(failureDiagnoses).where(inArray(failureDiagnoses.id, batch));
  }

  // Locator snapshots survive their run; only the pointer is cleared.
  for (const batch of batches(presentRunIds)) {
    await db
      .update(locatorSnapshots)
      .set({ lastSeenRunId: null })
      .where(inArray(locatorSnapshots.lastSeenRunId, batch));
  }

  // Hand-back outcomes follow their own age cutoff (`pruneOutcomesOlderThan`); only the run pointer is cleared.
  for (const batch of batches(presentRunIds)) {
    await db.update(handbackOutcomes).set({ runId: null }).where(inArray(handbackOutcomes.runId, batch));
  }

  // A project's day in as few slices as possible, so each day is recomputed about once.
  const ordered = [...runs].sort(
    (a, b) => a.projectId - b.projectId || new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );
  for (const slice of batches(ordered, options.sliceRuns ?? PURGE_SLICE_RUNS)) {
    const sliceIds = slice.map((run) => run.id);
    const touchedDays = slice.map((run) => ({ projectId: run.projectId, day: dayKey(run.startTime) }));
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as DrizzleDB;
      if (options.archiveRollups) await archiveRunsIntoRollups(txDb, sliceIds);
      for (const batch of batches(sliceIds)) {
        await tx.delete(testRunsCases).where(inArray(testRunsCases.testRunId, batch));
      }
      for (const batch of batches(sliceIds)) {
        await tx.delete(testRuns).where(inArray(testRuns.id, batch));
      }
      await recomputeRollupCells(txDb, touchedDays);
    });
  }

  // Graph nodes/edges whose newest evidence was a deleted run, per project, so
  // the feature-graph tables never point at runs that no longer exist.
  const runIdsByProject = new Map<number, number[]>();
  for (const run of runs) {
    const list = runIdsByProject.get(run.projectId) ?? [];
    list.push(run.id);
    runIdsByProject.set(run.projectId, list);
  }
  for (const [projectId, ids] of runIdsByProject) {
    await deleteGraphRowsForRuns(db, projectId, ids);
  }

  // GC payloads no longer referenced by any surviving execution row.
  for (const batch of batches([...candidatePayloadIds])) {
    await db.delete(casePayloads).where(and(inArray(casePayloads.id, batch), payloadUnreferenced())!);
  }

  for (const clusterId of affectedClusterIds) {
    await recomputeClusterOccurrences(db, clusterId);
  }

  return { deletedRuns: presentRunIds.length, deletedCases: caseIds.length };
}

/**
 * Newest runs per project that age-based pruning always leaves in place
 * (`PIWI_RETENTION_MIN_RUNS`); 0 means no floor.
 */
export function retentionMinRuns(): number {
  const n = Number(process.env.PIWI_RETENTION_MIN_RUNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface AgedRunsResult extends DeleteRunsResult {
  /** Runs past the cutoff left in place because they are kept forever. */
  skippedKept: number;
  /** Runs past the cutoff left in place because they are among their project's newest. */
  skippedNewest: number;
}

/**
 * Predicate: the run is not among the newest `keep` runs of its project, by
 * start time. Ranked over every run of the project, kept or not.
 */
function notAmongNewest(keep: number): SQL {
  return sql`${testRuns.id} NOT IN (
    SELECT id FROM (
      SELECT ${sql.identifier('id')} AS id,
        row_number() OVER (
          PARTITION BY ${sql.identifier('project_id')}
          ORDER BY ${sql.identifier('start_time')} DESC, ${sql.identifier('id')} DESC
        ) AS rn
      FROM ${testRuns}
    ) ranked WHERE rn <= ${keep}
  )`;
}

/**
 * Delete the test runs older than the cutoff that nothing protects. A run is
 * protected when it is kept forever (`kept_at` set), or when it is among the
 * newest `keepNewestPerProject` runs of its project — so a project that stops
 * reporting keeps its last runs instead of emptying. Thin wrapper over
 * {@link deleteRunsByIds}, which owns the full deletion; age-based deletion is
 * archival, so the deleted runs' numbers move to the rollups' archived rows.
 */
export async function deleteRunsOlderThan(
  db: DbClient,
  olderThanDays: number,
  options: { keepNewestPerProject?: number } = {},
): Promise<AgedRunsResult> {
  const cutoffDate = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const keepNewest = Math.max(0, Math.floor(options.keepNewestPerProject ?? 0));
  const aged = lt(testRuns.startTime, cutoffDate);

  const conditions = [aged, isNull(testRuns.keptAt)];
  if (keepNewest > 0) conditions.push(notAmongNewest(keepNewest));
  const doomed = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(...conditions));

  const [agedTotal] = await db.select({ n: count() }).from(testRuns).where(aged);
  const [agedKept] = await db
    .select({ n: count() })
    .from(testRuns)
    .where(and(aged, isNotNull(testRuns.keptAt)));
  const skippedKept = Number(agedKept?.n ?? 0);
  const skippedNewest = Number(agedTotal?.n ?? 0) - skippedKept - doomed.length;

  const deleted = await deleteRunsByIds(
    db,
    doomed.map((r) => r.id),
    { archiveRollups: true },
  );
  return { ...deleted, skippedKept, skippedNewest };
}

/**
 * Predicate: no surviving `test_runs_cases` row references the payload
 * through any of its payload columns. One NOT EXISTS probe per column, so
 * each hits its partial index.
 */
function payloadUnreferenced(): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.ariaSnapshotPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.ariaSnapshotJsonPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.testSourcePayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.testSourceFramesPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.pageInventoryPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.locatorPagesPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.codeReachPayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.coveragePayloadId} = ${casePayloads.id})
    AND NOT EXISTS (SELECT 1 FROM ${coverageReports} WHERE ${coverageReports.inventoryPayloadId} = ${casePayloads.id})`;
}

export interface OrphanSweepResult {
  networkRequests: number;
  entityLinks: number;
  diagnoses: number;
  diagnosisVersions: number;
  notificationDeliveries: number;
  casePayloads: number;
  coverageFragments: number;
  shareLinks: number;
  dashboards: number;
}

async function countWhere(db: DbClient, table: SQLiteTable, where: SQL): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(table)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete rows whose parent is already gone. Databases that ran deletes before
 * foreign-key enforcement was enabled (or before the delete paths removed
 * every child table) can hold such orphans; this sweep is idempotent and
 * set-based, so it is safe to run on every retention pass.
 */
export async function sweepOrphans(db: DbClient): Promise<OrphanSweepResult> {
  const orphanedNetworkRequests = sql`NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.id} = ${networkRequests.testRunsCaseId})`;
  const orphanedCaseLinks = sql`${entityLinks.testRunsCaseId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.id} = ${entityLinks.testRunsCaseId})`;
  const orphanedRunLinks = sql`${entityLinks.testRunId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.id} = ${entityLinks.testRunId})`;
  const orphanedDiagnoses = sql`${failureDiagnoses.testRunsCaseId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.id} = ${failureDiagnoses.testRunsCaseId})`;
  const orphanedVersions = sql`NOT EXISTS (SELECT 1 FROM ${failureDiagnoses} WHERE ${failureDiagnoses.id} = ${failureDiagnosisVersions.diagnosisId})`;
  const orphanedDeliveries = sql`${notificationDeliveries.subscriptionId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.id} = ${notificationDeliveries.subscriptionId})`;
  // Age gate: a payload is upserted moments before the rows that reference it,
  // so a concurrent sweep must not reap rows from an in-flight ingest batch.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const orphanedPayloads = and(lt(casePayloads.createdAt, oneHourAgo), payloadUnreferenced())!;
  // Coverage fragments no test's coverage and no remaining execution can reference.
  const orphanedFragments = unreferencedFragments();
  // `share_links.entity_id` is polymorphic over four tables and carries no FK,
  // so a link whose entity was pruned or deleted lingers until this sweep removes
  // it (a snapshot's and a dashboard's links go with them; this is the safety net).
  const orphanedShareLinks = sql`(${shareLinks.entityKind} = 'execution' AND NOT EXISTS (SELECT 1 FROM ${testRunsCases} WHERE ${testRunsCases.id} = ${shareLinks.entityId}))
    OR (${shareLinks.entityKind} = 'cluster' AND NOT EXISTS (SELECT 1 FROM ${failureClusters} WHERE ${failureClusters.id} = ${shareLinks.entityId}))
    OR (${shareLinks.entityKind} = 'report' AND NOT EXISTS (SELECT 1 FROM ${reportSnapshots} WHERE ${reportSnapshots.id} = ${shareLinks.entityId}))
    OR (${shareLinks.entityKind} = 'dashboard' AND NOT EXISTS (SELECT 1 FROM ${analyticsDashboards} WHERE ${analyticsDashboards.id} = ${shareLinks.entityId}))`;
  // A private dashboard whose owner was deleted has no one left who can open it; a shared one stays.
  const orphanedDashboards = and(eq(analyticsDashboards.visibility, 'private'), isNull(analyticsDashboards.ownerId))!;

  const result: OrphanSweepResult = {
    networkRequests: await countWhere(db, networkRequests, orphanedNetworkRequests),
    entityLinks:
      (await countWhere(db, entityLinks, orphanedCaseLinks)) + (await countWhere(db, entityLinks, orphanedRunLinks)),
    diagnoses: await countWhere(db, failureDiagnoses, orphanedDiagnoses),
    diagnosisVersions: await countWhere(db, failureDiagnosisVersions, orphanedVersions),
    notificationDeliveries: await countWhere(db, notificationDeliveries, orphanedDeliveries),
    casePayloads: await countWhere(db, casePayloads, orphanedPayloads),
    coverageFragments: await countWhere(db, coverageFragments, orphanedFragments),
    shareLinks: await countWhere(db, shareLinks, orphanedShareLinks),
    dashboards: await countWhere(db, analyticsDashboards, orphanedDashboards),
  };

  await db.delete(networkRequests).where(orphanedNetworkRequests);
  await db.delete(entityLinks).where(orphanedCaseLinks);
  await db.delete(entityLinks).where(orphanedRunLinks);
  // Diagnoses first: their version rows then match the orphaned-versions
  // predicate below (and cascade directly where FK enforcement is active).
  await db.delete(failureDiagnoses).where(orphanedDiagnoses);
  await db.delete(failureDiagnosisVersions).where(orphanedVersions);
  await db.delete(notificationDeliveries).where(orphanedDeliveries);
  await db.delete(casePayloads).where(orphanedPayloads);
  await db.delete(coverageFragments).where(orphanedFragments);
  await db.delete(shareLinks).where(orphanedShareLinks);
  if (result.dashboards > 0) await deleteDashboardRows(db as unknown as DrizzleDB, orphanedDashboards);

  return result;
}

/**
 * Delete outbox rows that finished dispatching (sent/failed/skipped) before
 * the cutoff. Pending rows are never touched. The outbox is otherwise
 * append-only — without pruning it grows one row per event × channel forever.
 */
export async function pruneNotificationDeliveries(db: DbClient, olderThanDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  // Typed operators bind the Date correctly for each dialect (ms integer on
  // SQLite, timestamp on PostgreSQL).
  const settled = and(
    inArray(notificationDeliveries.status, ['sent', 'failed', 'skipped']),
    lt(notificationDeliveries.createdAt, cutoffDate),
  )!;
  const pruned = await countWhere(db, notificationDeliveries, settled);
  if (pruned > 0) await db.delete(notificationDeliveries).where(settled);
  return pruned;
}

/** Days a report snapshot is kept when `PIWI_RETENTION_REPORT_DAYS` is unset. */
export const DEFAULT_REPORT_RETENTION_DAYS = 365;

/**
 * Delete report snapshots generated before the cutoff. A snapshot is a frozen
 * quality report of a few tens of kilobytes; its schedule stays.
 */
export async function pruneReportSnapshots(db: DbClient, olderThanDays: number): Promise<number> {
  const old = lt(reportSnapshots.generatedAt, new Date(Date.now() - olderThanDays * MS_PER_DAY));
  const pruned = await countWhere(db, reportSnapshots, old);
  if (pruned > 0) {
    // A report link has no FK to its snapshot: it goes with it.
    await db
      .delete(shareLinks)
      .where(
        and(
          eq(shareLinks.entityKind, 'report'),
          inArray(shareLinks.entityId, db.select({ id: reportSnapshots.id }).from(reportSnapshots).where(old)),
        ),
      );
    await db.delete(reportSnapshots).where(old);
  }
  return pruned;
}

/**
 * Delete auto-heal actions that settled (merged/closed/failed/skipped) before the
 * cutoff. Pending, processing and opened actions are never touched: they still
 * have work to do, or hold an open PR that counts toward the cap and keeps its
 * edit from being proposed twice. The DB row is only a record of what Piwi did;
 * deleting it never affects the PR itself, which lives in the user's repository.
 */
export async function pruneHealActions(db: DbClient, olderThanDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const settled = and(
    inArray(healActions.status, ['merged', 'closed', 'failed', 'skipped']),
    lt(healActions.updatedAt, cutoffDate),
  )!;
  const pruned = await countWhere(db, healActions, settled);
  if (pruned > 0) await db.delete(healActions).where(settled);
  return pruned;
}

/**
 * Delete integration actions that finished (done/failed/skipped) before the
 * cutoff. Pending actions are never touched. The row is only a record of what
 * Piwi wrote to the tracker; deleting it never touches the issue itself.
 */
export async function pruneIntegrationActions(db: DbClient, olderThanDays: number): Promise<number> {
  const cutoffDate = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const settled = and(
    inArray(integrationActions.status, ['done', 'failed', 'skipped']),
    lt(integrationActions.finishedAt, cutoffDate),
  )!;
  const pruned = await countWhere(db, integrationActions, settled);
  if (pruned > 0) await db.delete(integrationActions).where(settled);
  return pruned;
}

/**
 * Keep only the newest `keep` history snapshots per diagnosis. Every
 * re-diagnose appends a version row, so long-lived clusters accumulate them
 * without bound.
 */
export async function capDiagnosisVersions(db: DbClient, keep: number): Promise<number> {
  const overflow = sql`${failureDiagnosisVersions.id} IN (
    SELECT id FROM (
      SELECT ${sql.identifier('id')} AS id,
        row_number() OVER (
          PARTITION BY ${sql.identifier('diagnosis_id')}
          ORDER BY ${sql.identifier('created_at')} DESC, ${sql.identifier('id')} DESC
        ) AS rn
      FROM ${failureDiagnosisVersions}
    ) ranked WHERE rn > ${keep}
  )`;
  const pruned = await countWhere(db, failureDiagnosisVersions, overflow);
  if (pruned > 0) await db.delete(failureDiagnosisVersions).where(overflow);
  return pruned;
}

export interface ReclaimSpaceResult {
  attempted: boolean;
  note: string;
}

/**
 * Give freed pages back to the filesystem after a bulk delete.
 *
 * SQLite: checkpoints the WAL and runs an incremental vacuum (effective only
 * when the database was created with auto_vacuum enabled — fresh databases
 * are; for older ones pass `full: true` to run a blocking full VACUUM).
 * PostgreSQL: a no-op — autovacuum owns space reuse there.
 */
export async function reclaimSpace(db: DbClient, options: { full?: boolean } = {}): Promise<ReclaimSpaceResult> {
  if (getDialect() === 'postgres') {
    return { attempted: false, note: 'PostgreSQL reclaims space via autovacuum' };
  }
  if (options.full) {
    await db.run(sql`VACUUM`);
    return { attempted: true, note: 'full VACUUM completed' };
  }
  await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  const autoVacuum = await db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`);
  if (autoVacuum?.auto_vacuum) {
    await db.run(sql`PRAGMA incremental_vacuum`);
    return { attempted: true, note: 'incremental vacuum completed' };
  }
  return {
    attempted: false,
    note: 'auto_vacuum is disabled on this database; run cleanup with vacuum:true to reclaim space',
  };
}
