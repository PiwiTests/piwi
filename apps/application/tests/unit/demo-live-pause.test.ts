import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's side of a CI test paused for its controllers: a simulated CI worker that can pause is said to the run page
 * as one only while the run's project lets its controllers pause; **Pause**, **Resume** and **End the test** are taken
 * as the instance takes them (the settings on, Pause while the test stands at no stop, the other two while it is
 * paused) and reach the simulator that runs the worker; its paused stop names who paused it, and is taken only after
 * a Pause.
 */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, control: [] as unknown[], published: [] as unknown[] }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));
vi.mock('../../app/demo/run-events', () => ({
  publishDemoLetGo: () => undefined,
  publishDemoControl: (runId: number, worker: unknown, command: string) =>
    state.control.push({ runId, worker, command }),
  publishDemoRunEvent: (runId: number, event: unknown) => state.published.push({ runId, event }),
}));

const { apiDemoControl, apiPostDemoLiveStop } = await import('../../app/demo/api/live-view');

const WORKER = { shard: null, worker: 0, slot: 0 };
const PAUSED = {
  reason: 'pause',
  call: { title: "Click getByRole('button')", file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
  until: Date.now() + 60_000,
};
const ANA = { controls: true, heldFor: ['Ana'] };

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.control = [];
  state.published = [];
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', liveView: true, liveViewHold: true, liveViewPause: true },
    { id: 2, name: 'quiet', liveView: true, liveViewHold: true },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'running', startTime: new Date() },
    { id: 20, projectId: 2, status: 'running', startTime: new Date() },
  ]);
});

afterEach(async () => {
  for (const runId of [10, 20]) {
    await apiPostDemoLiveStop(runId, { type: 'stop', ...WORKER, stop: null, pauses: false }, ANA).catch(
      () => undefined,
    );
  }
  await close();
});

const control = (runId: number, command: string, by = 'Ana') =>
  apiDemoControl(runId, { watch: 'demo-watch', ...WORKER, command }, by).then(
    () => null,
    (error: { statusCode?: number }) => error.statusCode ?? -1,
  );
const lastState = () => (state.published.at(-1) as { event: { data: Record<string, unknown> } }).event.data;

describe('a simulated CI worker that can pause', () => {
  test('is said to the run page as one while its project lets its controllers pause, and only then', async () => {
    await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: null, pauses: true }, ANA);
    expect(lastState()).toMatchObject({ connected: true, paused: null, holds: true, pauses: true });
    state.published = [];
    await apiPostDemoLiveStop(20, { type: 'stop', ...WORKER, stop: null, pauses: true }, ANA);
    expect(state.published).toEqual([]);
  });

  test('takes Pause, then its paused stop with who paused it, then Resume and End the test', async () => {
    await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: null, pauses: true }, ANA);
    // Not paused yet: nothing to resume or end, and no paused stop taken before a Pause.
    expect(await control(10, 'resume')).toBe(409);
    expect(await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: PAUSED }, ANA)).toMatchObject({
      held: false,
    });
    expect(await control(10, 'pause')).toBeNull();
    expect(await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: PAUSED }, ANA)).toMatchObject({
      held: true,
    });
    expect(lastState()).toMatchObject({ paused: PAUSED, pauses: true, pausedBy: 'Ana' });
    // Paused: no second Pause.
    expect(await control(10, 'pause')).toBe(409);
    expect(await control(10, 'resume')).toBeNull();
    expect(await control(10, 'end')).toBeNull();
    expect(state.control).toEqual([
      { runId: 10, worker: WORKER, command: 'pause' },
      { runId: 10, worker: WORKER, command: 'resume' },
      { runId: 10, worker: WORKER, command: 'end' },
    ]);
  });

  test('is refused with the setting off, for a worker that cannot pause, and for a command it does not know', async () => {
    await apiPostDemoLiveStop(20, { type: 'stop', ...WORKER, stop: null, pauses: true }, ANA);
    expect(await control(20, 'pause')).toBe(409);
    expect(await control(10, 'pause')).toBe(409);
    expect(await control(10, 'step')).toBe(400);
    expect(state.control).toEqual([]);
  });
});
