import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { HIDDEN_VALUE } from '@piwitests/core/mask';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { reclusterFailureFingerprints } = await import('../../shared/handlers/failure-cluster-recluster');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [project] = await db.insert(schema.projects).values({ name: 'recluster-ingest' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

async function ingestFailure(error: string): Promise<number | null> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'failed', startTime: new Date(), metadata: {}, origin: 'ci' })
    .returning();
  const failure = { title: 'saves the order', filePath: 'tests/orders.spec.ts', status: 'failed', line: 3, column: 1 };
  const [stored] = await persistRunCases(db as never, projectId, run!.id, [{ ...failure, error }] as never);
  const [row] = await db
    .select({ clusterId: schema.testRunsCases.failureClusterId })
    .from(schema.testRunsCases)
    .where(eq(schema.testRunsCases.id, stored!.id));
  return row!.clusterId;
}

describe('a failure longer than the sample its cluster keeps', () => {
  test('fingerprints the same at ingest and in the recluster, so it never forks its cluster', async () => {
    // A value of 60,000 characters, then the call log naming the locator: the cluster's sample stops before it.
    const error = `Error: the order could not be saved\n${'x'.repeat(60_000)}\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })`;

    const clusterId = await ingestFailure(error);
    expect(clusterId).not.toBeNull();

    expect(await reclusterFailureFingerprints(db as unknown as DbClient)).toEqual({ updated: 0, merged: 0 });
    expect(await ingestFailure(error)).toBe(clusterId);
    expect(await db.$count(schema.failureClusters)).toBe(1);
  });
});

/** A failure whose message names a bearer token, built from parts so no scanner reads it as a live one. */
const refused = (token: string) =>
  `Error: the order was refused for ${['Bearer ', token].join('')}\n    at tests/orders.spec.ts:9:1`;

describe('a failure that holds a credential', () => {
  test('fingerprints its hidden text at ingest and in the recluster, so another token joins its cluster', async () => {
    const clusterId = await ingestFailure(refused('Zm9vYmFyYmF6cXV4MQ'));
    expect(clusterId).not.toBeNull();
    const [cluster] = await db.select().from(schema.failureClusters);
    expect(cluster!.fingerprintSample).toBe(
      `Error: the order was refused for ${HIDDEN_VALUE}\n    at tests/orders.spec.ts:9:1`,
    );

    expect(await reclusterFailureFingerprints(db as unknown as DbClient)).toEqual({ updated: 0, merged: 0 });
    expect(await ingestFailure(refused('Zm9vYmFyYmF6cXV4Mg'))).toBe(clusterId);
    expect(await db.$count(schema.failureClusters)).toBe(1);
  });
});
