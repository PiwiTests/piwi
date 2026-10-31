/**
 * Extract positional file/path filters from a Playwright CLI invocation
 * (e.g. `playwright test tests/login.spec.ts auth/`). These narrow a run to
 * specific files and are NOT reflected in `config.grep`, so they're the only
 * signal that a file-filtered run is partial. Returns an empty array when the
 * full suite was requested.
 *
 * Best-effort: skips the values of known value-taking options so they aren't
 * mistaken for file filters. `--flag=value` forms consume no extra token.
 */
const PW_VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-j',
  '--workers',
  '-g',
  '--grep',
  '--grep-invert',
  '--global-timeout',
  '--max-failures',
  '--output',
  '-p',
  '--project',
  '--repeat-each',
  '--reporter',
  '--retries',
  '--shard',
  '--timeout',
  '--trace',
]);

export function detectCliFileFilters(argv: string[] = process.argv): string[] {
  // Drop the node executable + script path, then start after the `test` subcommand.
  const args = argv.slice(2);
  const testIdx = args.indexOf('test');
  const rest = testIdx >= 0 ? args.slice(testIdx + 1) : args;

  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('-')) {
      // A bare value-taking flag (no `=`) consumes the next token as its value.
      if (!tok.includes('=') && PW_VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    files.push(tok);
  }
  return files;
}

/** The Playwright CLI flags that run a subset chosen from history or a diff: the last run's failures, the changed tests. */
const NARROWING_FLAGS = ['--last-failed', '--only-changed'];

/**
 * The narrowing flags of a Playwright CLI invocation, without their dashes:
 * `--last-failed` runs the last run's failures and `--only-changed` the tests a
 * diff touches, so either makes the run partial. Empty for the full suite.
 */
export function detectCliNarrowingFlags(argv: string[] = process.argv): string[] {
  const args = argv.slice(2);
  const testIdx = args.indexOf('test');
  const rest = testIdx >= 0 ? args.slice(testIdx + 1) : args;
  const flags = new Set<string>();
  for (const tok of rest) {
    const name = tok.split('=', 1)[0]!;
    if (NARROWING_FLAGS.includes(name)) flags.add(name.slice(2));
  }
  return [...flags];
}
