// `piwi-turbo --warm`: hands a `test` command to the warm runner of a daemon kept in the background, and passes its
// output, exit code and Ctrl+C on. Without a daemon, or when the runner was loaded for another environment, folder
// or terminal, the command runs in this process, and the daemon readies a runner for the next one.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { defaultCacheRoot, privateFolder } from './cache-folder';
import type { PlaywrightInstall } from './start';
import type { DaemonConfig } from './warm-daemon';
import {
  onMessages,
  send,
  terminalOf,
  warmAddress,
  type Terminal,
  type WarmAddress,
  type WarmContact,
  type WarmReply,
} from './warm-protocol';

const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

type Log = ((message: string) => void) | undefined;

/** The daemon's address and token, from the file only this user can read, or `undefined` without one. */
function readContact(address: WarmAddress): WarmContact | undefined {
  try {
    const contact = JSON.parse(readFileSync(address.contactFile, 'utf8')) as Partial<WarmContact>;
    return typeof contact.address === 'string' && typeof contact.token === 'string'
      ? { address: contact.address, token: contact.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The daemon's files, when this user has a folder only they can write to for them. */
function addressOf(install: PlaywrightInstall, log: Log): WarmAddress | undefined {
  const address = warmAddress(install, defaultCacheRoot(), PACKAGE_VERSION);
  if (privateFolder(address.folder)) return address;
  log?.(`no warm runner: other users can write to ${address.folder}`);
  return undefined;
}

function startDaemon(install: PlaywrightInstall, address: WarmAddress, terminal: Terminal): void {
  const config: DaemonConfig = {
    contactFile: address.contactFile,
    logFile: process.env.PIWI_TURBO_DEBUG ? address.logFile : undefined,
    socket: address.socket,
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
  const terminal = terminalOf(process.env, process.stdout, process.stderr);
  const contact = readContact(address);
  if (!contact) {
    log?.('no warm runner: starting one for the next command');
    startDaemon(install, address, terminal);
    return Promise.resolve('cold');
  }
  return new Promise((resolve) => {
    const socket = connect(contact.address);
    let connected = false;
    let settled = false;
    let exitCode: number | undefined;
    const forward = (signal: NodeJS.Signals) => send(socket, { type: 'signal', signal });
    const finish = (result: number | 'cold') => {
      if (settled) return;
      settled = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, forward);
      resolve(result);
    };
    socket.on('error', () => {
      if (connected) return;
      log?.('no warm runner: starting one for the next command');
      startDaemon(install, address, terminal);
      finish('cold');
    });
    socket.once('connect', () => {
      connected = true;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, forward);
      send(socket, {
        type: 'run',
        token: contact.token,
        args,
        env: process.env,
        cwd: process.cwd(),
        terminal,
        stdinIsTTY: !!process.stdin.isTTY,
      });
    });
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
      if (!connected) return;
      if (exitCode === undefined && !settled) process.stderr.write('piwi-turbo: the warm runner stopped\n');
      finish(exitCode ?? 1);
    });
  });
}

/** Stops the daemon of this project's Playwright, if one runs, once the commands it runs have stopped. */
export function stopWarm(install: PlaywrightInstall, log: Log): Promise<void> {
  const address = addressOf(install, log);
  const contact = address && readContact(address);
  if (!contact) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = connect(contact.address);
    socket.once('error', () => resolve());
    socket.once('connect', () => send(socket, { type: 'stop', token: contact.token }));
    socket.once('close', () => resolve());
  });
}
