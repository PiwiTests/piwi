import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

// The feature-graph write runs after persistRunCases returns; its last step settles the promise a test waits on, so
// the database is still open when it ends.
const graph = vi.hoisted(() => ({ settled: null as null | (() => void) }));
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return {
    ...mod,
    ingestPageInventoryGraph: async (...args: Parameters<typeof mod.ingestPageInventoryGraph>) => {
      try {
        return await mod.ingestPageInventoryGraph(...args);
      } finally {
        graph.settled?.();
      }
    },
  };
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
  const [project] = await db.insert(schema.projects).values({ name: 'interrupted' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

describe('a test the run stopped', () => {
  test('keeps its error but forms no failure cluster, while a real failure of the same batch does', async () => {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'interrupted', startTime: new Date(), metadata: {}, origin: 'local' })
      .returning();
    // As Playwright reports a locator wait that Ctrl+C ended, beside an assertion that failed before it.
    const cases = [
      {
        title: 'checks out',
        filePath: 'tests/shop.spec.ts',
        status: 'interrupted',
        line: 3,
        column: 1,
        error: "Error: locator.click: Test ended.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })",
      },
      {
        title: 'shows the price',
        filePath: 'tests/shop.spec.ts',
        status: 'failed',
        line: 9,
        column: 1,
        error: 'Error: expect(received).toBe(expected)\n\nExpected: "€41.00"\nReceived: "€42.00"',
      },
    ];

    const graphWritten = new Promise<void>((resolve) => (graph.settled = resolve));
    await persistRunCases(db as never, projectId, run!.id, cases as never);
    await graphWritten;

    const rows = await db
      .select({
        status: schema.testRunsCases.status,
        error: schema.testRunsCases.error,
        clusterId: schema.testRunsCases.failureClusterId,
      })
      .from(schema.testRunsCases)
      .orderBy(schema.testRunsCases.line);
    expect(rows[0]).toMatchObject({ status: 'interrupted', clusterId: null });
    expect(rows[0]!.error).toContain('Test ended');
    expect(rows[1]!.status).toBe('failed');
    expect(rows[1]!.clusterId).not.toBeNull();
    expect(await db.$count(schema.failureClusters)).toBe(1);
  });
});
