import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { and, eq, isNotNull, type SQL } from 'drizzle-orm';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { resolveBranchPolicy, resolveEnvironmentPolicy } = await import('../../shared/handlers/analytics/common');
const { environmentPolicyLabelCondition, environmentPolicyRunCondition } =
  await import('../../shared/handlers/analytics/environment-policy');
const { projectRunScopeConditions } = await import('../../shared/handlers/project-run-scope');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { projectDefaultBranch } = await import('../../server/utils/scm/stored-default-branch');

let db: ReturnType<typeof drizzle<typeof schema>>;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
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

describe('resolveEnvironmentPolicy', () => {
  // Project 1 reads staging by default, which `stg` names too; project 2 reads qa; project 3 has environments and no
  // default; the runs of project 3 report staging, a key project 1 also uses.
  beforeAll(async () => {
    await db.insert(schema.environments).values([
      { id: 11, projectId: 1, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'] },
      { id: 12, projectId: 1, key: 'production', keyFold: 'production', name: 'Production', position: 1 },
      { id: 21, projectId: 2, key: 'qa', keyFold: 'qa', name: 'QA' },
      { id: 31, projectId: 3, key: 'staging', keyFold: 'staging', name: 'Staging' },
      { id: 32, projectId: 3, key: 'qa', keyFold: 'qa', name: 'QA', position: 1 },
    ]);
    await db.update(schema.projects).set({ defaultEnvironmentId: 11 }).where(eq(schema.projects.id, 1));
    await db.update(schema.projects).set({ defaultEnvironmentId: 21 }).where(eq(schema.projects.id, 2));
    const run = (projectId: number, environment: string | null, environmentId: number | null) => ({
      projectId,
      status: 'passed',
      startTime: daysAgo(1),
      branch: 'main',
      metadata: {},
      environment,
      environmentId,
    });
    await db
      .insert(schema.testRuns)
      .values([
        run(1, 'staging', 11),
        run(1, 'stg', 11),
        run(1, 'production', 12),
        run(1, null, null),
        run(2, 'qa', 21),
        run(2, 'staging', null),
        run(3, 'staging', 31),
        run(3, 'qa', 32),
        run(3, null, null),
      ]);
  });

  const everyBranch = {
    environments: [],
    allEnvironments: false,
    branches: [],
    allBranches: true,
    fullRunsOnly: false,
  };

  async function runIdsOf(projectId: number, condition: SQL | null | undefined): Promise<number[]> {
    const rows = await db
      .select({ id: schema.testRuns.id })
      .from(schema.testRuns)
      .where(and(eq(schema.testRuns.projectId, projectId), condition ?? undefined))
      .orderBy(schema.testRuns.id);
    return rows.map((row) => row.id);
  }

  test('a project reads its default environment, a project without one every environment', async () => {
    const policy = await resolveEnvironmentPolicy(db as any, parseAnalyticsScope({}), 'all');
    if (policy.kind !== 'default') throw new Error(`expected the default-environment policy, got ${policy.kind}`);
    expect(new Map(policy.groups.flatMap((g) => g.projectIds.map((id) => [id, g.key] as const)))).toEqual(
      new Map([
        [1, 'staging'],
        [2, 'qa'],
      ]),
    );
  });

  test('agrees with the project tabs for every project, and so does a reading by label', async () => {
    const policy = await resolveEnvironmentPolicy(db as any, parseAnalyticsScope({}), 'all');
    const byLabel = environmentPolicyLabelCondition(policy, {
      environment: schema.testRuns.environment,
      projectId: schema.testRuns.projectId,
    });
    for (const projectId of [1, 2, 3, 4, 5]) {
      const tabs = await runIdsOf(
        projectId,
        and(...(await projectRunScopeConditions(db as any, projectId, everyBranch))),
      );
      expect(await runIdsOf(projectId, environmentPolicyRunCondition(policy))).toEqual(tabs);
      // The rollups count a run by its label: the runs with a label that read in the tabs, and no run with none.
      const labelled = await runIdsOf(projectId, and(byLabel ?? undefined, isNotNull(schema.testRuns.environment)));
      const tabsLabelled = await runIdsOf(
        projectId,
        and(
          ...(await projectRunScopeConditions(db as any, projectId, everyBranch)),
          isNotNull(schema.testRuns.environment),
        ),
      );
      expect(labelled).toEqual(tabsLabelled);
    }
  });

  test('picked environments and All environments override it; only the allowed projects are resolved', async () => {
    expect(await resolveEnvironmentPolicy(db as any, parseAnalyticsScope({ allEnvironments: 'true' }), 'all')).toEqual({
      kind: 'any',
    });
    expect(await resolveEnvironmentPolicy(db as any, parseAnalyticsScope({ environments: 'qa' }), 'all')).toEqual({
      kind: 'list',
      environments: ['qa'],
      labels: [
        { projectId: 2, label: 'qa' },
        { projectId: 3, label: 'qa' },
      ],
    });
    expect(await resolveEnvironmentPolicy(db as any, parseAnalyticsScope({}), [3, 4])).toEqual({ kind: 'any' });
  });
});

describe('the rollups and the markers read each project’s own labels', () => {
  // Projects 6 and 7 both read staging by default. Project 6's staging has the alias `qa`, which its runs report;
  // project 7 has a QA environment of its own. Project 4 has no default environment.
  const DAY = '2026-09-23';
  beforeAll(async () => {
    await db.insert(schema.projects).values([
      { id: 6, name: 'aliased' },
      { id: 7, name: 'own qa' },
    ]);
    await db.insert(schema.environments).values([
      { id: 61, projectId: 6, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['qa'] },
      { id: 62, projectId: 6, key: 'production', keyFold: 'production', name: 'Production', position: 1 },
      { id: 71, projectId: 7, key: 'staging', keyFold: 'staging', name: 'Staging' },
      { id: 72, projectId: 7, key: 'qa', keyFold: 'qa', name: 'QA', position: 1 },
    ]);
    await db.update(schema.projects).set({ defaultEnvironmentId: 61 }).where(eq(schema.projects.id, 6));
    await db.update(schema.projects).set({ defaultEnvironmentId: 71 }).where(eq(schema.projects.id, 7));
    const run = (projectId: number, environment: string, environmentId: number) => ({
      projectId,
      status: 'passed',
      startTime: daysAgo(1),
      branch: 'main',
      metadata: {},
      environment,
      environmentId,
    });
    await db.insert(schema.testRuns).values([run(6, 'qa', 61), run(6, 'production', 62), run(7, 'qa', 72)]);
    const cell = (projectId: number, environment: string) => ({
      projectId,
      day: DAY,
      environment,
      branch: 'main',
      fullRun: 1,
      part: 'retained',
      runs: 1,
    });
    // Project 6's `Staging` cell holds a label equal to the key in another case.
    await db
      .insert(schema.analyticsDailyRollups)
      .values([cell(6, 'qa'), cell(6, 'Staging'), cell(6, 'production'), cell(7, 'qa'), cell(7, 'staging')]);
    const marker = (projectId: number, label: string, environment: string | null, environmentId: number | null) => ({
      projectId,
      occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      label,
      category: 'release',
      environment,
      environmentId,
    });
    await db
      .insert(schema.markers)
      .values([
        marker(6, 'qa deploy', 'qa', 61),
        marker(6, 'production deploy', 'production', 62),
        marker(6, 'freeze', null, null),
        marker(7, 'qa deploy', 'qa', 72),
        marker(7, 'staging deploy', 'staging', 71),
        marker(4, 'production deploy', 'production', null),
      ]);
  });

  async function cellsOf(environments: Record<string, string>) {
    const { readRollupCells } = await import('../../shared/handlers/analytics/rollups');
    const policy = await resolveEnvironmentPolicy(db as any, parseAnalyticsScope(environments), [6, 7]);
    const cells = await readRollupCells(db as any, {
      projectIds: [6, 7],
      fromDay: DAY,
      toDay: DAY,
      environmentPolicy: policy,
      fullRunsOnly: false,
    });
    return cells.map((c) => `${c.projectId}:${c.environment}`).sort();
  }

  test('the default environments count another project’s label only where it names them', async () => {
    expect(await cellsOf({})).toEqual(['6:Staging', '6:qa', '7:staging']);
  });

  test('so do picked environments', async () => {
    expect(await cellsOf({ environments: 'staging' })).toEqual(['6:Staging', '6:qa', '7:staging']);
  });

  test('a marker is drawn when it is of the environment its project reads, or of every one', async () => {
    const { getAnalyticsScopeSummary } = await import('../../shared/handlers/analytics/scope-summary');
    const labels = async (query: Record<string, string>) =>
      (await getAnalyticsScopeSummary(db as any, parseAnalyticsScope({ projects: '4,6,7', ...query }), 'all')).markers
        .map((m) => `${m.projectId}:${m.ownLabel}`)
        .sort();
    expect(await labels({})).toEqual(['4:production deploy', '6:freeze', '6:qa deploy', '7:staging deploy']);
    expect(await labels({ allEnvironments: 'true' })).toHaveLength(6);
    expect(await labels({ environments: 'production' })).toEqual([
      '4:production deploy',
      '6:freeze',
      '6:production deploy',
    ]);
  });
});
