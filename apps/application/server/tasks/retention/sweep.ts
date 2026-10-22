import { getDatabase } from '../../database';
import {
  capDiagnosisVersions,
  DEFAULT_ASSISTANT_RETENTION_DAYS,
  DEFAULT_REPORT_RETENTION_DAYS,
  deleteRunsOlderThan,
  pruneHealActions,
  pruneIntegrationActions,
  pruneAssistantConversations,
  pruneNotificationDeliveries,
  pruneReportSnapshots,
  reclaimSpace,
  retentionMinRuns,
  sweepOrphans,
} from '../../utils/retention';
import { reclaimOrphanTraceBlobs, reclaimOrphanTraceResources } from '../../utils/delete-run-files';
import { reconcileRecentRollups } from '#shared/handlers/analytics/rollups';
import { pruneOutcomesOlderThan } from '../../utils/outcomes';
import { pruneMcpToolCalls } from '../../utils/mcp/write-log';
import { pruneMcpOAuth } from '../../utils/mcp-oauth';

/** Days of retained rollup rows the sweep recomputes before pruning. */
const RECONCILE_DAYS = 7;

function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export default defineTask({
  meta: {
    name: 'retention:sweep',
    description:
      'Reconcile the recent daily rollups, prune old test runs and hand-back outcomes (opt-in via PIWI_RETENTION_DAYS; kept runs and the newest PIWI_RETENTION_MIN_RUNS per project stay, and the pruned numbers stay in the rollups), settled notification deliveries, report snapshots older than PIWI_RETENTION_REPORT_DAYS, assistant conversations idle for PIWI_ASSISTANT_RETENTION_DAYS, excess diagnosis versions, trace blobs no execution has linked for a day, and expired MCP OAuth connections',
  },
  async run() {
    const db = await getDatabase();
    const result: Record<string, unknown> = {};

    // Destructive run pruning is strictly opt-in: unset or 0 = keep everything.
    // Kept runs and each project's newest runs are never pruned.
    const retentionDays = envInt('PIWI_RETENTION_DAYS');

    // Recompute the retained rollup rows of the last days before pruning, so a
    // write path that missed the ingest hook is corrected while its runs exist.
    const reconcileDays = retentionDays && retentionDays > 0 ? Math.min(RECONCILE_DAYS, retentionDays) : RECONCILE_DAYS;
    try {
      const reconciled = await reconcileRecentRollups(db, reconcileDays);
      if (reconciled > 0) result.rollupCellsReconciled = reconciled;
    } catch (err) {
      console.error('[retention:sweep] rollup reconcile failed', err);
    }
    if (retentionDays && retentionDays > 0) {
      const { deletedRuns, deletedCases, skippedKept, skippedNewest } = await deleteRunsOlderThan(db, retentionDays, {
        keepNewestPerProject: retentionMinRuns(),
      });
      result.deletedRuns = deletedRuns;
      result.deletedCases = deletedCases;
      if (skippedKept > 0) result.keptRunsSkipped = skippedKept;
      if (skippedNewest > 0) result.newestRunsSkipped = skippedNewest;

      // Hand-back outcomes follow run retention; their daily counters stay.
      const outcomesPruned = await pruneOutcomesOlderThan(db, retentionDays);
      if (outcomesPruned > 0) result.outcomesPruned = outcomesPruned;
    }

    const orphans = await sweepOrphans(db);
    const orphanTotal = Object.values(orphans).reduce((a, b) => a + b, 0);
    if (orphanTotal > 0) result.orphansRemoved = orphanTotal;

    // Delete trace blobs no execution links (past a day's grace), then shared
    // trace resources nothing references any more (in fully-indexed projects).
    const orphanBlobs = await reclaimOrphanTraceBlobs(db);
    if (orphanBlobs > 0) result.orphanTraceBlobsRemoved = orphanBlobs;
    const orphanResources = await reclaimOrphanTraceResources(db);
    if (orphanResources > 0) result.orphanResourcesRemoved = orphanResources;

    const notificationDays = envInt('PIWI_RETENTION_NOTIFICATION_DAYS') ?? 30;
    if (notificationDays > 0) {
      const pruned = await pruneNotificationDeliveries(db, notificationDays);
      if (pruned > 0) result.deliveriesPruned = pruned;
    }

    const reportDays = envInt('PIWI_RETENTION_REPORT_DAYS') ?? DEFAULT_REPORT_RETENTION_DAYS;
    if (reportDays > 0) {
      const pruned = await pruneReportSnapshots(db, reportDays);
      if (pruned > 0) result.reportSnapshotsPruned = pruned;
    }

    const assistantDays = envInt('PIWI_ASSISTANT_RETENTION_DAYS') ?? DEFAULT_ASSISTANT_RETENTION_DAYS;
    if (assistantDays > 0) {
      const pruned = await pruneAssistantConversations(db, assistantDays);
      if (pruned > 0) result.assistantConversationsPruned = pruned;
    }

    const keepVersions = envInt('PIWI_RETENTION_DIAGNOSIS_VERSIONS') ?? 20;
    if (keepVersions > 0) {
      const pruned = await capDiagnosisVersions(db, keepVersions);
      if (pruned > 0) result.diagnosisVersionsPruned = pruned;
    }

    // Reuse the notification-outbox horizon for settled heal actions.
    if (notificationDays > 0) {
      const pruned = await pruneHealActions(db, notificationDays);
      if (pruned > 0) result.healActionsPruned = pruned;
    }

    // …and for settled integration actions.
    if (notificationDays > 0) {
      const pruned = await pruneIntegrationActions(db, notificationDays);
      if (pruned > 0) result.integrationActionsPruned = pruned;
    }

    // …and for the agents' write log.
    if (notificationDays > 0) {
      const pruned = await pruneMcpToolCalls(db, notificationDays);
      if (pruned > 0) result.mcpToolCallsPruned = pruned;
    }

    // MCP clients' OAuth connections whose refresh token expired, with their API keys.
    const oauthEnded = await pruneMcpOAuth(db);
    if (oauthEnded > 0) result.mcpOAuthGrantsEnded = oauthEnded;

    const space = await reclaimSpace(db);
    if (space.attempted) result.spaceReclaim = space.note;

    if (Object.keys(result).length > 0) {
      console.info(`[retention:sweep] ${JSON.stringify(result)}`);
    }
    return { result };
  },
});
