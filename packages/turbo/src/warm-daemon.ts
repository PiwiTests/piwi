// The `piwi-turbo --warm` daemon: keeps one warm runner ready, hands it the next command whose caller sends the
// token and whose environment, folder and terminal the runner was loaded for, streams its output back, and readies
// another. It exits after WARM_IDLE_MS with no run and no request, or when asked.
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { envRefusal } from './spare';
import {
  onMessages,
  RUNNER_TERMINAL,
  send,
  TERMINAL_VARIABLE,
  WARM_IDLE_MS,
  type RunnerMessage,
  type Terminal,
  type WarmContact,
  type WarmRequest,
} from './warm-protocol';

/** What the command that starts the daemon tells it. */
export interface DaemonConfig {
  contactFile: string;
  logFile?: string;
  /** The POSIX socket to listen on; without it, a pipe with a name no one can guess. */
  socket?: string;
  cli: string;
  terminal: Terminal;
}

type RunRequest = Extract<WarmRequest, { type: 'run' }>;

interface Runner {
  child: ChildProcess;
  env: NodeJS.ProcessEnv;
  cwd: string;
  terminal: Terminal;
  reads?: { env: Set<string>; cwd: boolean };
  ready: Promise<boolean>;
}

/** How long a request waits for a runner that is still loading. */
const LOAD_WAIT_MS = 10_000;
/** The package's own variables a runner reads as it starts, outside what its loading recorded. */
const OWN_VARIABLE = /^PIWI_TURBO_(?!DEBUG$)/;

const config = JSON.parse(process.env.PIWI_TURBO_WARM_DAEMON ?? 'null') as DaemonConfig | null;
if (!config) process.exit(1);
delete process.env.PIWI_TURBO_WARM_DAEMON;

const token = randomBytes(24).toString('hex');
const address = config.socket ?? `\\\\.\\pipe\\piwi-turbo-${randomBytes(16).toString('hex')}`;
const log = (message: string) => {
  if (config.logFile) appendFileSync(config.logFile, `${new Date().toISOString()} ${message}\n`);
};
let runner: Runner | undefined;
const running = new Set<ChildProcess>();
let idle: NodeJS.Timeout | undefined;

/** Starts a runner for the next command, loaded with this environment, folder and terminal. */
function warm(env: NodeJS.ProcessEnv, cwd: string, terminal: Terminal): void {
  runner?.child.kill();
  const child = fork(join(__dirname, 'warm-runner.js'), [], {
    cwd,
    env: {
      ...env,
      [TERMINAL_VARIABLE]: terminal.force,
      [RUNNER_TERMINAL]: JSON.stringify(terminal),
      PIWI_TURBO_WARM_CLI: config!.cli,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
    windowsHide: true,
  } as Parameters<typeof fork>[2]);
  const next: Runner = { child, env, cwd, terminal, ready: Promise.resolve(false) };
  next.ready = new Promise((resolve) => {
    child.once('message', (message: RunnerMessage) => {
      if (message.type !== 'ready') return resolve(false);
      next.reads = { env: new Set(message.envRead), cwd: message.cwdRead };
      log(`runner ${child.pid} ready`);
      resolve(true);
    });
    child.once('exit', () => resolve(false));
  });
  child.on('exit', () => {
    if (runner === next) runner = undefined;
  });
  child.on('error', () => {});
  runner = next;
}

/** Why the runner cannot run this command, or `undefined` when it can. */
function refusal(ready: Runner, request: RunRequest): string | undefined {
  if (!ready.reads) return 'the warm runner had not loaded';
  if (JSON.stringify(ready.terminal) !== JSON.stringify(request.terminal)) return 'the terminal changed';
  if (ready.reads.cwd && ready.cwd !== request.cwd) return 'the working folder changed';
  for (const key of new Set([...Object.keys(ready.env), ...Object.keys(request.env)]))
    if (OWN_VARIABLE.test(key) && ready.env[key] !== request.env[key]) return `${key} changed`;
  return envRefusal(ready.env, ready.reads.env, request.env, new Set([TERMINAL_VARIABLE]));
}

/** Asks a run to stop as Ctrl+C does: a signal on POSIX, a message the runner turns into one on Windows. */
function interrupt(child: ChildProcess): void {
  if (process.platform === 'win32' && child.connected) child.send({ type: 'interrupt' } satisfies RunnerMessage);
  else child.kill('SIGINT');
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(idle);
  server.close();
  runner?.child.kill();
  for (const child of running) interrupt(child);
  const closed = [...running].map((child) => new Promise((resolve) => child.once('close', resolve)));
  await Promise.race([Promise.all(closed), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  for (const child of running) child.kill();
  rmSync(config!.contactFile, { force: true });
  if (config!.socket) rmSync(config!.socket, { force: true });
  log('stopped');
  process.exit(0);
}

/** Restarts the countdown to the daemon's exit, which waits while a command runs. */
function resetIdle(): void {
  clearTimeout(idle);
  if (!running.size) idle = setTimeout(() => void stop(), WARM_IDLE_MS);
}

function validToken(given: unknown): boolean {
  const expected = Buffer.from(token);
  const received = Buffer.from(typeof given === 'string' ? given : '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function run(socket: Socket, request: RunRequest): Promise<void> {
  // The runner belongs to this request from here: another one arriving meanwhile finds none.
  const candidate = runner;
  runner = undefined;
  if (candidate && !candidate.reads)
    await Promise.race([candidate.ready, new Promise((resolve) => setTimeout(resolve, LOAD_WAIT_MS))]);
  const reason = candidate ? refusal(candidate, request) : 'no warm runner';
  if (!candidate || reason) {
    log(`cold: ${reason}`);
    send(socket, { type: 'cold', reason: reason ?? 'no warm runner' });
    socket.end();
    candidate?.child.kill();
    if (!runner) warm(request.env, request.cwd, request.terminal);
    return;
  }
  const { child } = candidate;
  running.add(child);
  clearTimeout(idle);
  runOf.set(socket, child);
  send(socket, { type: 'started', pid: child.pid ?? 0 });
  child.stdout?.on('data', (data: Buffer) => send(socket, { type: 'out', fd: 1, data: data.toString('base64') }));
  child.stderr?.on('data', (data: Buffer) => send(socket, { type: 'out', fd: 2, data: data.toString('base64') }));
  child.once('close', (code, signal) => {
    running.delete(child);
    send(socket, { type: 'exit', code: code ?? (signal ? 130 : 1) });
    socket.end();
    resetIdle();
    if (!runner && !stopping) warm(request.env, request.cwd, request.terminal);
  });
  // A caller that goes away interrupts its run.
  socket.once('close', () => {
    if (running.has(child)) interrupt(child);
  });
  child.send({
    type: 'run',
    args: request.args,
    env: request.env,
    cwd: request.cwd,
    stdinIsTTY: request.stdinIsTTY,
  } satisfies RunnerMessage);
  log(`ran ${request.args.join(' ')} in ${child.pid}`);
}

/** The runner each connection's run went to: a signal on a connection goes to its run alone. */
const runOf = new WeakMap<Socket, ChildProcess>();

const server = createServer((socket) => {
  let requested = false;
  let signals = 0;
  socket.on('error', () => {});
  onMessages<WarmRequest>(socket, (request) => {
    if (request.type === 'signal') {
      const child = runOf.get(socket);
      // A second Ctrl+C ends the run at once.
      if (child && signals++) child.kill();
      else if (child) interrupt(child);
      return;
    }
    if (!validToken(request.token)) {
      log('refused a request without the token');
      socket.destroy();
      return;
    }
    resetIdle();
    if (request.type === 'stop') {
      socket.end();
      void stop();
      return;
    }
    if (requested || stopping) return;
    requested = true;
    void run(socket, request);
  });
});

server.once('listening', () => {
  writeFileSync(config.contactFile, JSON.stringify({ address, token } satisfies WarmContact), { mode: 0o600 });
  log(`listening on ${address}`);
  resetIdle();
  warm(process.env, process.cwd(), config.terminal);
});

function listen(retry: boolean): void {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE' || !retry || !config!.socket) process.exit(0);
    // A socket file left by a daemon that is gone: remove it, unless a daemon answers on it.
    const probe = createConnection(config!.socket);
    probe.once('connect', () => process.exit(0));
    probe.once('error', () => {
      rmSync(config!.socket!, { force: true });
      listen(false);
    });
  });
  server.listen(address);
}
listen(true);
