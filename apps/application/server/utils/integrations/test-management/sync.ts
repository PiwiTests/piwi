/**
 * Sending a finished run's results to a test management tool: reading the run into the payload a sync action stores,
 * and the steps of one attempt. The outbox row that carries the attempt, its retries and the failures an attempt may
 * end in are in `../actions.ts`, which calls this; nothing here imports it.
 *
 * An upload creates a test run in the tool every time it is sent, so the row says what it did before it did it: the
 * start is written to the row's `result` before the upload, and the test run the tool names right after it. A row that
 * holds the start and no test run is an upload that may have reached the tool.
 */
import { eq } from 'drizzle-orm';
import { readTagsTruncated } from '@piwitests/core/test-meta';
import { integrationActions, testCases, testRuns, testRunsCases } from '../../../database/schema';
import type { DbClient } from '../../../database';
import type { IntegrationAction } from '../../../database/schema';
import { testCaseKeyPattern } from '#shared/handlers/test-management-summary';
import { testCaseKeys } from '#shared/integrations/test-management-mapping';
import type { ResolvedTestManagementBinding } from '#shared/integrations/test-management-binding';
import {
  buildSyncPayload,
  readSyncState,
  type SyncActionPayload,
  type SyncAttemptRow,
  type SyncState,
} from '#shared/integrations/test-management-sync';
import type { RunMetadata } from '../../run-json-types';
import { writeCreatedIssueLink } from '../entity-links';
import type { TrackerRun } from '../tracker-run';
import { readCatalogInfo, readCatalogKeysAmong } from './catalog';
import type { TestManagementProvider, TmRun } from './types';

/** A binding that can send: a connection and the tool's project. */
export type SyncBinding = ResolvedTestManagementBinding & { connectionId: number; providerProjectKey: string };

/** The reason a run's sync is not queued, or the payload it queues. */
export type PreparedSync = { skip: string; payload: unknown } | { skip: null; payload: SyncActionPayload };

/** Why a sync is not queued while the tool's test cases were never read: no key can be told from a typo. */
export const SKIP_CATALOG_NOT_READ = 'catalog not read yet';
/** Why a sync is not queued for a run none of whose tests carries a key the catalog holds. */
export const SKIP_NO_MAPPED_CASES = 'no mapped test cases';

/** The dashboard base URL, trailing slash trimmed, or null when unset. */
function siteBase(): string | null {
  const raw = process.env.PIWI_SITE_URL?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

/** The final-attempt rows and the tags of the tests of a run, as the payload reads them. */
async function readAttemptRows(db: DbClient, runId: number): Promise<SyncAttemptRow[]> {
  const rows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      tags: testRunsCases.tags,
      externalId: testCases.externalId,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(eq(testRunsCases.testRunId, runId));
  return rows.map((row) => ({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  }));
}

/**
 * Read a finished run into the payload its sync stores, or the reason it is not sent: the catalog was never read, or
 * no test of the run carries a key the catalog holds. Reads the database only.
 */
export async function prepareRunSync(db: DbClient, run: TrackerRun, binding: SyncBinding): Promise<PreparedSync> {
  const { connectionId, providerProjectKey } = binding;
  const catalog = await readCatalogInfo(db, connectionId, providerProjectKey);
  if (!catalog.fetchedAt) return { skip: SKIP_CATALOG_NOT_READ, payload: { runId: run.id } };

  const [row] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, run.id));
  const metadata = (row?.metadata ?? null) as RunMetadata | null;
  const rows = await readAttemptRows(db, run.id);
  const { pattern } = await testCaseKeyPattern(db, run.projectId, providerProjectKey);
  const carried = new Set(rows.flatMap((attempt) => testCaseKeys(attempt, pattern, binding.keySources)));
  const knownKeys = new Set(await readCatalogKeysAmong(db, connectionId, providerProjectKey, [...carried]));

  const base = siteBase();
  const runUrl = base ? `${base}/test-runs/${run.id}` : null;
  const built = buildSyncPayload({
    run: {
      runId: run.id,
      url: runUrl,
      branch: run.branch,
      environment: run.environment,
      commit: run.commit,
      startedAt: run.startedAt,
      ciBuild: metadata?.ci?.buildNumber ?? null,
    },
    rows,
    pattern,
    binding,
    knownKeys,
    tagsTruncated: readTagsTruncated((metadata as Record<string, unknown> | null)?.tagsTruncated)?.tests ?? 0,
  });
  const payload: SyncActionPayload = {
    ...built,
    runId: run.id,
    runUrl,
    providerProjectKey,
    startedAt: new Date(run.startedAt ?? Date.now()).toISOString(),
  };
  return built.results.length === 0 ? { skip: SKIP_NO_MAPPED_CASES, payload } : { skip: null, payload };
}

/** An upload that failed: the error says which call it was, so the outbox can tell whether the tool saw the results. */
export class SyncUploadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SyncUploadError';
  }
}

/** Replace the row's `result`, committed before the call that follows it. */
export async function writeSyncState(db: DbClient, id: number, state: SyncState | null): Promise<void> {
  await db
    .update(integrationActions)
    .set({ result: state as never })
    .where(eq(integrationActions.id, id));
}

/** The title of the web link a test run carries back to the run's page in Piwi. */
function runLinkTitle(runId: number): string {
  return `Piwi run #${runId}`;
}

/**
 * Send one attempt of a sync: the upload, unless the row already names the test run it made; then the link back to the
 * run's page, unless the row says it was added; and the entity link with the action's final result in one transaction.
 * The upload start is written before the call, the test run's key right after it and the link once it is added, so no
 * later step repeats them. The caller has checked that the row does not hold an upload start without a test run.
 */
export async function applySyncResults(
  db: DbClient,
  tm: TestManagementProvider,
  action: IntegrationAction,
  attempts: number,
): Promise<{ runKey: string; runUrl: string; sent: number }> {
  const payload = action.payload as SyncActionPayload;
  let state = readSyncState(action.result);
  let run: Pick<TmRun, 'key' | 'url'> & { id?: string };
  if (state.runKey) {
    run = { key: state.runKey, url: state.runUrl ?? '' };
  } else {
    if (!tm.uploadRun) throw new Error('this test management tool takes no results');
    const uploadStartedAt = Date.now();
    await writeSyncState(db, action.id, { uploadStartedAt });
    try {
      run = await tm.uploadRun({
        projectKey: payload.providerProjectKey,
        name: payload.run.name,
        description: payload.run.description,
        folderId: payload.run.folderId,
        version: payload.run.version,
        results: payload.results,
      });
    } catch (err) {
      throw new SyncUploadError(err);
    }
    state = { uploadStartedAt, runKey: run.key, runUrl: run.url };
    await writeSyncState(db, action.id, state);
  }

  if (payload.runUrl && tm.linkRun && !state.linked) {
    await tm.linkRun(run, { url: payload.runUrl, title: runLinkTitle(payload.runId) });
    await writeSyncState(db, action.id, { ...state, linked: true });
  }

  const result = { runKey: run.key, runUrl: run.url, sent: payload.results.length };
  await db.transaction(async (tx) => {
    await writeCreatedIssueLink(tx as unknown as DbClient, {
      entityType: 'test_run',
      entityId: payload.runId,
      connectionId: action.connectionId,
      createdBy: action.requestedBy ?? null,
      issue: {
        provider: tm.provider,
        url: run.url,
        key: run.key,
        externalId: run.id ?? null,
        title: payload.run.name,
        statusText: null,
        statusColor: null,
      },
    });
    await tx
      .update(integrationActions)
      .set({ status: 'done', result: result as never, error: null, attempts, finishedAt: new Date() })
      .where(eq(integrationActions.id, action.id));
  });
  return result;
}
