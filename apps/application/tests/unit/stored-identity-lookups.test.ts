import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { runningTestHistory } = await import('../../shared/handlers/stuck-tests');
const { storedIdentity, MAX_IDENTITY_BYTES } = await import('../../server/utils/storable-values');

let db: ReturnType<typeof drizzle<typeof schema>>;

/** A title longer than an identity is stored whole, as a data-driven test can build one. */
const LONG_TITLE = `checks the order ${'with every line item and its discount '.repeat(40)}`;
const PROJECT = 'Desktop Chrome';

/** One passing execution of the long-titled test, stored as ingest stores it: under its shortened title. */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date() });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, filePath: 'orders.spec.ts', title: await storedIdentity(LONG_TITLE) });
  await db.insert(schema.testRunsCases).values({
    testRunId: 1,
    testCaseId: 1,
    status: 'passed',
    duration: 1200,
    browserName: PROJECT,
  });
});

describe('a lookup by a test name longer than the stored one', () => {
  test("finds a running test's history under its stored name", async () => {
    expect(Buffer.byteLength(LONG_TITLE)).toBeGreaterThan(MAX_IDENTITY_BYTES);

    const history = await runningTestHistory(db as never, {
      projectId: 1,
      filePath: 'orders.spec.ts',
      suitePath: null,
      title: LONG_TITLE,
      browserName: PROJECT,
    });

    expect(history.passingDurations).toEqual([1200]);
  });
});
