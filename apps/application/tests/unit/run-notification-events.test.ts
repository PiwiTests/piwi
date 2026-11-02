import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Which events a finished run sends, from `emitRunNotifications`. */

const emitted = vi.hoisted(() => [] as Array<{ event: string; payload: Record<string, unknown> }>);
vi.mock('../../server/utils/notifications/emit', () => ({
  emitNotification: async (_db: unknown, event: string, payload: Record<string, unknown>) => {
    emitted.push({ event, payload });
  },
}));

delete process.env.PIWI_DATABASE_URL;

const { emitRunNotifications } = await import('../../server/utils/notifications/run-notifications');

let db: TempDb;
let close: () => Promise<void>;

type RunValues = Partial<typeof schema.testRuns.$inferInsert>;

async function addRun(id: number, values: RunValues = {}): Promise<void> {
  await db.insert(schema.testRuns).values({
    id,
    projectId: 1,
    status: 'passed',
    branch: 'main',
    startTime: new Date(Date.UTC(2026, 9, 1, id)),
    totalTests: 1,
    passedTests: 1,
    origin: 'ci',
    metadata: { ci: { provider: 'github' } },
    ...values,
  });
}

const events = () => emitted.map((e) => e.event);

beforeEach(async () => {
  emitted.length = 0;
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/pay.spec.ts', title: 'pays' });
});
afterEach(() => close());

describe('emitRunNotifications', () => {
  test('sends run.failed for a run stopped by the global timeout, though no test failed', async () => {
    await addRun(1, { status: 'timedout', passedTests: 1, failedTests: 0 });
    await emitRunNotifications(db as never, 1);
    expect(events()).toEqual(expect.arrayContaining(['run.finished', 'run.failed', 'run.failed.default_branch']));
  });

  test('sends no run.failed for a passing run', async () => {
    await addRun(1);
    await emitRunNotifications(db as never, 1);
    expect(events()).toEqual(['run.finished']);
  });
});
