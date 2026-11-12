import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Deleting a project deletes every file it stored, its bug reports' screenshots included. */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

delete process.env.PIWI_DATABASE_URL;

const storageDir = mkdtempSync(join(tmpdir(), 'piwi-delete-project-'));
process.env.PIWI_STORAGE_PATH = storageDir;
const { resetStorage } = await import('../../server/storage');
resetStorage();
const { deleteProject } = await import('../../server/utils/delete-project');
const { runEventBus } = await import('../../server/utils/run-events');

let db: TempDb;
let close: () => Promise<void>;

function store(path: string): void {
  mkdirSync(join(storageDir, path, '..'), { recursive: true });
  writeFileSync(join(storageDir, path), 'png');
}

const EMPTY = { steps: { v: 1, steps: [] }, evidence: {}, context: {} };

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.bugReports).values([
    { id: 10, projectId: 1, title: 'Coupon', ...EMPTY },
    { id: 11, projectId: 2, title: 'Total', ...EMPTY },
  ]);
  store('project-1/run-1/7/shot.png');
  store('bug-reports/10/shot-1.png');
  store('bug-reports/11/shot-1.png');
});
afterEach(() => close());
afterAll(() => rmSync(storageDir, { recursive: true, force: true }));

describe('deleteProject', () => {
  test("removes the project's folder and its bug reports' screenshots, and no one else's", async () => {
    await deleteProject(1);

    expect(existsSync(join(storageDir, 'project-1'))).toBe(false);
    expect(existsSync(join(storageDir, 'bug-reports/10'))).toBe(false);
    expect(existsSync(join(storageDir, 'bug-reports/11/shot-1.png'))).toBe(true);
    expect(await db.select().from(schema.bugReports)).toMatchObject([{ id: 11 }]);
  });

  test('lets go of the lanes the event bus keeps of its runs that run', async () => {
    await db.insert(schema.testRuns).values({ id: 7, projectId: 1, status: 'running', startTime: new Date() });
    const begin = { title: 'pays', location: 'a.spec.ts:3:1', workerIndex: 0, parallelIndex: 0, retries: 0 };
    runEventBus.publish(7, { type: 'test-begin', data: begin });
    runEventBus.recordRunningCase(7, 'pays', begin);
    expect(runEventBus.getLanes(7)).toHaveLength(1);

    await deleteProject(1);

    expect(runEventBus.getLanes(7)).toEqual([]);
    expect(runEventBus.getRunningCases(7)).toEqual([]);
  });
});
