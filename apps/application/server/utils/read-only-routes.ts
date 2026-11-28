/**
 * Which requests read-only mode refuses: every one under `/api/` or `/oauth/` whose method is not GET, HEAD or OPTIONS,
 * a reporter's and an MCP client's sign-in included, so a run in progress stops being taken too. These pass, each by
 * its method and path:
 *
 * - signing in and out (`/api/auth/login`, `/api/auth/logout`); a sign-in through an OAuth provider is a GET;
 * - the operator's routes (`/api/operator/`), the one way to make the instance writable again;
 * - the reads sent as POST because their question does not fit a URL: a widget's preview, a selection's preview and
 *   impact, a report schedule's preview, a pass reuse plan's source commits, an issue automation's preview, a
 *   connection's check before it is saved, the trace blobs a project holds and an AI step's next action. Each of them
 *   writes nothing but the log of a saved credential's use, which every read through a credential keeps;
 * - a shard split, which answers the split stored for the run and refuses itself while it would store one;
 * - a run's live view: a worker's frames and a watch's change, which the server relays in memory alone.
 *
 * The path is matched as Nitro's router dispatches it, its query left out and one trailing `/` with it, lowered and
 * with its repeated `/` folded, so that no spelling of a write's path reaches the route unrefused.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The paths under which every write is refused. */
const WRITE_PREFIXES = ['/api/', '/oauth/'];

const OPEN_WHILE_READ_ONLY: { method: string | null; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/auth\/(?:login|logout)$/ },
  { method: null, path: /^\/api\/operator\// },
  { method: 'POST', path: /^\/api\/widgets\/preview$/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/selections\/(?:preview|impact)$/ },
  { method: 'POST', path: /^\/api\/reports\/schedules\/preview$/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/run-plans\/sources$/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/integrations\/auto-create-preview$/ },
  { method: 'POST', path: /^\/api\/integrations\/connections\/check$/ },
  { method: 'POST', path: /^\/api\/traces\/check$/ },
  { method: 'POST', path: /^\/api\/ai\/step-resolution$/ },
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/shard-split$/ },
  { method: 'POST', path: /^\/api\/test-runs\/[^/]+\/live-view(?:\/watch)?$/ },
];

/** A request path as the read-only check reads it: no query, lowered, its repeated `/` folded and no trailing `/`. */
function checkedPath(path: string): string {
  const bare = (path.split('?', 1)[0] ?? '').toLowerCase().replace(/\/{2,}/g, '/');
  return bare.length > 1 ? bare.replace(/\/$/, '') : bare;
}

/**
 * Whether read-only mode refuses a request: a write under `/api/` or `/oauth/` that is not one of the requests listed
 * above.
 */
export function readOnlyRefuses(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (SAFE_METHODS.has(verb)) return false;
  const route = checkedPath(path);
  if (!WRITE_PREFIXES.some((prefix) => route.startsWith(prefix))) return false;
  return !OPEN_WHILE_READ_ONLY.some((open) => (open.method === null || open.method === verb) && open.path.test(route));
}
