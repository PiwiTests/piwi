import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * Which runs send `test.stuck` for a running attempt: the `stuck-notifications` use of `#shared/run-eligibility`, read
 * by `emitTestStuck`. A run started on a developer's machine sends none, a local hub steering it or not, while the stuck
 * check still marks its attempt on the run page.
 */

delete process.env.PIWI_DATABASE_URL;
/** Each notification sent, by its event. */
const sent = vi.hoisted(() => [] as Array<{ event: string; payload: Record<string, unknown> }>);
vi.mock('../../server/utils/notifications/emit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    sent.push({ event, payload });
  },
}));
const { emitTestStuck } = await import('../../server/utils/notifications/run-notifications');
const { checkStuckTests } = await import('../../server/utils/stuck-tests');
const { runEventBus } = await import('../../server/utils/run-events');
const { runOrigin } = await import('#shared/run-eligibility');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const now = Date.UTC(2026, 10, 5, 12);
const LIVE_RUN = 10;
/** A run steered from VS Code, as the reporter stamps it. */
const STEERED = { piwiInteractive: { client: 'Visual Studio Code', ref: 'terminal-4242-1762340000000' } };

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  runEventBus.cleanup(LIVE_RUN);
  sent.length = 0;
});

/** Store the live run: running and full unless `run` says otherwise. */
async function liveRun(run: { metadata?: Record<string, unknown> | null; isFullRun?: boolean; status?: string }) {
  const metadata = run.metadata ?? null;
  await db.insert(schema.testRuns).values({
    id: LIVE_RUN,
    projectId: 1,
    status: run.status ?? 'running',
    isFullRun: run.isFullRun === false ? 0 : 1,
    startTime: new Date(now - 10 * 60_000),
    metadata,
    origin: runOrigin(metadata),
  });
}

describe('test.stuck', () => {
  const notice = {
    testTitle: 'pays with PayPal',
    filePath: 'tests/checkout.spec.ts',
    startedAt: now - 5 * 60_000,
    elapsedMs: 5 * 60_000,
    usualMs: 8000,
    owner: 'team-checkout',
  };

  test.each([
    { name: 'a partial CI run', run: { metadata: { piwiOrigin: { kind: 'ci' } }, isFullRun: false }, sends: true },
    { name: 'a full CI run', run: { metadata: { piwiOrigin: { kind: 'ci' } } }, sends: true },
    {
      name: 'a full run from a developer’s machine',
      run: { metadata: { piwiOrigin: { kind: 'local' } } },
      sends: false,
    },
    { name: 'a full run from the desktop app', run: { metadata: { piwiOrigin: { kind: 'desktop' } } }, sends: false },
    {
      name: 'a partial run from a developer’s machine',
      run: { metadata: { piwiOrigin: { kind: 'local' } }, isFullRun: false },
      sends: false,
    },
    { name: 'a full run from an editor', run: { metadata: { piwiOrigin: { kind: 'editor' } } }, sends: false },
    {
      name: 'a full terminal run that follows an editor',
      run: { metadata: { piwiOrigin: { kind: 'local' }, ...STEERED } },
      sends: false,
    },
    {
      name: 'a full desktop run its hub steers',
      run: { metadata: { piwiOrigin: { kind: 'desktop' }, ...STEERED } },
      sends: false,
    },
    // The stamp of a hub that steers a run changes nothing: its origin decides.
    { name: 'a CI run a hub steers', run: { metadata: { piwiOrigin: { kind: 'ci' }, ...STEERED } }, sends: true },
    {
      name: 'a run that no longer runs',
      run: { metadata: { piwiOrigin: { kind: 'ci' } }, status: 'passed' },
      sends: false,
    },
  ])('$name sends it: $sends', async ({ run, sends }) => {
    await liveRun(run);
    await emitTestStuck(db as never, LIVE_RUN, notice);
    expect(sent.map((s) => s.event)).toEqual(sends ? ['test.stuck'] : []);
  });
});

describe('the stuck check of a run a local hub steers', () => {
  beforeEach(async () => {
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
        isFullRun: 1,
        startTime: new Date(now - (i + 2) * 86_400_000),
      });
      await db
        .insert(schema.testRunsCases)
        .values({ testRunId: i + 1, testCaseId: 1, status: 'passed', duration, browserName: 'chromium' });
    }
  });

  /** Check a test that has run five minutes in the live run: the `test-stuck` events of its stream, and what was sent. */
  async function check(): Promise<{ marked: number; notified: string[] }> {
    runEventBus.recordRunningCase(LIVE_RUN, 'k', {
      title: 'pays with PayPal',
      filePath: 'tests/checkout.spec.ts',
      suitePath: ['Checkout'],
      startedAt: now - 5 * 60_000,
      browser: { projectName: 'chromium' },
      repeatEachIndex: 0,
    });
    let marked = 0;
    const off = runEventBus.subscribe(LIVE_RUN, (event) => {
      if (event.type === 'test-stuck') marked++;
    });
    try {
      expect(await checkStuckTests(db as never, now)).toBe(1);
    } finally {
      off();
    }
    return { marked, notified: sent.map((s) => s.event) };
  }

  test('marks its long attempt Stuck? and sends no test.stuck', async () => {
    await liveRun({ metadata: { piwiOrigin: { kind: 'local' }, ...STEERED } });
    expect(await check()).toEqual({ marked: 1, notified: [] });
    expect(runEventBus.getRunningCases(LIVE_RUN)[0]).toMatchObject({ stuck: { elapsedMs: 5 * 60_000 } });
  });

  test('marks the attempt of a CI run Stuck? and sends test.stuck', async () => {
    await liveRun({ metadata: { piwiOrigin: { kind: 'ci' } } });
    expect(await check()).toEqual({ marked: 1, notified: ['test.stuck'] });
  });
});
