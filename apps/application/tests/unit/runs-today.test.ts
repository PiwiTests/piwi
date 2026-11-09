import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { runsInFilters } from '../../app/utils/home-overview';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { countRunsLast24h, getRecentTestRuns } = await import('../../shared/handlers/test-runs');
const { runOrigin } = await import('../../shared/run-eligibility');
const { PROBE_RUN_METADATA_KEY } = await import('../../shared/handlers/probes');

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * Two projects. Today: 40 full runs on staging, 3 partial ones on production,
 * 2 full ones of project 2 on production and a probe run; yesterday's runs, 30
 * hours ago, are not today's.
 */
beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin' },
  ]);
  const runs: Array<typeof schema.testRuns.$inferInsert> = [];
  const add = (projectId: number, environment: string, isFullRun: number, hoursAgo: number, metadata?: object) =>
    runs.push({
      projectId,
      environment,
      isFullRun,
      status: 'passed',
      startTime: new Date(NOW - hoursAgo * HOUR),
      metadata: metadata ?? null,
      origin: runOrigin(metadata ?? null),
    });
  for (let i = 0; i < 40; i++) add(1, 'staging', 1, 1 + i * 0.5);
  for (let i = 0; i < 3; i++) add(1, 'production', 0, 2);
  for (let i = 0; i < 2; i++) add(2, 'production', 1, 3);
  add(1, 'staging', 1, 1, { [PROBE_RUN_METADATA_KEY]: true });
  for (let i = 0; i < 5; i++) add(1, 'staging', 1, 30);
  await db.insert(schema.testRuns).values(runs);
});

describe("home's runs today", () => {
  test('counts every run of the last 24 hours, past the 30 the recent list holds, lab runs left out', async () => {
    expect((await getRecentTestRuns(db as never)).length).toBe(30);
    const counts = await countRunsLast24h(db as never, 'all', NOW);
    expect(runsInFilters(counts, { environments: [], fullRunsOnly: false })).toBe(45);
  });

  test("follows home's filters", async () => {
    const counts = await countRunsLast24h(db as never, 'all', NOW);
    expect(runsInFilters(counts, { environments: [], fullRunsOnly: true })).toBe(42);
    expect(runsInFilters(counts, { environments: ['production'], fullRunsOnly: false })).toBe(5);
    expect(runsInFilters(counts, { environments: ['production'], fullRunsOnly: true })).toBe(2);
  });

  test('counts only the projects the viewer may read', async () => {
    const counts = await countRunsLast24h(db as never, new Set([2]), NOW);
    expect(runsInFilters(counts, { environments: [], fullRunsOnly: false })).toBe(2);
    expect(await countRunsLast24h(db as never, new Set(), NOW)).toEqual([]);
  });
});
