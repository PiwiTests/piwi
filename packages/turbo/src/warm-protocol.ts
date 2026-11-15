// What `piwi-turbo --warm`, its daemon and the daemon's warm runner share: where the daemon listens, the token a
// request carries, and the messages, one JSON object per line.
import { createHash } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import type { PlaywrightInstall } from './start';

/** How long the daemon waits for a request before it exits. */
export const WARM_IDLE_MS = 10 * 60_000;
/** The variable that tells Playwright the terminal it writes to; the warm runner is prepared for the caller's. */
export const TERMINAL_VARIABLE = 'PLAYWRIGHT_FORCE_TTY';

/** Where a daemon's files are: the address it listens on and its token, and its log. */
export interface WarmAddress {
  /** A folder only this user can write to. */
  folder: string;
  /** Holds the daemon's address and token, readable by this user alone (`WarmContact`). */
  contactFile: string;
  logFile: string;
  /** On POSIX, the socket, in `folder`; on Windows, the daemon names a pipe no one can guess and writes it down. */
  socket?: string;
}

/** What `contactFile` holds. */
export interface WarmContact {
  address: string;
  token: string;
}

/**
 * The daemon of this Node, this Playwright, this version of the package and this cache folder: each has its own, so an
 * upgrade starts a new one.
 */
export function warmAddress(install: PlaywrightInstall, cacheRoot: string, packageVersion: string): WarmAddress {
  const user = String(process.getuid?.() ?? userInfo().username);
  const key = createHash('sha1')
    .update([install.cli, install.version, process.execPath, process.version, packageVersion, cacheRoot].join('\0'))
    .digest('hex')
    .slice(0, 16);
  const folder = join(tmpdir(), `piwi-turbo-${user}`);
  return {
    folder,
    contactFile: join(folder, `warm-${key}.json`),
    logFile: join(folder, `warm-${key}.log`),
    socket: process.platform === 'win32' ? undefined : join(folder, `warm-${key}.sock`),
  };
}

/** What the caller's output streams are: the warm runner's take their place from its start. */
export interface StreamInfo {
  isTTY: boolean;
  columns?: number;
  rows?: number;
  colorDepth?: number;
}

/** How a stream of this process describes itself. */
export function streamInfo(stream: NodeJS.WriteStream): StreamInfo {
  if (!stream.isTTY) return { isTTY: false };
  return { isTTY: true, columns: stream.columns, rows: stream.rows, colorDepth: stream.getColorDepth?.() };
}

/**
 * The terminal the caller writes to, which Playwright and the libraries it loads read as they load: the value of
 * `PLAYWRIGHT_FORCE_TTY` that describes it (the caller's own, else its width and height on a terminal, else `0`), and
 * the caller's two output streams. A warm runner serves a caller whose terminal is the one it loaded for.
 */
export interface Terminal {
  force: string;
  stdout: StreamInfo;
  stderr: StreamInfo;
}

export function terminalOf(env: NodeJS.ProcessEnv, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Terminal {
  const out = streamInfo(stdout);
  const force = env[TERMINAL_VARIABLE] ?? (out.isTTY ? `${out.columns ?? 0}x${out.rows ?? 0}` : '0');
  return { force, stdout: out, stderr: streamInfo(stderr) };
}

/** The variable that hands a warm runner the terminal it loads for. */
export const RUNNER_TERMINAL = 'PIWI_TURBO_WARM_TERMINAL';

/** A request to the daemon. */
export type WarmRequest =
  | {
      type: 'run';
      token: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
      terminal: Terminal;
      stdinIsTTY: boolean;
    }
  | { type: 'signal'; signal: NodeJS.Signals }
  | { type: 'stop'; token: string };

/** What the daemon sends back for a run. */
export type WarmReply =
  | { type: 'started'; pid: number }
  | { type: 'out'; fd: 1 | 2; data: string }
  | { type: 'exit'; code: number }
  | { type: 'cold'; reason: string };

/** Between the daemon and its warm runner. */
export type RunnerMessage =
  | { type: 'ready'; envRead: string[]; cwdRead: boolean }
  | {
      type: 'run';
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
      stdinIsTTY: boolean;
    }
  | { type: 'interrupt' };

/** Sends one message. */
export function send(socket: Socket, message: WarmRequest | WarmReply): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

/** The longest message a socket takes: a request carries the caller's whole environment. */
const MESSAGE_LIMIT = 16 * 1024 * 1024;

/** Calls `onMessage` for each message the socket receives, and closes a socket that sends anything else. */
export function onMessages<T>(socket: Socket, onMessage: (message: T) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      let message: T;
      try {
        message = JSON.parse(line) as T;
      } catch {
        socket.destroy();
        return;
      }
      onMessage(message);
    }
    if (buffered.length > MESSAGE_LIMIT) socket.destroy();
  });
}
