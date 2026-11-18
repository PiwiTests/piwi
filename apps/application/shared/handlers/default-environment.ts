/**
 * A project's default environment (`projects.default_environment_id`): the environment its views read when no
 * environment is picked, as they read the default branch. An archived default reads as none, so the views then read
 * every environment. Also the environment a name picks in a project, for a reader given one.
 */
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { resolveEnvironment } from '@piwitests/core/environments';
import { environments, projects, testRuns } from '../../server/database/schema';
import type { EnvironmentRecord } from '../environments';
import { projectLabels, type ProjectLabel } from './environment-scope';
import type { DrizzleDB } from './db';

/** The default environment as the views name it. */
export type DefaultEnvironment = Pick<EnvironmentRecord, 'id' | 'key' | 'name'>;

/**
 * The join of a project to its default environment, left out when archived: a select from `projects` that joins
 * `environments` on it reads the default environment beside the project's row.
 */
export function defaultEnvironmentJoin(): SQL {
  return and(
    eq(environments.id, projects.defaultEnvironmentId),
    eq(environments.projectId, projects.id),
    isNull(environments.archivedAt),
  )!;
}

/** `projectIds` in chunks of 500, or one chunk of every project (null). */
function projectChunks(projectIds: readonly number[] | 'all'): Array<readonly number[] | null> {
  if (projectIds === 'all') return [null];
  const chunks: Array<readonly number[]> = [];
  for (let i = 0; i < projectIds.length; i += 500) chunks.push(projectIds.slice(i, i + 500));
  return chunks;
}

/**
 * The default environments of `projectIds` (`'all'` for every project), by project; a project without one, or whose
 * default is archived, is left out. One query per 500 projects.
 */
export async function projectDefaultEnvironments(
  db: DrizzleDB,
  projectIds: readonly number[] | 'all',
): Promise<Map<number, DefaultEnvironment>> {
  const found = new Map<number, DefaultEnvironment>();
  for (const chunk of projectChunks(projectIds)) {
    const rows = await db
      .select({ projectId: projects.id, id: environments.id, key: environments.key, name: environments.name })
      .from(projects)
      .innerJoin(environments, defaultEnvironmentJoin())
      .where(chunk ? inArray(projects.id, [...chunk]) : undefined);
    for (const row of rows) found.set(row.projectId, { id: row.id, key: row.key, name: row.name });
  }
  return found;
}

/**
 * `projectDefaultEnvironments`, with the labels the stored runs of each default environment reported (`labels`): what
 * a table keyed by a run's project and label (the analytics rollups) reads for it, beside its key. One query per 500
 * projects.
 */
export async function projectDefaultEnvironmentLabels(
  db: DrizzleDB,
  projectIds: readonly number[] | 'all',
): Promise<{ defaults: Map<number, DefaultEnvironment>; labels: ProjectLabel[] }> {
  const defaults = new Map<number, DefaultEnvironment>();
  const labels: ProjectLabel[] = [];
  for (const chunk of projectChunks(projectIds)) {
    const rows = await db
      .selectDistinct({
        projectId: projects.id,
        id: environments.id,
        key: environments.key,
        name: environments.name,
        label: testRuns.environment,
      })
      .from(projects)
      .innerJoin(environments, defaultEnvironmentJoin())
      .leftJoin(testRuns, and(eq(testRuns.projectId, projects.id), eq(testRuns.environmentId, environments.id)))
      .where(chunk ? inArray(projects.id, [...chunk]) : undefined);
    for (const row of rows) defaults.set(row.projectId, { id: row.id, key: row.key, name: row.name });
    labels.push(...projectLabels(rows));
  }
  return { defaults, labels };
}

/** `projectDefaultEnvironments` for one project: its default environment, or null. */
export async function projectDefaultEnvironment(db: DrizzleDB, projectId: number): Promise<DefaultEnvironment | null> {
  return (await projectDefaultEnvironments(db, [projectId])).get(projectId) ?? null;
}

/** Why `environmentId` cannot be a project's default environment, in words; null when it can (null clears it). */
export async function defaultEnvironmentProblem(
  db: DrizzleDB,
  projectId: number,
  environmentId: unknown,
): Promise<string | null> {
  if (environmentId === null) return null;
  if (typeof environmentId !== 'number' || !Number.isInteger(environmentId) || environmentId <= 0) {
    return 'defaultEnvironmentId must be the id of one of the project’s environments, or null';
  }
  const [row] = await db
    .select({ archivedAt: environments.archivedAt })
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  if (!row) return 'defaultEnvironmentId names no environment of this project';
  if (row.archivedAt != null) return 'An archived environment cannot be the default one: unarchive it first';
  return null;
}

/**
 * The environment of project `projectId` that `name` names, by its key or an alias, ignoring case, as a run's label
 * resolves (`resolveEnvironment`); archived ones left out with `active`. Null when none does.
 */
export async function namedProjectEnvironment(
  db: DrizzleDB,
  projectId: number,
  name: string,
  { active = false }: { active?: boolean } = {},
): Promise<DefaultEnvironment | null> {
  const rows = await db
    .select({
      id: environments.id,
      key: environments.key,
      name: environments.name,
      aliases: environments.aliases,
      position: environments.position,
    })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), active ? isNull(environments.archivedAt) : undefined))
    .orderBy(asc(environments.position), asc(environments.id));
  const sources = rows.map((row) => ({
    id: row.id,
    key: row.key,
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((alias): alias is string => typeof alias === 'string')
      : [],
    position: row.position,
  }));
  const found = rows.find((row) => row.id === resolveEnvironment(name, sources));
  return found ? { id: found.id, key: found.key, name: found.name } : null;
}

/**
 * Give project `toProjectId`, when it has no default environment, the default of project `fromProjectId`: its
 * environment, not archived, that the source default's key names (`namedProjectEnvironment`). Returns the default it
 * gave, or null when it gave none.
 */
export async function carryDefaultEnvironment(
  db: DrizzleDB,
  fromProjectId: number,
  toProjectId: number,
): Promise<DefaultEnvironment | null> {
  const source = await projectDefaultEnvironment(db, fromProjectId);
  if (!source) return null;
  const [target] = await db
    .select({ defaultEnvironmentId: projects.defaultEnvironmentId })
    .from(projects)
    .where(eq(projects.id, toProjectId));
  if (!target || target.defaultEnvironmentId != null) return null;
  const found = await namedProjectEnvironment(db, toProjectId, source.key, { active: true });
  if (!found) return null;
  await db.update(projects).set({ defaultEnvironmentId: found.id }).where(eq(projects.id, toProjectId));
  return found;
}
