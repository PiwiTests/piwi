import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';
import { ADMIN_ACCESS } from '#shared/permissions';

/**
 * Which runs the flaky leaderboard reads: with no branch named, those of the
 * project's default branch as the project tabs resolve it, even when no
 * default branch is stored. The Analytics widget ranks each project over the
 * whole scope (period, environments, browsers, test filter) before its cut.
 */

delete process.env.PIWI_DATABASE_URL;
const { getProjectFlakyTests, newestFlakyRunId } = await import('../../shared/handlers/projects');
const { getAnalyticsFlakyLeaderboard } = await import('../../shared/handlers/analytics/flaky-leaderboard');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

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
      await db.insert(schema.testRunsCases).values(
        withStoredVerdicts({
          testRunId: run!.id,
          testCaseId: Number(caseId),
          status,
          retries,
          duration: 2_000,
          browserName,
          browser: { projectName: browserName },
        }),
      );
    }
  }
  return run!.id;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
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

describe('a project with a default environment', () => {
  // Project 3 declares prod, which `production` names too, and firefox-only; prod is its default environment.
  beforeAll(async () => {
    await db.insert(schema.environments).values([
      { id: 31, projectId: 3, key: 'prod', keyFold: 'prod', name: 'Production', aliases: ['production'] },
      { id: 32, projectId: 3, key: 'firefox-only', keyFold: 'firefox-only', name: 'Firefox', position: 1 },
    ]);
    await db.update(schema.testRuns).set({ environmentId: 31 }).where(eq(schema.testRuns.environment, 'prod'));
    await db.update(schema.testRuns).set({ environmentId: 32 }).where(eq(schema.testRuns.environment, 'firefox-only'));
    await db.update(schema.projects).set({ defaultEnvironmentId: 31 }).where(eq(schema.projects.id, 3));
  });

  afterAll(async () => {
    await db.update(schema.projects).set({ defaultEnvironmentId: null }).where(eq(schema.projects.id, 3));
    await db
      .update(schema.testRuns)
      .set({ environmentId: null })
      .where(inArray(schema.testRuns.environmentId, [31, 32]));
    await db.delete(schema.environments).where(inArray(schema.environments.id, [31, 32]));
  });

  test('the unscoped leaderboard, as quarantine candidates and pull request feedback read it, reads it alone', async () => {
    expect((await getProjectFlakyTests(db as any, 3, 50)).map((t) => t.title).sort()).toEqual([
      'flaky long ago',
      'flaky on prod',
    ]);
  });

  test('an explicit environment wins, matched by its key or an alias ignoring case', async () => {
    expect((await getProjectFlakyTests(db as any, 3, 50, 'firefox-only')).map((t) => t.title)).toEqual([
      'flaky in firefox',
    ]);
    expect((await getProjectFlakyTests(db as any, 3, 50, 'PRODUCTION')).map((t) => t.title).sort()).toEqual([
      'flaky long ago',
      'flaky on prod',
    ]);
  });

  test('MCP’s list_flaky_tests reads it, every environment with allEnvironments, and a named one first', async () => {
    const listFlakyTests = MCP_TOOLS.find((tool) => tool.name === 'list_flaky_tests')!.handler;
    const ctx = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };
    const titles = async (params: Record<string, unknown>) => {
      const page = (await listFlakyTests(db as any, { projectId: 3, pageSize: 50, ...params }, ctx)) as {
        items: Array<{ title: string }>;
      };
      return page.items.map((item) => item.title).sort();
    };
    expect(await titles({})).toEqual(['flaky long ago', 'flaky on prod']);
    expect(await titles({ allEnvironments: true })).toEqual(['flaky in firefox', 'flaky long ago', 'flaky on prod']);
    expect(await titles({ allEnvironments: true, environment: 'firefox-only' })).toEqual(['flaky in firefox']);
  });

  test('the newest run the quarantine dismissals key on is the default environment’s', async () => {
    const [newest] = await db
      .select({ environmentId: schema.testRuns.environmentId })
      .from(schema.testRuns)
      .where(eq(schema.testRuns.id, (await newestFlakyRunId(db as any, 3))!));
    expect(newest!.environmentId).toBe(31);
  });

  test('Analytics reads it for this project, and every environment under All environments', async () => {
    expect(await leaderboard({ projects: '3' })).toEqual(['flaky on prod']);
    expect((await leaderboard({ projects: '3', allEnvironments: 'true' })).sort()).toEqual([
      'flaky in firefox',
      'flaky on prod',
    ]);
    // A project with no default environment reads them all.
    expect(await leaderboard({ projects: '2', files: 'wanted.spec.ts' })).toEqual(['wanted']);
  });
});
