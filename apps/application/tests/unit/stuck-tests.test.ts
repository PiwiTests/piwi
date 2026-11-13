import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import {
  STUCK_FLOOR_MS,
  stuckAttempt,
  runningUsualDurationTest,
  stuckThresholdMs,
  usualDurationKey,
  usualDurationMs,
} from '../../shared/stuck-tests';
import { resolveBrowserName } from '../../shared/browser-name';
import { joinSuitePath } from '../../shared/utils/suites';
import { storableRunCase, storedUsualDurationTest } from '../../server/utils/storable-values';
import { useTimelineModel } from '../../app/composables/useTimelineModel';
import type { TestCaseResult } from '../../types/api';

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
const { testBeginData, testStopRunEvent } = await import('../../server/utils/live-case-events');
const { runningTestHistory, runUsualDurations } = await import('../../shared/handlers/stuck-tests');

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

  test('reads the usual duration as the longest pass, among as many passes as the threshold needs', () => {
    expect(usualDurationMs([])).toBeNull();
    expect(usualDurationMs([8000])).toBeNull();
    expect(usualDurationMs([8000, 6000, Number.NaN, -1])).toBe(8000);
    expect(usualDurationMs([8000, 6000])).toBe(stuckAttempt(STUCK_FLOOR_MS + 1, [8000, 6000])!.usualMs);
  });

  test('keys a usual duration alike for a stored test and a running one, and apart for each browser', () => {
    const stored = { filePath: 'a.spec.ts', suitePath: ['A', 'B'], title: 't', browser: 'chromium' };
    expect(usualDurationKey({ ...stored, suitePath: ['A', 'B'] })).toBe(usualDurationKey(stored));
    expect(usualDurationKey({ ...stored, browser: 'webkit' })).not.toBe(usualDurationKey(stored));
    expect(usualDurationKey({ ...stored, suitePath: ['A\x1fB'] })).toBe(usualDurationKey(stored));
    expect(usualDurationKey({ ...stored, suitePath: ['A'] })).not.toBe(usualDurationKey(stored));
    expect(usualDurationKey({ title: 't' })).toBe(usualDurationKey({ title: 't', filePath: null, browser: '' }));
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

describe('the usual durations of a run’s project', () => {
  const PAYPAL = { filePath: 'tests/checkout.spec.ts', suitePath: ['Checkout'], title: 'pays with PayPal' };

  test('are the longest of each test’s last ten passes on each browser, as the stuck check reads them', async () => {
    // Ten newer passes on chromium push the older three out; one webkit pass is too few to tell.
    for (let i = 0; i < 10; i++) {
      await db.insert(schema.testRunsCases).values({
        testRunId: 1,
        testCaseId: 1,
        repeatEachIndex: i + 1,
        status: 'passed',
        duration: 4000 + i * 100,
        browserName: 'chromium',
        createdAt: new Date(Date.now() + 60_000 + i),
      });
    }
    await db.insert(schema.testRunsCases).values({
      testRunId: 1,
      testCaseId: 1,
      status: 'passed',
      duration: 2000,
      browserName: 'webkit',
    });
    // A failure is no pass.
    await db.insert(schema.testRunsCases).values({
      testRunId: 2,
      testCaseId: 1,
      repeatEachIndex: 1,
      status: 'failed',
      duration: 90_000,
      browserName: 'chromium',
      createdAt: new Date(now - 60_000),
    });

    const { tests } = await runUsualDurations(db as never, LIVE_RUN);
    expect(tests).toEqual([{ ...PAYPAL, browser: 'chromium', usualMs: 4900 }]);
    const history = await runningTestHistory(db as never, { projectId: 1, ...PAYPAL, browserName: 'chromium' });
    expect(usualDurationMs(history.passingDurations)).toBe(4900);
  });

  test('take the test an external ID names when two share a name, and none of an unknown run', async () => {
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, ...PAYPAL, suitePath: 'Checkout', externalId: 'TC-9' });
    for (const duration of [30_000, 31_000]) {
      await db.insert(schema.testRunsCases).values({
        testRunId: 3,
        testCaseId: 2,
        repeatEachIndex: duration,
        status: 'passed',
        duration,
        browserName: 'chromium',
      });
    }
    const { tests } = await runUsualDurations(db as never, LIVE_RUN);
    expect(tests).toEqual([{ ...PAYPAL, browser: 'chromium', usualMs: 31_000 }]);
    expect(await runUsualDurations(db as never, 999)).toEqual({ tests: [] });
  });

  test('are found on the Timeline by the running test its begin event names', async () => {
    // A test two describe blocks deep, on another Playwright project, beside the PayPal test.
    await db.insert(schema.testCases).values({
      id: 3,
      projectId: 1,
      filePath: 'tests/checkout.spec.ts',
      suitePath: joinSuitePath(['Checkout', 'Gift cards']),
      title: 'pays by gift card',
    });
    for (const [i, duration] of [3000, 3500].entries()) {
      await db.insert(schema.testRunsCases).values({
        testRunId: i + 1,
        testCaseId: 3,
        status: 'passed',
        duration,
        browserName: 'Mobile Safari',
      });
    }
    // The Timeline keeps them by `usualDurationKey`, and each running test's bar reads its own, from the test its
    // `begin` names as the run's stream publishes it (`testBeginData`: the file from its location).
    const { tests } = await runUsualDurations(db as never, LIVE_RUN);
    const usualDurations = new Map(tests.map((test) => [usualDurationKey(test), test.usualMs]));
    const paypal = begin();
    const running = [
      paypal,
      {
        ...paypal,
        title: 'pays by gift card',
        suitePath: ['Checkout', 'Gift cards'],
        workerIndex: 2,
        browser: { projectName: 'Mobile Safari' },
      },
      { ...paypal, workerIndex: 3, browser: { projectName: 'firefox' } },
    ].map((event, i) => ({
      ...testBeginData({ type: 'begin', ...event } as never, now),
      executionId: -1 - i,
      testCaseId: 0,
      status: 'running',
    }));
    const { timelineData } = useTimelineModel({
      testCases: running as unknown as TestCaseResult[],
      live: true,
      now,
      usualDurations,
    });
    const usualOf = (workerIndex: number) => timelineData.value.find((bar) => bar.workerIndex === workerIndex)?.usualMs;
    expect(usualOf(1)).toBe(8000);
    expect(usualOf(2)).toBe(3500);
    // No pass on firefox: no ghost.
    expect(usualOf(3)).toBeNull();
  });

  test('are found for a running test whose names are stored otherwise than its begin event sends them', async () => {
    // A title holding a NUL, a describe path long enough to be shortened, and a project named only by its browser.
    const sent = [
      { title: 'pays \0with a NUL', suitePath: ['Checkout'], browser: { projectName: 'chromium' } },
      {
        title: 'pays from a long describe',
        suitePath: ['Checkout', 'x'.repeat(3000)],
        browser: { projectName: 'chromium' },
      },
      { title: 'pays without a project', suitePath: ['Checkout'], browser: { browserName: 'chromium' } },
    ];
    for (const [i, test] of sent.entries()) {
      const stored = await storableRunCase({ filePath: PAYPAL.filePath, ...test });
      await db.insert(schema.testCases).values({
        id: 10 + i,
        projectId: 1,
        filePath: stored.filePath,
        suitePath: joinSuitePath(stored.suitePath),
        title: stored.title,
      });
      for (const [run, duration] of [2000 + i, 2500 + i].entries()) {
        await db.insert(schema.testRunsCases).values({
          testRunId: run + 1,
          testCaseId: 10 + i,
          status: 'passed',
          duration,
          browserName: resolveBrowserName(stored.browser),
        });
      }
    }
    const { tests } = await runUsualDurations(db as never, LIVE_RUN);
    expect(tests.find((t) => t.title === 'pays with a NUL')).toBeDefined();
    expect(tests.find((t) => t.title === 'pays without a project')?.browser).toBeNull();
    const usual = new Map(tests.map((test) => [usualDurationKey(test), test.usualMs]));

    for (const [i, test] of sent.entries()) {
      const running = runningUsualDurationTest(testBeginData({ type: 'begin', ...begin(test) } as never, now) as never);
      // The names as sent miss the first two; the names as their rows store them find all three.
      expect(usual.get(usualDurationKey(await storedUsualDurationTest(running)))).toBe(2500 + i);
      if (i < 2) expect(usual.has(usualDurationKey(running))).toBe(false);
    }
    // A begin event naming no Playwright project is keyed by none, as its result is stored, never by its browser.
    expect(runningUsualDurationTest({ title: 't', browser: { browserName: 'chromium' } }).browser).toBeNull();
  });
});
