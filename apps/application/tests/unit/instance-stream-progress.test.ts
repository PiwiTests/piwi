/**
 * The instance stream (`GET /api/stream`), on a migrated database and the real run event bus: a running run's tally
 * goes out as `run-progress`, at most once every 2 s per run with its latest winning and before the run's next
 * lifecycle event, to a caller who may read the run's project and see the run, while its lifecycle events go out as
 * they did.
 */
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { RunProgressBroadcast } from '../../server/utils/run-events';

const state = vi.hoisted(() => ({ db: null as unknown, scope: 'all' as 'all' | Set<number> }));

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({ id: null }) }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/project-access', async (importOriginal) => ({
  runVisibilityReader: (await importOriginal<typeof import('../../server/utils/project-access')>()).runVisibilityReader,
  getProjectScope: async () => state.scope,
  scopeAllows: (scope: 'all' | Set<number>, projectId: number) => scope === 'all' || scope.has(projectId),
}));

let db: TempDb;
let close: () => Promise<void>;
let route: (event: unknown) => Promise<Response>;
let runEventBus: typeof import('../../server/utils/run-events').runEventBus;

/** Let the stream read what it needs and write what it sends. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** An open stream: the messages it sent so far, and how to end it. */
async function openStream() {
  const req = Object.assign(new EventEmitter(), { destroyed: false });
  const response = await route({ node: { req } });
  const reader = response.body!.getReader();
  const messages: Array<Record<string, unknown>> = [];
  let text = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      text += new TextDecoder().decode(value);
      const frames = text.split('\n\n');
      text = frames.pop()!;
      for (const frame of frames) if (frame.startsWith('data: ')) messages.push(JSON.parse(frame.slice(6)));
    }
  })();
  await settled();
  return { messages, end: () => req.emit('close') };
}

/** A tally of run `runId` with `passed` results passed of 10. */
function tally(runId: number, passed: number, projectId = 1): RunProgressBroadcast {
  return { runId, projectId, totalTests: 10, passedTests: passed, failedTests: 0, skippedTests: 0, didNotRunTests: 0 };
}

/** What the stream sent of run `runId`: each message's type, and its passed count for a tally. */
function sentOf(messages: Array<Record<string, unknown>>, runId: number) {
  return messages
    .filter((m) => m.runId === runId)
    .map((m) => (m.type === 'run-progress' ? `progress ${m.passedTests}` : m.type));
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  vi.stubGlobal('defineRouteMeta', () => {});
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  route = (await import('../../server/api/stream.get')).default as unknown as typeof route;
  ({ runEventBus } = await import('../../server/utils/run-events'));
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin' },
    { id: 3, name: 'quiet' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 5, projectId: 1, status: 'running', startTime: new Date() },
    { id: 6, projectId: 1, status: 'running', startTime: new Date() },
    { id: 7, projectId: 2, status: 'running', startTime: new Date() },
    { id: 8, projectId: 1, status: 'running', startTime: new Date(), origin: 'request' },
    { id: 9, projectId: 3, status: 'running', startTime: new Date() },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  state.scope = 'all';
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe('the instance stream’s tallies', () => {
  test('sends a running run’s tally as run-progress, with its counts', async () => {
    const stream = await openStream();
    runEventBus.publishRunProgress({ ...tally(5, 3), failedTests: 1, skippedTests: 2, didNotRunTests: 1 });
    await settled();
    stream.end();
    expect(stream.messages.filter((m) => m.runId === 5)).toEqual([
      {
        type: 'run-progress',
        runId: 5,
        projectId: 1,
        totalTests: 10,
        passedTests: 3,
        failedTests: 1,
        skippedTests: 2,
        didNotRunTests: 1,
      },
    ]);
  });

  test('sends one tally per run every 2 seconds, the latest as the interval ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stream = await openStream();
    for (const passed of [1, 2, 3]) runEventBus.publishRunProgress(tally(5, passed));
    runEventBus.publishRunProgress(tally(6, 1));
    await settled();
    expect(sentOf(stream.messages, 5)).toEqual(['progress 1']);
    expect(sentOf(stream.messages, 6)).toEqual(['progress 1']);

    await vi.advanceTimersByTimeAsync(1_999);
    await settled();
    expect(sentOf(stream.messages, 5)).toEqual(['progress 1']);
    await vi.advanceTimersByTimeAsync(1);
    await settled();
    expect(sentOf(stream.messages, 5)).toEqual(['progress 1', 'progress 3']);
    // Run 6 sent nothing more, so nothing more goes out.
    expect(sentOf(stream.messages, 6)).toEqual(['progress 1']);
    stream.end();
  });

  test('sends the run’s tally it holds before the run’s next lifecycle event, which goes out as it did', async () => {
    const stream = await openStream();
    runEventBus.publishRunProgress(tally(5, 4));
    runEventBus.publishRunProgress(tally(5, 9));
    runEventBus.publishRunProgress(tally(5, 10));
    runEventBus.publishGlobal({ type: 'run-finished', runId: 5, projectId: 1, status: 'passed' });
    await settled();
    stream.end();
    expect(sentOf(stream.messages, 5)).toEqual(['progress 4', 'progress 10', 'run-finished']);
    expect(stream.messages.find((m) => m.type === 'run-finished')).toEqual({
      type: 'run-finished',
      runId: 5,
      projectId: 1,
      status: 'passed',
    });
  });

  test('sends no tally of a run outside the caller’s scope', async () => {
    state.scope = new Set([1]);
    const stream = await openStream();
    runEventBus.publishRunProgress(tally(7, 1, 2));
    runEventBus.publishRunProgress(tally(6, 1));
    await settled();
    stream.end();
    expect(sentOf(stream.messages, 7)).toEqual([]);
    expect(sentOf(stream.messages, 6)).toEqual(['progress 1']);
  });

  test('sends no tally of another person’s private run', async () => {
    const stream = await openStream();
    runEventBus.publishRunProgress(tally(8, 1));
    runEventBus.publishRunProgress(tally(6, 2));
    await settled();
    stream.end();
    expect(sentOf(stream.messages, 8)).toEqual([]);
    expect(sentOf(stream.messages, 6)).toEqual(['progress 2']);
  });

  test('counts a tally as no run event in when the stream says the last one was published', async () => {
    state.scope = new Set([3]);
    runEventBus.publishRunProgress(tally(9, 1, 3));
    const stream = await openStream();
    stream.end();
    expect(stream.messages[0]).toEqual({ type: 'stream-open', lastEventAt: null });
  });

  test('holds no tally once the stream ended', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stream = await openStream();
    runEventBus.publishRunProgress(tally(6, 1));
    runEventBus.publishRunProgress(tally(6, 2));
    await settled();
    stream.end();
    expect(vi.getTimerCount()).toBe(0);
    runEventBus.publishRunProgress(tally(6, 3));
    await vi.advanceTimersByTimeAsync(2_000);
    await settled();
    expect(sentOf(stream.messages, 6)).toEqual(['progress 1']);
  });
});
