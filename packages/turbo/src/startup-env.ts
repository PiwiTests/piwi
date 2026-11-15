// What `piwi-turbo` shares with the code-cache hook and the spare worker: the environment variables it passes them, the
// messages the spare exchanges with the runner, and where the caches go.
import { dirname, join } from 'node:path';

/** The code-cache folder; the hook does nothing without it. */
export const CODE_CACHE_DIR = 'PIWI_TURBO_CODE_CACHE_DIR';
/** The runner's process id, which tells the runner from the Node processes it starts. */
export const RUNNER_PID = 'PIWI_TURBO_RUNNER_PID';
/** Playwright's worker entry, which the spare worker runs once handed off. */
export const SPARE_ENTRY = 'PIWI_TURBO_SPARE_ENTRY';
/** The modules the spare worker loads while it waits, as a JSON array of paths. */
export const SPARE_PRELOAD = 'PIWI_TURBO_SPARE_PRELOAD';

/** The message the spare worker sends once it has loaded, with the environment variables its modules read. */
export interface SpareLoaded {
  method: '__piwi_turbo_spare_loaded__';
  envRead: string[];
}

/** The message that hands the spare worker over, with the environment Playwright gave the worker it meant to fork. */
export interface SpareHandoff {
  method: '__piwi_turbo_spare_handoff__';
  env: NodeJS.ProcessEnv;
}

/** The cache folder of a run from `cwd`: `.cache/piwi-turbo` in the nearest `node_modules`, else the temporary folder. */
export function cacheRoot(cwd: string, exists: (path: string) => boolean, temporary: string): string {
  for (let folder = cwd; ; folder = dirname(folder)) {
    if (exists(join(folder, 'node_modules'))) return join(folder, 'node_modules', '.cache', 'piwi-turbo');
    if (dirname(folder) === folder) return join(temporary, 'piwi-turbo');
  }
}

/** Whether a `playwright` command line runs tests in workers this process forks: `test`, without UI mode or `--list`. */
export function runsWorkers(args: readonly string[]): boolean {
  if (args[0] !== 'test') return false;
  return !args.some((arg) => /^(--ui|--list$|--help$|-h$|--debug$)/.test(arg));
}
