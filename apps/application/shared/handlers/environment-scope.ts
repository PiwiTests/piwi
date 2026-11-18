import { inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { environments, testRuns } from '../../server/database/schema';
import { NO_ENVIRONMENT_FILTER } from '#shared/environments';

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
 * The labels a filter's environments name, for a table keyed by a run's label (the analytics rollups): the names
 * themselves, and every label of a stored run whose environment has one of them as its key. A label only an archived
 * rollup part still holds counts when it equals a name.
 */
export function environmentLabelsSql(names: readonly string[]): SQL {
  const named = names.filter((name) => name !== NO_ENVIRONMENT_FILTER);
  const folds = [...new Set(named.map((name) => name.toLowerCase()))];
  return sql`SELECT ${
    named.length > 0
      ? sql.join(
          named.map((name) => sql`${name}`),
          sql`, `,
        )
      : sql`NULL`
  } UNION SELECT DISTINCT ${testRuns.environment} FROM ${testRuns} WHERE ${testRuns.environmentId} IN (SELECT ${environments.id} FROM ${environments} WHERE ${folds.length > 0 ? inArray(environments.keyFold, folds) : sql`0 = 1`})`;
}
