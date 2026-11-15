// The runner a `piwi-turbo --warm` daemon keeps ready: it sets up the caches, starts its spare worker and loads
// Playwright's CLI while nobody waits, recording what that loading read, then runs the one command the daemon sends it
// with the caller's arguments, environment and folder.
import { dirname, join } from 'node:path';
import { recordReads } from './env-reads';
import { startSpareWorker } from './spare';
import { findPlaywright, setUpCaches } from './start';
import { CODE_CACHE_DIR, RUNNER_PID } from './startup-env';
import type { RunnerMessage } from './warm-protocol';

const cli = process.env.PIWI_TURBO_WARM_CLI;
const install = cli ? findPlaywright(dirname(cli)) : undefined;
if (!install || !process.send) process.exit(1);
delete process.env.PIWI_TURBO_WARM_CLI;

setUpCaches(install);
if (process.env.PIWI_TURBO_SPARE_WORKER !== '0') startSpareWorker(install.playwrightDir, install.coreDir);
// What the caches set in this process's environment, which the caller's environment does not carry.
const own = Object.fromEntries(
  ['NODE_COMPILE_CACHE', CODE_CACHE_DIR, RUNNER_PID]
    .map((key) => [key, process.env[key]] as const)
    .filter(([, value]) => value !== undefined),
);

let program: { parse(argv: string[]): void } | undefined;
const reads = recordReads(() => {
  program = (require(join(install.playwrightDir, 'lib', 'program.js')) as { program: typeof program }).program;
});
process.send({ type: 'ready', envRead: [...reads.env], cwdRead: reads.cwd } satisfies RunnerMessage);

process.once('message', (message: RunnerMessage) => {
  if (message.type !== 'run' || !program) return;
  process.chdir(message.cwd);
  for (const key of Object.keys(process.env)) if (message.env[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries({ ...message.env, ...own }))
    if (value !== undefined) process.env[key] = value;
  Object.defineProperty(process.stdin, 'isTTY', { value: message.stdinIsTTY, configurable: true });
  process.argv = [process.execPath, install.cli, ...message.args];
  program.parse(process.argv);
});
