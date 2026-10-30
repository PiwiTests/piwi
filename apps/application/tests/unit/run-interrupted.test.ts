import { describe, test, expect, beforeAll, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

const runFinalizeSideEffects = vi.fn(async () => {});
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects }));
const emitNotification = vi.fn(async (_db: unknown, _event: string, _payload: Record<string, unknown>) => {});
vi.mock('../../server/utils/notifications/emit', () => ({ emitNotification }));

delete process.env.PIWI_DATABASE_URL;
const { interruptStaleRuns, STALE_TIMEOUT_MS } = await import('../../server/utils/stale-runs');
const { NOTIFICATION_EVENTS, RUN_SCOPED_EVENTS, renderEventSubject, passesSubscriptionFilters } =
  await import('../../shared/notification-events');

let db: ReturnType<typeof drizzle<typeof schema>>;
const now = Date.now();
const stale = new Date(now - STALE_TIMEOUT_MS - 60_000);

// Run 1 is a CI run on main whose reporter went quiet with one failure stored;
// run 2 is a quiet probe run, run 3 a quiet run of one test from an editor.
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([{ id: 1, name: 'checkout', defaultBranch: 'main' }]);
  const run = (id: number, metadata: Record<string, unknown>) => ({
    id,
    projectId: 1,
    status: 'running',
    startTime: stale,
    createdAt: stale,
    updatedAt: stale,
    streamToken: `token-${id}`,
    totalTests: 4,
    branch: 'main',
    environment: 'staging',
    metadata,
  });
  await db
    .insert(schema.testRuns)
    .values([
      run(1, { scm: { branch: 'main' } }),
      run(2, { piwiProbe: true }),
      { ...run(3, { piwiOrigin: { kind: 'editor' } }), origin: 'editor', isFullRun: 0 },
    ]);
  await db.insert(schema.testCases).values([{ id: 1, projectId: 1, title: 'pays', filePath: 'pay.spec.ts' }]);
  await db
    .insert(schema.testRunsCases)
    .values([
      { testRunId: 1, testCaseId: 1, status: 'failed', retries: 0, browserName: 'chromium', error: 'Error: boom' },
    ]);
});

describe('run.interrupted', () => {
  test('is a run-scoped notification event with its own subject', () => {
    expect(NOTIFICATION_EVENTS).toContain('run.interrupted');
    expect(RUN_SCOPED_EVENTS.has('run.interrupted')).toBe(true);
    const payload = { runId: 1, projectId: 1, projectName: 'checkout', status: 'interrupted', branch: 'main' };
    expect(renderEventSubject('run.interrupted', payload as never)).toBe('Test run interrupted — checkout (main)');
    expect(passesSubscriptionFilters({ branches: ['release/*'] }, 'run.interrupted', payload as never)).toBe(false);
    expect(passesSubscriptionFilters({ statuses: ['interrupted'] }, 'run.interrupted', payload as never)).toBe(true);
  });

  test('a reaped run sends run.interrupted and runs no finish-time side effects', async () => {
    const reaped = await interruptStaleRuns(db, now);

    expect([...reaped].sort()).toEqual([1, 2, 3]);
    expect(runFinalizeSideEffects).not.toHaveBeenCalled();
    // The probe run and the editor run stay silent; the CI run names its branch, environment and stored failure.
    expect(emitNotification.mock.calls.map(([, event, payload]) => [event, payload.runId])).toEqual([
      ['run.interrupted', 1],
    ]);
    expect(emitNotification.mock.calls[0]![2]).toEqual(
      expect.objectContaining({
        status: 'interrupted',
        branch: 'main',
        environment: 'staging',
        isDefaultBranch: true,
        failedTests: 1,
        topFailures: [expect.objectContaining({ title: 'pays' })],
      }),
    );
  });
});
