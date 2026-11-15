// `piwi-turbo --warm`: hands a `test` command to the warm runner of a daemon kept in the background, and passes its
// output and exit code on. Without a daemon, or when the runner was loaded for another environment, folder or
// terminal, the command runs in this process, and the daemon readies a runner for the next one.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { defaultCacheRoot, privateFolder } from './cache-folder';
import type { PlaywrightInstall } from './start';
import type { DaemonConfig } from './warm-daemon';
import { onMessages, send, terminalOf, warmAddress, type WarmAddress, type WarmReply } from './warm-protocol';

const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

type Log = ((message: string) => void) | undefined;

function readToken(address: WarmAddress): string | undefined {
  try {
    return readFileSync(address.tokenFile, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** The daemon's address, when this user has a folder of their own for it. */
function addressOf(install: PlaywrightInstall, log: Log): WarmAddress | undefined {
  const address = warmAddress(install, defaultCacheRoot(), PACKAGE_VERSION);
  if (privateFolder(address.folder)) return address;
  log?.(`no warm runner: other users can write to ${address.folder}`);
  return undefined;
}

function startDaemon(install: PlaywrightInstall, address: WarmAddress, terminal: string): void {
  const config: DaemonConfig = {
    socket: address.socket,
    tokenFile: address.tokenFile,
    logFile: process.env.PIWI_TURBO_DEBUG ? address.tokenFile.replace(/\.token$/, '.log') : undefined,
    cli: install.cli,
    terminal,
  };
  const daemon = spawn(process.execPath, [join(__dirname, 'warm-daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PIWI_TURBO_WARM_DAEMON: JSON.stringify(config) },
  });
  daemon.unref();
}

/**
 * Runs `args` through the warm runner; resolves to its exit code, or to `cold` when this process must run them
 * itself.
 */
export function runWarm(install: PlaywrightInstall, args: string[], log: Log): Promise<number | 'cold'> {
  const address = addressOf(install, log);
  if (!address) return Promise.resolve('cold');
  const terminal = terminalOf(process.env, process.stdout);
  return new Promise((resolve) => {
    const socket = connect(address.socket);
    let settled = false;
    const finish = (result: number | 'cold') => {
      if (settled) return;
      settled = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, forward);
      resolve(result);
    };
    const forward = (signal: NodeJS.Signals) => send(socket, { type: 'signal', signal });
    let connected = false;
    socket.on('error', () => {
      if (connected) return;
      log?.('no warm runner: starting one for the next command');
      startDaemon(install, address, terminal);
      finish('cold');
    });
    socket.once('connect', () => {
      connected = true;
      const token = readToken(address);
      if (!token) {
        socket.destroy();
        log?.('no warm runner: the daemon has no token');
        return finish('cold');
      }
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, forward);
      send(socket, {
        type: 'run',
        token,
        args,
        env: process.env,
        cwd: process.cwd(),
        terminal,
        stdinIsTTY: !!process.stdin.isTTY,
      });
    });
    let exitCode: number | undefined;
    onMessages<WarmReply>(socket, (reply) => {
      if (reply.type === 'started') log?.(`warm runner ${reply.pid} runs the command`);
      else if (reply.type === 'out')
        (reply.fd === 1 ? process.stdout : process.stderr).write(Buffer.from(reply.data, 'base64'));
      else if (reply.type === 'exit') exitCode = reply.code;
      else if (reply.type === 'cold') {
        log?.(`no warm runner: ${reply.reason}`);
        finish('cold');
      }
    });
    socket.once('close', () => {
      if (exitCode === undefined && !settled) process.stderr.write('piwi-turbo: the warm runner stopped\n');
      finish(exitCode ?? 1);
    });
  });
}

/** Stops the daemon of this project's Playwright, if one runs. */
export function stopWarm(install: PlaywrightInstall, log: Log): Promise<void> {
  const address = addressOf(install, log);
  const token = address && readToken(address);
  if (!address || !token) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = connect(address.socket);
    socket.once('error', () => resolve());
    socket.once('connect', () => send(socket, { type: 'stop', token }));
    socket.once('close', () => resolve());
  });
}
