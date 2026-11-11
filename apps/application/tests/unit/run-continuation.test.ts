import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { DbClient } from '../../server/database';
import { runEventBus, type GlobalRunEvent, type RunEvent } from '../../server/utils/run-events';

/**
 * The run a shared run continues: a worker names the earlier run of its editor window (`after`), and that run, of the
 * same project, with a lower id, seen by the same people, is continued by it once, its page hearing so on the run's
 * stream and on the global one; its detail answers `continuedInId` while that run is stored.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set, so clear it before the module loads.
delete process.env.PIWI_DATABASE_URL;
const { continueRun } = await import('../../server/utils/run-continuation');
const { getTestRun } = await import('#shared/handlers/test-runs');

let db: TempDb;
let close: () => Promise<void>;
const runEvents: Array<{ runId: number; event: RunEvent }> = [];
const globalEvents: GlobalRunEvent[] = [];
const stops: Array<() => void> = [];

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values({ id: 9, username: 'dana', password: '', role: 'member' });
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin' },
  ]);
  const at = new Date();
  await db.insert(schema.testRuns).values([
    { id: 76, projectId: 1, status: 'cancelled', startTime: at, origin: 'editor' },
    { id: 77, projectId: 1, status: 'passed', startTime: at, origin: 'editor' },
    { id: 78, projectId: 1, status: 'running', startTime: at, origin: 'editor' },
    { id: 79, projectId: 2, status: 'passed', startTime: at, origin: 'editor' },
    { id: 80, projectId: 1, status: 'passed', startTime: at, origin: 'request', requesterId: 9 },
    { id: 81, projectId: 1, status: 'running', startTime: at, origin: 'request', requesterId: 9 },
    { id: 90, projectId: 1, status: 'running', startTime: at, origin: 'editor' },
  ]);
  runEvents.length = 0;
  globalEvents.length = 0;
  for (const runId of [76, 77, 79, 80]) {
    stops.push(runEventBus.subscribe(runId, (event) => runEvents.push({ runId, event })));
  }
  stops.push(runEventBus.subscribeGlobal((event) => globalEvents.push(event)));
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await close();
});

const run = (id: number, projectId = 1, origin = 'editor', requesterId: number | null = null) => ({
  id,
  projectId,
  origin,
  requesterId,
});

async function continuedIn(id: number): Promise<number | null> {
  const [row] = await db
    .select({ continuedInId: schema.testRuns.continuedInId })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, id));
  return row!.continuedInId;
}

describe('a run that continues an earlier one', () => {
  test('links the earlier run of the same project once, and its page hears it', async () => {
    expect(await continueRun(db as unknown as DbClient, run(78), 77)).toBe(true);
    expect(await continuedIn(77)).toBe(78);
    expect(runEvents).toEqual([
      { runId: 77, event: expect.objectContaining({ type: 'continued', data: { runId: 78 } }) },
    ]);
    expect(globalEvents).toEqual([{ type: 'run-continued', runId: 77, projectId: 1, continuedInId: 78 }]);

    // Once: another worker of the run, or a later run naming it again, changes nothing.
    expect(await continueRun(db as unknown as DbClient, run(78), 77)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(90), 77)).toBe(false);
    expect(await continuedIn(77)).toBe(78);
    expect(globalEvents).toHaveLength(1);
  });

  test('links no run of another project, no later run, no missing run and not itself', async () => {
    expect(await continueRun(db as unknown as DbClient, run(78), 79)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(78), 90)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(78), 78)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(78), 50)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(78), 0)).toBe(false);
    expect(await continuedIn(79)).toBeNull();
    expect(await continuedIn(90)).toBeNull();
    expect(runEvents).toEqual([]);
    expect(globalEvents).toEqual([]);
  });

  test('links runs the same people see: a private run to its requester’s private run alone', async () => {
    expect(await continueRun(db as unknown as DbClient, run(78), 80)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(81, 1, 'request', 7), 80)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(81, 1, 'request', 9), 76)).toBe(false);
    expect(await continueRun(db as unknown as DbClient, run(81, 1, 'request', 9), 80)).toBe(true);
    expect(await continuedIn(80)).toBe(81);
  });

  test('the earlier run’s detail names the run that continued it while that run is stored', async () => {
    await continueRun(db as unknown as DbClient, run(78), 76);
    expect((await getTestRun(db as never, 76))?.continuedInId).toBe(78);
    await db.delete(schema.testRuns).where(eq(schema.testRuns.id, 78));
    expect((await getTestRun(db as never, 76))?.continuedInId).toBeNull();
  });
});
