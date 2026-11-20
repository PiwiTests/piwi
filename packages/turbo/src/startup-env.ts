// What `piwi-turbo` shares with the code-cache hook and the spare worker: the environment variables it passes them, the
// messages the spare exchanges with the runner, and the code cache's folders.

/** The code-cache folder; the hook does nothing without it. */
export const CODE_CACHE_DIR = 'PIWI_TURBO_CODE_CACHE_DIR';
/** The runner's process id, which tells the runner from the Node processes it starts. */
export const RUNNER_PID = 'PIWI_TURBO_RUNNER_PID';
/** Set on `globalThis` by a process whose code caches are not worth keeping, such as a spare worker never used. */
export const DISCARD_CODE_CACHE = Symbol.for('piwi-turbo.discard-code-cache');
/** Playwright's worker entry, which the spare worker runs once handed off. */
export const SPARE_ENTRY = 'PIWI_TURBO_SPARE_ENTRY';
/** The modules the spare worker loads while it waits, as a JSON array of paths. */
export const SPARE_PRELOAD = 'PIWI_TURBO_SPARE_PRELOAD';
/** The `playwright-core` package the spare worker launches its early browser with. */
export const SPARE_CORE = 'PIWI_TURBO_SPARE_CORE';

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

/** Whether a folder in the code cache holds the caches of one Playwright, Node and architecture (`codeCacheFolder`). */
export function isCodeCacheFolder(name: string): boolean {
  return /^\d+\.\d+\.\d+\S*-v\d+\.\d+\.\d+-[a-z0-9]+$/.test(name);
}

/** The folder of the code caches of one Playwright version, for this Node and architecture. */
export function codeCacheFolder(playwrightVersion: string): string {
  return `${playwrightVersion}-${process.version}-${process.arch}`;
}

/** Whether a `playwright` command line runs tests in workers this process forks: `test`, without UI mode or `--list`. */
export function runsWorkers(args: readonly string[]): boolean {
  if (args[0] !== 'test') return false;
  return !args.some((arg) => /^(--ui|--list$|--help$|-h$|--debug$)/.test(arg));
}
