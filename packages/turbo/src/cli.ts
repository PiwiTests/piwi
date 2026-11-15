#!/usr/bin/env node
// `piwi-turbo`: Playwright's CLI, run in this process with its start-up costs cut before Playwright loads: Node's
// compile cache, a code cache of Playwright's modules for this process and the Node processes it starts, and for
// `test`, a spare worker that loads Playwright while the runner does.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { enableCompileCache } from './compile-cache';
import { startSpareWorker } from './spare';
import { cacheRoot, CODE_CACHE_DIR, RUNNER_PID, runsWorkers } from './startup-env';

const log = process.env.PIWI_TURBO_DEBUG ? (message: string) => console.error(`[piwi-turbo] ${message}`) : undefined;

function resolveFrom(request: string, folder: string): string | undefined {
  try {
    return require.resolve(request, { paths: [folder] });
  } catch {
    return undefined;
  }
}

/** Points the code-cache hook at this Node and Playwright's folder, removes the others, and loads the hook. */
function enableCodeCache(root: string, version: string): void {
  if (process.env.NODE_V8_COVERAGE) return;
  const current = `${version}-${process.version}-${process.arch}`;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== current)
        rmSync(join(root, entry.name), { recursive: true, force: true });
  } catch {}
  process.env[CODE_CACHE_DIR] = join(root, current);
  process.env[RUNNER_PID] = String(process.pid);
  const hook = join(__dirname, 'code-cache.js');
  require(hook);
  process.execArgv.push('--require', hook);
}

const cli = resolveFrom('@playwright/test/cli', process.cwd());
const playwright = cli && resolveFrom('playwright/package.json', dirname(cli));
const core = playwright && resolveFrom('playwright-core/package.json', dirname(playwright));
if (!cli || !playwright || !core) {
  console.error('piwi-turbo runs the Playwright of the project in the current folder: install @playwright/test there.');
  process.exit(1);
}

if (process.env.PIWI_TURBO_CACHE !== '0') {
  const root = process.env.PIWI_TURBO_CACHE_DIR ?? cacheRoot(process.cwd(), existsSync, tmpdir());
  enableCompileCache(join(root, 'compile'));
  enableCodeCache(join(root, 'code'), JSON.parse(readFileSync(core, 'utf8')).version);
}
if (process.env.PIWI_TURBO_SPARE_WORKER !== '0' && runsWorkers(process.argv.slice(2)))
  startSpareWorker(dirname(playwright), dirname(core), log);
require(cli);
