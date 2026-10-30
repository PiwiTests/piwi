import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { STUCK_FLOOR_MS } from '../../shared/stuck-tests';
import type { DemoEventMessage } from '../../app/demo/run-events';
import { checkDemoStuckTests, forgetDemoRun, noteDemoBegin, noteDemoComplete } from '../../app/demo/api/stuck-tests';

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
      .values({ id, projectId: 1, status: 'passed', isFullRun: true, startTime: new Date() });
    await db.insert(schema.testRunsCases).values({ testRunId: id, testCaseId: 1, status: 'passed', duration: 7000 });
  }
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

  test('leaves a test that completed', async () => {
    noteDemoBegin(RUN.id, begin);
    noteDemoComplete(RUN.id, begin);
    await checkDemoStuckTests(db as never, RUN, [{ startedAt: begin.startedAt + 10 * 60_000 }]);
    await delivered();
    expect(messages).toEqual([]);
  });
});
