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
  const [project] = await db.insert(schema.projects).values({ name: 'large-batch' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

function locatorSnapshot(test: number, site: number) {
  const name = `Buy ${test}-${site}`;
  return {
    location: `tests/shop.spec.ts:${test * 10 + site}:5`,
    used: { method: 'getByRole', args: ['button', { name }] },
    element: { tagName: 'button', attributes: {}, accessibleName: name, textContent: name, center: { x: 10, y: 10 } },
    alternatives: [],
  };
}

function execution(test: number) {
  return {
    title: `buys item ${test}`,
    filePath: 'tests/shop.spec.ts',
    status: 'passed',
    line: test * 10,
    column: 1,
    browser: { projectName: 'chromium', browserName: 'chromium' },
    networkRequests: [
      { method: 'GET', url: `https://app.test/items/${test}`, status: 200, resourceType: 'document' },
      { method: 'POST', url: `https://app.test/cart/${test}`, status: 201, resourceType: 'fetch' },
    ],
    locatorSnapshots: [0, 1, 2, 3].map((site) => locatorSnapshot(test, site)),
  };
}

describe('persistRunCases with a whole run in one batch', () => {
  test('stores every execution, request and locator snapshot of a batch past one statement’s parameter limit', async () => {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'passed', startTime: new Date(), metadata: {}, origin: 'ci' })
      .returning();
    const executions = Array.from({ length: 800 }, (_, i) => execution(i + 1));

    const graphWritten = new Promise<void>((resolve) => (graph.settled = resolve));
    const persisted = await persistRunCases(db as never, projectId, run!.id, executions as never);
    await graphWritten;

    expect(persisted).toHaveLength(800);
    expect(new Set(persisted.map((p) => p.inputIndex)).size).toBe(800);
    expect(await db.$count(schema.testRunsCases)).toBe(800);
    expect(await db.$count(schema.networkRequests)).toBe(1600);
    expect(await db.$count(schema.locatorSnapshots)).toBe(3200);
  });
});
