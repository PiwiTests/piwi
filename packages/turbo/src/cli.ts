#!/usr/bin/env node
// `piwi-turbo`: Playwright's CLI, run in this process with its start-up costs cut before Playwright loads: Node's
// compile cache, a code cache of Playwright's modules for this process and the Node processes it starts, and for
// `test`, a spare worker that loads Playwright while the runner does. With `--warm` first, a `test` command goes to a
// runner a daemon loaded ahead (`--warm-stop` stops the daemon).
import { startSpareWorker } from './spare';
import { findPlaywright, setUpCaches } from './start';
import { runsWorkers } from './startup-env';
import { runWarm, stopWarm } from './warm';

const log = process.env.PIWI_TURBO_DEBUG ? (message: string) => console.error(`[piwi-turbo] ${message}`) : undefined;

async function main(): Promise<void> {
  const install = findPlaywright(process.cwd());
  if (!install) {
    console.error(
      'piwi-turbo runs the Playwright of the project in the current folder: install @playwright/test there.',
    );
    process.exit(1);
  }
  const flag = process.argv[2];
  if (flag === '--warm-stop') return stopWarm(install, log);
  if (flag === '--warm') {
    process.argv.splice(2, 1);
    const args = process.argv.slice(2);
    // Watch mode reads keys from the terminal, which the warm runner does not have.
    const warmable =
      runsWorkers(args) && process.execArgv.length === 0 && !process.env.NODE_V8_COVERAGE && !process.env.PWTEST_WATCH;
    const result = warmable ? await runWarm(install, args, log) : 'cold';
    if (result !== 'cold') {
      process.exitCode = result;
      return;
    }
  }
  setUpCaches(install, log);
  if (process.env.PIWI_TURBO_SPARE_WORKER !== '0' && runsWorkers(process.argv.slice(2)))
    startSpareWorker(install.playwrightDir, install.coreDir, log);
  require(install.cli);
}

void main();
