/**
 * The Nitro module that gives the route manifest Nitro's whole route table:
 *
 * ```ts
 * export default defineNitroConfig({ modules: ['@piwitests/instrumentation-nitro/module'] });
 * ```
 *
 * In Nuxt, the same entry goes under `nitro.modules`. Without it, `/__piwi/manifest`
 * lists only the routes the server has answered. With `PIWI_COVERAGE_BUILD=true`
 * set when the server is built, it also makes a coverage build. Modules run before Nitro scans its
 * route files, so the table is read when the server is bundled, again on each
 * rebuild in development.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Nitro, NitroModule } from 'nitropack';
import { COVERAGE_PLUGIN_ID, coveragePluginSource, coverageRollupPlugin } from './coverage-transform.js';
import { ROUTE_TABLE_ID, declaredRoutesOf, routeTablePlugin } from './route-table.js';

/** This package's own directory: its files are never instrumented. */
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** The coverage runtime beside this file: the built one, or the source when the module runs from source. */
function coverageRuntimePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, 'coverage-runtime.js');
  return existsSync(built) ? built : join(here, 'coverage-runtime.ts');
}

/**
 * A coverage build (`PIWI_COVERAGE_BUILD=true` when the server is built): the
 * coverage transform instruments the application's modules, Nitro writes the
 * source maps it reads, and a generated plugin hands the span table to the
 * coverage runtime at startup. `PIWI_COVERAGE_FORBIDDEN=true` makes such a
 * build fail, for a pipeline whose output must never carry it.
 */
function setUpCoverage(nitro: Nitro, root: string): void {
  if (process.env.PIWI_COVERAGE_BUILD !== 'true') return;
  if (process.env.PIWI_COVERAGE_FORBIDDEN === 'true') {
    throw new Error('[piwi] PIWI_COVERAGE_BUILD=true in a build where PIWI_COVERAGE_FORBIDDEN=true: a coverage build must not reach this output.');
  }
  const runtime = coverageRuntimePath();
  nitro.options.sourceMap = true;
  nitro.options.virtual[COVERAGE_PLUGIN_ID] = () => coveragePluginSource(runtime);
  nitro.options.plugins.unshift(COVERAGE_PLUGIN_ID);
  // Last, so it reads what Nitro's own transforms (esbuild) produce. Each build makes its config anew (a development
  // server's full reload too), so each gets its own plugin.
  nitro.hooks.hook('rollup:before', (_nitro, config) => {
    const plugins = (config.plugins ??= []) as Array<{ name?: string }>;
    if (!plugins.some((plugin) => plugin?.name === 'piwi-coverage')) {
      plugins.push(coverageRollupPlugin({ root, runtime, exclude: [packageDir] }));
    }
  });
}

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
    setUpCoverage(nitro, root);
  },
};

export default piwiRouteTable;
