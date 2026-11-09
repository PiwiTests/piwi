/**
 * `piwi rerun` — run the tests a CI re-run from the dashboard asked for.
 *
 * The dashboard hands the job its Playwright arguments in `PIWI_RERUN_ARGS`,
 * each one double-quoted. This command splits the variable into those words
 * and starts `playwright test` with them, then the ones on its own command
 * line, with no shell on any platform.
 */
import { splitRerunArgs } from '@piwitests/core/rerun-args';
import { RERUN_ARGS_ENV } from '../internal/config/env.js';
import { spawnPlaywright } from '../internal/support/playwright-spawn.js';

const EXIT_ERROR = 2;

const USAGE = `
piwi rerun — run the tests a CI re-run from the dashboard asked for

Usage:
  npx @piwitests/reporter rerun [--] [playwright args]

Runs playwright test with the arguments of ${RERUN_ARGS_ENV}, split as the
dashboard quoted them and never read by a shell, followed by the arguments
given here (after an optional --). Declare ${RERUN_ARGS_ENV} in the CI job: set and empty, the whole
suite runs; unset, the command fails rather than run it.

Options:
  -h, --help    Show this help (as the first argument only)

Exit codes: Playwright's own, 128 plus the signal's number when the runner
stops Playwright (143 for SIGTERM), or 2 when ${RERUN_ARGS_ENV} is unset or
cannot be read, or Playwright cannot start.
`.trim();

export async function runRerun(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return 0;
  }
  const text = env[RERUN_ARGS_ENV];
  if (text === undefined) {
    console.error(
      `piwi rerun: ${RERUN_ARGS_ENV} is not set. Declare it in the job (a pipeline variable or build parameter) so the dashboard's arguments reach it.`,
    );
    return EXIT_ERROR;
  }
  let words: string[];
  try {
    words = splitRerunArgs(text);
  } catch (e) {
    console.error(`piwi rerun: ${RERUN_ARGS_ENV} cannot be read: ${(e as Error).message}.`);
    return EXIT_ERROR;
  }
  const extra = argv[0] === '--' ? argv.slice(1) : argv;
  return spawnPlaywright([...words, ...extra], env, { command: 'piwi rerun' });
}
