import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
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
vi.stubGlobal('apiError', apiError);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const begin = (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { getBranchFailures } = await import('../../server/utils/branch-failures');
const { selectBaselineRun } = await import('../../server/utils/branch-baseline');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

const PR_METADATA = { scm: { branch: 'feature/pay', commit: 'abc123', baseBranch: 'main' } };
const ERROR = 'Error: locator.click: Timeout 5000ms exceeded.\n\n    at /ci/tests/checkout.spec.ts:8:3';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: 'sharded-branch' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

/**
 * Two shards report one run the way the reporter does: each runs global setup
 * (which sends no metadata) and then `/begin` with the run's metadata; then
 * their cases, then `/finish` per shard.
 */
async function reportShardedRun(opts: {
  beginMetadata: Record<string, unknown>;
  finishMetadata: (shard: number) => Record<string, unknown> | undefined;
}): Promise<number> {
  const shard = { instanceId: 'ci-run-42', shardTotal: 2 };
  const setups = [];
  for (const shardIndex of [1, 2]) {
    setups.push(await setup({ body: { projectName: 'sharded-branch', ...shard, shardIndex } }));
  }
  const runId = setups[0]!.runId as number;
  expect(setups[1]!.runId).toBe(runId);

  const streamTokens: string[] = [];
  for (const [i, set] of setups.entries()) {
    const began = await begin({
      params: { id: String(runId) },
      body: { setupToken: set.setupToken, totalTests: 1, metadata: opts.beginMetadata, ...shard, shardIndex: i + 1 },
    });
    streamTokens.push(began.streamToken as string);
  }

  await persistRunCases(db as never, projectId, runId, [
    {
      title: 'pays',
      filePath: 'tests/checkout.spec.ts',
      location: 'tests/checkout.spec.ts:7:1',
      line: 7,
      status: 'failed',
      error: ERROR,
      shardIndex: 1,
    },
    {
      title: 'adds',
      filePath: 'tests/cart.spec.ts',
      location: 'tests/cart.spec.ts:3:1',
      line: 3,
      status: 'passed',
      shardIndex: 2,
    },
  ] as never);

  for (const [i, streamToken] of streamTokens.entries()) {
    await finish({
      params: { id: String(runId) },
      body: {
        streamToken,
        status: i === 0 ? 'failed' : 'passed',
        duration: 1000,
        metadata: opts.finishMetadata(i + 1),
      },
    });
  }
  return runId;
}

describe('a sharded run on a pull-request branch', () => {
  test('takes its branch from /begin, and the editor and the same-branch baseline find it', async () => {
    const runId = await reportShardedRun({ beginMetadata: PR_METADATA, finishMetadata: () => PR_METADATA });

    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(run).toMatchObject({ status: 'failed', branch: 'feature/pay' });

    const failures = await getBranchFailures(db as never, projectId, 'feature/pay');
    expect(failures.run?.id).toBe(runId);
    expect(failures.failures.map((f) => f.title)).toEqual(['pays']);

    const baseline = await selectBaselineRun(db as never, {
      projectId,
      before: new Date(Date.now() + 60_000),
      branch: 'feature/pay',
      environment: null,
      fallbackBranch: 'main',
      failedFallback: true,
    });
    expect(baseline?.run.id).toBe(runId);
    expect(baseline?.match).toMatchObject({ branch: 'same', outcome: 'failed' });
  });

  test('takes its branch from a shard that finishes with it when /begin carried none', async () => {
    const runId = await reportShardedRun({
      beginMetadata: { ci: { provider: 'github' } },
      finishMetadata: (shard) => (shard === 2 ? PR_METADATA : undefined),
    });

    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
    expect(run!.branch).toBe('feature/pay');
  });
});
