import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { recomputeClusterOccurrences } = await import('../../shared/handlers/failure-cluster-ops');

let db: ReturnType<typeof drizzle<typeof schema>>;
const TRIAGED_AT = new Date('2026-10-01T09:00:00Z');

/** A cluster with one failure, triaged at `TRIAGED_AT` to the status each test sets. */
beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'cart.spec.ts', title: 'adds' });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    fingerprint: 'fp',
    signature: 'Error: boom',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    updatedAt: TRIAGED_AT,
  });
  await db.insert(schema.testRunsCases).values({ testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 });
});

const updatedAt = async () =>
  (await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 1)))[0]!.updatedAt;

describe("recounting a cluster's occurrences", () => {
  test.each(['resolved', 'ignored'])('keeps the time a %s cluster was triaged', async (status) => {
    await db.update(schema.failureClusters).set({ status, updatedAt: TRIAGED_AT });

    expect(await recomputeClusterOccurrences(db as never, 1)).toBe(1);

    expect(await updatedAt()).toEqual(TRIAGED_AT);
  });

  test("moves an open cluster's update time", async () => {
    await recomputeClusterOccurrences(db as never, 1);

    expect((await updatedAt())!.getTime()).toBeGreaterThan(TRIAGED_AT.getTime());
  });
});
