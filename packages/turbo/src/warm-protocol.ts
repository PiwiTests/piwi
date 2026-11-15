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

/** Where a daemon listens, and the file holding the token its requests carry. */
export interface WarmAddress {
  /** A folder only this user can reach: the token, and the socket on POSIX. */
  folder: string;
  socket: string;
  tokenFile: string;
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
  const socket =
    process.platform === 'win32' ? `\\\\.\\pipe\\piwi-turbo-${user}-${key}` : join(folder, `warm-${key}.sock`);
  return { folder, socket, tokenFile: join(folder, `warm-${key}.token`) };
}

/**
 * The terminal the caller writes to, as Playwright reads it when it loads: the caller's own `PLAYWRIGHT_FORCE_TTY`, else
 * its width and height on a terminal, else `0`.
 */
export function terminalOf(env: NodeJS.ProcessEnv, stdout: { isTTY?: boolean; columns?: number; rows?: number }) {
  return env[TERMINAL_VARIABLE] ?? (stdout.isTTY ? `${stdout.columns ?? 0}x${stdout.rows ?? 0}` : '0');
}

/** A request to the daemon. */
export type WarmRequest =
  | {
      type: 'run';
      token: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      cwd: string;
      terminal: string;
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
  | { type: 'run'; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdinIsTTY: boolean };

/** Sends one message. */
export function send(socket: Socket, message: WarmRequest | WarmReply): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

/** Calls `onMessage` for each message the socket receives. */
export function onMessages<T>(socket: Socket, onMessage: (message: T) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line) onMessage(JSON.parse(line) as T);
    }
  });
}
