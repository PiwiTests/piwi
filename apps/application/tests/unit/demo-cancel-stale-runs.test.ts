import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's clean-up of the runs a closed or reloaded page cut off mid-simulation: it cancels the simulator's runs
 * whose page load is gone, a sharded simulation's shards included (`<id>|<label>`), and leaves the runs a page still
 * open is streaming, finished runs and every run the simulator did not send.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { apiCancelStaleSimulatorRuns } = await import('~~/app/demo/api/reporter');
const { simulatorInstanceId, simulatorPageOf } = await import('~~/app/demo/simulator-instance');

let db: TempDb;
let close: () => Promise<void>;

const RUNS: Array<{ id: number; instanceId: string; status: string }> = [
  { id: 1, instanceId: 'demo-simulator:gone', status: 'running' },
  { id: 2, instanceId: 'demo-simulator:gone|sim-1-ab12', status: 'initializing' },
  { id: 3, instanceId: 'demo-simulator:gone|sim-2-cd34', status: 'passed' },
  { id: 4, instanceId: 'ci-runner|nightly', status: 'running' },
  { id: 5, instanceId: 'demo-simulator-2', status: 'running' },
  { id: 6, instanceId: 'demo-simulator:open', status: 'running' },
  { id: 7, instanceId: 'demo-simulator:open|sim-3-ef56', status: 'finalizing' },
  { id: 8, instanceId: 'demo-simulator', status: 'running' },
];

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db
    .insert(schema.testRuns)
    .values(RUNS.map((r) => ({ ...r, projectId: 1, isFullRun: true, startTime: new Date() })));
});

afterAll(() => close());

const statusOf = async (id: number) =>
  (await db.select({ status: schema.testRuns.status }).from(schema.testRuns).where(eq(schema.testRuns.id, id)))[0]
    ?.status;

const statusesOf = (ids: number[]) => Promise.all(ids.map(statusOf));

describe("the demo's stale simulator runs", () => {
  test('cancels nothing without the list of open pages', async () => {
    expect(await apiCancelStaleSimulatorRuns({})).toMatchObject({ cancelled: 0 });
    expect(await apiCancelStaleSimulatorRuns({ livePages: 'open' })).toMatchObject({ cancelled: 0 });
    expect(await statusesOf([1, 2, 6, 7, 8])).toEqual(['running', 'initializing', 'running', 'finalizing', 'running']);
  });

  test("cancels the unfinished runs and shards of the pages that are gone, and leaves the open page's", async () => {
    expect(await apiCancelStaleSimulatorRuns({ livePages: ['open', ''] })).toMatchObject({ cancelled: 3 });
    expect(await statusesOf([1, 2, 8])).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(await statusesOf([6, 7])).toEqual(['running', 'finalizing']);
    expect(await statusesOf([3, 4, 5])).toEqual(['passed', 'running', 'running']);
  });

  test('cancels the runs of a page once it is gone', async () => {
    expect(await apiCancelStaleSimulatorRuns({ livePages: [] })).toMatchObject({ cancelled: 2 });
    expect(await statusesOf([6, 7])).toEqual(['cancelled', 'cancelled']);
    expect(await statusesOf([4, 5])).toEqual(['running', 'running']);
  });
});

describe("a simulated run's page load", () => {
  test('is read from the instance id, a shard label aside', () => {
    expect(simulatorPageOf('demo-simulator:abc')).toBe('abc');
    expect(simulatorPageOf('demo-simulator:abc|sim-1-ab12')).toBe('abc');
    expect(simulatorPageOf('demo-simulator')).toBe('');
    expect(simulatorPageOf('demo-simulator|sim-1-ab12')).toBe('');
    expect(simulatorPageOf('demo-simulator-2')).toBeNull();
    expect(simulatorPageOf('ci-runner|nightly')).toBeNull();
    expect(simulatorPageOf(null)).toBeNull();
  });

  test("is this page's own for the runs it sends", () => {
    expect(simulatorPageOf(simulatorInstanceId())).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(simulatorInstanceId()).toBe(simulatorInstanceId());
  });
});
