import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { MAX_TEST_TAGS } from '@piwitests/core/test-meta';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

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

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const begin = (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { addBatchShard, batchShardRun, batchShardTally } = await import('../../server/utils/sharded-runs');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PROJECT = 'tags-truncated-ingest';
const A = { filePath: 'tests/a.spec.ts', title: 'A', dropped: 1 };
const B = { filePath: 'tests/b.spec.ts', title: 'B', dropped: 2 };
const tagList = (count: number) => Array.from({ length: count }, (_, i) => `@SHOP-T${i + 1}`);

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

async function storedTagsTruncated(runId: number): Promise<unknown> {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return (run!.metadata as Record<string, unknown> | null)?.tagsTruncated;
}

describe('metadata.tagsTruncated', () => {
  test('counts once when the reporter sends it on /begin and again on /finish', async () => {
    const report = { tests: 30, examples: [A, B] };
    const set = await setup({ body: { projectName: PROJECT, instanceId: 'local-1' } });
    const runId = set.runId as number;
    const began = await begin({
      params: { id: String(runId) },
      body: { setupToken: set.setupToken, totalTests: 2, metadata: { tagsTruncated: report } },
    });
    await finish({
      params: { id: String(runId) },
      body: { streamToken: began.streamToken, status: 'passed', duration: 10, metadata: { tagsTruncated: report } },
    });
    expect(await storedTagsTruncated(runId)).toEqual(report);
  });

  test("adds each streamed shard's tests up", async () => {
    const shard = { instanceId: 'ci-run-7', shardTotal: 2 };
    const setups = [];
    for (const shardIndex of [1, 2]) setups.push(await setup({ body: { projectName: PROJECT, ...shard, shardIndex } }));
    const runId = setups[0]!.runId as number;
    const reports = [
      { tests: 3, examples: [A] },
      { tests: 2, examples: [B] },
    ];
    for (const [i, set] of setups.entries()) {
      await begin({
        params: { id: String(runId) },
        body: {
          setupToken: set.setupToken,
          totalTests: 1,
          metadata: { tagsTruncated: reports[i] },
          ...shard,
          shardIndex: i + 1,
        },
      });
    }
    expect(await storedTagsTruncated(runId)).toEqual({ tests: 5, examples: [A, B] });
  });

  test("counts a later shard's report once when the first shard sent none", async () => {
    const shard = { instanceId: 'ci-run-9', shardTotal: 2 };
    const setups = [];
    for (const shardIndex of [1, 2]) setups.push(await setup({ body: { projectName: PROJECT, ...shard, shardIndex } }));
    const runId = setups[0]!.runId as number;
    const examples = Array.from({ length: 20 }, (_, i) => ({
      filePath: 'tests/b.spec.ts',
      title: `t${i}`,
      dropped: 1,
    }));
    const metadata = [{}, { tagsTruncated: { tests: 25, examples } }];
    for (const [i, set] of setups.entries()) {
      await begin({
        params: { id: String(runId) },
        body: { setupToken: set.setupToken, totalTests: 1, metadata: metadata[i], ...shard, shardIndex: i + 1 },
      });
    }
    expect(await storedTagsTruncated(runId)).toEqual({ tests: 25, examples });
  });

  test("adds each batch shard's tests up, the first shard's once", async () => {
    const reports = [
      { tests: 3, examples: [A] },
      { tests: 2, examples: [B] },
    ];
    let runId = 0;
    for (const [i, tagsTruncated] of reports.entries()) {
      const body = {
        projectName: PROJECT,
        startTime: new Date().toISOString(),
        duration: 10,
        status: 'passed',
        shardTotal: 2,
        shardIndex: i + 1,
        metadata: { tagsTruncated },
      };
      const run = await batchShardRun(db as never, projectId, 'ci-run-8', body as never);
      runId = run.id;
      await addBatchShard(db as never, run.id, batchShardTally(body as never, []));
    }
    expect(await storedTagsTruncated(runId)).toEqual({ tests: 5, examples: [A, B] });
  });

  test('records the tests of a payload sent without the reporter whose raw tags pass the limit', async () => {
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId, status: 'running', startTime: new Date(), metadata: {} })
      .returning();
    const execution = (title: string, tags: string[], retries = 0) => ({
      title,
      filePath: 'tests/cart.spec.ts',
      line: 4,
      column: 1,
      status: 'passed',
      retries,
      tags,
    });
    await persistRunCases(db as never, projectId, run!.id, [
      execution('covers many cases', tagList(MAX_TEST_TAGS + 4)),
      execution('covers many cases', tagList(MAX_TEST_TAGS + 4), 1),
      execution('fits', tagList(MAX_TEST_TAGS)),
    ] as never);
    const report = await storedTagsTruncated(run!.id);
    // The same batch sent again stores no execution and adds no test.
    await persistRunCases(db as never, projectId, run!.id, [
      execution('covers many cases', tagList(MAX_TEST_TAGS + 4)),
    ] as never);
    expect(await storedTagsTruncated(run!.id)).toEqual(report);
    expect(report).toEqual({
      tests: 1,
      examples: [{ filePath: 'tests/cart.spec.ts', title: 'covers many cases', line: 4, dropped: 4 }],
    });
    const stored = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, run!.id));
    expect(stored.every((row) => (row.tags as string[]).length <= MAX_TEST_TAGS)).toBe(true);
  });
});
