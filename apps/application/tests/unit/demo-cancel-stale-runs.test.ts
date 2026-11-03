import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's clean-up of the runs a reload cut off mid-simulation: it cancels the simulator's own runs, a sharded
 * simulation's shards included (`<id>|<label>`), and no other run, whatever characters the id holds.
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

let db: TempDb;
let close: () => Promise<void>;

const RUNS: Array<{ id: number; instanceId: string; status: string }> = [
  { id: 1, instanceId: 'demo-simulator', status: 'running' },
  { id: 2, instanceId: 'demo-simulator|sim-1-ab12', status: 'initializing' },
  { id: 3, instanceId: 'demo-simulator|sim-2-cd34', status: 'passed' },
  { id: 4, instanceId: 'ci-runner|nightly', status: 'running' },
  { id: 5, instanceId: 'demo-simulator-2', status: 'running' },
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

describe("the demo's stale simulator runs", () => {
  test('reads an id as its characters, so a wildcard cancels nothing', async () => {
    expect(await apiCancelStaleSimulatorRuns({ instanceId: '%' })).toMatchObject({ cancelled: 0 });
    expect(await apiCancelStaleSimulatorRuns({ instanceId: '_emo-simulator' })).toMatchObject({ cancelled: 0 });
  });

  test("cancels the simulator's unfinished runs and shards, and leaves the rest", async () => {
    expect(await apiCancelStaleSimulatorRuns({ instanceId: 'demo-simulator' })).toMatchObject({ cancelled: 2 });
    expect([await statusOf(1), await statusOf(2)]).toEqual(['cancelled', 'cancelled']);
    expect([await statusOf(3), await statusOf(4), await statusOf(5)]).toEqual(['passed', 'running', 'running']);
  });
});
