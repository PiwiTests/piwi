import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { migrateToLatest } from './temp-db';
import {
  int32,
  MAX_IDENTITY_BYTES,
  MAX_INT32,
  storableSuitePath,
  storedIdentity,
  withoutNul,
} from '../../server/utils/storable-values';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

interface RouteEvent {
  params?: Record<string, string>;
  body: Record<string, unknown>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as (
  event: RouteEvent,
) => Promise<Record<string, unknown>>;
const { runEventBus } = await import('../../server/utils/run-events');
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

describe('values held to what the database stores', () => {
  test('an integer column takes a rounded number within 32 bits', () => {
    expect(int32(12.6)).toBe(13);
    expect(int32(3_000_000_000)).toBe(MAX_INT32);
    expect(int32(-3_000_000_000)).toBe(-MAX_INT32 - 1);
    expect(int32('12')).toBeNull();
    expect(int32(null)).toBeNull();
  });

  test('NUL characters leave strings and keys at any depth, and a value without one comes back as it is', () => {
    const clean = { steps: [{ title: 'click' }], n: 1 };
    expect(withoutNul(clean)).toBe(clean);
    expect(withoutNul({ text: 'a\0b', list: ['c\0', 2, null], ['k\0ey']: { deep: '\0' } })).toEqual({
      text: 'ab',
      list: ['c', 2, null],
      key: { deep: '' },
    });
  });

  test('a long identity keeps its head and the hash of the whole value, within the bytes an index entry takes', async () => {
    const head = 'renders the order summary for '.repeat(40);
    const one = await storedIdentity(`${head}order 1`);
    const two = await storedIdentity(`${head}order 2`);

    expect(one).not.toBe(two);
    expect(await storedIdentity(`${head}order 1`)).toBe(one);
    expect(one.startsWith(head.slice(0, 700))).toBe(true);
    expect(bytes(one)).toBeLessThanOrEqual(MAX_IDENTITY_BYTES);
    expect(bytes(await storedIdentity('注文の概要を表示する'.repeat(100)))).toBeLessThanOrEqual(MAX_IDENTITY_BYTES);
    expect(await storedIdentity('pays\0 the order')).toBe('pays the order');
    expect(await storedIdentity('pays the order')).toBe('pays the order');
  });

  test('a describe path too long for an index entry is stored as one level', async () => {
    expect(await storableSuitePath(['checkout', 'pay\0ment'])).toEqual(['checkout', 'payment']);
    const levels = await storableSuitePath(Array.from({ length: 40 }, (_, i) => `when the cart holds ${i} items`));
    expect(levels).toHaveLength(1);
    expect(bytes(levels![0]!)).toBeLessThanOrEqual(MAX_IDENTITY_BYTES);
  });
});

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: 'storable' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

async function newRun(extra: Partial<typeof schema.testRuns.$inferInsert> = {}) {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'running', startTime: new Date(), metadata: {}, origin: 'ci', ...extra })
    .returning();
  return run!.id;
}

describe('a run case PostgreSQL could not store as it came', () => {
  test('is stored without its NUL characters, its identity and its numbers held to their columns', async () => {
    const runId = await newRun();
    const title = `shows the receipt of ${'a very long order '.repeat(200)}`;
    const describe = Array.from({ length: 40 }, (_, i) => `when the cart holds ${i} items`);

    await persistRunCases(db as never, projectId, runId, [
      {
        title,
        filePath: 'tests/receipt.spec.ts',
        suitePath: describe,
        status: 'failed',
        line: 3,
        column: 1,
        duration: 12.4,
        timeout: 3_000_000_000,
        retries: 1,
        startedAt: 1_793_000_000_000.7,
        browser: { projectName: `chromium${'-x'.repeat(600)}` },
        error: 'Error: expected "a\0b"',
        consoleLogs: [{ type: 'log', text: 'binary \0 output' }],
        networkRequests: [
          { url: 'https://shop.test/api/orders' },
          { method: 'GET', url: 'https://shop.test/', status: 200 },
        ],
      },
    ] as never);

    const [stored] = await db
      .select()
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    const execution = stored!.test_runs_cases;
    expect(execution).toMatchObject({ duration: 12, timeout: MAX_INT32, retries: 1, startedAt: 1_793_000_000_001 });
    expect(execution.error).toBe('Error: expected "ab"');
    expect(execution.consoleLogs).toEqual([{ type: 'log', text: 'binary  output' }]);
    expect(bytes(execution.browserName!)).toBeLessThanOrEqual(MAX_IDENTITY_BYTES);
    expect(stored!.test_cases.title).toBe(await storedIdentity(title));
    expect(bytes(stored!.test_cases.suitePath)).toBeLessThanOrEqual(MAX_IDENTITY_BYTES);
    expect(await db.select().from(schema.networkRequests)).toHaveLength(1);
    const [suite] = await db.select().from(schema.testSuites);
    expect(suite!.suitePath).toBe(stored!.test_cases.suitePath);
    expect(stored!.test_cases.suiteId).toBe(suite!.id);
  });

  test('of a streamed batch is left out when a field has the wrong type, and the rest of the batch is stored', async () => {
    const streamToken = 'stream-token-of-the-run';
    const runId = await newRun({ streamToken: streamTokenDigest(streamToken) });
    runEventBus.clearRunState(runId);
    const result = (title: string, extra: Record<string, unknown> = {}) => ({
      type: 'complete',
      title,
      location: 'tests/pay.spec.ts:3:1',
      status: 'passed',
      ...extra,
    });

    await events({
      params: { id: String(runId) },
      body: { streamToken, testCases: [result('pays', { startedAt: { at: 1 } }), result('refunds')] },
    });

    const titles = await db
      .select({ title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    expect(titles).toEqual([{ title: 'refunds' }]);
  });
});

describe('a streamed result', () => {
  test('of a test with an empty title is stored, as Playwright runs it', async () => {
    const streamToken = 'stream-token-of-the-run';
    const runId = await newRun({ streamToken: streamTokenDigest(streamToken) });
    runEventBus.clearRunState(runId);

    await events({
      params: { id: String(runId) },
      body: {
        streamToken,
        testCases: [{ type: 'complete', title: '', location: 'tests/pay.spec.ts:3:1', status: 'passed' }],
      },
    });

    const titles = await db
      .select({ title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    expect(titles).toEqual([{ title: '' }]);
  });
});
