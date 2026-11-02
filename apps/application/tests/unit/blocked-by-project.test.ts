import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getTestRunCase } = await import('../../shared/handlers/test-cases');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** The ids of each project's executions, by test: `pays` failed, `ships` was skipped after it in the serial group. */
const ids = { firefox: { pays: 1, ships: 2 }, chromium: { pays: 3, ships: 4 }, mobile: { refunds: 5 } };
const BLOCKER = 'checkout.spec.ts:10:5';

/**
 * One run of a serial group in two Playwright projects, stored firefox first: in each, `pays` failed and `ships` was
 * skipped after it, both naming the blocker by its location, which is the same in every project. A third project
 * depends on both, and its `refunds` never ran because `pays` failed in them.
 */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'ships' },
    { id: 3, projectId: 1, filePath: 'refunds.spec.ts', title: 'refunds' },
  ]);
  const pays = (id: number, browserName: string) => ({
    id,
    testRunId: 1,
    testCaseId: 1,
    browserName,
    status: 'failed',
    line: 10,
    column: 5,
  });
  const ships = (id: number, browserName: string) => ({
    id,
    testRunId: 1,
    testCaseId: 2,
    browserName,
    status: 'didnotrun',
    didNotRunReason: 'previous-failure',
    blockedBy: BLOCKER,
    line: 20,
    column: 5,
  });
  await db.insert(schema.testRunsCases).values([
    pays(ids.firefox.pays, 'firefox'),
    ships(ids.firefox.ships, 'firefox'),
    pays(ids.chromium.pays, 'chromium'),
    ships(ids.chromium.ships, 'chromium'),
    {
      id: ids.mobile.refunds,
      testRunId: 1,
      testCaseId: 3,
      browserName: 'mobile',
      status: 'didnotrun',
      didNotRunReason: 'dependency-failure',
      blockedBy: BLOCKER,
      line: 4,
      column: 5,
    },
  ]);
});

describe('the execution page of a test blocked by another', () => {
  test('names the blocker that failed in its own project', async () => {
    const page = await getTestRunCase(db as never, ids.chromium.ships);

    expect(page?.blockedByCase?.id).toBe(ids.chromium.pays);
  });

  test("lists, under the blocker, its own project's cascade and the projects that depend on it", async () => {
    const page = await getTestRunCase(db as never, ids.chromium.pays);

    expect(page?.blockedTests.map((t: { id: number }) => t.id).sort()).toEqual([
      ids.chromium.ships,
      ids.mobile.refunds,
    ]);
  });

  test('names a failed dependency in another project', async () => {
    const page = await getTestRunCase(db as never, ids.mobile.refunds);

    expect([ids.firefox.pays, ids.chromium.pays]).toContain(page?.blockedByCase?.id);
  });

  test('never names an execution that passed, nor lists tests under it', async () => {
    // Firefox's `pays` passed, its cascade with it: only chromium's failure blocks.
    await db
      .update(schema.testRunsCases)
      .set({ status: 'passed' })
      .where(eq(schema.testRunsCases.id, ids.firefox.pays));

    expect((await getTestRunCase(db as never, ids.mobile.refunds))?.blockedByCase?.id).toBe(ids.chromium.pays);
    expect((await getTestRunCase(db as never, ids.firefox.pays))?.blockedTests).toEqual([]);
  });
});
