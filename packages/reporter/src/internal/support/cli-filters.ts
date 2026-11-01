/**
 * What a Playwright CLI invocation narrows a run to, read from its arguments as
 * Playwright's own option table reads them (`playwright test --help`): the
 * positional file and path filters (`playwright test tests/login.spec.ts auth/`),
 * the flags that run a subset, and the grep patterns, which Playwright hands to
 * its runner rather than to `config.grep`. A value an option takes is never a
 * file filter, and `--flag=value` forms consume no extra token.
 */

/** Options that take a value. */
const REQUIRED_VALUE_FLAGS = new Set([
  '--add-reporter',
  '--browser',
  '-c',
  '--config',
  '--global-timeout',
  '-g',
  '--grep',
  '-G',
  '--grep-invert',
  '--last-failed-file',
  '--max-failures',
  '--output',
  '-p',
  '--repeat-each',
  '--reporter',
  '--retries',
  '--run-agents',
  '--shard',
  '--test-list',
  '--test-list-invert',
  '--timeout',
  '--trace',
  '--tsconfig',
  '--ui-host',
  '--ui-port',
  '--update-source-method',
  '-j',
  '--workers',
]);

/** Options whose value is optional: the next argument is theirs unless it is an option. */
const OPTIONAL_VALUE_FLAGS = new Set(['--debug', '--only-changed', '--shuffle', '-u', '--update-snapshots']);

/** Options that take every following argument up to the next option. */
const VARIADIC_FLAGS = new Set(['--project']);

/** The flags that run a subset chosen from history, a diff or a list. */
const NARROWING_FLAGS = ['--last-failed', '--only-changed', '--test-list', '--test-list-invert'];

interface TestArguments {
  files: string[];
  options: Map<string, string | true>;
}

/**
 * The file filters and options of a `playwright test` invocation. `argv` holds
 * the node executable and the script first; the arguments after the `test`
 * subcommand are read, or all of them when it is absent. `merge-reports` names
 * report folders, never tests, so it reads as no filter.
 */
function parseTestArguments(argv: string[]): TestArguments {
  const args = argv.slice(2);
  const files: string[] = [];
  const options = new Map<string, string | true>();
  if (args.find((arg) => !arg.startsWith('-')) === 'merge-reports') return { files, options };
  const testIdx = args.indexOf('test');
  const rest = testIdx >= 0 ? args.slice(testIdx + 1) : args;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (!tok.startsWith('-')) {
      files.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq > 0) {
      options.set(tok.slice(0, eq), tok.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (REQUIRED_VALUE_FLAGS.has(tok) && next !== undefined) {
      options.set(tok, next);
      i++;
    } else if (OPTIONAL_VALUE_FLAGS.has(tok) && next !== undefined && !next.startsWith('-')) {
      options.set(tok, next);
      i++;
    } else if (VARIADIC_FLAGS.has(tok)) {
      const values: string[] = [];
      while (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('-')) values.push(rest[++i]!);
      options.set(tok, values.join(','));
    } else {
      options.set(tok, true);
    }
  }
  return { files, options };
}

/**
 * The positional file and path filters of a Playwright CLI invocation: they
 * narrow a run to some files and never reach `config.grep`. Empty for the full
 * suite.
 */
export function detectCliFileFilters(argv: string[] = process.argv): string[] {
  return parseTestArguments(argv).files;
}

/**
 * The narrowing flags of a Playwright CLI invocation, without their dashes:
 * `--last-failed` runs the last run's failures, `--only-changed` the tests a
 * diff touches, and `--test-list` or `--test-list-invert` the tests a file
 * lists, so each makes the run partial. Empty for the full suite.
 */
export function detectCliNarrowingFlags(argv: string[] = process.argv): string[] {
  const { options } = parseTestArguments(argv);
  return [...options.keys()].filter((flag) => NARROWING_FLAGS.includes(flag)).map((flag) => flag.slice(2));
}

/** The grep patterns of a Playwright CLI invocation (`--grep`, `-g`, `--grep-invert`, `-G`). */
export function detectCliGrep(argv: string[] = process.argv): { grep?: string; grepInvert?: string } {
  const { options } = parseTestArguments(argv);
  const valueOf = (...names: string[]) =>
    names.map((name) => options.get(name)).find((v): v is string => typeof v === 'string' && v.length > 0);
  const grep = valueOf('--grep', '-g');
  const grepInvert = valueOf('--grep-invert', '-G');
  return { ...(grep ? { grep } : {}), ...(grepInvert ? { grepInvert } : {}) };
}
