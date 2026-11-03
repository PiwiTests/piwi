import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * The files the reporter keeps in the shared temp directory: created readable and writable by their owner alone,
 * never written through a symbolic link, and read back only when they are a regular file this user owns that no one
 * else may write. Each path is checked (`lstat`) before it is opened, and what was opened is checked again; the open
 * neither follows a link (`O_NOFOLLOW`) nor waits for the other end of a named pipe (`O_NONBLOCK`).
 *
 * Windows has neither flag, nor file owners and mode bits: there the `lstat` alone refuses a link, a link made between
 * it and the open is followed, and the owner and mode checks are skipped. Its `os.tmpdir()` is the user's own folder,
 * but for a service's.
 */

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
export type PrivateRead = { text: string } | { untrusted: string };

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
    const opened = untrustedReason(fs.fstatSync(fd));
    if (opened) return { untrusted: opened };
    return { text: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}
