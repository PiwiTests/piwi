import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's side of a held CI failure: a simulated CI worker's held stop is taken only while the run's project holds
 * failing CI tests and the person acting may control the run, so **Let it go** finds a hold only the demo made, and
 * reaches the simulator that holds it.
 */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, letGo: [] as unknown[], published: [] as unknown[] }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));
vi.mock('../../app/demo/run-events', () => ({
  publishDemoLetGo: (runId: number, worker: unknown) => state.letGo.push({ runId, worker }),
  publishDemoRunEvent: (runId: number, event: unknown) => state.published.push({ runId, event }),
}));

const { apiDemoLetGo, apiPostDemoLiveStop } = await import('../../app/demo/api/live-view');

const WORKER = { shard: null, worker: 0, slot: 0 };
const HELD = {
  reason: 'held',
  call: { title: 'Failed: Timed out', file: 'tests/a.spec.ts', line: 9 },
  test: 'pays',
  until: Date.now() + 60_000,
};
const ANA = { controls: true, heldFor: ['Ana'] };

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.letGo = [];
  state.published = [];
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', liveView: true, liveViewHold: true },
    { id: 2, name: 'quiet', liveView: true },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 10, projectId: 1, status: 'running', startTime: new Date() },
    { id: 20, projectId: 2, status: 'running', startTime: new Date() },
  ]);
});

afterEach(async () => {
  await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: null }, ANA).catch(() => undefined);
  await close();
});

const letGo = (runId: number) =>
  apiDemoLetGo(runId, { watch: 'demo-watch', ...WORKER }).then(
    () => null,
    (error: { statusCode?: number }) => error.statusCode ?? -1,
  );

describe('a simulated CI worker’s held failure', () => {
  test('is taken for someone who may control the run, in a project that holds, and Let it go reaches it', async () => {
    expect(await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: HELD }, ANA)).toEqual({
      success: true,
      held: true,
    });
    expect(state.published).toHaveLength(1);
    expect(await letGo(10)).toBeNull();
    expect(state.letGo).toEqual([{ runId: 10, worker: WORKER }]);
  });

  test('is not taken for someone who may not control the run, nor in a project that does not hold', async () => {
    const sam = { controls: false, heldFor: [] };
    expect(await apiPostDemoLiveStop(10, { type: 'stop', ...WORKER, stop: HELD }, sam)).toMatchObject({ held: false });
    expect(await apiPostDemoLiveStop(20, { type: 'stop', ...WORKER, stop: HELD }, ANA)).toMatchObject({ held: false });
    expect(state.published).toEqual([]);
    // Let it go finds no hold: the setting is on and nothing is held, or the setting is off.
    expect(await letGo(10)).toBe(409);
    expect(await letGo(20)).toBe(409);
    expect(state.letGo).toEqual([]);
  });
});
