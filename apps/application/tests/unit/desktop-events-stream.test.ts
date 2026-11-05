/**
 * The desktop window's event stream (`GET /api/desktop/events`), on a migrated database and the real run event bus:
 * what each run's messages say of what launched it once it began (`server/utils/desktop-run-facts.ts`), so the window
 * shows a job's steps as progress alone and finds its own processes' runs, and how many runs the hub of the runs the
 * desktop shell starts has live, so a window that reloads takes its stream again.
 */
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { desktopRunFacts, desktopRunFactsReader } from '../../server/utils/desktop-run-facts';

const state = vi.hoisted(() => ({
  db: null as unknown,
  live: 0,
  listeners: new Set<(live: number) => void>(),
}));

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({}) }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/project-access', () => ({ getProjectScope: async () => 'all', scopeAllows: () => true }));
vi.mock('../../server/utils/desktop-runs', () => ({
  desktopRuns: () =>
    Promise.resolve({
      liveRunCount: () => state.live,
      onLiveRunCount: (listener: (live: number) => void) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    }),
}));

const BISECT = { piwiOrigin: { kind: 'bisect', ref: '37' }, piwiRunRef: 'desktop-6-unattended' };
const CI = { piwiOrigin: { kind: 'ci' }, ci: { provider: 'github' } };

let db: TempDb;
let close: () => Promise<void>;
let route: (event: unknown) => Promise<Response>;
let runEventBus: typeof import('../../server/utils/run-events').runEventBus;

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
  return { messages, end: () => req.emit('close') };
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  vi.stubGlobal('defineRouteMeta', () => {});
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  route = (await import('../../server/api/desktop/events.get')).default as unknown as typeof route;
  ({ runEventBus } = await import('../../server/utils/run-events'));
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values([
    { id: 5, projectId: 1, status: 'running', startTime: new Date(), metadata: BISECT, origin: 'bisect' },
    { id: 6, projectId: 1, status: 'initializing', startTime: new Date(), metadata: null },
  ]);
});

afterEach(() => {
  state.live = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await close();
});

describe('the desktop event stream', () => {
  test('names what launched each run once it began, and whether it is a step of a job, in its order', async () => {
    const stream = await openStream();
    const snapshot = await vi.waitFor(() => {
      const found = stream.messages.find((m) => m.type === 'snapshot');
      if (!found) throw new Error('no snapshot yet');
      return found as { runs: Array<Record<string, unknown>> };
    });
    expect(snapshot.runs.find((run) => run.id === 5)).toMatchObject({
      origin: 'bisect',
      originRef: '37',
      name: 'desktop-6-unattended',
      job: true,
    });
    // A run still initializing has no metadata yet: nothing says what launched it.
    expect(snapshot.runs.find((run) => run.id === 6)).not.toHaveProperty('origin');

    runEventBus.publishGlobal({ type: 'run-initializing', runId: 6, projectId: 1 });
    await db
      .update(schema.testRuns)
      .set({ status: 'running', metadata: CI, origin: 'ci' })
      .where(eq(schema.testRuns.id, 6));
    runEventBus.publishGlobal({ type: 'run-started', runId: 6, projectId: 1 });
    const counts = { totalTests: 4, passedTests: 1, failedTests: 1, skippedTests: 0, didNotRunTests: 0 };
    runEventBus.publishRunProgress({ runId: 5, projectId: 1, ...counts });
    runEventBus.publishGlobal({ type: 'run-finished', runId: 5, projectId: 1, status: 'failed' });
    const of = (runId: number) => stream.messages.filter((m) => m.type !== 'snapshot' && m.runId === runId);
    await vi.waitFor(() => expect(of(5).length + of(6).length).toBe(4));
    stream.end();

    // Each run's messages in their order; a run that began names what launched it.
    expect(of(6)).toEqual([
      { type: 'run-initializing', runId: 6, projectId: 1 },
      { type: 'run-started', runId: 6, projectId: 1, origin: 'ci', originRef: null, name: null, job: false },
    ]);
    expect(of(5)).toEqual([
      expect.objectContaining({ type: 'run-progress', failedTests: 1, origin: 'bisect', originRef: '37', job: true }),
      expect.objectContaining({ type: 'run-finished', status: 'failed', name: 'desktop-6-unattended', job: true }),
    ]);
  });

  test('says how many runs the hub has live as it opens, then each time it changes, until it ends', async () => {
    state.live = 2;
    const stream = await openStream();
    await vi.waitFor(() => expect(stream.messages).toContainEqual({ type: 'hub-runs', live: 2 }));
    for (const listener of state.listeners) listener(0);
    await vi.waitFor(() => expect(stream.messages).toContainEqual({ type: 'hub-runs', live: 0 }));
    stream.end();
    expect(state.listeners.size).toBe(0);
  });
});

describe('desktopRunFactsReader', () => {
  test('reads a run once for all its messages, and again only while nothing named it', async () => {
    const rows = new Map<number, { status: string; metadata: unknown } | Error>([
      [5, { status: 'running', metadata: BISECT }],
      [6, { status: 'initializing', metadata: null }],
      [7, new Error('database busy')],
    ]);
    const reads: number[] = [];
    const factsOf = desktopRunFactsReader(async (runId) => {
      reads.push(runId);
      const row = rows.get(runId);
      if (row instanceof Error) throw row;
      return row;
    });
    const [first, second] = await Promise.all([factsOf(5), factsOf(5)]);
    expect(first).toEqual(desktopRunFacts(BISECT));
    expect(second).toBe(first);
    expect(await factsOf(6)).toBeNull();
    expect(await factsOf(7)).toBeNull();
    expect(await factsOf(8)).toBeNull();
    rows.set(6, { status: 'running', metadata: CI });
    expect(await factsOf(6)).toEqual({ origin: 'ci', originRef: null, name: null, job: false });
    expect(reads).toEqual([5, 6, 7, 8, 6]);
  });

  test('tells a job’s step by the origins the notifications leave out', () => {
    for (const kind of ['bisect', 'reproduce', 'flake-lab', 'probe']) {
      expect(desktopRunFacts({ piwiOrigin: { kind } }).job, kind).toBe(true);
    }
    for (const kind of ['desktop', 'editor', 'local', 'ci']) {
      expect(desktopRunFacts({ piwiOrigin: { kind } }).job, kind).toBe(false);
    }
  });
});
