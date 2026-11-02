import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's quarantine view, served through the demo router from the shared
 * handler the server route answers with: the list, its debt and the candidates.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));
// The flaky analysis behind the candidates: test 1 flakes, expensively.
vi.mock('#shared/handlers/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/handlers/projects')>()),
  getProjectFlakyTests: async () => [
    {
      testCaseId: 1,
      title: 'pays',
      filePath: 'tests/cart.spec.ts',
      score: 60,
      wastedCiMinutes: 4,
      rootCause: 'timing',
    },
  ],
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');
const { addQuarantine } = await import('#shared/handlers/quarantine');

interface QuarantineView {
  entries: Array<{ testCaseId: number }>;
  candidates: Array<{ testCaseId: number; dismissed: boolean }>;
}

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'refunds' },
  ]);
  await addQuarantine(db as never, 1, 2);
});

afterAll(() => close());

const quarantineView = (query?: string) =>
  handleDemoRequest('/api/projects/1/quarantine', 'GET', undefined, query) as Promise<QuarantineView>;

describe('the demo quarantine view', () => {
  test('lists the candidates the flaky analysis proposes', async () => {
    const view = await quarantineView();
    expect(view.entries.map((entry) => entry.testCaseId)).toEqual([2]);
    expect(view.candidates).toMatchObject([{ testCaseId: 1, dismissed: false }]);
  });

  test('skips them with candidates=false, as the server does', async () => {
    expect((await quarantineView('candidates=false')).candidates).toEqual([]);
  });
});
