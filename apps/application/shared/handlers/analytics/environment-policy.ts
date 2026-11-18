/**
 * The environment policy of an analytics scope, as SQL over `test_runs` and over the daily rollups, whose cells are
 * keyed by the label a run reported (`''` for none).
 */

import { and, eq, inArray, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { NO_ENVIRONMENT_FILTER } from '../../environments';
import { testRuns } from '../../../server/database/schema';
import type { DefaultEnvironment } from '../default-environment';
import { environmentLabelsSql, environmentScopeSql } from '../environment-scope';

export type EnvironmentPolicy =
  /** Every environment. */
  | { kind: 'any' }
  /** Exactly these environments, picked by hand: keys or labels, and `NO_ENVIRONMENT_FILTER`. */
  | { kind: 'list'; environments: string[] }
  /**
   * Each project's default environment, by its key, for the projects of `groups`; every other project reads every
   * environment. A run with no environment counts in no project with a default.
   */
  | { kind: 'default'; groups: Array<{ key: string; projectIds: number[] }> };

/**
 * The policy of projects given their default environments (`projectDefaultEnvironments`): `any` when none has one,
 * else one group per default key ignoring case, so the SQL has one clause per key.
 */
export function defaultEnvironmentPolicy(defaults: ReadonlyMap<number, DefaultEnvironment>): EnvironmentPolicy {
  const byKey = new Map<string, { key: string; projectIds: number[] }>();
  for (const [projectId, environment] of defaults) {
    const fold = environment.key.toLowerCase();
    const group = byKey.get(fold) ?? { key: environment.key, projectIds: [] };
    group.projectIds.push(projectId);
    byKey.set(fold, group);
  }
  if (byKey.size === 0) return { kind: 'any' };
  return { kind: 'default', groups: [...byKey.values()] };
}

/** The condition a policy puts on `test_runs`, or null for none. */
export function environmentPolicyRunCondition(policy: EnvironmentPolicy): SQL | null {
  if (policy.kind === 'any') return null;
  if (policy.kind === 'list') return environmentScopeSql(policy.environments);
  return or(
    notInArray(
      testRuns.projectId,
      policy.groups.flatMap((group) => group.projectIds),
    ),
    ...policy.groups.map((group) =>
      and(inArray(testRuns.projectId, group.projectIds), environmentScopeSql([group.key]) ?? undefined)!,
    ),
  )!;
}

/**
 * The condition a policy puts on rows keyed by a run's label, or null for none: a label of the environments it reads
 * (`environmentLabelsSql`, the labels of a default environment read from its projects' own runs), `''` for the runs
 * with no environment when the list names `NO_ENVIRONMENT_FILTER`.
 */
export function environmentPolicyLabelCondition(
  policy: EnvironmentPolicy,
  columns: { environment: SQLWrapper; projectId: SQLWrapper },
): SQL | null {
  if (policy.kind === 'any') return null;
  if (policy.kind === 'list') {
    const labels = sql`${columns.environment} IN (${environmentLabelsSql(policy.environments)})`;
    return policy.environments.includes(NO_ENVIRONMENT_FILTER)
      ? or(labels, eq(columns.environment as any, ''))!
      : labels;
  }
  return or(
    notInArray(
      columns.projectId as any,
      policy.groups.flatMap((group) => group.projectIds),
    ),
    ...policy.groups.map((group) =>
      and(
        inArray(columns.projectId as any, group.projectIds),
        sql`${columns.environment} IN (${environmentLabelsSql([group.key], group.projectIds)})`,
      )!,
    ),
  )!;
}
