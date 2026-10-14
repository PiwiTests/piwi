/**
 * The declared-surface route manifest the plugin serves at `/__piwi/manifest`
 * outside production. Nitro has no stable public API to enumerate its route table
 * at runtime: the module (`./module`) reads it at build time (`route-table.ts`),
 * and the routes the server matches are added as they come, each request with its
 * method, matched pattern and handler file. The Piwi reporter fetches it once at
 * run start and uploads it, and a declared route no test reaches becomes a
 * "declared, never hit" gap, which only the module's routes can give.
 */

/** One declared route: method, path pattern and the handler's source file. */
export interface ManifestRouteEntry {
  method: string;
  pattern: string;
  handler?: string;
}

/** The manifest body served at `/__piwi/manifest`. */
export interface RouteManifest {
  routes: ManifestRouteEntry[];
}

/**
 * Collapse a concrete request path to a pattern: numeric and uuid segments become
 * `:id` / `:uuid`, so `/api/orders/42` and `/api/orders/43` fold to one route.
 * Used only when the matched route carries no pattern of its own.
 */
export function collapsePathPattern(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return (
    '/' +
    clean
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
        if (/^\d+$/.test(seg)) return ':id';
        return seg;
      })
      .join('/')
  );
}

/** The unique key for a route in the accumulator: method plus pattern. */
function routeKey(method: string, pattern: string): string {
  return `${method.toUpperCase()} ${pattern}`;
}

/**
 * Record an observed route in the accumulator, keeping the first handler file
 * seen for it. Bounded so a pathological app (or an unbounded set of patterns
 * slipping through) cannot grow the map without limit.
 */
export function recordObservedRoute(
  map: Map<string, ManifestRouteEntry>,
  entry: ManifestRouteEntry,
  max = 2000,
): void {
  if (!entry.method || !entry.pattern) return;
  const key = routeKey(entry.method, entry.pattern);
  const existing = map.get(key);
  if (existing) {
    if (!existing.handler && entry.handler) existing.handler = entry.handler;
    return;
  }
  if (map.size >= max) return;
  map.set(key, { method: entry.method.toUpperCase(), pattern: entry.pattern, handler: entry.handler });
}

/** Build the manifest body from the accumulator, routes sorted for stable output. */
export function buildRouteManifest(map: Map<string, ManifestRouteEntry>): RouteManifest {
  const routes = [...map.values()].sort((a, b) => routeKey(a.method, a.pattern).localeCompare(routeKey(b.method, b.pattern)));
  return { routes };
}
