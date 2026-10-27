/**
 * The service's discovery file, `~/.piwi/editors/<pid>.json` (`@piwitests/core/editor-discovery`): written once the
 * service listens, in a folder only this user reads (0700), as a file only this user reads (0600), never into a folder
 * another user owns or a link; removed as the service stops. On Windows the user's profile folder already keeps other
 * users out, as for `~/.piwi/desktop.json`. The editors' clients list the folder with `readLiveHubs` for Piwi Picker:
 * nothing from a folder that is a link, another user's, or one other users can enter (where the platform tells), and
 * only the files this user owns in it.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EDITORS_DIR_ENV,
  EDITORS_DIR_PARTS,
  editorDiscoveryName,
  formatEditorDiscovery,
  readLiveEditors,
  type DiscoveryFolder,
  type EditorDiscovery,
} from '@piwitests/core/editor-discovery';
import { liveHubsOf, type LiveHub } from '@piwitests/core/run-hub';

/** The folder of the discovery files: `PIWI_EDITORS_DIR`, else `~/.piwi/editors`. */
export function editorsDir(env: Record<string, string | undefined> = process.env): string {
  return env[EDITORS_DIR_ENV] || path.join(os.homedir(), ...EDITORS_DIR_PARTS);
}

/** Whether a process with this id runs; one of another user's counts. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether `dir` is a folder this user owns, not a link, that no other user can enter; one only too open is closed to
 * them when `tighten`. Where the platform has no user ids (Windows), a folder that is not a link.
 */
function privateFolder(dir: string, tighten: boolean): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  if (stat.uid !== process.getuid()) return false;
  if ((stat.mode & 0o077) === 0) return true;
  if (!tighten) return false;
  fs.chmodSync(dir, 0o700);
  return true;
}

/** The folder's operations, on the disk: none of its entries when it is not this user's alone. */
function folderOnDisk(dir: string): DiscoveryFolder {
  return {
    host: os.hostname(),
    names: () => {
      try {
        return privateFolder(dir, false) ? fs.readdirSync(dir) : [];
      } catch {
        return [];
      }
    },
    owned: (name) => {
      try {
        const stat = fs.lstatSync(path.join(dir, name));
        return stat.isFile() && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
      } catch {
        return false;
      }
    },
    read: (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    alive: processAlive,
    remove: (name) => {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Another reader removed it, or the folder is not ours to change.
      }
    },
  };
}

/**
 * The services whose discovery files the folder holds and whose process runs; the files this machine's services that
 * are gone left are deleted.
 */
export function readLiveEditorsIn(dir: string): EditorDiscovery[] {
  return readLiveEditors(folderOnDisk(dir));
}

/** The hubs of the live services, as `GET /piwi/live` lists them. */
export function readLiveHubs(dir: string = editorsDir()): LiveHub[] {
  return liveHubsOf(readLiveEditorsIn(dir));
}

/**
 * Write the service's file in `dir`, readable by this user only, through a temporary file renamed over it, so a reader
 * never reads half of it; the files of services gone are deleted first. Returns its path; null when it could not be
 * written. Never throws.
 */
export function writeDiscovery(dir: string, discovery: EditorDiscovery): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!privateFolder(dir, true)) return null;
    readLiveEditorsIn(dir);
    const file = path.join(dir, editorDiscoveryName(discovery.pid));
    const temporary = path.join(dir, `.${editorDiscoveryName(discovery.pid)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, formatEditorDiscovery(discovery), { mode: 0o600, flag: 'wx' });
      if (typeof process.getuid === 'function') fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    return file;
  } catch {
    return null;
  }
}

/** Remove a file `writeDiscovery` wrote. Synchronous, for the process's last moment. Never throws. */
export function removeDiscovery(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Gone already.
  }
}
