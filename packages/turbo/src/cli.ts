#!/usr/bin/env node
// `piwi-turbo`: Playwright's CLI, run in this process with its start-up costs cut before Playwright loads: Node's
// compile cache, a code cache of Playwright's modules for this process and the Node processes it starts, and for
// `test`, a spare worker that loads Playwright while the runner does.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { enableCompileCache } from './compile-cache';
import { startSpareWorker } from './spare';
import { cacheRoot, CODE_CACHE_DIR, codeCacheFolder, isCodeCacheFolder, RUNNER_PID, runsWorkers } from './startup-env';

const log = process.env.PIWI_TURBO_DEBUG ? (message: string) => console.error(`[piwi-turbo] ${message}`) : undefined;

function resolveFrom(request: string, folder: string): string | undefined {
  try {
    return require.resolve(request, { paths: [folder] });
  } catch {
    return undefined;
  }
}

/** Creates `folder` for this user alone if needed; whether only this user can write to it (always, on Windows). */
function privateFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!process.getuid) return true;
    const { uid, mode } = statSync(folder);
    return uid === process.getuid() && (mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * Points the code-cache hook at the folder of this Node and Playwright, removes the folders of other versions, and
 * loads the hook.
 */
function enableCodeCache(root: string, version: string): void {
  if (process.env.NODE_V8_COVERAGE) return;
  const current = codeCacheFolder(version);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== current && isCodeCacheFolder(entry.name))
        rmSync(join(root, entry.name), { recursive: true, force: true });
  } catch {}
  process.env[CODE_CACHE_DIR] = join(root, current);
  process.env[RUNNER_PID] = String(process.pid);
  const hook = join(__dirname, 'code-cache.js');
  require(hook);
  process.execArgv.push('--require', hook);
}

const cli = resolveFrom('@playwright/test/cli', process.cwd()) ?? resolveFrom('playwright/cli', process.cwd());
const playwright = cli && resolveFrom('playwright/package.json', dirname(cli));
const core = playwright && resolveFrom('playwright-core/package.json', dirname(playwright));
if (!cli || !playwright || !core) {
  console.error('piwi-turbo runs the Playwright of the project in the current folder: install @playwright/test there.');
  process.exit(1);
}

if (process.env.PIWI_TURBO_CACHE !== '0') {
  const user = String(process.getuid?.() ?? userInfo().username);
  const root = resolve(process.env.PIWI_TURBO_CACHE_DIR ?? cacheRoot(process.cwd(), existsSync, tmpdir(), user));
  if (privateFolder(root)) {
    enableCompileCache(join(root, 'compile'));
    enableCodeCache(join(root, 'code'), JSON.parse(readFileSync(core, 'utf8')).version);
  } else log?.(`no caches: other users can write to ${root}`);
}
if (process.env.PIWI_TURBO_SPARE_WORKER !== '0' && runsWorkers(process.argv.slice(2)))
  startSpareWorker(dirname(playwright), dirname(core), log);
require(cli);
