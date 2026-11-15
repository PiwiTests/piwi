// The `piwi-turbo --warm` daemon: keeps one warm runner ready, hands it the next command whose caller sends the
// token and whose environment, folder and terminal the runner was loaded for, streams its output back, and readies
// another. It exits after WARM_IDLE_MS without a request, or when asked.
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { envRefusal } from './spare';
import {
  onMessages,
  send,
  TERMINAL_VARIABLE,
  WARM_IDLE_MS,
  type RunnerMessage,
  type WarmRequest,
} from './warm-protocol';

/** What the command that starts the daemon tells it. */
export interface DaemonConfig {
  socket: string;
  tokenFile: string;
  logFile?: string;
  cli: string;
  terminal: string;
}

interface Runner {
  child: ChildProcess;
  env: NodeJS.ProcessEnv;
  cwd: string;
  terminal: string;
  reads?: { env: Set<string>; cwd: boolean };
  ready: Promise<boolean>;
}

const config = JSON.parse(process.env.PIWI_TURBO_WARM_DAEMON ?? 'null') as DaemonConfig | null;
if (!config) process.exit(1);
delete process.env.PIWI_TURBO_WARM_DAEMON;

const token = randomBytes(24).toString('hex');
const log = (message: string) => {
  if (config.logFile) appendFileSync(config.logFile, `${new Date().toISOString()} ${message}\n`);
};
let runner: Runner | undefined;
let idle: NodeJS.Timeout | undefined;

/** Starts a runner for the next command, loaded with this environment, folder and terminal. */
function warm(env: NodeJS.ProcessEnv, cwd: string, terminal: string): void {
  runner?.child.kill();
  const child = fork(join(__dirname, 'warm-runner.js'), [], {
    cwd,
    env: { ...env, [TERMINAL_VARIABLE]: terminal, PIWI_TURBO_WARM_CLI: config!.cli },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
  const next: Runner = { child, env, cwd, terminal, ready: Promise.resolve(false) };
  next.ready = new Promise((resolve) => {
    child.once('message', (message: RunnerMessage) => {
      if (message.type !== 'ready') return resolve(false);
      next.reads = { env: new Set(message.envRead), cwd: message.cwdRead };
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
function refusal(ready: Runner, request: Extract<WarmRequest, { type: 'run' }>): string | undefined {
  if (!ready.reads) return 'the warm runner had not loaded';
  if (ready.terminal !== request.terminal) return 'the terminal changed';
  if (ready.reads.cwd && ready.cwd !== request.cwd) return 'the working folder changed';
  return envRefusal(ready.env, ready.reads.env, request.env, new Set([TERMINAL_VARIABLE]));
}

function stop(): never {
  runner?.child.kill();
  rmSync(config!.tokenFile, { force: true });
  log('stopped');
  process.exit(0);
}

function resetIdle(): void {
  clearTimeout(idle);
  idle = setTimeout(stop, WARM_IDLE_MS);
}

function validToken(given: unknown): boolean {
  const expected = Buffer.from(token);
  const received = Buffer.from(typeof given === 'string' ? given : '');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function run(socket: Socket, request: Extract<WarmRequest, { type: 'run' }>): Promise<void> {
  const candidate = runner;
  if (candidate && !candidate.reads)
    await Promise.race([candidate.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
  const reason = candidate ? refusal(candidate, request) : 'no warm runner';
  if (!candidate || reason) {
    log(`cold: ${reason}`);
    send(socket, { type: 'cold', reason: reason ?? 'no warm runner' });
    socket.end();
    warm(request.env, request.cwd, request.terminal);
    return;
  }
  runner = undefined;
  const { child } = candidate;
  runningChildOf.set(socket, child);
  send(socket, { type: 'started', pid: child.pid ?? 0 });
  child.stdout?.on('data', (data: Buffer) => send(socket, { type: 'out', fd: 1, data: data.toString('base64') }));
  child.stderr?.on('data', (data: Buffer) => send(socket, { type: 'out', fd: 2, data: data.toString('base64') }));
  child.once('close', (code, signal) => {
    send(socket, { type: 'exit', code: code ?? (signal ? 130 : 1) });
    socket.end();
    resetIdle();
    if (!runner) warm(request.env, request.cwd, request.terminal);
  });
  // A caller that goes away interrupts its run.
  socket.once('close', () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
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
const runningChildOf = new WeakMap<Socket, ChildProcess>();

const server = createServer((socket) => {
  let running = false;
  socket.on('error', () => {});
  onMessages<WarmRequest>(socket, (request) => {
    resetIdle();
    if (request.type === 'signal') {
      runningChildOf.get(socket)?.kill(request.signal);
      return;
    }
    if (!validToken(request.token)) {
      log('refused a request without the token');
      socket.destroy();
      return;
    }
    if (request.type === 'stop') {
      socket.end();
      stop();
    }
    if (running) return;
    running = true;
    void run(socket, request);
  });
});

function listen(retry: boolean): void {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE' || !retry || process.platform === 'win32') process.exit(0);
    // A socket file left by a daemon that is gone: remove it, unless a daemon answers on it.
    const probe = createConnection(config!.socket);
    probe.once('connect', () => process.exit(0));
    probe.once('error', () => {
      rmSync(config!.socket, { force: true });
      listen(false);
    });
  });
  server.listen(config!.socket, () => {
    writeFileSync(config!.tokenFile, token, { mode: 0o600 });
    log(`listening on ${config!.socket}`);
    resetIdle();
    warm(process.env, process.cwd(), config!.terminal);
  });
}
listen(true);
