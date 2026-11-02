import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
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

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [project] = await db.insert(schema.projects).values({ name: 'cluster-occurrences' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

async function newRun() {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'running', startTime: new Date(), metadata: {}, origin: 'ci' })
    .returning();
  return run!.id;
}

/** A failed execution of `title` in the chromium project, as a streamed `complete` event maps to. */
function failure(title: string, retries = 0) {
  return {
    title,
    filePath: 'tests/checkout.spec.ts',
    status: 'failed',
    retries,
    line: 3,
    column: 1,
    browser: { projectName: 'chromium' },
    error: "Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('button', { name: 'Pay' })",
  };
}

async function occurrences(): Promise<number[]> {
  const clusters = await db.select().from(schema.failureClusters);
  return clusters.map((cluster) => cluster.occurrences);
}

describe("a failure cluster's occurrences", () => {
  test('count a batch sent again once', async () => {
    const runId = await newRun();
    const batch = [failure('pays'), failure('refunds')];

    await persistRunCases(db as never, projectId, runId, batch as never);
    expect(await persistRunCases(db as never, projectId, runId, batch as never)).toEqual([]);

    expect(await db.select().from(schema.testRunsCases)).toHaveLength(2);
    expect(await occurrences()).toEqual([2]);
  });

  test('count a row a batch repeats once', async () => {
    const runId = await newRun();

    await persistRunCases(db as never, projectId, runId, [
      failure('pays'),
      failure('pays'),
      failure('pays', 1),
    ] as never);

    expect(await db.select().from(schema.testRunsCases)).toHaveLength(2);
    expect(await occurrences()).toEqual([2]);
  });

  test('count only the stored rows when the database refuses a batch', async () => {
    await persistRunCases(db as never, projectId, await newRun(), [failure('pays')] as never);

    // No such run: the executions' insert fails on its foreign key, after the clusters were counted.
    await expect(persistRunCases(db as never, projectId, 9999, [failure('pays')] as never)).rejects.toThrow();

    expect(await occurrences()).toEqual([1]);
  });
});
