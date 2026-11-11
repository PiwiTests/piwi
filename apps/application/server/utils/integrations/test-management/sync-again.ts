/**
 * Sending a run's results again after a sync failed: the one place that looks in the test management tool for a test
 * run an earlier upload may have made. The outbox never does; a person asks for it.
 */
import { and, desc, eq } from 'drizzle-orm';
import { integrationActions } from '../../../database/schema';
import type { DbClient } from '../../../database';
import type { IntegrationAction } from '../../../database/schema';
import { readSyncState, uploadOutcomeUnknown, type SyncActionPayload } from '#shared/integrations/test-management-sync';
import type { TestManagementProvider } from './types';

/** The latest sync of a run's results that failed, or null when the run has none. */
export async function findFailedSync(db: DbClient, runId: number): Promise<IntegrationAction | null> {
  const [row] = await db
    .select()
    .from(integrationActions)
    .where(
      and(
        eq(integrationActions.kind, 'sync-results'),
        eq(integrationActions.entityType, 'test_run'),
        eq(integrationActions.entityId, runId),
        eq(integrationActions.status, 'failed'),
      ),
    )
    .orderBy(desc(integrationActions.id))
    .limit(1);
  return row ?? null;
}

/** What asking to send a failed sync again came to. */
export type RequeueOutcome =
  | { status: 'queued'; action: IntegrationAction }
  | { status: 'changed' }
  | { status: 'unsure'; reason: string };

/**
 * Queue a failed sync to be sent again. A row that holds an upload start and no test run is looked up in the tool
 * first: a test run found there is recorded on the row, so the next attempt only links it; none found clears the start,
 * so the next attempt uploads. When the tool gives no answer Piwi can trust, the row is left as it was. `changed` when
 * another request changed the row first.
 */
export async function requeueFailedSync(
  db: DbClient,
  tm: TestManagementProvider,
  action: IntegrationAction,
): Promise<RequeueOutcome> {
  const payload = action.payload as SyncActionPayload;
  const state = readSyncState(action.result);
  let result: Record<string, unknown> | null = state.runKey
    ? {
        uploadStartedAt: state.uploadStartedAt,
        runKey: state.runKey,
        runUrl: state.runUrl,
        ...(state.linked ? { linked: true } : {}),
      }
    : null;

  if (uploadOutcomeUnknown(state) && tm.findRun && payload.results.length > 0) {
    const found = await tm.findRun(payload.providerProjectKey, {
      runId: payload.runId,
      startedAt: payload.startedAt,
      testCaseKey: payload.results[0]!.key,
      name: payload.run.name,
    });
    if (found.outcome === 'unsure') return { status: 'unsure', reason: found.reason };
    if (found.outcome === 'found') {
      result = { uploadStartedAt: state.uploadStartedAt, runKey: found.run.key, runUrl: found.run.url };
    }
  }

  const [queued] = await db
    .update(integrationActions)
    .set({
      status: 'pending',
      attempts: 0,
      error: null,
      result: result as never,
      scheduledFor: new Date(),
      finishedAt: null,
    })
    .where(and(eq(integrationActions.id, action.id), eq(integrationActions.status, 'failed')))
    .returning();
  return queued ? { status: 'queued', action: queued } : { status: 'changed' };
}
