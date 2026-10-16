import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitHashObjects } from '../collect/blob-ids.js';

/**
 * What `piwi coverage upload` reads from the checkout: the repository root,
 * the commit, and the file inventory, every tracked file with the blob id of
 * its content in the checkout: from `git ls-tree -r HEAD` for a file the
 * checkout leaves unchanged, from `git hash-object` for a changed one, as the
 * reporter names a file version everywhere.
 */

/** Largest output read from one git command. */
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT, timeout: 120_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** The checkout the upload reads: its root, the commit checked out, and the branch git names, if any. */
export interface Checkout {
  root: string;
  commit: string;
  /** The branch checked out; undefined on a detached head. */
  gitBranch?: string;
}

/** The checkout around `cwd`; throws when it is no git checkout. */
export async function readCheckout(cwd: string): Promise<Checkout> {
  let root: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git checkout: coverage is uploaded from the checkout the tests ran in`);
  }
  const commit = (await git(root, ['rev-parse', 'HEAD'])).trim().toLowerCase();
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  return { root, commit, ...(branch && branch !== 'HEAD' ? { gitBranch: branch } : {}) };
}

/**
 * The tracked files of the checkout and their blob ids, by repository-relative
 * path: the committed blob, or, for a file the checkout changed, the blob of
 * its content now. A tracked file deleted from the checkout is left out.
 */
export async function readInventory(root: string): Promise<Map<string, string>> {
  const inventory = new Map<string, string>();
  // `-z`: paths as they are, NUL-separated, never quoted.
  for (const entry of (await git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).split('\0')) {
    // `<mode> blob <id>\t<path>`; submodules are commits, not blobs.
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && id) inventory.set(entry.slice(tab + 1), id);
  }
  const changed: string[] = [];
  for (const file of (await git(root, ['diff', '--name-only', '-z', 'HEAD']).catch(() => '')).split('\0')) {
    if (!file || !inventory.has(file)) continue;
    if (fs.existsSync(path.join(root, file))) changed.push(file);
    else inventory.delete(file);
  }
  if (changed.length > 0) {
    const ids = await gitHashObjects(root, changed);
    changed.forEach((file, i) => {
      const id = ids?.[i];
      if (id) inventory.set(file, id);
      else inventory.delete(file);
    });
  }
  return inventory;
}
