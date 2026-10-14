/**
 * The Nitro module that gives the route manifest Nitro's whole route table:
 *
 * ```ts
 * export default defineNitroConfig({ modules: ['@piwitests/instrumentation-nitro/module'] });
 * ```
 *
 * In Nuxt, the same entry goes under `nitro.modules`. Without it, `/__piwi/manifest`
 * lists only the routes the server has answered. Modules run before Nitro scans its
 * route files, so the table is read when the server is bundled, again on each
 * rebuild in development.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Nitro, NitroModule } from 'nitropack';
import { ROUTE_TABLE_ID, declaredRoutesOf, routeTablePlugin } from './route-table.js';

/** The repository root above `dir` (the closest folder holding `.git`), else `dir` itself. */
function repositoryRoot(dir: string): string {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return dir;
  }
}

const piwiRouteTable: NitroModule = {
  name: 'piwi-route-table',
  setup(nitro: Nitro) {
    const root = repositoryRoot(nitro.options.rootDir);
    nitro.options.virtual[ROUTE_TABLE_ID] = () =>
      routeTablePlugin(declaredRoutesOf([...nitro.scannedHandlers, ...nitro.options.handlers], root));
    nitro.options.plugins.push(ROUTE_TABLE_ID);
  },
};

export default piwiRouteTable;
