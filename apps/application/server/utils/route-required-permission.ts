import type { H3Event } from 'h3';
import type { RouterContext } from 'rou3';
import type { RoutePermission } from '#shared/permissions';
import { buildPermissionRouter, matchRequiredPermissions } from './route-permission-match';
// Nitro compiles each route's extracted meta into this internal virtual module;
// its types are declared ambiently in shared/nitro-virtual.d.ts.
import { handlersMeta } from '#nitro-internal-virtual/server-handlers-meta';

// Built once from the compiled route metas; the set of routes is fixed per build.
let router: RouterContext<RoutePermission[]> | undefined;

/**
 * The permissions the current route requires, from its `x-required-permission`
 * OpenAPI meta — the single source of truth, also surfaced in the `/docs`
 * reference. Empty when the route declares none (public or token-authenticated),
 * leaving `requireAuth` to enforce sign-in only.
 */
export function getRouteRequiredPermissions(event: H3Event): RoutePermission[] {
  router ??= buildPermissionRouter(handlersMeta);
  // The path Nitro's router dispatched the request on: the raw path, its query left out. A normalized URL would read
  // `\`, `..` and `#` differently, and send the lookup to another route than the one that runs.
  const path = event.path.split('?', 1)[0] || '/';
  return matchRequiredPermissions(router, event.method, path);
}
