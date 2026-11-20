/**
 * Which runs and environment filters a timeline marker applies to. A marker keeps the environment's label as written
 * and the environment it resolves to (`environmentId`), as a run does; one with neither applies to every environment.
 */
import { NO_ENVIRONMENT_FILTER } from './environments';

/** What a marker names of an environment. */
export interface MarkerEnvironment {
  environment: string | null;
  environmentId: number | null;
}

function appliesEverywhere(marker: MarkerEnvironment): boolean {
  return marker.environment == null && marker.environmentId == null;
}

/**
 * Whether a marker applies to a run: one with no environment to every run, one with an environment to the runs of that
 * environment, else, when either has none, to the runs whose label equals its own, ignoring case.
 */
export function markerAppliesToRun(
  marker: MarkerEnvironment,
  run: { environment?: string | null; environmentId?: number | null },
): boolean {
  if (appliesEverywhere(marker)) return true;
  if (marker.environmentId != null && run.environmentId != null) return marker.environmentId === run.environmentId;
  return (
    !!marker.environment && !!run.environment && marker.environment.toLowerCase() === run.environment.toLowerCase()
  );
}

/**
 * Whether a marker shows under an environment filter (`names`: environment keys, labels and `NO_ENVIRONMENT_FILTER`,
 * as a project's filter holds them): every marker with an empty filter, a marker with no environment always, and one
 * with an environment when the filter names its environment's key (`keyOf` its id) or its label, ignoring case.
 */
export function markerInEnvironmentFilter(
  marker: MarkerEnvironment,
  names: readonly string[],
  keyOf: (environmentId: number) => string | null | undefined,
): boolean {
  if (names.length === 0 || appliesEverywhere(marker)) return true;
  const folds = new Set(names.filter((name) => name !== NO_ENVIRONMENT_FILTER).map((name) => name.toLowerCase()));
  const key = marker.environmentId != null ? keyOf(marker.environmentId) : null;
  return (
    (!!key && folds.has(key.toLowerCase())) || (!!marker.environment && folds.has(marker.environment.toLowerCase()))
  );
}
