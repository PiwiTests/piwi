import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { STUCK_FLOOR_MS } from '../../shared/stuck-tests';
import type { DemoEventMessage } from '../../app/demo/run-events';
import {
  checkDemoStuckTests,
  demoRunningCase,
  demoRunningCases,
  forgetDemoRun,
  noteDemoBegin,
  noteDemoComplete,
} from '../../app/demo/api/stuck-tests';
import { testStopRunEvent } from '../../server/utils/live-case-events';

/**
 * The demo's stuck check: the server's rule and history, run on the time a demo run's events reached, since the
 * simulator runs on a virtual clock and the demo has no timer.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let channel: BroadcastChannel;
let messages: DemoEventMessage[];
const RUN = { id: 5, projectId: 1 };
const begin = {
  title: 'should complete checkout with PayPal',
  filePath: 'tests/checkout/checkout.spec.ts',
  suitePath: null,
  location: 'tests/checkout/checkout.spec.ts:20:3',
  workerIndex: 0,
  shardIndex: null,
  startedAt: 1_000_000,
  browser: null,
  repeatEachIndex: 0,
};

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'e2e-checkout', label: 'E2E Checkout' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: begin.filePath, title: begin.title });
  for (const id of [1, 2]) {
    await db
      .insert(schema.testRuns)
      .values({ id, projectId: 1, status: 'passed', isFullRun: 1, startTime: new Date() });
    await db.insert(schema.testRunsCases).values({ testRunId: id, testCaseId: 1, status: 'passed', duration: 7000 });
  }
  await db.insert(schema.testRuns).values({
    id: RUN.id,
    projectId: 1,
    status: 'running',
    isFullRun: 1,
    startTime: new Date(),
    metadata: { piwiOrigin: { kind: 'ci' } },
  });
  messages = [];
  // The channel the demo's service worker publishes its events on (`app/demo/run-events.ts`).
  channel = new BroadcastChannel('piwi-demo-run-events');
  channel.onmessage = (event) => messages.push(event.data as DemoEventMessage);
  forgetDemoRun(RUN.id);
});

afterEach(() => channel.close());

/** Let the channel deliver what was posted. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the demo’s stuck check', () => {
  test('marks a local run’s test Stuck? and sends no test.stuck, as the server does', async () => {
    await db
      .update(schema.testRuns)
      .set({ metadata: { piwiOrigin: { kind: 'local' } } })
      .where(eq(schema.testRuns.id, RUN.id));
    noteDemoBegin(RUN.id, begin);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 3 * 60_000 }]);
    await delivered();
    expect(
      messages.map((m) => (m.scope === 'notification' ? m.event.type : m.scope === 'run' && m.event.type)),
    ).toEqual(['test-stuck']);
  });

  test('tells a running test past its threshold once, as the run’s events reach the time', async () => {
    noteDemoBegin(RUN.id, begin);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + STUCK_FLOOR_MS - 1000 }]);
    await delivered();
    expect(messages).toEqual([]);

    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 3 * 60_000 }]);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 4 * 60_000 }]);
    await delivered();
    expect(
      messages.map((m) => (m.scope === 'notification' ? m.event.type : m.scope === 'run' && m.event.type)),
    ).toEqual(['test-stuck', 'test.stuck']);
    expect(messages[0]).toMatchObject({
      scope: 'run',
      runId: RUN.id,
      event: { data: { title: begin.title, elapsedMs: 3 * 60_000, usualMs: 7000 } },
    });
    expect(messages[1]).toMatchObject({ event: { projectName: 'E2E Checkout', testTitle: begin.title } });
  });

  test('leaves a test while it stands stopped, and leaves the time it stood stopped out', async () => {
    // The kept payload is the one the stops update: a copy, as each streamed begin is its own.
    noteDemoBegin(RUN.id, { ...begin });
    const running = demoRunningCase(RUN.id, begin);
    const stop = { reason: 'breakpoint', title: 'Click', file: 'tests/checkout/checkout.spec.ts', line: 24, bar: true };
    testStopRunEvent(
      { type: 'test-stopped', ...begin, stop: { ...stop, since: begin.startedAt + 60_000, pausedMs: 0 } } as never,
      running,
    );
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 6 * 60_000 }]);
    await delivered();
    expect(messages).toEqual([]);

    // It went on after five minutes stopped: it has run one minute, then four.
    testStopRunEvent({ type: 'test-resumed', ...begin, pausedMs: 5 * 60_000 } as never, running);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 6 * 60_000 }]);
    await delivered();
    expect(messages).toEqual([]);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 9 * 60_000 }]);
    await delivered();
    expect(messages[0]).toMatchObject({ scope: 'run', event: { type: 'test-stuck', data: { elapsedMs: 4 * 60_000 } } });
  });

  test('leaves a test that completed', async () => {
    noteDemoBegin(RUN.id, begin);
    noteDemoComplete(RUN.id, begin);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 10 * 60_000 }]);
    await delivered();
    expect(messages).toEqual([]);
  });

  test('replays the running tests to a page that connects later, a stuck one with its mark', async () => {
    const other = { ...begin, title: 'should show the cart', location: 'tests/checkout/checkout.spec.ts:40:3' };
    noteDemoBegin(RUN.id, begin);
    noteDemoBegin(RUN.id, { ...other, startedAt: begin.startedAt + 2 * 60_000 });
    expect(demoRunningCases(RUN.id).map((c) => [c.title, c.stuck ?? null])).toEqual([
      [begin.title, null],
      [other.title, null],
    ]);

    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 3 * 60_000 }]);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 5 * 60_000 }]);
    expect(demoRunningCases(RUN.id).find((c) => c.title === begin.title)?.stuck).toEqual({
      elapsedMs: 5 * 60_000,
      usualMs: 7000,
    });

    noteDemoComplete(RUN.id, begin);
    expect(demoRunningCases(RUN.id).map((c) => c.title)).toEqual([other.title]);
    forgetDemoRun(RUN.id);
    expect(demoRunningCases(RUN.id)).toEqual([]);
  });
});
