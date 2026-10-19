import { describe, test, expect, beforeAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { GlobalRunEvent } from '../../server/utils/run-events';

// The finish-time side effects are mocked: only that a settled run fires them matters here.
const runFinalizeSideEffects = vi.fn(async (_db: unknown, _id: number, _run: unknown) => {});
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects }));

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the helper.
delete process.env.PIWI_DATABASE_URL;
const { interruptStaleRuns, settleStaleFinalizingRuns, STALE_TIMEOUT_MS, FINALIZING_TIMEOUT_MS, BATCH_SHARD_WAIT_MS } =
  await import('../../server/utils/stale-runs');
const { runEventBus } = await import('../../server/utils/run-events');

let db: ReturnType<typeof drizzle<typeof schema>>;
const now = Date.now();
const stale = new Date(now - STALE_TIMEOUT_MS - 60_000);
const fresh = new Date(now - 10_000);
const abandoned = new Date(now - FINALIZING_TIMEOUT_MS - 60_000);
const shardsGone = new Date(now - BATCH_SHARD_WAIT_MS - 60_000);

// Runs 1–2 are in flight and quiet past the timeout; run 3 is finalizing and
// quiet past it too, but still within the wait for its report upload; run 4 is
// in flight but active; run 5 is quiet but already finished. Runs 6–7 are
// finalizing and their report upload never came: run 6 kept the status its
// reporter sent to /finish, run 7 has none stored. Runs 8–9 are sharded runs
// delivered by batch submissions, which wait for their other shards: run 8 is
// quiet past the timeout but within that wait, run 9 past it.
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });

  await db.insert(schema.projects).values([
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
  ]);
  const run = (id: number, projectId: number, status: string, updatedAt: Date) => ({
    id,
    projectId,
    status,
    startTime: stale,
    createdAt: stale,
    updatedAt,
    streamToken: `token-${id}`,
    totalTests: 10,
  });
  await db.insert(schema.testRuns).values([
    run(1, 1, 'running', stale),
    run(2, 2, 'initializing', stale),
    run(3, 1, 'finalizing', stale),
    run(4, 1, 'running', fresh),
    run(5, 1, 'passed', stale),
    {
      ...run(6, 2, 'finalizing', abandoned),
      streamToken: null,
      metadata: { ci: { provider: 'github' }, pendingStatus: 'passed' },
    },
    { ...run(7, 2, 'finalizing', abandoned), streamToken: null },
    { ...run(8, 2, 'running', stale), streamToken: null, shardTotal: 2, shardsFinished: 1 },
    { ...run(9, 2, 'running', shardsGone), streamToken: null, shardTotal: 2, shardsFinished: 1 },
  ]);
  await db.insert(schema.testCases).values([{ id: 1, projectId: 1, title: 'test 1', filePath: 'a.spec.ts' }]);
  await db
    .insert(schema.testRunsCases)
    .values([{ testRunId: 1, testCaseId: 1, status: 'passed', retries: 0, browserName: 'chromium' }]);
});

describe('interruptStaleRuns', () => {
  test('marks quiet in-flight runs interrupted and announces each on the global stream', async () => {
    const global: GlobalRunEvent[] = [];
    const unsubscribe = runEventBus.subscribeGlobal((event) => global.push(event));
    const finished: unknown[] = [];
    const unsubscribeRun = runEventBus.subscribe(1, (event) => finished.push(event.data));

    const reaped = await interruptStaleRuns(db, now);
    unsubscribe();
    unsubscribeRun();

    expect([...reaped].sort()).toEqual([1, 2, 9]);
    const runEvents = global.filter((e) => e.type === 'run-finished');
    expect([...runEvents].sort((a, b) => a.runId - b.runId)).toEqual([
      { type: 'run-finished', runId: 1, projectId: 1, status: 'interrupted' },
      { type: 'run-finished', runId: 2, projectId: 2, status: 'interrupted' },
      { type: 'run-finished', runId: 9, projectId: 2, status: 'interrupted' },
    ]);
    // Their day's rollup counts them as failed runs at once, not at the nightly reconcile, and says so once per project.
    const rollupEvents = global.filter((e) => e.type === 'rollup-updated');
    expect(rollupEvents.map((e) => e.projectId).sort()).toEqual([1, 2]);
    expect(global.indexOf(rollupEvents[0]!)).toBeGreaterThan(global.indexOf(runEvents[runEvents.length - 1]!));
    const rollups = await db.select().from(schema.analyticsDailyRollups);
    const failedOf = (projectId: number) =>
      rollups.filter((r) => r.projectId === projectId && r.part === 'retained').reduce((n, r) => n + r.failedRuns, 0);
    expect(failedOf(1)).toBe(1);
    expect(failedOf(2)).toBe(2);
    // The run's own stream gets the reconciled counts.
    expect(finished).toEqual([expect.objectContaining({ status: 'interrupted', totalTests: 10, passedTests: 1 })]);

    const rows = await db.select().from(schema.testRuns);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [1, 2]) {
      expect(byId.get(id)?.status).toBe('interrupted');
      // The token stays so the run's own reporter, and only it, can revive the run.
      expect(byId.get(id)?.streamToken).toBe(`token-${id}`);
    }
    for (const id of [3, 6, 7]) expect(byId.get(id)?.status).toBe('finalizing');
    expect(byId.get(4)?.status).toBe('running');
    expect(byId.get(5)?.status).toBe('passed');
    expect(byId.get(8)?.status).toBe('running');
    expect(byId.get(9)?.status).toBe('interrupted');
  });

  test('leaves nothing to announce once every stale run is reaped', async () => {
    const global: GlobalRunEvent[] = [];
    const unsubscribe = runEventBus.subscribeGlobal((event) => global.push(event));
    const reaped = await interruptStaleRuns(db, now);
    unsubscribe();

    expect(reaped).toEqual([]);
    expect(global).toEqual([]);
    const [active] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, 4));
    expect(active?.status).toBe('running');
  });
});

describe('settleStaleFinalizingRuns', () => {
  test('settles a finalizing run past the upload wait to the status its reporter sent', async () => {
    const global: GlobalRunEvent[] = [];
    const unsubscribe = runEventBus.subscribeGlobal((event) => global.push(event));
    const finished: unknown[] = [];
    const unsubscribeRun = runEventBus.subscribe(6, (event) => finished.push(event.data));

    const settled = await settleStaleFinalizingRuns(db, now);
    unsubscribe();
    unsubscribeRun();

    expect([...settled].sort()).toEqual([6, 7]);
    const rows = await db.select().from(schema.testRuns);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(6)?.status).toBe('passed');
    // The pending status leaves the metadata; the reporter's own keys stay.
    expect(byId.get(6)?.metadata).toEqual({ ci: { provider: 'github' } });
    // Nothing kept a status for run 7, so its outcome is unknown.
    expect(byId.get(7)?.status).toBe('interrupted');
    // Run 3 is still within its upload wait.
    expect(byId.get(3)?.status).toBe('finalizing');

    expect(finished).toEqual([{ status: 'passed' }]);
    expect(global.filter((e) => e.type === 'run-finished').sort((a, b) => a.runId - b.runId)).toEqual([
      { type: 'run-finished', runId: 6, projectId: 2, status: 'passed' },
      { type: 'run-finished', runId: 7, projectId: 2, status: 'interrupted' },
    ]);
    expect(runFinalizeSideEffects.mock.calls.map(([, id, run]) => [id, run])).toEqual([
      [6, { projectId: 2, metadata: { ci: { provider: 'github' } }, isFullRun: 1, status: 'passed' }],
      [7, { projectId: 2, metadata: {}, isFullRun: 1, status: 'interrupted' }],
    ]);
  });

  test('leaves nothing to settle once every abandoned run is settled', async () => {
    runFinalizeSideEffects.mockClear();
    expect(await settleStaleFinalizingRuns(db, now)).toEqual([]);
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();
  });
});
