import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { InstanceRole, ADMIN_ACCESS } from '#shared/permissions';
import { MAX_RUN_ERRORS } from '@piwitests/core/run-errors';
import type { User } from '../../server/database/schema';
import { migrateToLatest } from './temp-db';

/**
 * The errors Playwright reports outside any test (a global setup that threw, a spec that did not load, a worker's
 * teardown) reach a run through `/finish` and the batch bodies, are stored hidden and bounded, a sharded run adding
 * each shard's to the others', and come back with the run and from the MCP `get_run` tool.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db, getDialect: () => 'sqlite' }));
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
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const begin = (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const { getTestRun } = await import('#shared/handlers/test-runs');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'run-errors';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
});

/** As the reporter sends a global setup that threw: its message, the frames of its stack and its place. */
const GLOBAL_SETUP = {
  message: 'Error: global setup could not sign in at https://auth.example.test/login?token=s3cr3t-v4lue',
  stack: '    at module.exports (/repo/global-setup.ts:4:9)',
  location: { file: 'global-setup.ts', line: 4, column: 9 },
};

async function runErrorsOf(runId: number): Promise<unknown> {
  const [run] = await db
    .select({ runErrors: schema.testRuns.runErrors })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, runId));
  return run!.runErrors;
}

/** A streamed run, started and finished with `finish` as the rest of its `/finish` body. */
async function streamedRun(finishBody: Record<string, unknown>): Promise<number> {
  const { runId, streamToken } = await start({
    body: { projectName: PROJECT, startTime: '2026-11-01T10:00:00.000Z', instanceId: 'local-1' },
  });
  await finish({
    params: { id: String(runId) },
    body: { streamToken, status: 'failed', duration: 1000, totalTests: 0, ...finishBody },
  });
  return runId;
}

describe('a run’s errors outside any test, on /finish', () => {
  test('are stored with what may be a secret hidden, and come back with the run', async () => {
    const runId = await streamedRun({ runErrors: [GLOBAL_SETUP] });
    const expected = [
      {
        message: 'Error: global setup could not sign in at https://auth.example.test/login?token=<hidden>',
        stack: '    at module.exports (/repo/global-setup.ts:4:9)',
        location: { file: 'global-setup.ts', line: 4, column: 9 },
      },
    ];
    expect(await runErrorsOf(runId)).toEqual(expected);
    const run = await getTestRun(db as never, runId);
    expect(run?.status).toBe('failed');
    expect(run?.runErrors).toEqual(expected);
  });

  test('keep the first ones, each valid and with no NUL character, and are null for none', async () => {
    const many = [
      { message: 'Error: spec \u0000a.spec.ts did not load' },
      { stack: '    at x (/a.ts:1:1)' },
      ...Array.from({ length: MAX_RUN_ERRORS + 5 }, (_, i) => ({ message: `Error: worker ${i} teardown failed` })),
    ];
    const stored = (await runErrorsOf(await streamedRun({ runErrors: many }))) as Array<{ message: string }>;
    expect(stored).toHaveLength(MAX_RUN_ERRORS);
    expect(stored[0]!.message).toBe('Error: spec a.spec.ts did not load');
    expect(stored[1]!.message).toBe('Error: worker 0 teardown failed');

    expect(await runErrorsOf(await streamedRun({ runErrors: [{ message: ' ' }] }))).toBeNull();
    expect(await runErrorsOf(await streamedRun({}))).toBeNull();
  });

  test('of each shard of a sharded run join the others', async () => {
    const shards = { projectName: PROJECT, instanceId: 'ci-run-9', shardTotal: 2 };
    const tokens: string[] = [];
    let runId = 0;
    for (const shardIndex of [1, 2]) {
      const res = await setup({ body: { ...shards, shardIndex } });
      runId = res.runId;
      const begun = await begin({
        params: { id: String(runId) },
        body: { setupToken: res.setupToken, totalTests: 1, ...shards, shardIndex },
      });
      tokens.push(begun.streamToken);
    }
    for (const [i, streamToken] of tokens.entries()) {
      await finish({
        params: { id: String(runId) },
        body: {
          streamToken,
          status: 'failed',
          duration: 1000,
          shardIndex: i + 1,
          shardTotal: 2,
          runErrors: [{ message: `Error: shard ${i + 1}: No tests found` }],
        },
      });
    }
    expect(await runErrorsOf(runId)).toEqual([
      { message: 'Error: shard 1: No tests found', stack: null, location: null },
      { message: 'Error: shard 2: No tests found', stack: null, location: null },
    ]);
  });
});

describe('a run’s errors outside any test, in a batch body', () => {
  const batch = (extra: Record<string, unknown>) =>
    submit({
      body: {
        projectName: PROJECT,
        status: 'failed',
        startTime: '2026-11-01T10:00:00.000Z',
        duration: 1000,
        totalTests: 0,
        ...extra,
      },
    });

  test('are stored with the run it creates', async () => {
    const { runId } = await batch({ runErrors: [GLOBAL_SETUP] });
    expect(await runErrorsOf(runId)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('?token=<hidden>') }),
    ]);
  });

  test('of each shard of a sharded batch run join the others', async () => {
    const shards = { instanceId: 'ci-run-10', shardTotal: 2 };
    const one = await batch({ ...shards, shardIndex: 1, runErrors: [{ message: 'Error: webServer did not start' }] });
    const two = await batch({ ...shards, shardIndex: 2, runErrors: [{ message: 'Error: No tests found' }] });
    expect(two.runId).toBe(one.runId);
    expect((await runErrorsOf(one.runId)) as Array<{ message: string }>).toEqual([
      expect.objectContaining({ message: 'Error: webServer did not start' }),
      expect.objectContaining({ message: 'Error: No tests found' }),
    ]);
  });
});

describe('the MCP get_run tool', () => {
  test('lists the run’s errors outside any test, each message cut for an agent, with its place', async () => {
    const runId = await streamedRun({
      runErrors: [GLOBAL_SETUP, { message: `Error: ${'x'.repeat(600)}` }],
    });
    const getRun = MCP_TOOLS.find((tool) => tool.name === 'get_run')!.handler;
    const ctx = {
      user: { id: 0, role: InstanceRole.ADMINISTRATOR } as User,
      access: ADMIN_ACCESS,
      scope: 'all' as const,
    };
    const answer = (await getRun(db as never, { runId }, ctx)) as { runErrors: Array<Record<string, unknown>> };
    expect(answer.runErrors[0]).toEqual({
      message: 'Error: global setup could not sign in at https://auth.example.test/login?token=<hidden>',
      stack: '    at module.exports (/repo/global-setup.ts:4:9)',
      filePath: 'global-setup.ts',
      line: 4,
      column: 9,
    });
    expect(String(answer.runErrors[1]!.message)).toHaveLength(401);
  });
});
