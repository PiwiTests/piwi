import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * A project's default environment: the setting `updateProject` checks, what `getProject` names and reads with no
 * environment picked, and what a copy of another project's environments carries.
 */

delete process.env.PIWI_DATABASE_URL;
const { copyEnvironments, createEnvironment, listInstanceEnvironments, updateEnvironment } =
  await import('../../shared/handlers/environments');
const { getProject, updateProject, InvalidDefaultEnvironmentError } = await import('../../shared/handlers/projects');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const SHOP = 1;
const OTHER = 2;

async function environmentId(projectId: number, key: string, name = key): Promise<number> {
  const created = await createEnvironment(db as never, projectId, { key, name });
  if (!created.ok) throw new Error(created.problems.join(' '));
  return created.environment.id;
}

async function storedDefault(projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.projects.defaultEnvironmentId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return row!.id;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: SHOP, name: 'shop', defaultBranch: 'main' },
    { id: OTHER, name: 'shop-globex', defaultBranch: 'main' },
  ]);
});

describe('the setting', () => {
  test('takes an environment of the project, refuses another project’s or an archived one, and null clears it', async () => {
    const staging = await environmentId(SHOP, 'staging', 'Staging');
    const elsewhere = await environmentId(OTHER, 'qa');
    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });
    expect(await storedDefault(SHOP)).toBe(staging);

    await expect(updateProject(db as never, SHOP, { defaultEnvironmentId: elsewhere })).rejects.toBeInstanceOf(
      InvalidDefaultEnvironmentError,
    );
    await expect(updateProject(db as never, SHOP, { defaultEnvironmentId: 'staging' })).rejects.toBeInstanceOf(
      InvalidDefaultEnvironmentError,
    );
    const archived = await environmentId(SHOP, 'old');
    await updateEnvironment(db as never, SHOP, archived, { archived: true });
    await expect(updateProject(db as never, SHOP, { defaultEnvironmentId: archived })).rejects.toThrow(/archived/);
    expect(await storedDefault(SHOP)).toBe(staging);

    await updateProject(db as never, SHOP, { defaultEnvironmentId: null });
    expect(await storedDefault(SHOP)).toBeNull();
  });
});

describe('the project', () => {
  test('names its default environment, and reads it with no environment picked', async () => {
    const staging = await environmentId(SHOP, 'staging', 'Staging');
    await environmentId(SHOP, 'production', 'Production');
    const start = Date.parse('2026-10-01T12:00:00Z');
    await db.insert(schema.testRuns).values(
      ['staging', 'production', null].map((label, i) => ({
        projectId: SHOP,
        status: 'passed',
        branch: 'main',
        environment: label,
        environmentId: label === 'staging' ? staging : label === 'production' ? staging + 1 : null,
        startTime: new Date(start + i * 60_000),
        metadata: {},
        isFullRun: 1,
      })),
    );
    const scope = {
      environments: [] as string[],
      allEnvironments: false,
      branches: [] as string[],
      allBranches: false,
      fullRunsOnly: true,
    };
    const labels = async (value = scope) =>
      ((await getProject(db as never, SHOP, { scope: value })).testRuns as Array<{ environment: string | null }>)
        .map((run) => run.environment)
        .sort();

    expect((await getProject(db as never, SHOP)).effectiveDefaultEnvironment).toBeNull();
    expect(await labels()).toEqual([null, 'production', 'staging'].sort());

    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });
    const project = await getProject(db as never, SHOP, { scope });
    expect(project.effectiveDefaultEnvironment).toEqual({ id: staging, key: 'staging', name: 'Staging' });
    expect(await labels()).toEqual(['staging']);
    expect(await labels({ ...scope, allEnvironments: true })).toEqual([null, 'production', 'staging'].sort());
    expect(await labels({ ...scope, environments: ['production'] })).toEqual(['production']);
    // The unscoped list keeps every run, for the filters' choices and the runs they hide.
    expect(project.unscopedRuns).toHaveLength(3);

    await updateEnvironment(db as never, SHOP, staging, { archived: true });
    expect((await getProject(db as never, SHOP)).effectiveDefaultEnvironment).toBeNull();
  });

  test('gives each run the key of its environment, which an alias’s run shares, for the filters to match', async () => {
    const created = await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging', aliases: ['stg'] });
    if (!created.ok) throw new Error(created.problems.join(' '));
    const staging = created.environment.id;
    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });
    const start = Date.parse('2026-10-01T12:00:00Z');
    await db.insert(schema.testRuns).values(
      ['stg', 'staging', null].map((label, i) => ({
        projectId: SHOP,
        status: 'passed',
        branch: 'main',
        environment: label,
        environmentId: label ? staging : null,
        startTime: new Date(start + i * 60_000),
        metadata: {},
        isFullRun: 1,
      })),
    );
    const project = await getProject(db as never, SHOP, {
      scope: { environments: [], allEnvironments: true, branches: [], allBranches: false, fullRunsOnly: true },
    });
    const keys = (runs: Array<{ environment?: string | null; environmentKey?: string | null }>) =>
      runs.map((run) => [run.environment, run.environmentKey]);
    expect(keys(project.testRuns)).toEqual([
      [null, null],
      ['staging', 'staging'],
      ['stg', 'staging'],
    ]);
    expect(keys(project.unscopedRuns!)).toEqual(keys(project.testRuns));
  });
});

describe('copying environments', () => {
  test('carries the source’s default to a target that has none, never over one it has', async () => {
    const staging = await environmentId(SHOP, 'staging', 'Staging');
    await environmentId(SHOP, 'production', 'Production');
    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });

    const { copied, defaultEnvironment } = await copyEnvironments(db as never, SHOP, OTHER, { canManageSource: true });
    const carried = copied.find((environment) => environment.key === 'staging')!.id;
    expect(await storedDefault(OTHER)).toBe(carried);
    expect(defaultEnvironment).toEqual({ id: carried, key: 'staging', name: 'Staging' });

    const production = copied.find((environment) => environment.key === 'production')!.id;
    await updateProject(db as never, OTHER, { defaultEnvironmentId: production });
    const again = await copyEnvironments(db as never, SHOP, OTHER, { canManageSource: true });
    expect(await storedDefault(OTHER)).toBe(production);
    expect(again.defaultEnvironment).toBeNull();
  });

  test('a copy that adds nothing still carries it to the target’s environment of that key', async () => {
    const staging = await environmentId(SHOP, 'staging', 'Staging');
    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });
    const own = await environmentId(OTHER, 'Staging', 'Staging (Globex)');
    const result = await copyEnvironments(db as never, SHOP, OTHER, { canManageSource: true });
    expect(result.copied).toEqual([]);
    expect(await storedDefault(OTHER)).toBe(own);
    expect(result.defaultEnvironment).toEqual({ id: own, key: 'Staging', name: 'Staging (Globex)' });
  });
});

describe('the environments across projects', () => {
  test('count how many projects read each key by default', async () => {
    const staging = await environmentId(SHOP, 'staging', 'Staging');
    await environmentId(OTHER, 'staging', 'Staging');
    await updateProject(db as never, SHOP, { defaultEnvironmentId: staging });
    expect(await listInstanceEnvironments(db as never, 'all')).toEqual([
      { key: 'staging', names: ['Staging'], projects: 2, defaults: 1 },
    ]);
    expect(await listInstanceEnvironments(db as never, new Set([OTHER]))).toEqual([
      { key: 'staging', names: ['Staging'], projects: 1, defaults: 0 },
    ]);
  });
});
