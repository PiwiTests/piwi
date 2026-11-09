import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's run stream route: the catch-up the server's stream sends a page that connects, as one list. An ended
 * run's `run-finished`; for a live run, each stored execution, then each test still running with its stuck mark.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');
const { noteDemoBegin, forgetDemoRun } = await import('~~/app/demo/api/stuck-tests');

interface CatchUp {
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds an item' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'removes an item' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'running', startTime: new Date() },
    { id: 2, projectId: 1, status: 'passed', startTime: new Date(), totalTests: 1, passedTests: 1, duration: 900 },
    { id: 3, projectId: 1, status: 'initializing', startTime: new Date() },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 10, testRunId: 1, testCaseId: 1, status: 'passed', duration: 800 },
    { id: 11, testRunId: 1, testCaseId: 2, status: 'failed', duration: 700, finalAttempt: false },
    { id: 12, testRunId: 1, testCaseId: 2, status: 'passed', duration: 600, retries: 1, passedAfterFailure: true },
  ]);
  noteDemoBegin(1, {
    title: 'removes an item',
    filePath: 'tests/cart.spec.ts',
    location: 'tests/cart.spec.ts:9:3',
    startedAt: 1_000,
    browser: null,
    repeatEachIndex: 0,
  });
});

afterAll(async () => {
  forgetDemoRun(1);
  await close();
});

const catchUp = (runId: number) => handleDemoRequest(`/api/test-runs/${runId}/stream`, 'GET') as Promise<CatchUp>;

describe('the demo run stream catch-up', () => {
  test('replays a live run’s stored executions, then its running tests', async () => {
    const { events } = await catchUp(1);
    expect(events.map((e) => [e.type, e.data.title])).toEqual([
      ['test-completed', 'adds an item'],
      ['test-completed', 'removes an item'],
      ['test-completed', 'removes an item'],
      ['test-begin', 'removes an item'],
    ]);
    expect(events[0]!.data).toMatchObject({
      executionId: 10,
      status: 'passed',
      location: 'tests/cart.spec.ts',
      passedAfterFailure: false,
    });
    expect(events[2]!.data).toMatchObject({ executionId: 12, retries: 1, passedAfterFailure: true });
  });

  test('answers an ended run’s run-finished alone', async () => {
    expect((await catchUp(2)).events).toEqual([
      expect.objectContaining({
        type: 'run-finished',
        data: expect.objectContaining({ status: 'passed', duration: 900 }),
      }),
    ]);
  });

  test('sends no run-finished for a run still initializing, which the demo run page listens to', async () => {
    expect((await catchUp(3)).events).toEqual([]);
  });

  test('answers 404 for a run that does not exist', async () => {
    await expect(catchUp(99)).rejects.toMatchObject({ statusCode: 404 });
  });
});
