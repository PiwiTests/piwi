/**
 * The route table the Nitro module (`@piwitests/instrumentation-nitro/module`)
 * reads at build time, from the routes Nitro scanned (`routes/`, `api/`) and the
 * handlers its config declares. The module writes it into a small generated
 * plugin, which hands it to the runtime plugin through a global, so
 * `/__piwi/manifest` lists every declared route from the server's first request,
 * reached or not.
 */
import type { ManifestRouteEntry } from './manifest.js';

/** The id of the generated plugin that carries the route table. */
export const ROUTE_TABLE_ID = '#piwi/route-table';

/** The global the generated plugin sets the route table on. */
const DECLARED_ROUTES_KEY = '__piwiDeclaredRoutes';

/** A Nitro handler, as `nitro.scannedHandlers` and `nitro.options.handlers` list it. */
export interface NitroHandlerLike {
  route?: string;
  method?: string;
  handler?: string;
  middleware?: boolean;
}

/** A route that is only a catch-all (`/**`, `/**:path`): an app's fallback, such as Nuxt's page renderer. */
const FALLBACK_ROUTE = /^\/\*\*(?::[^/]*)?$/;

/**
 * The declared routes of Nitro's handlers: every handler with a route, middleware
 * and a fallback catch-all left out, one entry per method and pattern. A handler
 * without a method answers every method and is declared as `GET`. Its file is
 * named relative to `root` (the repository root, else the app's root) with `/`
 * separators.
 */
export function declaredRoutesOf(handlers: NitroHandlerLike[], root: string): ManifestRouteEntry[] {
  const routes = new Map<string, ManifestRouteEntry>();
  for (const handler of handlers) {
    if (handler.middleware || !handler.route || FALLBACK_ROUTE.test(handler.route)) continue;
    const method = (handler.method || 'get').toUpperCase();
    const key = `${method} ${handler.route}`;
    if (routes.has(key)) continue;
    const file = handler.handler ? relativeFile(root, handler.handler) : undefined;
    routes.set(key, { method, pattern: handler.route, ...(file ? { handler: file } : {}) });
  }
  return [...routes.values()];
}

/** `file` relative to `root`, with `/` separators; undefined when it is not under `root`. */
function relativeFile(root: string, file: string): string | undefined {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedFile = file.replace(/\\/g, '/');
  return normalizedFile.startsWith(`${normalizedRoot}/`) ? normalizedFile.slice(normalizedRoot.length + 1) : undefined;
}

/** The source of the generated plugin: it sets the route table on the global the runtime plugin reads. */
export function routeTablePlugin(routes: ManifestRouteEntry[]): string {
  return `export default function piwiRouteTable() {\n  globalThis.${DECLARED_ROUTES_KEY} = ${JSON.stringify(routes)};\n}\n`;
}

/** The routes the generated plugin set; none when the app does not use the module. */
export function declaredRoutes(): ManifestRouteEntry[] {
  const routes = (globalThis as Record<string, unknown>)[DECLARED_ROUTES_KEY];
  return Array.isArray(routes) ? (routes as ManifestRouteEntry[]) : [];
}
