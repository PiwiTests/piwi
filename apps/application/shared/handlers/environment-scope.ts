import { and, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { environments, markers, testRuns } from '../../server/database/schema';
import { NO_ENVIRONMENT_FILTER } from '#shared/environments';
import type { DrizzleDB } from './db';

/**
 * The runs a filter's environments name, as SQL over `test_runs`: a run whose environment has one of the names as its
 * key (ignoring case, so a run whose label is an alias of it counts), a run whose label is one of them (a run stored
 * past the project's room for discovered environments), and with `NO_ENVIRONMENT_FILTER` a run with no label. Null
 * for an empty list: no condition.
 */
export function environmentScopeSql(names: readonly string[]): SQL | null {
  const named = names.filter((name) => name !== NO_ENVIRONMENT_FILTER);
  const parts: SQL[] = [];
  if (named.length > 0) {
    const folds = [...new Set(named.map((name) => name.toLowerCase()))];
    parts.push(inArray(testRuns.environment, named));
    parts.push(
      sql`${testRuns.environmentId} IN (SELECT ${environments.id} FROM ${environments} WHERE ${inArray(environments.keyFold, folds)})`,
    );
  }
  if (names.includes(NO_ENVIRONMENT_FILTER)) parts.push(isNull(testRuns.environment));
  return parts.length > 0 ? or(...parts)! : null;
}

/**
 * The key of the environment a run's label resolves to, as a column of a select over `test_runs`: what a filter's
 * environments match beside the label (`runInProjectScope`'s `environmentKey`). Null for a run with none.
 */
export function runEnvironmentKeySql(): SQL<string | null> {
  return sql<
    string | null
  >`(SELECT ${environments.key} FROM ${environments} WHERE ${environments.id} = ${testRuns.environmentId})`;
}

/** A label the stored runs of a project reported. */
export interface ProjectLabel {
  projectId: number;
  label: string;
}

/**
 * The labels the stored runs of a filter's environments reported, each with its run's project: the runs whose
 * environment has one of the names as its key, ignoring case, in `projectIds` (`'all'` for every project). What a
 * table keyed by a run's project and label (the analytics rollups) reads for those environments, beside the names
 * themselves. One query; none for a list that names no environment.
 */
export async function namedEnvironmentRunLabels(
  db: DrizzleDB,
  names: readonly string[],
  projectIds: 'all' | readonly number[],
): Promise<ProjectLabel[]> {
  const folds = [...new Set(names.filter((name) => name !== NO_ENVIRONMENT_FILTER).map((name) => name.toLowerCase()))];
  if (folds.length === 0 || (projectIds !== 'all' && projectIds.length === 0)) return [];
  const named = and(
    inArray(environments.keyFold, folds),
    projectIds === 'all' ? undefined : inArray(environments.projectId, [...projectIds]),
  );
  const rows: Array<{ projectId: number; label: string | null }> = await db
    .selectDistinct({ projectId: testRuns.projectId, label: testRuns.environment })
    .from(testRuns)
    .where(
      and(
        sql`${testRuns.environmentId} IN (SELECT ${environments.id} FROM ${environments} WHERE ${named})`,
        isNotNull(testRuns.environment),
      ),
    );
  return projectLabels(rows);
}

/** The rows of a select of a run's project and label, without the runs that reported none. */
export function projectLabels(rows: ReadonlyArray<{ projectId: number; label: string | null }>): ProjectLabel[] {
  return rows.flatMap((row) => (row.label ? [{ projectId: Number(row.projectId), label: row.label }] : []));
}

/**
 * The timeline markers a filter's environments show, as SQL over `markers`: a marker of every environment (no label),
 * a marker whose environment has one of the names as its key, and a marker whose label is one of them, both ignoring
 * case. Null for an empty list: no condition.
 */
export function markerEnvironmentScopeSql(names: readonly string[]): SQL | null {
  if (names.length === 0) return null;
  const folds = [...new Set(names.filter((name) => name !== NO_ENVIRONMENT_FILTER).map((name) => name.toLowerCase()))];
  const parts: SQL[] = [isNull(markers.environment)];
  if (folds.length > 0) {
    parts.push(inArray(sql`lower(${markers.environment})`, folds));
    parts.push(
      sql`${markers.environmentId} IN (SELECT ${environments.id} FROM ${environments} WHERE ${inArray(environments.keyFold, folds)})`,
    );
  }
  return or(...parts)!;
}
