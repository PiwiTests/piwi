import { beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { resolveBranchPolicy } = await import('../../shared/handlers/analytics/common');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { projectDefaultBranch } = await import('../../server/utils/scm/stored-default-branch');

let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values([
    { id: 1, name: 'configured', defaultBranch: 'develop' },
    { id: 2, name: 'mostly develop' },
    { id: 3, name: 'tied' },
    { id: 4, name: 'no runs' },
    { id: 5, name: 'no branch' },
  ]);
  const run = (projectId: number, days: number, branch: string | null, metadata: Record<string, unknown> = {}) => ({
    projectId,
    status: 'passed',
    startTime: daysAgo(days),
    branch,
    metadata,
  });
  await db.insert(schema.testRuns).values([
    run(1, 1, 'main'),
    run(1, 2, 'main'),
    // A run's reported default branch is not what the project tabs read: the branch most runs are on is.
    run(2, 4, 'develop', { defaultBranch: 'master' }),
    run(2, 3, 'develop'),
    run(2, 1, 'feature/x', { defaultBranch: 'trunk' }),
    // A tie goes to the branch of the latest run.
    run(3, 2, 'release'),
    run(3, 1, 'trunk'),
    run(5, 1, null),
  ]);
});

async function defaultsOf(allowed: 'all' | number[]) {
  const policy = await resolveBranchPolicy(db as any, parseAnalyticsScope({}), allowed);
  if (policy.kind !== 'default') throw new Error(`expected the default-branch policy, got ${policy.kind}`);
  return new Map(policy.groups.flatMap((g) => g.projectIds.map((id) => [id, g.branch] as const)));
}

describe('resolveBranchPolicy', () => {
  test('a project uses its setting, else the branch most of its runs are on, else main', async () => {
    expect(await defaultsOf('all')).toEqual(
      new Map([
        [1, 'develop'],
        [2, 'develop'],
        [3, 'trunk'],
        [4, 'main'],
        [5, 'main'],
      ]),
    );
  });

  test('agrees with the project tabs for every project', async () => {
    const defaults = await defaultsOf('all');
    for (const [projectId, branch] of defaults) expect(await projectDefaultBranch(db as any, projectId)).toBe(branch);
  });

  test('only the allowed projects are resolved', async () => {
    expect(await defaultsOf([2, 4])).toEqual(
      new Map([
        [2, 'develop'],
        [4, 'main'],
      ]),
    );
  });
});
