/**
 * Detect Playwright's interactive **UI mode** (`playwright test --ui`, or
 * `--ui-host` / `--ui-port`).
 *
 * Why the reporter cares: UI mode keeps a single long-lived runner process and
 * re-runs `globalSetup` every time you press play, while swapping the user's
 * reporters out for Playwright's internal UI reporter. So a run registered from
 * `globalSetup` would never be finished by the Piwi reporter — leaving orphaned
 * "initializing" runs on the dashboard: one when the UI launches and another
 * each time a run is started from it. Skipping registration in UI mode avoids
 * those stray runs.
 *
 * `globalSetup` runs in the same process the CLI was launched in, so the
 * `--ui*` flags are visible on `process.argv`. We only scan tokens after the
 * `test` subcommand (mirroring `detectCliFileFilters`) so an unrelated value
 * that happens to look like a UI flag can't trigger a false positive.
 *
 * `argv` is a parameter (defaulting to `process.argv`) purely so tests can drive
 * it deterministically.
 */
const PW_UI_FLAGS = ['--ui', '--ui-host', '--ui-port'];

export function isUiMode(argv: string[] = process.argv): boolean {
  // Drop the node executable + script path, then start after the `test` subcommand.
  const args = argv.slice(2);
  const testIdx = args.indexOf('test');
  const rest = testIdx >= 0 ? args.slice(testIdx + 1) : args;

  return rest.some((tok) => PW_UI_FLAGS.some((flag) => tok === flag || tok.startsWith(`${flag}=`)));
}

/**
 * Detect Playwright's **list mode** (`playwright test --list`), which prints the
 * planned tests without executing any.
 *
 * Why the reporter cares: list mode still drives the reporter through
 * `onBegin`/`onEnd` and runs `globalSetup`, yet no test runs. Registering a run
 * would leave an empty phantom run on the dashboard — created, finalized and
 * uploaded with zero results — for every `--list`. Skipping registration and
 * submission in list mode avoids those.
 *
 * As with `isUiMode`, only the tokens after the `test` subcommand are scanned so
 * a spec file or value that merely contains "list" can't trigger a false positive.
 *
 * `argv` is a parameter (defaulting to `process.argv`) purely so tests can drive
 * it deterministically.
 */
const PW_LIST_FLAGS = ['--list'];

export function isListMode(argv: string[] = process.argv): boolean {
  // Drop the node executable + script path, then start after the `test` subcommand.
  const args = argv.slice(2);
  const testIdx = args.indexOf('test');
  const rest = testIdx >= 0 ? args.slice(testIdx + 1) : args;

  return rest.some((tok) => PW_LIST_FLAGS.some((flag) => tok === flag || tok.startsWith(`${flag}=`)));
}

/**
 * Detect Playwright's **merge-reports** command (`playwright merge-reports`),
 * which replays blob reports through the reporters: no test runs, no worker
 * starts and nothing of the run is live. The command is the first argument
 * that is not an option, so a spec filter that reads `merge-reports` is not it.
 */
export function isMergeReports(argv: readonly string[] = process.argv): boolean {
  return argv.slice(2).find((arg) => !arg.startsWith('-')) === 'merge-reports';
}
