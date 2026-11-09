import type { ProjectTendency } from '#shared/project-health';

/** The page state holding a signed-in user's stars, cleared at sign-out. */
export const STARRED_PROJECTS_STATE = 'starred-projects';

/** The most stars the browser keeps when sign-in is off, so the cookie stays small. */
export const MAX_BROWSER_STARS = 200;

/** The project ids of a stored star list: whole positive ids, each once, at most `MAX_BROWSER_STARS`. */
export function parseStarredIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const id of value) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_BROWSER_STARS) break;
  }
  return ids;
}

/** The items whose project is starred, then the rest, each part in the order it came. */
export function starredFirst<T>(items: readonly T[], starred: ReadonlySet<number>, idOf: (item: T) => number): T[] {
  const first: T[] = [];
  const rest: T[] = [];
  for (const item of items) (starred.has(idOf(item)) ? first : rest).push(item);
  return [...first, ...rest];
}

const TENDENCY_ORDER: Record<ProjectTendency, number> = { failing: 0, flaky: 1, passing: 2, unknown: 3 };

/** What Home's Project health orders a project by. */
export interface HealthOrderProject {
  id: number;
  tendency: ProjectTendency;
  latestFullRun: { startTime: Date | string } | null;
}

/**
 * Home's Project health order: starred projects first, then the rest. Each
 * part puts failing projects first, then flaky, passing and unknown ones, and
 * within a tendency the newest full run first. `starredCount` is how many
 * lead the list, where the Starred divider ends.
 */
export function orderProjectHealth<T extends HealthOrderProject>(
  projects: readonly T[],
  starred: ReadonlySet<number>,
): { projects: T[]; starredCount: number } {
  const byHealth = [...projects].sort((a, b) => {
    const tendency = TENDENCY_ORDER[a.tendency] - TENDENCY_ORDER[b.tendency];
    if (tendency !== 0) return tendency;
    const at = a.latestFullRun ? new Date(a.latestFullRun.startTime).getTime() : 0;
    const bt = b.latestFullRun ? new Date(b.latestFullRun.startTime).getTime() : 0;
    return bt - at;
  });
  const ordered = starredFirst(byHealth, starred, (p) => p.id);
  return { projects: ordered, starredCount: ordered.filter((p) => starred.has(p.id)).length };
}
