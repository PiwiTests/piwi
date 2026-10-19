import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

/**
 * Which runs the flaky leaderboard reads: with no branch named, those of the
 * project's default branch as the project tabs resolve it, even when no
 * default branch is stored. The Analytics widget ranks each project over the
 * whole scope (period, environments, browsers, test filter) before its cut.
 */

delete process.env.PIWI_DATABASE_URL;
const { getProjectFlakyTests } = await import('../../shared/handlers/projects');
const { getAnalyticsFlakyLeaderboard } = await import('../../shared/handlers/analytics/flaky-leaderboard');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

/** A run of `projectId` on `branch` where each named test retry-passes and every other test passes. */
async function seedRun(
  projectId: number,
  branch: string,
  hoursAgo: number,
  tests: Record<number, 'pass' | 'flaky'>,
  extra: Partial<typeof schema.testRuns.$inferInsert> = {},
) {
  runSeq += 1;
  const browserName = extra.environment === 'firefox-only' ? 'firefox' : 'chromium';
  const [run] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'passed',
      branch,
      startTime: new Date(NOW - hoursAgo * HOUR_MS),
      duration: 60_000,
      totalTests: Object.keys(tests).length,
      isFullRun: 1,
      ...extra,
    })
    .returning({ id: schema.testRuns.id });
  for (const [caseId, outcome] of Object.entries(tests)) {
    const attempts = outcome === 'flaky' ? ['failed', 'passed'] : ['passed'];
    for (const [retries, status] of attempts.entries()) {
      await db.insert(schema.testRunsCases).values({
        testRunId: run!.id,
        testCaseId: Number(caseId),
        status,
        retries,
        duration: 2_000,
        browserName,
        browser: { projectName: browserName },
      });
    }
  }
  return run!.id;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  // No default branch stored: most of the project's runs are on develop.
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'flaky on develop' },
    { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'flaky on a feature branch' },
  ]);
  for (const hoursAgo of [10, 9, 8, 7]) await seedRun(1, 'develop', hoursAgo, { 1: hoursAgo === 8 ? 'flaky' : 'pass' });
  for (const hoursAgo of [6, 5, 4]) await seedRun(1, 'feature/x', hoursAgo, { 2: hoursAgo === 5 ? 'flaky' : 'pass' });

  // Project 2: 55 noisy tests that flake twice, and one wanted test that flakes once.
  await db.insert(schema.projects).values({ id: 2, name: 'storefront', defaultBranch: 'main' });
  const noisy = Array.from({ length: 55 }, (_, i) => ({
    id: 100 + i,
    projectId: 2,
    filePath: 'noise.spec.ts',
    title: `noisy ${i}`,
  }));
  await db
    .insert(schema.testCases)
    .values([...noisy, { id: 99, projectId: 2, filePath: 'wanted.spec.ts', title: 'wanted' }]);
  for (const hoursAgo of [10, 9, 8, 7]) {
    const outcomes: Record<number, 'pass' | 'flaky'> = { 99: hoursAgo === 9 ? 'flaky' : 'pass' };
    for (const { id } of noisy) outcomes[id] = hoursAgo === 8 || hoursAgo === 7 ? 'flaky' : 'pass';
    await seedRun(2, 'main', hoursAgo, outcomes, { environment: 'staging' });
  }

  // Project 3: a test that flakes in firefox runs on qa, another in chromium runs on prod, and one 40 days ago.
  await db.insert(schema.projects).values({ id: 3, name: 'admin', defaultBranch: 'main' });
  await db.insert(schema.testCases).values([
    { id: 201, projectId: 3, filePath: 'admin.spec.ts', title: 'flaky in firefox' },
    { id: 202, projectId: 3, filePath: 'admin.spec.ts', title: 'flaky on prod' },
    { id: 203, projectId: 3, filePath: 'admin.spec.ts', title: 'flaky long ago' },
  ]);
  for (const hoursAgo of [10, 9, 8]) {
    await seedRun(3, 'main', hoursAgo, { 201: hoursAgo === 9 ? 'flaky' : 'pass' }, { environment: 'firefox-only' });
    await seedRun(3, 'main', hoursAgo, { 202: hoursAgo === 9 ? 'flaky' : 'pass' }, { environment: 'prod' });
    await seedRun(3, 'main', 40 * 24 + hoursAgo, { 203: hoursAgo === 9 ? 'flaky' : 'pass' }, { environment: 'prod' });
  }
});

const leaderboard = async (query: Record<string, string>) =>
  (await getAnalyticsFlakyLeaderboard(db as any, parseAnalyticsScope(query))).map((row) => row.title);

describe('the Analytics flaky leaderboard', () => {
  test('ranks a project over the tests of the test filter, so a match past its top 50 still shows', async () => {
    expect(await leaderboard({ projects: '2', files: 'wanted.spec.ts' })).toEqual(['wanted']);
  });

  test('reads the runs of the period only', async () => {
    expect(await leaderboard({ projects: '3' })).not.toContain('flaky long ago');
    expect(await leaderboard({ projects: '3', days: '60' })).toContain('flaky long ago');
  });

  test('honors several environments and the browser filter', async () => {
    expect((await leaderboard({ projects: '3', environments: 'prod,firefox-only' })).sort()).toEqual([
      'flaky in firefox',
      'flaky on prod',
    ]);
    expect(await leaderboard({ projects: '3', browsers: 'chromium' })).toEqual(['flaky on prod']);
  });
});

describe('the unscoped flaky leaderboard', () => {
  test('reads the default branch the project tabs resolve, not every branch', async () => {
    const titles = (await getProjectFlakyTests(db as any, 1, 50)).map((t) => t.title);
    expect(titles).toEqual(['flaky on develop']);
  });

  test('reads exactly the branch it is given', async () => {
    const titles = (await getProjectFlakyTests(db as any, 1, 50, null, undefined, 'feature/x')).map((t) => t.title);
    expect(titles).toEqual(['flaky on a feature branch']);
  });
});
