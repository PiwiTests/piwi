import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's gaps list, served through the demo router as the server's route answers it: a filter its query does not
 * name filters nothing, and one it names filters what the server's does.
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

interface GapsList {
  items: Array<{ id: number; prNumber: number | null }>;
}

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  const now = new Date();
  await db.insert(schema.scenarioGaps).values([
    {
      id: 1,
      projectId: 1,
      detector: 'changed-unreached',
      class: 'blind-spot',
      key: 'file:src/cart.ts',
      title: 'src/cart.ts changed but not reached',
      score: 0.4,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 2,
      projectId: 1,
      detector: 'new-control',
      class: 'blind-spot',
      key: 'control:/cart:Apply coupon',
      title: 'Apply coupon has no test',
      score: 0.3,
      prNumber: 418,
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

afterAll(() => close());

const gaps = (query?: string) =>
  handleDemoRequest('/api/projects/1/gaps', 'GET', undefined, query) as Promise<GapsList>;

describe('the demo gaps list', () => {
  test('lists every open gap when its query names no gap and no pull request, as the Gaps view asks', async () => {
    expect((await gaps('status=open')).items.map((g) => g.id).sort()).toEqual([1, 2]);
  });

  test('filters by the gap and the pull request its query names', async () => {
    expect((await gaps('gap=2')).items.map((g) => g.id)).toEqual([2]);
    expect((await gaps('pr=418')).items.map((g) => g.id)).toEqual([2]);
  });
});
