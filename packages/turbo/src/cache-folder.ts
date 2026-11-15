// Where @piwitests/turbo keeps what it caches between runs, and the check that no other user can write there: V8 runs
// what a code cache holds, and a screenshot assertion passes on what the match store holds.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * The cache folder of a run from `cwd`: `.cache/piwi-turbo` in the nearest `node_modules`, else a folder of this user's
 * own in the temporary folder.
 */
export function cacheRoot(cwd: string, exists: (path: string) => boolean, temporary: string, user: string): string {
  for (let folder = cwd; ; folder = dirname(folder)) {
    if (exists(join(folder, 'node_modules'))) return join(folder, 'node_modules', '.cache', 'piwi-turbo');
    if (dirname(folder) === folder) return join(temporary, `piwi-turbo-${user}`);
  }
}

/** This run's cache folder: `PIWI_TURBO_CACHE_DIR`, else the one `cacheRoot` finds from the working folder. */
export function defaultCacheRoot(): string {
  const user = String(process.getuid?.() ?? userInfo().username);
  return resolve(process.env.PIWI_TURBO_CACHE_DIR ?? cacheRoot(process.cwd(), existsSync, tmpdir(), user));
}

/** Creates `folder` for this user alone if needed; whether only this user can write to it (always, on Windows). */
export function privateFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!process.getuid) return true;
    const { uid, mode } = statSync(folder);
    return uid === process.getuid() && (mode & 0o022) === 0;
  } catch {
    return false;
  }
}
