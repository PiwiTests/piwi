import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

/**
 * Which runs the flaky leaderboard reads: with no branch named, those of the
 * project's default branch as the project tabs resolve it, even when no
 * default branch is stored.
 */

delete process.env.PIWI_DATABASE_URL;
const { getProjectFlakyTests } = await import('../../shared/handlers/projects');

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
        browserName: 'chromium',
        browser: { projectName: 'chromium' },
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
