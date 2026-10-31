import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';
import { REPORT_READY_EVENT } from '#shared/notification-events';
import { openTempDb, type TempDb } from './temp-db';

/**
 * `GET /api/notifications/stream`: every refresh re-checks the caller and
 * reloads their project scope, a refused caller ends the stream, and an event
 * addressed to the caller still needs every project it is about.
 */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({
  db: null as unknown,
  scope: 'all' as 'all' | Set<number>,
  authError: null as Error | null,
}));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  isAuthEnabled: () => true,
  requireAuth: async () => {
    if (state.authError) throw state.authError;
    return { id: 7 };
  },
}));
vi.mock('../../server/utils/project-access', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectScope: async () => state.scope,
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);

const { runEventBus } = await import('../../server/utils/run-events');
const stream = (await import('../../server/api/notifications/stream.get')).default as unknown as (
  event: object,
) => Promise<Response>;

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.scope = new Set([5]);
  state.authError = null;
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  await close();
});

/** Open the stream and collect the events it delivers. */
async function open() {
  const response = await stream({ node: { req: { on: () => {} } } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const received: unknown[] = [];
  let ended = false;
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        return;
      }
      const text = decoder.decode(value);
      for (const line of text.split('\n')) if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
    }
  })();
  return { received, ended: () => ended };
}

const targeted = (projectId: number) => ({ type: 'cluster.fixed', projectId, targetUserId: 7 });

describe('notification stream', () => {
  test('applies a narrowed project scope at the next refresh', async () => {
    const s = await open();
    runEventBus.publishNotification(targeted(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toHaveLength(1);

    state.scope = new Set();
    await vi.advanceTimersByTimeAsync(60_000);
    runEventBus.publishNotification(targeted(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toHaveLength(1);
    expect(s.ended()).toBe(false);
  });

  test('ends once the caller is refused, and keeps going through other failures', async () => {
    const s = await open();
    state.authError = new Error('database unavailable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.ended()).toBe(false);

    state.authError = apiError({ statusCode: 401, message: 'Authentication required' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.ended()).toBe(true);
    runEventBus.publishNotification(targeted(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toHaveLength(0);
  });
});

describe('an event addressed to the caller', () => {
  const report = (projectIds: number[], targetUserId?: number) => ({
    type: REPORT_READY_EVENT,
    snapshotId: 1,
    scheduleId: 1,
    title: 'Weekly quality',
    projectIds,
    ...(targetUserId === undefined ? {} : { targetUserId }),
  });

  test('reaches them only on a project they can open', async () => {
    const s = await open();
    runEventBus.publishNotification(targeted(6));
    runEventBus.publishNotification({ type: 'cluster.fixed', targetUserId: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toEqual([]);

    runEventBus.publishNotification(targeted(5));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toEqual([targeted(5)]);
  });

  test('a quality report reaches its channel owner only when they can open every project it covers', async () => {
    const s = await open();
    runEventBus.publishNotification(report([5, 6], 7));
    runEventBus.publishNotification(report([], 7));
    runEventBus.publishNotification(report([5], 8));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toEqual([]);

    runEventBus.publishNotification(report([5], 7));
    runEventBus.publishNotification(report([5]));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.received).toEqual([report([5], 7), report([5])]);
  });
});
