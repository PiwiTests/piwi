/**
 * The choices of a project's environment filter, read from the project's environments (`useProjectEnvironments`), and
 * the environment a page's copied commands and run requests start on.
 */
import { resolveEnvironment } from '@piwitests/core/environments';
import { NO_ENVIRONMENT_FILTER, type EnvironmentRecord } from '#shared/environments';

/** One choice of an environment filter: the value it stores and the words it shows. */
export interface EnvironmentFilterItem {
  label: string;
  value: string;
}

/** The words a filter shows for the runs with no environment. */
export const NO_ENVIRONMENT_LABEL = 'No environment';

function byPosition(a: EnvironmentRecord, b: EnvironmentRecord): number {
  return a.position - b.position || a.id - b.id;
}

function sameKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The choices of a project's environment filter, each stored as an environment's key (which the run scope matches
 * ignoring case, aliases included) and shown by its name: the environments that are not archived, in position order;
 * then the labels of the project's recent runs that no environment takes, as they came; then each value of `selected`
 * none of these holds, so a stored filter shows what it keeps (an archived environment by its name); and last **No
 * environment** (`NO_ENVIRONMENT_FILTER`), once anything else is offered or it is selected.
 */
export function environmentFilterItems(input: {
  environments: readonly EnvironmentRecord[];
  labels?: readonly (string | null | undefined)[];
  selected?: readonly string[];
}): EnvironmentFilterItem[] {
  const ordered = [...input.environments].sort(byPosition);
  const items: EnvironmentFilterItem[] = ordered
    .filter((environment) => !environment.archived)
    .map((environment) => ({ label: environment.name, value: environment.key }));
  const has = (value: string) => items.some((item) => sameKey(item.value, value));

  const loose = new Set<string>();
  for (const raw of input.labels ?? []) {
    const label = raw?.trim();
    if (!label || resolveEnvironment(label, ordered) !== null) continue;
    if (![...loose].some((kept) => sameKey(kept, label))) loose.add(label);
  }
  for (const label of [...loose].sort((a, b) => a.localeCompare(b))) {
    if (!has(label)) items.push({ label, value: label });
  }

  const selected = input.selected ?? [];
  for (const value of selected) {
    if (value === NO_ENVIRONMENT_FILTER || has(value)) continue;
    const own = ordered.find((environment) => sameKey(environment.key, value));
    items.push({ label: own ? own.name : value, value });
  }

  if (items.length > 0 || selected.includes(NO_ENVIRONMENT_FILTER)) {
    items.push({ label: NO_ENVIRONMENT_LABEL, value: NO_ENVIRONMENT_FILTER });
  }
  return items;
}

/** The words a filter shows for one of its values: the name of the environment it is the key of, else the value. */
export function environmentFilterLabel(value: string, environments: readonly EnvironmentRecord[]): string {
  if (value === NO_ENVIRONMENT_FILTER) return NO_ENVIRONMENT_LABEL;
  return environments.find((environment) => sameKey(environment.key, value))?.name ?? value;
}

/**
 * The environment a page's copied commands and run requests start on, given the environment of the run it shows: that
 * one, unless it is archived or protected (a protected environment is never a default), else none.
 */
export function commandEnvironmentDefault(
  shown: Pick<EnvironmentRecord, 'id' | 'archived' | 'protected'> | null | undefined,
): number | null {
  return shown && !shown.archived && !shown.protected ? shown.id : null;
}

/**
 * The environment a page's commands are for: the pick (`undefined` when nothing was picked, `null` for **None**) while
 * it is among `active`, the project's environments that are not archived, else the start
 * (`commandEnvironmentDefault` of `shown`). With `protectedAllowed` false, a protected pick reads as none.
 */
export function commandEnvironmentOf(input: {
  picked: number | null | undefined;
  active: readonly EnvironmentRecord[];
  shown: Pick<EnvironmentRecord, 'id' | 'archived' | 'protected'> | null | undefined;
  protectedAllowed?: boolean;
}): number | null {
  if (input.picked === null) return null;
  const environment =
    input.picked === undefined ? null : input.active.find((candidate) => candidate.id === input.picked);
  if (environment) return input.protectedAllowed === false && environment.protected ? null : environment.id;
  return commandEnvironmentDefault(input.shown);
}
