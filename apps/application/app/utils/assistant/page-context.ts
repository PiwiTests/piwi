/**
 * The page a question is asked on, as the browser sends it with the question:
 * the route, the `app/pages` pattern it matched, its parameters and query, and
 * the project the page shows.
 */
import type { AssistantPageContext } from '#shared/assistant';

/** The parts of the current route the context is built from (vue-router's route, reduced to plain values). */
export interface AssistantRouteSnapshot {
  path: string;
  fullPath: string;
  /** The path of the matched route record (`/projects/:id()`); undefined when no page matched. */
  recordPath: string | undefined;
  params: Readonly<Record<string, string | readonly string[] | undefined>>;
  query: Readonly<Record<string, string | null | readonly (string | null)[] | undefined>>;
}

/** The schema's bounds on the context's fields (`assistantPageContextSchema`). */
const MAX_ROUTE = 500;
const MAX_PAGE = 200;
const MAX_KEY = 60;
const MAX_VALUE = 200;
const MAX_ENTRIES = 20;

/**
 * The `app/pages` pattern of a route record's path: `/projects/:id()` is
 * `/projects/[id]`, an optional `:id?` is `[[id]]` and a catch-all
 * `:slug(.*)*` is `[...slug]`.
 */
export function assistantPagePattern(recordPath: string): string {
  const pattern = recordPath
    .replace(/:(\w+)\(\.\*\)\*/g, '[...$1]')
    .replace(/:(\w+)(?:\(\))?\?/g, '[[$1]]')
    .replace(/:(\w+)(?:\(\))?/g, '[$1]')
    .replace(/(.)\/+$/, '$1');
  return pattern || '/';
}

/** At most `MAX_ENTRIES` entries, each key and value within the schema's lengths; empty values left out. */
function boundedRecord(entries: [string, string | undefined][]): Record<string, string> | undefined {
  const record: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (Object.keys(record).length === MAX_ENTRIES) break;
    if (key.length > MAX_KEY || value === undefined || value === '') continue;
    record[key] = value.slice(0, MAX_VALUE);
  }
  return Object.keys(record).length ? record : undefined;
}

function firstValue(value: string | null | readonly (string | null)[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return value?.find((v): v is string => typeof v === 'string');
}

/** The project a page of `pattern` shows: the `id` of a `/projects/[id]` page and its sub-pages. */
function projectIdOf(pattern: string, params: Record<string, string> | undefined): number | null {
  if (pattern !== '/projects/[id]' && !pattern.startsWith('/projects/[id]/')) return null;
  const id = Number(params?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The context sent with a question asked on `route`. */
export function assistantPageContext(route: AssistantRouteSnapshot): AssistantPageContext {
  const page = route.recordPath === undefined ? null : assistantPagePattern(route.recordPath).slice(0, MAX_PAGE);
  const params = boundedRecord(
    Object.entries(route.params).map(([key, value]): [string, string | undefined] => [
      key,
      typeof value === 'string' ? value : value?.join('/'),
    ]),
  );
  const query = boundedRecord(
    Object.entries(route.query).map(([key, value]): [string, string | undefined] => [key, firstValue(value)]),
  );
  return {
    route: route.fullPath.length <= MAX_ROUTE ? route.fullPath : route.path.slice(0, MAX_ROUTE),
    page,
    ...(params ? { params } : {}),
    ...(query ? { query } : {}),
    projectId: page ? projectIdOf(page, params) : null,
  };
}
