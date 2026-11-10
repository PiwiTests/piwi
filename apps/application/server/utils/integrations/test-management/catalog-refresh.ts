/**
 * Reading the test case catalog from the tool into `test_management_cases`: the Refresh button and the hourly task share
 * {@link refreshTestManagementCatalog}. The stored catalog is read in `catalog.ts`.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { DbClient } from '../../../database';
import { projectTestManagement, testManagementCases, testManagementCatalogReads } from '../../../database/schema';
import { isProviderOfKind } from '#shared/integrations/registry';
import { IntegrationHttpError } from '../http-error';
import { connectionPausedUntil, pauseConnectionById, RATE_LIMIT_PAUSE_MS } from '../actions';
import { getConnectionRow, markConnectionFailed, recordConnectionError, testManagementForRow } from '../connections';
import { readCatalogInfo } from './catalog';
import type { PageCursor, TestManagementProvider, TmCase, TmPage } from './types';

/** A catalog older than this is read again by the hourly task. */
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The most pages one read follows (1000 cases each), so a tool that never says "last" cannot loop forever. */
export const CATALOG_MAX_PAGES = 200;

/** How many rows one statement writes: 8 columns each, well under both databases' parameter limits. */
const WRITE_CHUNK = 200;

export type CatalogRefresh =
  | { ok: true; size: number; fetchedAt: Date }
  | {
      ok: false;
      /** The HTTP status the failure answers with: 429 for a paused connection, 502 for the rest, 404 for no connection. */
      status: number;
      error: string;
      /** When a rate limited connection may be called again. */
      pausedUntil: Date | null;
    };

export interface CatalogRefreshOptions {
  now?: () => Date;
  /** How the read waits out a short rate limit; real time unless a test says otherwise. */
  sleep?: (ms: number) => Promise<void>;
}

class RateLimited extends Error {
  constructor(readonly waitMs: number) {
    super('The test management tool rate limited this connection');
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One page of cases. A 429 that asks for a wait of a minute or less is slept through and the page read once more. */
async function readPage(
  client: TestManagementProvider,
  projectKey: string,
  cursor: PageCursor,
  sleep: (ms: number) => Promise<void>,
): Promise<TmPage<TmCase>> {
  const waitOf = (err: unknown): number | null =>
    err instanceof IntegrationHttpError && err.status === 429 ? err.retryAfterMs || RATE_LIMIT_PAUSE_MS : null;
  try {
    return await client.listCases(projectKey, cursor);
  } catch (err) {
    const wait = waitOf(err);
    if (wait === null) throw err;
    if (wait > RATE_LIMIT_PAUSE_MS) throw new RateLimited(wait);
    await sleep(wait);
  }
  try {
    return await client.listCases(projectKey, cursor);
  } catch (err) {
    const wait = waitOf(err);
    throw wait === null ? err : new RateLimited(wait);
  }
}

/** Every case of the project, page by page. Nothing is written until the last page is in. */
async function readAllCases(
  client: TestManagementProvider,
  projectKey: string,
  sleep: (ms: number) => Promise<void>,
): Promise<TmCase[]> {
  const cases = new Map<string, TmCase>();
  let cursor: PageCursor = null;
  for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
    const result = await readPage(client, projectKey, cursor, sleep);
    for (const item of result.items) cases.set(item.key, item);
    if (result.next === null) return [...cases.values()];
    cursor = result.next;
  }
  throw new Error(`The project lists more than ${CATALOG_MAX_PAGES} pages of test cases`);
}

/**
 * Replace the stored catalog of one project with `cases`, read at `fetchedAt`: every case is upserted, the rows the
 * read did not see are deleted and the time of the read is recorded, in one transaction, so a reader sees the old
 * catalog or the new one and never half. A project with no cases keeps the record of the read.
 */
async function storeCatalog(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  cases: TmCase[],
  fetchedAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (let start = 0; start < cases.length; start += WRITE_CHUNK) {
      await tx
        .insert(testManagementCases)
        .values(
          cases.slice(start, start + WRITE_CHUNK).map((item) => ({
            connectionId,
            projectKey,
            key: item.key,
            providerId: item.id,
            name: item.name,
            statusName: item.status,
            folder: item.folderId,
            fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [testManagementCases.connectionId, testManagementCases.projectKey, testManagementCases.key],
          set: {
            providerId: sql`excluded.provider_id`,
            name: sql`excluded.name`,
            statusName: sql`excluded.status_name`,
            folder: sql`excluded.folder`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }
    // A row this read touched carries `fetchedAt`; any other row of the project was not seen and is gone from the tool.
    await tx
      .delete(testManagementCases)
      .where(
        and(
          eq(testManagementCases.connectionId, connectionId),
          eq(testManagementCases.projectKey, projectKey),
          ne(testManagementCases.fetchedAt, fetchedAt),
        ),
      );
    await tx
      .insert(testManagementCatalogReads)
      .values({ connectionId, projectKey, fetchedAt })
      .onConflictDoUpdate({
        target: [testManagementCatalogReads.connectionId, testManagementCatalogReads.projectKey],
        set: { fetchedAt },
      });
  });
}

const inFlight = new Map<string, Promise<CatalogRefresh>>();

/**
 * Read a project's test cases from the tool and replace the stored catalog with them. It reads every page first and
 * writes once, so a failure on any page keeps the old catalog whole. A 429 asking for a minute or less is waited out
 * once; a longer one pauses the connection (the outbox's pause) and stops. A 401 marks the connection failed; any other
 * failure is recorded on it. A read already running for the same project is shared, not repeated.
 */
export function refreshTestManagementCatalog(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  options: CatalogRefreshOptions = {},
): Promise<CatalogRefresh> {
  const id = `${connectionId}:${projectKey}`;
  const running = inFlight.get(id);
  if (running) return running;
  const read = readAndStore(db, connectionId, projectKey, options).finally(() => inFlight.delete(id));
  inFlight.set(id, read);
  return read;
}

async function readAndStore(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  options: CatalogRefreshOptions,
): Promise<CatalogRefresh> {
  const now = options.now ?? (() => new Date());
  const row = await getConnectionRow(db, connectionId);
  if (!row || !isProviderOfKind(row.provider, 'test-management')) {
    return { ok: false, status: 404, error: 'Connection not found', pausedUntil: null };
  }
  const client = testManagementForRow(row);
  if (!client) return { ok: false, status: 502, error: 'This connection has no usable credentials', pausedUntil: null };
  const paused = connectionPausedUntil(connectionId, now());
  if (paused) {
    return { ok: false, status: 429, error: `Paused until ${paused.toISOString()}: rate limited`, pausedUntil: paused };
  }

  const fetchedAt = now();
  try {
    const cases = await readAllCases(client, projectKey, options.sleep ?? realSleep);
    await storeCatalog(db, connectionId, projectKey, cases, fetchedAt);
    if (row.status !== 'failed') await recordConnectionError(db, connectionId, null);
    return { ok: true, size: cases.length, fetchedAt };
  } catch (err) {
    if (err instanceof RateLimited) {
      await pauseConnectionById(db, connectionId, err.waitMs, now());
      const pausedUntil = new Date(now().getTime() + err.waitMs);
      console.warn(
        `[integrations:test-management-catalog] connection ${connectionId} is rate limited until ${pausedUntil.toISOString()}`,
      );
      return { ok: false, status: 429, error: `Rate limited until ${pausedUntil.toISOString()}`, pausedUntil };
    }
    // The clients scrub the token from what they throw; a message of anything else holds no credential.
    const message = err instanceof Error ? err.message : 'The catalog could not be read';
    if (err instanceof IntegrationHttpError && err.status === 401)
      await markConnectionFailed(db, connectionId, message);
    else await recordConnectionError(db, connectionId, `Catalog read failed: ${message}`);
    console.warn(`[integrations:test-management-catalog] connection ${connectionId} project ${projectKey}: ${message}`);
    return { ok: false, status: 502, error: message, pausedUntil: null };
  }
}

export interface DueCatalog {
  connectionId: number;
  projectKey: string;
}

/**
 * The (connection, project) pairs of enabled bindings whose catalog the hourly task should read: the connection is a
 * test management connection with a token, not failed and not paused, and the newest case was read more than
 * {@link CATALOG_MAX_AGE_MS} ago, or the catalog was never read.
 */
export async function dueCatalogs(db: DbClient, now: Date): Promise<DueCatalog[]> {
  const pairs = await db
    .selectDistinct({
      connectionId: projectTestManagement.connectionId,
      projectKey: projectTestManagement.providerProjectKey,
    })
    .from(projectTestManagement)
    .where(eq(projectTestManagement.enabled, true));
  const due: DueCatalog[] = [];
  for (const pair of pairs) {
    if (pair.connectionId === null || pair.projectKey === null) continue;
    const row = await getConnectionRow(db, pair.connectionId);
    if (!row || !isProviderOfKind(row.provider, 'test-management') || row.status === 'failed') continue;
    if (!testManagementForRow(row) || connectionPausedUntil(pair.connectionId, now)) continue;
    const { fetchedAt } = await readCatalogInfo(db, pair.connectionId, pair.projectKey);
    if (fetchedAt === null || now.getTime() - fetchedAt.getTime() > CATALOG_MAX_AGE_MS) {
      due.push({ connectionId: pair.connectionId, projectKey: pair.projectKey });
    }
  }
  return due;
}

/** One tick of the catalog task: read each due catalog in turn. A connection that fails or pauses is left alone for the rest of the tick. */
export async function refreshDueCatalogs(
  db: DbClient,
  options: CatalogRefreshOptions = {},
): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const now = (options.now ?? (() => new Date()))();
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  const blocked = new Set<number>();
  for (const pair of await dueCatalogs(db, now)) {
    if (blocked.has(pair.connectionId)) {
      skipped += 1;
      continue;
    }
    const result = await refreshTestManagementCatalog(db, pair.connectionId, pair.projectKey, options);
    if (result.ok) refreshed += 1;
    else {
      failed += 1;
      blocked.add(pair.connectionId);
    }
  }
  return { refreshed, failed, skipped };
}
