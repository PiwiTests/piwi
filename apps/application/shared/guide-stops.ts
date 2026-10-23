/**
 * Where a guide stop goes, shared by the guide engine in the browser and the
 * server's check of a composed guide: the query an anchor's reveal selects,
 * the route a stop opens, and whether a route opens a page of `app/pages`.
 */
import { BUILTIN_DASHBOARDS } from '#shared/analytics/dashboards';
import type { GuideAnchor } from '#shared/guide-anchors/index.mjs';

/** The query values an anchor's reveal selects through the URL (`{ tab: 'flaky-tests' }`), merged. */
export function revealQuery(anchor: GuideAnchor | undefined): Record<string, string> {
  const query: Record<string, string> = {};
  for (const step of anchor?.reveal ?? []) {
    if ('query' in step) Object.assign(query, step.query);
  }
  return query;
}

/** `route` with each value of `query` it does not name already added to its query string. */
function withQuery(route: string, query: Record<string, string>): string {
  const hashAt = route.indexOf('#');
  const base = hashAt < 0 ? route : route.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : route.slice(hashAt);
  const queryAt = base.indexOf('?');
  const named = new URLSearchParams(queryAt < 0 ? '' : base.slice(queryAt + 1));
  const missing = new URLSearchParams(Object.entries(query).filter(([key]) => !named.has(key))).toString();
  if (!missing) return route;
  return `${base}${queryAt < 0 ? '?' : '&'}${missing}${hash}`;
}

/** Whether a page pattern of `app/pages` names one route: not `*`, with no `[param]`. */
export function isFixedPage(page: string): boolean {
  return page !== '*' && !page.includes('[');
}

/**
 * The route a guide stop opens: its own `route`, else its anchor's main page
 * when that is a fixed path, each with the values of the anchor's `query`
 * reveal it leaves out added; `undefined` when the stop stays on the current
 * page.
 */
export function stopRoute(route: string | undefined, anchor: GuideAnchor | undefined): string | undefined {
  const main = anchor?.pages[0];
  const opens = route ?? (main !== undefined && isFixedPage(main) ? main : undefined);
  return opens === undefined ? undefined : withQuery(opens, revealQuery(anchor));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The keys a page's `[param]` takes besides an id: `/analytics/d/engineering` opens a built-in dashboard. */
const PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  '/analytics/d/[id]': BUILTIN_DASHBOARDS.map((dashboard) => dashboard.key),
};

/**
 * Whether `route` (a path from the app's root, with or without a query) opens
 * the page `page`, a pattern of `app/pages` whose `[param]` segments each stand
 * for a seeded id, or for one of the keys `PARAM_KEYS` lists for the page; `*`
 * matches every route.
 */
export function routeOnPage(route: string, page: string): boolean {
  if (page === '*') return true;
  const path = route.split(/[?#]/)[0]!.replace(/(.)\/$/, '$1');
  const param = ['\\d+', ...(PARAM_KEYS[page] ?? []).map(escapeRegExp)].join('|');
  const pattern = page
    .split('/')
    .map((segment) => (/^\[\w+\]$/.test(segment) ? `(?:${param})` : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${pattern}$`).test(path);
}
