/**
 * The environment policy of an analytics scope, as SQL over `test_runs`, over the daily rollups, whose cells are
 * keyed by a project and the label a run reported (`''` for none), and over the timeline markers.
 */

import { and, eq, inArray, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { NO_ENVIRONMENT_FILTER } from '../../environments';
import { markers, testRuns } from '../../../server/database/schema';
import type { DefaultEnvironment } from '../default-environment';
import { environmentScopeSql, markerEnvironmentScopeSql, type ProjectLabel } from '../environment-scope';

export type EnvironmentPolicy =
  /** Every environment. */
  | { kind: 'any' }
  /**
   * Exactly these environments, picked by hand: keys or labels, and `NO_ENVIRONMENT_FILTER`. `labels` holds the
   * labels the stored runs of the environments they name reported, each with its project
   * (`namedEnvironmentRunLabels`).
   */
  | { kind: 'list'; environments: string[]; labels: ProjectLabel[] }
  /**
   * Each project's default environment, by its key, for the projects of `groups`; every other project reads every
   * environment. A run with no environment counts in no project with a default. `labels` holds the labels the stored
   * runs of each default environment reported, each with its project (`projectDefaultEnvironmentLabels`).
   */
  | { kind: 'default'; groups: Array<{ key: string; projectIds: number[] }>; labels: ProjectLabel[] };

/**
 * The policy of projects given their default environments and the labels their stored runs reported
 * (`projectDefaultEnvironmentLabels`): `any` when none has one, else one group per default key ignoring case, so the
 * SQL has one clause per key.
 */
export function defaultEnvironmentPolicy(
  defaults: ReadonlyMap<number, DefaultEnvironment>,
  labels: readonly ProjectLabel[] = [],
): EnvironmentPolicy {
  const byKey = new Map<string, { key: string; projectIds: number[] }>();
  for (const [projectId, environment] of defaults) {
    const fold = environment.key.toLowerCase();
    const group = byKey.get(fold) ?? { key: environment.key, projectIds: [] };
    group.projectIds.push(projectId);
    byKey.set(fold, group);
  }
  if (byKey.size === 0) return { kind: 'any' };
  return {
    kind: 'default',
    groups: [...byKey.values()],
    labels: labels.filter((label) => defaults.has(label.projectId)),
  };
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
 * The condition a policy puts on rows keyed by a run's project and label, or null for none. A row counts in its own
 * project only: under a label equal to one of the environments read, ignoring case, or under a label that project's
 * runs of them reported (`labels`); `''` holds the runs with no environment, read when the list names
 * `NO_ENVIRONMENT_FILTER`.
 */
export function environmentPolicyLabelCondition(
  policy: EnvironmentPolicy,
  columns: { environment: SQLWrapper; projectId: SQLWrapper },
): SQL | null {
  if (policy.kind === 'any') return null;
  const ownLabels = projectLabelsSql(policy.labels, columns);
  const fold = sql`lower(${columns.environment})`;
  if (policy.kind === 'list') {
    const folds = [
      ...new Set(
        policy.environments.filter((name) => name !== NO_ENVIRONMENT_FILTER).map((name) => name.toLowerCase()),
      ),
    ];
    const parts: SQL[] = [];
    if (folds.length > 0) parts.push(inArray(fold, folds));
    if (ownLabels) parts.push(ownLabels);
    if (policy.environments.includes(NO_ENVIRONMENT_FILTER)) parts.push(eq(columns.environment as any, ''));
    return or(...parts) ?? sql`1 = 0`;
  }
  return or(
    notInArray(
      columns.projectId as any,
      policy.groups.flatMap((group) => group.projectIds),
    ),
    ...policy.groups.map((group) =>
      and(inArray(columns.projectId as any, group.projectIds), eq(fold, group.key.toLowerCase()))!,
    ),
    ownLabels ?? undefined,
  )!;
}

/**
 * Rows whose project and label are one of `labels`, as SQL: one clause per set of projects that share the same
 * labels. Null for no label.
 */
function projectLabelsSql(
  labels: readonly ProjectLabel[],
  columns: { environment: SQLWrapper; projectId: SQLWrapper },
): SQL | null {
  const byProject = new Map<number, Set<string>>();
  for (const { projectId, label } of labels) {
    const set = byProject.get(projectId) ?? new Set<string>();
    set.add(label);
    byProject.set(projectId, set);
  }
  const bySet = new Map<string, { projectIds: number[]; labels: string[] }>();
  for (const [projectId, set] of byProject) {
    const sorted = [...set].sort();
    const key = JSON.stringify(sorted);
    const group = bySet.get(key) ?? { projectIds: [], labels: sorted };
    group.projectIds.push(projectId);
    bySet.set(key, group);
  }
  const parts = [...bySet.values()].map((group) =>
    and(inArray(columns.projectId as any, group.projectIds), inArray(columns.environment as any, group.labels))!,
  );
  return or(...parts) ?? null;
}

/**
 * The condition a policy puts on the timeline markers, or null for none: a marker of every environment (no label)
 * always counts; under the default policy, a marker of a project with a default environment counts when it is of that
 * environment (`markerEnvironmentScopeSql`), and every marker of another project counts.
 */
export function environmentPolicyMarkerCondition(policy: EnvironmentPolicy): SQL | null {
  if (policy.kind === 'any') return null;
  if (policy.kind === 'list') return markerEnvironmentScopeSql(policy.environments);
  return or(
    notInArray(
      markers.projectId,
      policy.groups.flatMap((group) => group.projectIds),
    ),
    ...policy.groups.map((group) =>
      and(inArray(markers.projectId, group.projectIds), markerEnvironmentScopeSql([group.key]) ?? undefined)!,
    ),
  )!;
}
