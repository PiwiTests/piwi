import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * A test found by the names a client sends, whether its identity is stored whole (its file, describe path and title
 * fit an index entry together) or shortened (they do not): the lookups of a running test's history, of the
 * reporter's failure links (`/test-runs/:id/locate`) and of the MCP coverage tools.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({ getCurrentUser: async () => null, isAuthEnabled: () => false }));
// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

interface LocateEvent {
  params: Record<string, string>;
  query: Record<string, string>;
}

vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('setResponseStatus', () => {});
vi.stubGlobal('getRouterParam', (event: LocateEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: LocateEvent) => event.query);
vi.stubGlobal('sendRedirect', (_event: LocateEvent, location: string) => ({ redirect: location }));

const { runningTestHistory } = await import('../../shared/handlers/stuck-tests');
const { resolveTestByTitle } = await import('../../shared/handlers/coverage-insights');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { MAX_IDENTITY_BYTES, MAX_TEST_IDENTITY_BYTES } = await import('../../server/utils/storable-values');
const locate = (await import('../../server/routes/test-runs/[id]/locate.get')).default as unknown as (
  event: LocateEvent,
) => Promise<unknown>;

let db: ReturnType<typeof drizzle<typeof schema>>;

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const PROJECT = 'Desktop Chrome';

/** A test whose title is longer than a shortened identity keeps, while its whole identity fits an index entry. */
const WHOLE = {
  filePath: 'orders.spec.ts',
  suitePath: ['checkout'],
  title: `checks the order ${'with every line item and its discount '.repeat(40)}`,
};

/** A test whose file, describe path and title are each long, and too long together for an index entry. */
const SHORTENED = {
  filePath: `tests/${'orders/'.repeat(150)}order.spec.ts`,
  suitePath: Array.from({ length: 40 }, (_, i) => `when the cart holds ${i} items`),
  title: `checks the order ${'with every line item and its discount '.repeat(30)}`,
};

/** One passing execution of `test`, stored as ingest stores it; its execution and its test case. */
async function storePassing(test: typeof WHOLE) {
  const [stored] = await persistRunCases(db as never, 1, 1, [
    { ...test, status: 'passed', duration: 1200, line: 3, column: 1, retries: 0, browser: { projectName: PROJECT } },
  ] as never);
  return stored!;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

describe("a test's identity", () => {
  test('is the one a test stored whole before keeps, when it fits an index entry', async () => {
    expect(bytes(WHOLE.title)).toBeGreaterThan(MAX_IDENTITY_BYTES);
    const [existing] = await db
      .insert(schema.testCases)
      .values({ projectId: 1, filePath: WHOLE.filePath, suitePath: 'checkout', title: WHOLE.title })
      .returning();

    const stored = await storePassing(WHOLE);

    expect(stored.testCaseId).toBe(existing!.id);
    expect(await db.select().from(schema.testCases)).toHaveLength(1);
  });

  test.each([
    ['stored whole', WHOLE],
    ['shortened', SHORTENED],
  ])('%s is found by the names a client sends', async (shape, test) => {
    const together = bytes(test.filePath) + bytes(test.suitePath.join('\x1f')) + bytes(test.title);
    expect(together > MAX_TEST_IDENTITY_BYTES).toBe(shape === 'shortened');
    const stored = await storePassing(test);

    const history = await runningTestHistory(db as never, { projectId: 1, ...test, browserName: PROJECT });
    expect(history.passingDurations).toEqual([1200]);

    const link = await locate({
      params: { id: '1' },
      query: { file: test.filePath, title: test.title, retry: '0', browser: PROJECT },
    });
    expect(link).toEqual({ redirect: `/test-run-cases/${stored.id}` });

    expect(await resolveTestByTitle(db as never, 1, test.filePath, test.title)).toBe(stored.testCaseId);
  });

  test('stored shortened keeps the names the database holds within an index entry', async () => {
    const stored = await storePassing(SHORTENED);

    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.id, stored.testCaseId));
    expect(bytes(testCase!.filePath) + bytes(testCase!.suitePath) + bytes(testCase!.title)).toBeLessThanOrEqual(
      MAX_TEST_IDENTITY_BYTES,
    );
  });
});
