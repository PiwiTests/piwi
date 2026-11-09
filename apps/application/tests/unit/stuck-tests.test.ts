import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { STUCK_FLOOR_MS, stuckAttempt, stuckThresholdMs } from '../../shared/stuck-tests';

delete process.env.PIWI_DATABASE_URL;
/** What each `test.stuck` notification the check sent says. */
const notices = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../server/utils/notifications/emit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    if (event === 'test.stuck') notices.push(payload);
  },
}));
const { checkStuckTests } = await import('../../server/utils/stuck-tests');
const { runEventBus } = await import('../../server/utils/run-events');
const { testStopRunEvent } = await import('../../server/utils/live-case-events');

describe('when a running test is stuck', () => {
  test('past both the floor and three times its longest pass among enough passes', () => {
    expect(stuckThresholdMs([])).toBeNull();
    expect(stuckThresholdMs([8000])).toBeNull();
    expect(stuckThresholdMs([8000, 6000])).toBe(STUCK_FLOOR_MS);
    expect(stuckThresholdMs([60_000, 50_000])).toBe(180_000);
    expect(stuckAttempt(STUCK_FLOOR_MS + 1, [8000, 6000])).toEqual({ elapsedMs: STUCK_FLOOR_MS + 1, usualMs: 8000 });
    expect(stuckAttempt(STUCK_FLOOR_MS, [8000, 6000])).toBeNull();
    expect(stuckAttempt(170_000, [60_000, 50_000])).toBeNull();
    expect(stuckAttempt(10 * 60_000, [8000])).toBeNull();
  });
});

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const now = Date.UTC(2026, 9, 30, 12);
/** The live run, and the test running in it as its begin event names it. */
const LIVE_RUN = 10;
const begin = (extra: Record<string, unknown> = {}) => ({
  title: 'pays with PayPal',
  filePath: 'tests/checkout.spec.ts',
  suitePath: ['Checkout'],
  location: 'tests/checkout.spec.ts:12:3',
  workerIndex: 1,
  shardIndex: null,
  startedAt: now - 5 * 60_000,
  browser: { projectName: 'chromium' },
  repeatEachIndex: 0,
  ...extra,
});

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values({
    id: 1,
    projectId: 1,
    filePath: 'tests/checkout.spec.ts',
    suitePath: 'Checkout',
    title: 'pays with PayPal',
  });
  // Three earlier runs where it passed in 8 s at most on chromium.
  for (const [i, duration] of [6000, 8000, 7000].entries()) {
    await db.insert(schema.testRuns).values({
      id: i + 1,
      projectId: 1,
      status: 'passed',
      isFullRun: true,
      startTime: new Date(now - (i + 2) * 86_400_000),
    });
    await db.insert(schema.testRunsCases).values({
      testRunId: i + 1,
      testCaseId: 1,
      status: 'passed',
      duration,
      browserName: 'chromium',
    });
  }
  await db.insert(schema.testRuns).values({
    id: LIVE_RUN,
    projectId: 1,
    status: 'running',
    startTime: new Date(now),
    origin: 'ci',
    metadata: { piwiOrigin: { kind: 'ci' } },
  });
  runEventBus.cleanup(LIVE_RUN);
  notices.length = 0;
});

/** The `test-stuck` events the run's stream gets while `body` runs. */
async function stuckEvents(body: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  const off = runEventBus.subscribe(LIVE_RUN, (event) => {
    if (event.type === 'test-stuck') events.push(event.data);
  });
  try {
    await body();
  } finally {
    off();
  }
  return events;
}

describe('the stuck check of a live run', () => {
  test('tells a running test past its threshold once, on the run stream and with its begin payload', async () => {
    const data = begin();
    runEventBus.recordRunningCase(LIVE_RUN, 'k', data);
    const events = await stuckEvents(async () => {
      expect(await checkStuckTests(db as never, now)).toBe(1);
      expect(await checkStuckTests(db as never, now + 30_000)).toBe(0);
    });
    expect(events).toEqual([
      {
        title: 'pays with PayPal',
        location: 'tests/checkout.spec.ts:12:3',
        browser: { projectName: 'chromium' },
        repeatEachIndex: 0,
        elapsedMs: 5 * 60_000,
        usualMs: 8000,
      },
    ]);
    // A page that connects later reads it from the running case, with the time the last check counted.
    expect(runEventBus.getRunningCases(LIVE_RUN)[0]).toMatchObject({
      stuck: { elapsedMs: 5 * 60_000 + 30_000, usualMs: 8000 },
    });
    expect(notices.map((n) => [n.runId, n.testTitle, n.origin])).toEqual([[LIVE_RUN, 'pays with PayPal', 'ci']]);
  });

  test.each(['local', 'desktop', 'editor', 'preflight', 'bug'])(
    "a %s run's long attempt is marked Stuck? and sends no test.stuck",
    async (kind) => {
      await db
        .update(schema.testRuns)
        .set({ origin: kind, metadata: { piwiOrigin: { kind } } })
        .where(eq(schema.testRuns.id, LIVE_RUN));
      runEventBus.recordRunningCase(LIVE_RUN, 'k', begin());
      const events = await stuckEvents(() => checkStuckTests(db as never, now));
      expect(events.map((e) => e.title)).toEqual(['pays with PayPal']);
      expect(notices).toEqual([]);
    },
  );

  test("names the attempt's worker process and lane in its notification", async () => {
    runEventBus.recordRunningCase(LIVE_RUN, 'k', begin({ workerIndex: 4, parallelIndex: 1, shardIndex: 2 }));
    runEventBus.recordRunningCase(LIVE_RUN, 'old', begin({ title: 'pays with a gift card', workerIndex: 3 }));
    await db.insert(schema.testCases).values({
      id: 2,
      projectId: 1,
      filePath: 'tests/checkout.spec.ts',
      suitePath: 'Checkout',
      title: 'pays with a gift card',
    });
    for (const runId of [1, 2]) {
      await db
        .insert(schema.testRunsCases)
        .values({ testRunId: runId, testCaseId: 2, status: 'passed', duration: 6000, browserName: 'chromium' });
    }
    await checkStuckTests(db as never, now);
    expect(notices.map((n) => [n.testTitle, n.workerIndex, n.parallelIndex, n.shardIndex])).toEqual([
      ['pays with PayPal', 4, 1, 2],
      ['pays with a gift card', 3, undefined, undefined],
    ]);
  });

  test('leaves out the time a test stood stopped, and never marks one while it stands stopped', async () => {
    const data = begin();
    runEventBus.recordRunningCase(LIVE_RUN, 'k', data);
    const stop = {
      reason: 'breakpoint',
      title: 'Click',
      file: 'tests/checkout.spec.ts',
      line: 18,
      bar: true,
      since: now - 60_000,
      pausedMs: 0,
    };
    const of = { title: 'pays with PayPal', location: 'tests/checkout.spec.ts:12:3' };
    testStopRunEvent({ type: 'test-stopped', ...of, stop } as never, data);
    expect(await stuckEvents(() => checkStuckTests(db as never, now))).toEqual([]);

    // It went on after four of its five minutes stopped: one minute ran, under the floor.
    testStopRunEvent({ type: 'test-resumed', ...of, pausedMs: 4 * 60_000 } as never, data);
    expect(await stuckEvents(() => checkStuckTests(db as never, now))).toEqual([]);
    // Four minutes later it has run five, its stop left out.
    const later = await stuckEvents(() => checkStuckTests(db as never, now + 4 * 60_000));
    expect(later.map((e) => e.elapsedMs)).toEqual([5 * 60_000]);
  });

  test("leaves the running attempt as it is for a stop of the test's earlier attempt", async () => {
    const data = begin({ retries: 1 });
    runEventBus.recordRunningCase(LIVE_RUN, 'k', data);
    const of = { title: 'pays with PayPal', location: 'tests/checkout.spec.ts:12:3', retries: 0 };
    const stop = { reason: 'pause', title: 'Click', file: null, line: null, bar: false, since: now, pausedMs: 0 };
    expect(testStopRunEvent({ type: 'test-stopped', ...of, stop } as never, data)).toMatchObject({
      type: 'test-stopped',
      data: { retries: 0 },
    });
    testStopRunEvent({ type: 'test-resumed', ...of, pausedMs: 4 * 60_000 } as never, data);
    expect(data.stop).toBeUndefined();
    expect(data.pausedMs).toBeUndefined();
    expect((await stuckEvents(() => checkStuckTests(db as never, now))).map((e) => e.elapsedMs)).toEqual([5 * 60_000]);
  });

  test('tells a retry, another attempt, again', async () => {
    runEventBus.recordRunningCase(LIVE_RUN, 'k', begin());
    await checkStuckTests(db as never, now);
    runEventBus.recordRunningCase(LIVE_RUN, 'k', begin({ startedAt: now - 3 * 60_000 }));
    const events = await stuckEvents(() => checkStuckTests(db as never, now));
    expect(events).toHaveLength(1);
  });

  test('leaves a test under the floor, one with too few passes, and a run that no longer runs', async () => {
    runEventBus.recordRunningCase(LIVE_RUN, 'short', begin({ startedAt: now - STUCK_FLOOR_MS + 1000 }));
    runEventBus.recordRunningCase(LIVE_RUN, 'webkit', begin({ browser: { projectName: 'webkit' } }));
    runEventBus.recordRunningCase(LIVE_RUN, 'new', begin({ title: 'pays with a gift card' }));
    expect(await stuckEvents(() => checkStuckTests(db as never, now))).toEqual([]);

    // A run whose status is final forgets its running tests.
    await db.update(schema.testRuns).set({ status: 'interrupted' });
    runEventBus.recordRunningCase(LIVE_RUN, 'k', begin());
    expect(await stuckEvents(() => checkStuckTests(db as never, now))).toEqual([]);
    expect(runEventBus.getRunningCases(LIVE_RUN)).toEqual([]);

    // Revived, it is looked at again from the next test that begins.
    await db.update(schema.testRuns).set({ status: 'running' });
    runEventBus.recordRunningCase(LIVE_RUN, 'k', begin());
    const later = await stuckEvents(() => checkStuckTests(db as never, now));
    expect(later.map((e) => e.elapsedMs)).toEqual([5 * 60_000]);
  });
});
