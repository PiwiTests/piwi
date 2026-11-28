// What `piwi-turbo` and its warm runner do before Playwright loads: find the project's Playwright, and set up Node's
// compile cache and the code cache of Playwright's modules for this process and the Node processes it starts.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCacheRoot, privateFolder } from './cache-folder';
import { enableCompileCache } from './compile-cache';
import { CODE_CACHE_DIR, codeCacheFolder, isCodeCacheFolder, RUNNER_PID } from './startup-env';

/** The project's Playwright: its CLI, the folders of `playwright` and `playwright-core`, and its version. */
export interface PlaywrightInstall {
  cli: string;
  playwrightDir: string;
  coreDir: string;
  version: string;
}

function resolveFrom(request: string, folder: string): string | undefined {
  try {
    return require.resolve(request, { paths: [folder] });
  } catch {
    return undefined;
  }
}

/** The Playwright that `npx playwright` would run from `cwd`, or `undefined` when none is installed there. */
export function findPlaywright(cwd: string): PlaywrightInstall | undefined {
  const cli = resolveFrom('@playwright/test/cli', cwd) ?? resolveFrom('playwright/cli', cwd);
  const playwright = cli && resolveFrom('playwright/package.json', dirname(cli));
  const core = playwright && resolveFrom('playwright-core/package.json', dirname(playwright));
  if (!cli || !playwright || !core) return undefined;
  const { version } = JSON.parse(readFileSync(core, 'utf8')) as { version: string };
  return { cli, playwrightDir: dirname(playwright), coreDir: dirname(core), version };
}

/**
 * Points the code-cache hook at the folder of this Node and Playwright, removes the folders of other versions, and
 * loads the hook here and in the Node processes this one forks.
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

/** Sets up both caches in the cache folder, unless `PIWI_TURBO_CACHE=0` or other users can write to it. */
export function setUpCaches(install: PlaywrightInstall, log?: (message: string) => void): void {
  if (process.env.PIWI_TURBO_CACHE === '0') return;
  const root = defaultCacheRoot();
  if (!privateFolder(root)) {
    log?.(`no caches: other users can write to ${root}`);
    return;
  }
  enableCompileCache(join(root, 'compile'));
  enableCodeCache(join(root, 'code'), install.version);
}
