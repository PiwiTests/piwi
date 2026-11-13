/**
 * How a run's results sync to the test management tool stands, for the run page: the latest `sync-results` action of the
 * run, read as what a person needs (what was sent or would be, what is left out, whether the outcome is unknown).
 * Served by `GET /api/test-runs/:id/test-management-sync` and its demo mirror.
 */
import { and, desc, eq } from 'drizzle-orm';
import { integrationActions } from '../../server/database/schema';
import type { IntegrationAction } from '../../server/database/schema';
import {
  readSyncState,
  uploadOutcomeUnknown,
  type SyncActionPayload,
  type SyncCounts,
} from '../integrations/test-management-sync';
import type { DrizzleDB } from './db';

export interface RunSyncView {
  actionId: number;
  /** `pending` while an attempt is still to come (a retry is scheduled). */
  status: 'pending' | 'processing' | 'done' | 'failed' | 'skipped';
  /** Why the sync was skipped, or what the last attempt failed with. */
  error: string | null;
  /** Nothing is sent: the binding is in dry run, and the payload is what a live sync would send. */
  dryRun: boolean;
  /** The upload may have reached the tool: look there first, then send again. */
  outcomeUnknown: boolean;
  /** The test run's name in the tool. */
  runName: string | null;
  providerProjectKey: string | null;
  /** The test run the tool made, once it names it. */
  runKey: string | null;
  /** The results in the payload: sent when done, to be sent otherwise. */
  resultCount: number;
  counts: SyncCounts;
  /** Keys the tests carry that the catalog does not hold, up to 20; never sent. */
  unknownKeys: string[];
  unknownKeyCount: number;
  /** Tests that carry no key. */
  unmappedCount: number;
  /** When the last attempt ended, ISO 8601; null while one is still to come. */
  finishedAt: string | null;
  /** Attempts made so far; a pending sync with attempts and an error waits to retry. */
  attempts: number;
  /** When the next attempt is due, ISO 8601, while the sync is pending; null otherwise. */
  scheduledFor: string | null;
}

const NO_COUNTS: SyncCounts = { passed: 0, failed: 0, flaky: 0, notExecuted: 0 };

/** One sync row as the run page reads it. */
export function runSyncView(row: IntegrationAction): RunSyncView {
  const payload = (row.payload ?? {}) as Partial<SyncActionPayload>;
  const state = readSyncState(row.result);
  return {
    actionId: row.id,
    status: row.status as RunSyncView['status'],
    error: row.error ?? null,
    dryRun: payload.dryRun === true,
    outcomeUnknown: row.status === 'failed' && uploadOutcomeUnknown(state),
    runName: payload.run?.name ?? null,
    providerProjectKey: payload.providerProjectKey ?? null,
    runKey: state.runKey ?? null,
    resultCount: payload.results?.length ?? 0,
    counts: payload.counts ?? NO_COUNTS,
    unknownKeys: payload.unknownKeys ?? [],
    unknownKeyCount: payload.unknownKeyCount ?? 0,
    unmappedCount: payload.unmappedCount ?? 0,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
    attempts: row.attempts,
    scheduledFor: row.status === 'pending' && row.scheduledFor ? new Date(row.scheduledFor).toISOString() : null,
  };
}

/** The run's latest results sync, or null when none was queued or recorded. */
export async function getRunSync(db: DrizzleDB, runId: number): Promise<RunSyncView | null> {
  const [row] = await db
    .select()
    .from(integrationActions)
    .where(
      and(
        eq(integrationActions.kind, 'sync-results'),
        eq(integrationActions.entityType, 'test_run'),
        eq(integrationActions.entityId, runId),
      ),
    )
    .orderBy(desc(integrationActions.id))
    .limit(1);
  return row ? runSyncView(row) : null;
}
