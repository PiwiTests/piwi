import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The files the reporter keeps in its temp folder (`privateTempDir`): created readable and writable by their owner
 * alone, never written through a symbolic link, and read back only when they are a regular file this user owns that no
 * one else may write. Each path is checked (`lstat`) before it is opened, and what was opened is checked again; the
 * open neither follows a link (`O_NOFOLLOW`) nor waits for the other end of a named pipe (`O_NONBLOCK`).
 *
 * Windows has neither flag, nor file owners and mode bits: there the `lstat` alone refuses a link, a link made between
 * it and the open is followed, and the owner and mode checks are skipped. The files live there in a folder of this
 * user's profile, which other users of the machine may not enter, whatever account the run uses.
 */

/**
 * The folder the reporter keeps its private files in: `os.tmpdir()` on Linux and macOS; on Windows, `piwi\tmp` in
 * this user's local application data folder (`%LOCALAPPDATA%`, else `AppData\Local` in the home folder), created on
 * first use. Every process of a run (the global setup, the workers, the reporter) runs as one user, so all of them
 * find the same folder.
 */
export function privateTempDir(): string {
  if (process.platform !== 'win32') return os.tmpdir();
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'piwi', 'tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // A file that cannot be written there fails where it is written.
  }
  return dir;
}

/**
 * The folder an older reporter kept its private files in where `privateTempDir` is another one: `os.tmpdir()` on
 * Windows, `null` elsewhere.
 */
export function legacyPrivateTempDir(): string | null {
  return process.platform === 'win32' ? os.tmpdir() : null;
}

/** How long a private file named for one run may go unchanged before a later run removes it as left behind. */
export const STALE_PRIVATE_FILE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove the files of `dir` (the private temp folder by default) whose name starts with `prefix`, that are regular
 * files this user owns, and that have not changed for `STALE_PRIVATE_FILE_MS`: the ones a run killed before its end
 * left. A link is never followed nor removed, and a file that cannot be read or removed is left as it is.
 */
export function sweepStalePrivateFiles(prefix: string, { dir = privateTempDir(), now = Date.now() } = {}): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
      if (now - stat.mtimeMs < STALE_PRIVATE_FILE_MS) continue;
      fs.rmSync(file, { force: true });
    } catch {
      // Another run removed it, or it is not this user's to remove.
    }
  }
}

/**
 * Mark a private file a run still reads as in use, its times set to now, never through a link, so a later run's
 * `sweepStalePrivateFiles` leaves it whatever time passes without a write. A file that is gone is left gone.
 */
export function keepPrivateFileLive(file: string): void {
  try {
    const now = new Date();
    fs.lutimesSync(file, now, now);
  } catch {
    // Removed meanwhile: the run's own end removes it too.
  }
}

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NO_WAIT = fs.constants.O_NONBLOCK ?? 0;

/** Why a file at a shared path is not trusted, or `null` when it is a regular file this user alone may write. */
export function untrustedReason(stat: fs.Stats): string | null {
  if (stat.isSymbolicLink()) return 'it is a symbolic link';
  if (!stat.isFile()) return 'it is not a regular file';
  if (typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) return 'another user owns it';
    if (stat.mode & 0o022) return 'other users may write to it';
    if (stat.nlink > 1) return 'it has another name';
  }
  return null;
}

/**
 * Write `text` to `file`, readable by its owner alone: into a new file beside it, then renamed over it, so whatever
 * was at `file`, a link included, is replaced and never written through. Throws when either step fails.
 */
export function writePrivateFile(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Append `text` to `file`, creating it readable by its owner alone. Throws, writing nothing, when `file` is a link or
 * a file `untrustedReason` refuses, checked on the path itself (`lstat`) and again on what was opened.
 */
export function appendPrivateFile(file: string, text: string): void {
  const found = fs.lstatSync(file, { throwIfNoEntry: false });
  const refused = found && untrustedReason(found);
  if (refused) throw new Error(`${file} is not written: ${refused}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW | NO_WAIT,
    0o600,
  );
  try {
    const reason = untrustedReason(fs.fstatSync(fd));
    if (reason) throw new Error(`${file} is not written: ${reason}`);
    fs.appendFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** What `readPrivateFile` found at its path: the file's text, or why it is not trusted. */
/** What was read, with the mode of the file as opened, or why it was not trusted. */
export type PrivateRead = { text: string; mode: number } | { untrusted: string };

/**
 * Read `file` when it is a regular file this user alone may write (`untrustedReason`), checked on the path itself
 * (`lstat`) and again on what was opened. `null` when there is no file; throws on any other read error.
 */
export function readPrivateFile(file: string): PrivateRead | null {
  const found = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!found) return null;
  const reason = untrustedReason(found);
  if (reason) return { untrusted: reason };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NO_WAIT);
  try {
    const stat = fs.fstatSync(fd);
    const opened = untrustedReason(stat);
    if (opened) return { untrusted: opened };
    return { text: fs.readFileSync(fd, 'utf8'), mode: stat.mode };
  } finally {
    fs.closeSync(fd);
  }
}
