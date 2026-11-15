// `piwi-turbo test` starts one spare test worker before Playwright loads, and gives it to Playwright's first worker
// fork when nothing the spare's start depended on has changed since. Otherwise the spare stops and Playwright forks
// as usual.
import childProcess, { type ChildProcess, type ForkOptions, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SPARE_ENTRY, SPARE_PRELOAD, type SpareHandoff, type SpareLoaded } from './startup-env';

/** Variables Node reads as a process starts, and the `debug` module's options, which it finds by listing them all. */
const STARTUP_ENV = /^(NODE_|UV_|LANG$|LANGUAGE$|LC_|OPENSSL_|SSL_CERT_|DEBUG)/i;

/** What the spare was started with. */
export interface SpareStart {
  entry: string;
  execArgv: string[];
  cwd: string;
  stdio: StdioOptions;
  env: NodeJS.ProcessEnv;
}

/** A fork Playwright asks for, with this process's Node options and folder at that time. */
export interface ForkRequest {
  args: readonly string[];
  options: ForkOptions;
  execArgv: string[];
  cwd: string;
}

/** Why the spare cannot stand in for a worker fork, or `undefined` when it can. */
export function spareRefusal(
  start: SpareStart,
  envRead: ReadonlySet<string> | undefined,
  request: ForkRequest,
): string | undefined {
  if (!envRead) return 'it was still loading';
  const { options } = request;
  const extra = Object.entries(options).filter(
    ([key, value]) => value !== undefined && !['env', 'stdio', 'detached'].includes(key),
  );
  if (request.args.length || extra.length || options.detached) return 'the fork has options the spare does not';
  if (JSON.stringify(request.execArgv) !== JSON.stringify(start.execArgv)) return 'the Node options changed';
  if (request.cwd !== start.cwd) return 'the working folder changed';
  if (JSON.stringify(options.stdio) !== JSON.stringify(start.stdio)) return 'the fork asks for other stdio';
  const env = options.env ?? process.env;
  for (const key of new Set([...Object.keys(env), ...Object.keys(start.env)]))
    if (env[key] !== start.env[key] && (envRead.has(key) || STARTUP_ENV.test(key))) return `${key} changed`;
  return undefined;
}

/**
 * Starts the spare worker for the `playwright` and `playwright-core` packages in these folders, with the environment
 * and stdio Playwright gives a worker, and wraps `child_process.fork` to hand it over.
 */
export function startSpareWorker(playwrightDir: string, coreDir: string, log?: (message: string) => void): void {
  const entry = join(playwrightDir, 'lib', 'worker', 'workerProcessEntry.js');
  const preload = ['coreBundle.js', 'utilsBundle.js'].map((file) => join(coreDir, 'lib', file));
  if (![entry, ...preload].every((file) => existsSync(file))) {
    log?.('no spare worker: this Playwright has another layout');
    return;
  }
  const start: SpareStart = {
    entry,
    execArgv: [...process.execArgv],
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', process.env.PW_RUNNER_DEBUG ? 'inherit' : 'pipe', 'ipc'],
    env: {
      ...process.env,
      PLAYWRIGHT_TEST: '1',
      FORCE_COLOR: '1',
      DEBUG_COLORS: process.env.DEBUG_COLORS === undefined ? '1' : process.env.DEBUG_COLORS,
    },
  };
  const spare = childProcess.fork(join(__dirname, 'spare-worker.js'), [], {
    detached: false,
    env: { ...start.env, [SPARE_ENTRY]: entry, [SPARE_PRELOAD]: JSON.stringify(preload) },
    stdio: start.stdio,
    execArgv: start.execArgv,
  });
  log?.(`spare worker ${spare.pid} started`);
  let state: 'waiting' | 'handed off' | 'gone' = 'waiting';
  let envRead: Set<string> | undefined;
  const onMessage = (message: SpareLoaded) => {
    if (message?.method === '__piwi_turbo_spare_loaded__') envRead = new Set(message.envRead);
  };
  spare.on('message', onMessage);
  spare.on('error', () => {});
  spare.on('exit', () => {
    if (state === 'waiting') state = 'gone';
  });
  const handles = [spare, spare.channel, spare.stdout, spare.stderr] as Array<{ ref?(): void; unref?(): void } | null>;
  for (const handle of handles) handle?.unref?.();
  process.on('exit', () => {
    if (state === 'waiting') spare.kill();
  });

  const fork = childProcess.fork;
  const forkWithSpare = function (this: unknown, modulePath: string | URL, ...rest: unknown[]): ChildProcess {
    if (modulePath !== entry || state !== 'waiting') return Reflect.apply(fork, this, [modulePath, ...rest]);
    childProcess.fork = fork;
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const options = ((Array.isArray(rest[0]) ? rest[1] : rest[0]) ?? {}) as ForkOptions;
    const refusal = spareRefusal(start, envRead, { args, options, execArgv: process.execArgv, cwd: process.cwd() });
    if (refusal) {
      state = 'gone';
      spare.kill();
      log?.(`spare worker not used: ${refusal}`);
      return Reflect.apply(fork, this, [modulePath, ...rest]);
    }
    state = 'handed off';
    spare.off('message', onMessage);
    for (const handle of handles) handle?.ref?.();
    spare.send({ method: '__piwi_turbo_spare_handoff__', env: options.env ?? process.env } satisfies SpareHandoff);
    log?.(`spare worker ${spare.pid} handed off`);
    return spare;
  };
  childProcess.fork = forkWithSpare as typeof childProcess.fork;
}
