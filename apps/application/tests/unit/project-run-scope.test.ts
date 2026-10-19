import { beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import {
  parseProjectRunScope,
  projectRunScopeQuery,
  runInProjectScope,
  type ProjectRunScope,
} from '../../shared/project-run-scope';

delete process.env.PIWI_DATABASE_URL;
const { projectRunScopeConditions } = await import('../../shared/handlers/project-run-scope');
const { getProjectFailureClusters, getProjectTestCases, getProjectPerformance } =
  await import('../../shared/handlers/projects');

const scope = (change: Partial<ProjectRunScope> = {}): ProjectRunScope => ({
  environments: [],
  branches: [],
  allBranches: false,
  fullRunsOnly: true,
  ...change,
});

describe('parseProjectRunScope', () => {
  test('a request without environments, branches or allBranches reads unscoped', () => {
    expect(parseProjectRunScope({})).toBeNull();
    expect(parseProjectRunScope({ fullRunsOnly: 'false', runs: '50' })).toBeNull();
    expect(parseProjectRunScope(null)).toBeNull();
  });

  test('reads the analytics keys: comma lists, the branch policy and the run kind', () => {
    expect(
      parseProjectRunScope({ environments: 'staging, production', branches: 'main,', fullRunsOnly: 'false' }),
    ).toEqual({ environments: ['staging', 'production'], branches: ['main'], allBranches: false, fullRunsOnly: false });
    expect(parseProjectRunScope(new URLSearchParams('allBranches=true'))).toEqual(scope({ allBranches: true }));
  });

  test('round-trips through its query, which always reads as scoped', () => {
    for (const value of [
      scope(),
      scope({ allBranches: true, fullRunsOnly: false }),
      scope({ environments: ['ci'], branches: ['main', 'release/2.0'] }),
    ]) {
      expect(parseProjectRunScope(projectRunScopeQuery(value))).toEqual(value);
    }
  });
});

describe('runInProjectScope', () => {
  const run = (branch: string | null, extra: { environment?: string; isFullRun?: boolean } = {}) => ({
    branch,
    environment: extra.environment ?? 'ci',
    isFullRun: extra.isFullRun ?? true,
  });

  test('with no branch picked, reads the default branch and runs that report none', () => {
    expect(runInProjectScope(run('main'), scope(), 'main')).toBe(true);
    expect(runInProjectScope(run(null), scope(), 'main')).toBe(true);
    expect(runInProjectScope(run('  '), scope(), 'main')).toBe(true);
    expect(runInProjectScope(run('feature/x'), scope(), 'main')).toBe(false);
    expect(runInProjectScope(run('feature/x'), scope({ allBranches: true }), 'main')).toBe(true);
  });

  test('picked branches read exactly those, never a run with no branch', () => {
    const picked = scope({ branches: ['feature/x'] });
    expect(runInProjectScope(run('feature/x'), picked, 'main')).toBe(true);
    expect(runInProjectScope(run('main'), picked, 'main')).toBe(false);
    expect(runInProjectScope(run(null), picked, 'main')).toBe(false);
  });

  test('environments and full runs only narrow independently', () => {
    expect(runInProjectScope(run('main', { environment: 'prod' }), scope({ environments: ['ci'] }), 'main')).toBe(
      false,
    );
    expect(runInProjectScope(run('main', { isFullRun: false }), scope(), 'main')).toBe(false);
    expect(runInProjectScope(run('main', { isFullRun: false }), scope({ fullRunsOnly: false }), 'main')).toBe(true);
  });
});

describe('the scope in SQL', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values([
      { id: 1, name: 'configured', defaultBranch: 'main' },
      { id: 2, name: 'unconfigured' },
    ]);
    const start = Date.parse('2026-10-01T12:00:00Z');
    const run = (id: number, projectId: number, branch: string | null, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      status: 'failed',
      branch,
      environment: 'ci',
      startTime: new Date(start + id * 60_000),
      metadata: {},
      ...extra,
    });
    await db
      .insert(schema.testRuns)
      .values([
        run(1, 1, 'main'),
        run(2, 1, 'main', { isFullRun: 0 }),
        run(3, 1, 'feature/x'),
        run(4, 1, null),
        run(5, 1, 'main', { environment: 'staging' }),
        run(6, 2, 'develop'),
        run(7, 2, 'develop'),
        run(8, 2, 'feature/y'),
      ]);
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'totals' },
      { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'coupon' },
    ]);
    await db.insert(schema.failureClusters).values([
      {
        id: 1,
        projectId: 1,
        fingerprint: 'fp-main',
        signature: 'on main',
        firstSeenRunId: 1,
        lastSeenRunId: 3,
        occurrences: 3,
      },
      {
        id: 2,
        projectId: 1,
        fingerprint: 'fp-feature',
        signature: 'on a feature',
        firstSeenRunId: 3,
        lastSeenRunId: 3,
        occurrences: 1,
      },
    ]);
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, testCaseId: 1, status: 'failed', failureClusterId: 1 },
      { testRunId: 1, testCaseId: 2, status: 'passed' },
      { testRunId: 2, testCaseId: 1, status: 'failed', failureClusterId: 1 },
      { testRunId: 3, testCaseId: 1, status: 'failed', failureClusterId: 1 },
      { testRunId: 3, testCaseId: 2, status: 'failed', failureClusterId: 2 },
      { testRunId: 4, testCaseId: 1, status: 'passed' },
      { testRunId: 5, testCaseId: 1, status: 'passed' },
    ]);
  });

  async function runIds(projectId: number, value: ProjectRunScope): Promise<number[]> {
    const conditions = await projectRunScopeConditions(db as never, projectId, value);
    const rows = await db
      .select({ id: schema.testRuns.id })
      .from(schema.testRuns)
      .where(and(eq(schema.testRuns.projectId, projectId), ...conditions))
      .orderBy(schema.testRuns.id);
    return rows.map((r) => r.id);
  }

  test('the default scope reads full runs on the default branch and runs with no branch', async () => {
    expect(await runIds(1, scope())).toEqual([1, 4, 5]);
  });

  test('a project with no default branch set reads its most common run branch', async () => {
    expect(await runIds(2, scope())).toEqual([6, 7]);
  });

  test('every branch, picked branches, environments and partial runs', async () => {
    expect(await runIds(1, scope({ allBranches: true }))).toEqual([1, 3, 4, 5]);
    expect(await runIds(1, scope({ branches: ['feature/x'] }))).toEqual([3]);
    expect(await runIds(1, scope({ environments: ['staging'] }))).toEqual([5]);
    expect(await runIds(1, scope({ fullRunsOnly: false }))).toEqual([1, 2, 4, 5]);
  });

  test('clusters seen in the scope, counted over its runs', async () => {
    const onDefault = await getProjectFailureClusters(db as never, 1, undefined, scope());
    expect(onDefault.map((c: { id: number }) => c.id)).toEqual([1]);
    expect(onDefault[0]).toMatchObject({ occurrences: 1, affectedTests: 1, lastSeenRunId: 1 });

    const everywhere = await getProjectFailureClusters(
      db as never,
      1,
      undefined,
      scope({ allBranches: true, fullRunsOnly: false }),
    );
    expect(everywhere.map((c: { id: number }) => c.id).sort()).toEqual([1, 2]);
    expect(everywhere.find((c: { id: number }) => c.id === 1)).toMatchObject({ occurrences: 3, lastSeenRunId: 3 });

    // Without a scope the list keeps the clusters' stored totals.
    const unscoped = await getProjectFailureClusters(db as never, 1);
    expect(unscoped.find((c: { id: number }) => c.id === 1)).toMatchObject({ occurrences: 3, lastSeenRunId: 3 });
  });

  test('the test catalog counts the executions of the scope’s runs', async () => {
    const totals = async (value?: ProjectRunScope) => {
      const page = await getProjectTestCases(db as never, 1, { sort: 'title', dir: 'asc', scope: value });
      return Object.fromEntries(page.items.map((t: { title: string; totalRuns: number }) => [t.title, t.totalRuns]));
    };
    expect(await totals(scope())).toEqual({ coupon: 1, totals: 3 });
    expect(await totals(scope({ branches: ['feature/x'] }))).toEqual({ coupon: 1, totals: 1 });
    expect(await totals()).toEqual({ coupon: 2, totals: 5 });
  });

  test('the performance trend reads the scope’s runs', async () => {
    const ids = async (value: ProjectRunScope) =>
      (await getProjectPerformance(db as never, 1, 50, undefined, undefined, true, value)).map(
        (r: { id: number }) => r.id,
      );
    expect(await ids(scope())).toEqual([1, 4, 5]);
    expect(await ids(scope({ environments: ['ci'], allBranches: true }))).toEqual([1, 3, 4]);
  });

  test('a run of another project never leaks into a scope', async () => {
    const conditions = await projectRunScopeConditions(db as never, 1, scope({ allBranches: true }));
    const rows = await db
      .select({ id: schema.testRuns.id })
      .from(schema.testRuns)
      .where(and(inArray(schema.testRuns.id, [6, 7, 8]), eq(schema.testRuns.projectId, 1), ...conditions));
    expect(rows).toEqual([]);
  });
});
