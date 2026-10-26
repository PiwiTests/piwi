import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineNitroConfig } from 'nitropack/config';
import { PROBE_SECRET } from '../../backends';

/** A path relative to this folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Inside the Piwi repository, until an `npm install` in the sample, the packages come from the repository's
// node_modules, where the integration is its workspace, which has no build: the server builds it from its source.
// After an install, and copied anywhere else, it uses the npm package.
const integrationSource = here('../../../../integrations/nitro/src/index.ts');
const fromSource =
  existsSync(integrationSource) && !existsSync(here('../../node_modules/@piwitests/instrumentation-nitro'));

// The environment `nitro dev` gives the server it starts: the sample's probe secret, and server probes on.
process.env.PIWI_PROBE_SECRET ??= PROBE_SECRET;
process.env.PIWI_SERVER_PROBES ??= 'true';
// A coverage build, as the ASP.NET Core backend's `-p:PiwiCoverage=true`: the integration's module instruments the
// server's code, so each test records the backend lines it ran. `PIWI_COVERAGE_BUILD=false` builds without it.
process.env.PIWI_COVERAGE_BUILD ??= 'true';

// The routes are the files under routes/, the Piwi integration is plugins/piwi-test-logs.ts, and its module gives the
// route manifest the route table.
export default defineNitroConfig({
  compatibilityDate: '2026-07-17',
  modules: [fromSource ? here('../../../../integrations/nitro/src/module.ts') : '@piwitests/instrumentation-nitro/module'],
  alias: fromSource ? { '@piwitests/instrumentation-nitro': integrationSource } : {},
  // The server bundles the integration rather than loading it from node_modules: up to 0.52.0 its build imported its
  // own modules without a file extension, which Node does not resolve.
  externals: { inline: ['@piwitests/instrumentation-nitro'] },
  // The frontend every backend serves, examples/sample-app/web: its stylesheet and scripts, and the folder the page
  // routes read their files from.
  publicAssets: [{ baseURL: '/assets', dir: here('../../web/assets') }],
  runtimeConfig: { pages: here('../../web/pages') },
});
