import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';

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
vi.stubGlobal('durationStats', durationStats);

type Route = (event: RouteEvent) => Promise<Record<string, any>>;
const setup = (await import('../../server/api/test-runs/setup.post')).default as unknown as Route;
const start = (await import('../../server/api/test-runs/start.post')).default as unknown as Route;
const submit = (await import('../../server/api/test-runs/submit.post')).default as unknown as Route;
const begin = (await import('../../server/api/test-runs/[id]/begin.post')).default as unknown as Route;
const events = (await import('../../server/api/test-runs/[id]/events.post')).default as unknown as Route;
const finish = (await import('../../server/api/test-runs/[id]/finish.post')).default as unknown as Route;
const { runEventBus } = await import('../../server/utils/run-events');
const { shardTokenDigest } = await import('../../server/utils/shard-tokens');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { runFinalizeSideEffects } = await import('../../server/utils/run-finalize-side-effects');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const PROJECT = 'sharded-setup';
const SHARDS = { instanceId: 'ci-run-7', shardTotal: 2 };
const METADATA = { scm: { branch: 'feature/pay', commit: 'abc123' } };

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  state.db = db;
  const [project] = await db.insert(schema.projects).values({ name: PROJECT }).returning();
  testCaseCache.invalidate(project!.id);
  testSuiteCache.invalidate(project!.id);
  vi.mocked(runFinalizeSideEffects).mockClear();
});

/** A shard's global setup: `/setup`, which hands back the run and a setup token. */
async function setupShard(shardIndex: number): Promise<{ runId: number; setupToken: string }> {
  const res = await setup({ body: { projectName: PROJECT, ...SHARDS, shardIndex } });
  return { runId: res.runId, setupToken: res.setupToken };
}

/** A shard's reporter starting: `/begin` with its setup token, which hands back a stream token. */
async function beginShard(runId: number, setupToken: string, shardIndex: number): Promise<string> {
  const res = await begin({
    params: { id: String(runId) },
    body: { setupToken, totalTests: 1, metadata: METADATA, ...SHARDS, shardIndex },
  });
  return res.streamToken;
}

async function streamCase(runId: number, streamToken: string, title: string, shardIndex: number) {
  await events({
    params: { id: String(runId) },
    body: {
      streamToken,
      testCases: [
        { type: 'complete', title, location: `tests/${title}.spec.ts:1:1`, status: 'passed', duration: 10, shardIndex },
      ],
    },
  });
}

async function finishShard(runId: number, streamToken: string, durations?: number[]) {
  return finish({ params: { id: String(runId) }, body: { streamToken, status: 'passed', duration: 1000, durations } });
}

async function readRun(runId: number) {
  const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, runId));
  return run!;
}

describe('every shard of a run goes through global setup', () => {
  test('a shard begins after another shard began the run', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    expect(two.runId).toBe(one.runId);

    const tokenOne = await beginShard(one.runId, one.setupToken, 1);
    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);
    expect(tokenTwo).not.toBe(tokenOne);
    // Each shard plans one test, so the run plans two.
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', totalTests: 2 });

    await streamCase(one.runId, tokenOne, 'pays', 1);
    await streamCase(one.runId, tokenTwo, 'adds', 2);
    await finishShard(one.runId, tokenOne);
    await finishShard(one.runId, tokenTwo);

    expect(await readRun(one.runId)).toMatchObject({ status: 'passed', branch: 'feature/pay', passedTests: 2 });
  });

  test('a shard whose setup comes after another shard began joins the same run', async () => {
    const one = await setupShard(1);
    const tokenOne = await beginShard(one.runId, one.setupToken, 1);

    const two = await setupShard(2);
    expect(two.runId).toBe(one.runId);
    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);

    await finishShard(one.runId, tokenOne);
    await finishShard(one.runId, tokenTwo);
    expect((await readRun(one.runId)).status).toBe('passed');
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
  });

  test('a shard begins from the token digests stored with the run when the server holds none in memory', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    await beginShard(one.runId, one.setupToken, 1);

    runEventBus.clearRunState(one.runId);
    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);
    await streamCase(one.runId, tokenTwo, 'adds', 2);
    expect((await readRun(one.runId)).passedTests).toBe(1);
  });

  test('the run metadata stores the digests of the tokens still in use next to what /begin sent', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    const tokenOne = await beginShard(one.runId, one.setupToken, 1);

    const metadata = (await readRun(one.runId)).metadata as Record<string, unknown>;
    expect(metadata.scm).toEqual(METADATA.scm);
    expect(new Set(metadata.shardTokens as string[])).toEqual(
      new Set([shardTokenDigest(two.setupToken), shardTokenDigest(tokenOne)]),
    );

    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);
    const joined = (await readRun(one.runId)).metadata as Record<string, unknown>;
    expect(new Set(joined.shardTokens as string[])).toEqual(
      new Set([shardTokenDigest(tokenOne), shardTokenDigest(tokenTwo)]),
    );
  });

  test('a setup token opens one /begin', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    const tokenOne = await beginShard(one.runId, one.setupToken, 1);
    await beginShard(two.runId, two.setupToken, 2);

    for (const setupToken of [one.setupToken, two.setupToken]) {
      await expect(beginShard(one.runId, setupToken, 2)).rejects.toMatchObject({ statusCode: 403 });
      await expect(streamCase(one.runId, setupToken, 'adds', 2)).rejects.toMatchObject({ statusCode: 403 });
    }
    await streamCase(one.runId, tokenOne, 'pays', 1);
  });

  test('two shards that begin at once both stream on their own tokens', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    const [tokenOne, tokenTwo] = await Promise.all([
      beginShard(one.runId, one.setupToken, 1),
      beginShard(two.runId, two.setupToken, 2),
    ]);

    await streamCase(one.runId, tokenOne, 'pays', 1);
    await streamCase(one.runId, tokenTwo, 'adds', 2);
    await finishShard(one.runId, tokenOne);
    await finishShard(one.runId, tokenTwo);
    expect(await readRun(one.runId)).toMatchObject({ status: 'passed', passedTests: 2 });
  });

  test('a setup token the run never issued is rejected, from memory and from its metadata', async () => {
    const one = await setupShard(1);
    await setupShard(2);
    await beginShard(one.runId, one.setupToken, 1);

    await expect(beginShard(one.runId, 'not-a-setup-token', 2)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Invalid setup token',
    });

    runEventBus.clearRunState(one.runId);
    await expect(beginShard(one.runId, 'not-a-setup-token', 2)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('a shard begins a run the stale-run sweep marked interrupted, and its events revive it', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    await beginShard(one.runId, one.setupToken, 1);

    await db.update(schema.testRuns).set({ status: 'interrupted' }).where(eq(schema.testRuns.id, one.runId));
    runEventBus.cleanup(one.runId);

    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);
    await streamCase(one.runId, tokenTwo, 'adds', 2);
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', passedTests: 1 });
  });

  test('a cancelled run turns a shard away, so its reporter starts a new run', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    await beginShard(one.runId, one.setupToken, 1);

    await db
      .update(schema.testRuns)
      .set({ status: 'cancelled', streamToken: null })
      .where(eq(schema.testRuns.id, one.runId));

    await expect(beginShard(two.runId, two.setupToken, 2)).rejects.toMatchObject({ statusCode: 409 });
    expect((await readRun(one.runId)).totalTests).toBe(1);
  });
});

describe('a run keeps only the digest of its main token', () => {
  test('setup, begin and events work from the stored digest, which is never a usable token', async () => {
    const started = await setup({ body: { projectName: PROJECT, instanceId: 'local-1' } });
    expect((await readRun(started.runId)).streamToken).toBe(shardTokenDigest(started.setupToken));

    const began = await begin({ params: { id: String(started.runId) }, body: { setupToken: started.setupToken } });
    const stored = (await readRun(started.runId)).streamToken!;
    expect(stored).toBe(shardTokenDigest(began.streamToken));

    // The server forgets the run, as after a restart: the stored digest still authenticates.
    runEventBus.clearRunState(started.runId);
    await streamCase(started.runId, began.streamToken, 'pays', 1);
    expect((await readRun(started.runId)).passedTests).toBe(1);

    await expect(
      events({ params: { id: String(started.runId) }, body: { streamToken: stored, testCases: [] } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      finish({ params: { id: String(started.runId) }, body: { streamToken: stored, status: 'passed' } }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('shards that reach the server at once', () => {
  test('shards whose setups arrive together share one run, which keeps every setup token', async () => {
    const shards = await Promise.all(
      [1, 2, 3].map((i) => setup({ body: { projectName: PROJECT, ...SHARDS, shardTotal: 3, shardIndex: i } })),
    );

    expect(new Set(shards.map((s) => s.runId)).size).toBe(1);
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
    const metadata = (await readRun(shards[0]!.runId)).metadata as Record<string, unknown>;
    expect(new Set(metadata.shardTokens as string[])).toEqual(
      new Set(shards.map((s) => shardTokenDigest(s.setupToken))),
    );
  });

  test("shards whose starts arrive together share one run and plan every shard's tests", async () => {
    const shards = await Promise.all(
      [1, 2].map((i) => start({ body: { projectName: PROJECT, ...SHARDS, shardIndex: i, totalTests: 3 } })),
    );

    expect(shards[1]!.runId).toBe(shards[0]!.runId);
    expect(await readRun(shards[0]!.runId)).toMatchObject({ status: 'running', totalTests: 6 });
  });

  test("shards that begin together plan every shard's tests", async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    await Promise.all([beginShard(one.runId, one.setupToken, 1), beginShard(two.runId, two.setupToken, 2)]);
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', totalTests: 2 });
  });

  test("the last two shards finishing together settle the run once, with every shard's durations", async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    const tokenOne = await beginShard(one.runId, one.setupToken, 1);
    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);
    await streamCase(one.runId, tokenOne, 'pays', 1);
    await streamCase(one.runId, tokenTwo, 'adds', 2);

    await Promise.all([finishShard(one.runId, tokenOne, [10]), finishShard(one.runId, tokenTwo, [30])]);

    const run = await readRun(one.runId);
    expect(run).toMatchObject({ status: 'passed', shardsFinished: 2, passedTests: 2, avgTestDuration: 20 });
    expect((run.metadata as Record<string, unknown>).shardDurations).toEqual(expect.arrayContaining([10, 30]));
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('a shard that finishes twice counts once, so the run waits for the other shard', async () => {
    const one = await setupShard(1);
    const two = await setupShard(2);
    const tokenOne = await beginShard(one.runId, one.setupToken, 1);
    const tokenTwo = await beginShard(two.runId, two.setupToken, 2);

    await finishShard(one.runId, tokenOne);
    // tokenOne is also the run's main stream token, so it still opens /finish.
    await expect(finishShard(one.runId, tokenOne)).resolves.toMatchObject({ status: 'running' });
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', shardsFinished: 1 });
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();

    await finishShard(one.runId, tokenTwo);
    expect(await readRun(one.runId)).toMatchObject({ status: 'passed', shardsFinished: 2 });
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });
});

describe('a sharded run delivered by batch submissions', () => {
  const shardBody = (shardIndex: number, title: string, status: 'passed' | 'failed') => ({
    projectName: PROJECT,
    ...SHARDS,
    shardIndex,
    status,
    startTime: new Date().toISOString(),
    duration: 1000 * shardIndex,
    totalTests: 1,
    passedTests: status === 'passed' ? 1 : 0,
    failedTests: status === 'failed' ? 1 : 0,
    testCases: [{ title, location: `tests/${title}.spec.ts:1:1`, status, duration: 10 * shardIndex }],
  });

  test('every shard joins one run, which the last shard settles from all their executions', async () => {
    const one = await submit({ body: shardBody(1, 'pays', 'failed') });
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', shardsFinished: 1 });
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();

    const two = await submit({ body: shardBody(2, 'adds', 'passed') });
    expect(two.runId).toBe(one.runId);
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
    expect(await readRun(one.runId)).toMatchObject({
      status: 'failed',
      shardsFinished: 2,
      totalTests: 2,
      passedTests: 1,
      failedTests: 1,
      duration: 2000,
      avgTestDuration: 15,
    });
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('shards submitted together join one run and settle it once', async () => {
    const shards = await Promise.all([
      submit({ body: shardBody(1, 'pays', 'passed') }),
      submit({ body: shardBody(2, 'adds', 'passed') }),
    ]);

    expect(shards[1]!.runId).toBe(shards[0]!.runId);
    expect(await readRun(shards[0]!.runId)).toMatchObject({ status: 'passed', passedTests: 2 });
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });
});

describe('a batch delivery repeated under its delivery key', () => {
  const delivery = (deliveryKey: string, extra: Record<string, unknown> = {}) => ({
    projectName: PROJECT,
    status: 'passed',
    startTime: new Date().toISOString(),
    totalTests: 1,
    passedTests: 1,
    deliveryKey,
    testCases: [{ title: 'pays', location: 'tests/pays.spec.ts:1:1', status: 'passed', duration: 10 }],
    ...extra,
  });

  test('answers with the run its first delivery stored, sent again or at once', async () => {
    const key = 'c0ffee00-0000-4000-8000-000000000001';
    const [first, second] = await Promise.all([submit({ body: delivery(key) }), submit({ body: delivery(key) })]);
    const third = await submit({ body: delivery(key) });

    expect(second.runId).toBe(first.runId);
    expect(third).toMatchObject({ runId: first.runId, duplicate: true });
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(1);
    expect(runFinalizeSideEffects).toHaveBeenCalledTimes(1);
  });

  test('counts a shard of a batch run once', async () => {
    const shard = (key: string, shardIndex: number) => delivery(key, { ...SHARDS, shardIndex });
    const one = await submit({ body: shard('shard-one-delivery-key', 1) });
    await submit({ body: shard('shard-one-delivery-key', 1) });
    expect(await readRun(one.runId)).toMatchObject({ status: 'running', shardsFinished: 1 });

    await submit({ body: shard('shard-two-delivery-key', 2) });
    expect(await readRun(one.runId)).toMatchObject({ status: 'passed', shardsFinished: 2 });
  });

  test('a delivery with another key, or none, stores a run of its own', async () => {
    await submit({ body: delivery('first-delivery-key-0001') });
    await submit({ body: delivery('second-delivery-key-0002') });
    await submit({ body: delivery('short') });
    expect(await db.select().from(schema.testRuns)).toHaveLength(3);
  });
});
