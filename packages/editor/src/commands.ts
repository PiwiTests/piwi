import { requiredTagsGrepInvert } from '@piwitests/core/environments';

/**
 * The command lines the editor runs in a terminal: built here from arguments checked one by one, never taken as an
 * instance's command text. An instance names what to run (the Playwright arguments of a test or a selection, the
 * verification of a fix plan), or the editor names tests by their location in a spec; an argument that is not a test
 * filter or an option of {@link PLAYWRIGHT_OPTIONS}, or that a shell would expand, refuses the whole command.
 */

/**
 * Characters bash, zsh, PowerShell or cmd expand inside double quotes, plus control characters. PowerShell reads the
 * typographic double quotes (“ ” „) as `"`: one of them would end the quoted word.
 */
const SHELL_EXPANDED = /[$`"\\%!\u201C\u201D\u201E\p{Cc}]/u;

/** Characters every shell leaves as they are outside quotes. */
const SHELL_PLAIN = /^[A-Za-z0-9._/:=+-]+$/;

/**
 * The `playwright test` options an instance may pass, with whether each takes a value: test filters and run options
 * only, none that names a file Playwright loads (`--config`, `--reporter`, `--tsconfig`) or where it writes.
 */
const PLAYWRIGHT_OPTIONS = new Map<string, boolean>([
  ['--grep', true],
  ['-g', true],
  ['--grep-invert', true],
  ['--project', true],
  ['--repeat-each', true],
  ['--retries', true],
  ['--workers', true],
  ['-j', true],
  ['--max-failures', true],
  ['--timeout', true],
  ['--trace', true],
  ['--headed', false],
  ['--debug', false],
  ['--ui', false],
  ['--last-failed', false],
  ['-x', false],
  ['--pass-with-no-tests', false],
]);

/**
 * A `--grep-invert` value `requiredTagsGrepInvert` writes: a run's own pattern in `(?:…)|` (group 1), then the
 * lookahead over the required tags (group 2).
 */
const REQUIRED_TAGS_FILTER =
  /^(?:\(\?:(.+)\)\|)?\^\(\?!\.\*\(\?:\^\|\\s\)\(\?:(@[A-Za-z0-9_-]{1,63}(?:\|@[A-Za-z0-9_-]{1,63})*)\)\(\?:\\s\|\$\)\)$/;

/**
 * Whether `arg` is the filter that keeps a run to the tests carrying a protected environment's required tags, as
 * `requiredTagsGrepInvert` writes it from tags and a run's own pattern that a shell leaves as they are in double quotes.
 * Its own characters a shell could expand (`!`, `\s`, `$` before `)`) are left as they are in double quotes by bash
 * and zsh run with a command (no history expansion) and by PowerShell, so it is a shell word in double quotes too.
 * PowerShell hands it to a native command bare, having no whitespace, so a `.cmd` such as `npx.cmd` would let cmd
 * read its `^` and `|`: on Windows such a run starts the project's Playwright CLI with `node`
 * ({@link playwrightNodeCommand}).
 */
export function isRequiredTagsFilter(arg: string): boolean {
  const match = REQUIRED_TAGS_FILTER.exec(arg);
  if (!match) return false;
  const own = match[1];
  if (own !== undefined && (!own || SHELL_EXPANDED.test(own))) return false;
  return requiredTagsGrepInvert(match[2]!.split('|'), own) === arg;
}

/** `arg` as a shell word: bare when no shell changes it, else double-quoted; null when a shell would expand it. */
export function shellWord(arg: string): string | null {
  if (SHELL_PLAIN.test(arg)) return arg;
  if (isRequiredTagsFilter(arg)) return `"${arg}"`;
  return arg && !SHELL_EXPANDED.test(arg) ? `"${arg}"` : null;
}

/** Whether `args` are test filters and the options of {@link PLAYWRIGHT_OPTIONS}, each followed by its value. */
export function validPlaywrightArgs(args: unknown[]): args is string[] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string' || !arg) return false;
    if (!arg.startsWith('-')) continue;
    const eq = arg.indexOf('=');
    const takesValue = PLAYWRIGHT_OPTIONS.get(eq < 0 ? arg : arg.slice(0, eq));
    if (takesValue === undefined || (eq >= 0 && !takesValue)) return false;
    if (takesValue && eq < 0 && typeof args[++i] !== 'string') return false;
  }
  return true;
}

/** The options a run of each test several times sets itself. */
const REPEAT_OPTIONS = new Set(['--repeat-each', '--retries']);

/** The most runs of each test a repeated run asks for. */
const MAX_REPEAT = 100;

/**
 * `args` running each test `repeat` times without retries (`--repeat-each=3 --retries=0`), in place of the repeat and
 * retries they set; null when they are not {@link validPlaywrightArgs} or `repeat` is not a whole number from 1 to
 * {@link MAX_REPEAT}.
 */
export function repeatArgs(args: unknown[], repeat: unknown): string[] | null {
  if (!validPlaywrightArgs(args)) return null;
  if (typeof repeat !== 'number' || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) return null;
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('-') ? (eq < 0 ? arg : arg.slice(0, eq)) : null;
    const words = name && eq < 0 && PLAYWRIGHT_OPTIONS.get(name) ? [arg, args[++i]!] : [arg];
    if (!name || !REPEAT_OPTIONS.has(name)) kept.push(...words);
  }
  return [...kept, `--repeat-each=${repeat}`, '--retries=0'];
}

/**
 * `args` kept to the tests carrying one of `tags`, a protected environment's required tags: the run's own
 * `--grep-invert` (the last, as Playwright reads it) taken out and merged into one with `requiredTagsGrepInvert`,
 * written last. Null when `args` are not {@link validPlaywrightArgs}.
 */
export function withRequiredTags(args: unknown[], tags: readonly string[]): string[] | null {
  if (!validPlaywrightArgs(args)) return null;
  const kept: string[] = [];
  let own: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('-') ? (eq < 0 ? arg : arg.slice(0, eq)) : null;
    const words = name && eq < 0 && PLAYWRIGHT_OPTIONS.get(name) ? [arg, args[++i]!] : [arg];
    if (name === '--grep-invert') own = eq < 0 ? words[1]! : arg.slice(eq + 1);
    else kept.push(...words);
  }
  return [...kept, '--grep-invert', requiredTagsGrepInvert(tags, own)];
}

/**
 * Whether `location` names tests as Playwright's location filter takes it: a spec's path relative to the Playwright
 * config's folder, with forward slashes, then the 1-based line of its `test(…)` call (`tests/checkout.spec.ts:42`), or
 * without a line for every test of the spec (`tests/checkout.spec.ts`).
 */
export function isTestLocation(location: unknown): location is string {
  if (typeof location !== 'string') return false;
  const match = /^([^:]+)(?::[1-9]\d*)?$/.exec(location);
  const file = match?.[1];
  return !!file && !file.startsWith('/') && !file.startsWith('-') && !file.split('/').includes('..');
}

/** The spec a location names, without its line (`tests/checkout.spec.ts:42` → `tests/checkout.spec.ts`). */
export function locationSpec(location: string): string {
  return location.replace(/:[1-9]\d*$/, '');
}

/** `npx playwright test` with `args`, or null when they are not {@link validPlaywrightArgs} or one cannot be quoted. */
export function playwrightTestCommand(args: unknown): string | null {
  if (!Array.isArray(args) || !validPlaywrightArgs(args)) return null;
  const words = args.map(shellWord);
  return words.every((w) => w !== null) ? ['npx playwright test', ...words].join(' ') : null;
}

/**
 * `node <cli> test` with `args`: the project's Playwright CLI (`cli`, its path, written with `/`) started by Node with
 * no `.cmd` between, so no cmd reads the arguments; null when `cli` is unknown, `args` are not
 * {@link validPlaywrightArgs}, or one cannot be quoted.
 */
export function playwrightNodeCommand(cli: string | null, args: unknown): string | null {
  if (!cli || !Array.isArray(args) || !validPlaywrightArgs(args)) return null;
  const file = shellWord(cli.replaceAll('\\', '/'));
  const words = args.map(shellWord);
  return file && words.every((w) => w !== null) ? ['node', file, 'test', ...words].join(' ') : null;
}

/**
 * The words of a command line an instance sent, split as every shell splits plain words and double quotes; null when
 * it holds anything else: a single quote, an unclosed quote, an operator, a character a shell expands.
 */
export function commandWords(command: string): string[] | null {
  const words: string[] = [];
  const pattern = /\s*((?:"[^"]*"|[^\s"]+)+)/gy;
  let match: RegExpExecArray | null;
  let end = 0;
  while ((match = pattern.exec(command))) {
    const word = match[1]!;
    const parts = word.match(/"[^"]*"|[^"]+/g) ?? [];
    if (!parts.every((p) => (p.startsWith('"') ? !SHELL_EXPANDED.test(p.slice(1, -1)) : SHELL_PLAIN.test(p)))) {
      return null;
    }
    words.push(parts.map((p) => (p.startsWith('"') ? p.slice(1, -1) : p)).join(''));
    end = pattern.lastIndex;
  }
  return command.slice(end).trim() ? null : words;
}

/** The arguments after `npx playwright test` in a command line an instance sent, else null. */
export function playwrightArgsOf(command: unknown): string[] | null {
  const words = typeof command === 'string' ? commandWords(command) : null;
  if (!words || words.slice(0, 3).join(' ') !== 'npx playwright test') return null;
  const args = words.slice(3);
  return validPlaywrightArgs(args) ? args : null;
}

/**
 * A fix plan's verification, built again from its `npx playwright test` commands (one per Playwright project, joined
 * with `&&`); null when one part is anything else.
 */
export function verificationCommand(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  const parts = command.split(' && ').map((part) => {
    const args = playwrightArgsOf(part.trim());
    return args ? playwrightTestCommand(args) : null;
  });
  return parts.every((p) => p !== null) ? parts.join(' && ') : null;
}

/** A Flake Lab line's command (`flakeCommand`), with the `--server-url` it may carry (`withServerUrl`). */
const FLAKE_LINE = /^npx @piwitests\/reporter flake (?:verify )?[1-9]\d*(?: --server-url (?:[^\s"]+|"[^"$`\\]+"))?$/;

/**
 * Whether a command a client sends back to be followed (`piwi/followCommand`) is one the service gives with `follow`: a
 * fix plan's verification as `verificationCommand` builds it, or a Flake Lab line.
 */
export function followableCommand(command: unknown): command is string {
  if (typeof command !== 'string') return false;
  return verificationCommand(command) === command || FLAKE_LINE.test(command);
}

/** The `piwi flake` command that reproduces a test, or verifies its fix. */
export function flakeCommand(testCaseId: number, kind: 'reproduce' | 'verify'): string | null {
  if (!Number.isSafeInteger(testCaseId) || testCaseId <= 0) return null;
  return kind === 'verify'
    ? `npx @piwitests/reporter flake verify ${testCaseId}`
    : `npx @piwitests/reporter flake ${testCaseId}`;
}

/** A character of a dashboard's copied spec filter written with its `file:` URL encoding (`(?:é|.C3.A9)`). */
const URL_ENCODED_ALTERNATIVE = /\(\?:(\[.\]|[^|])\|(?:\.[0-9A-F]{2})+\)/gu;

/** A grep that a person would not read as a title: a regular expression's syntax beyond `.`. */
const GREP_PATTERN = /[|()^$\\[\]*+?{}]/;

/**
 * What a run is called wherever a person sees or picks it, from its arguments after `playwright test`: its first
 * filter, a test file with the line it names (`checkout.spec.ts:12`), and how many more, else the title it greps, else
 * every test; then how many times each test repeats (`checkout.spec.ts:12 ×3`). A file reads as its spec's own name,
 * without the classes `specPattern` writes (`[[]id].spec.ts` is `[id].spec.ts`) nor the percent-encoded alternatives
 * of a dashboard's copied command (`caf(?:é|.C3.A9).spec.ts` is `café.spec.ts`).
 */
export function runName(args: readonly string[]): string {
  const files: string[] = [];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      // A location anchored at its start (`^/w/a.spec.ts:3`), in two spellings (`^(?:a|b)/.`, `^(?:a|b):3`) by its first.
      const file = arg
        .replace(/^\^?\(\?:((?:\[.\]|[^|])*)\|.*\)(?=\/\.$|:\d+$|$)/, '$1')
        .replace(/^\^/, '')
        .split(/[\\/]/)
        .filter((part) => part && part !== '.')
        .pop();
      if (file) files.push(file.replace(URL_ENCODED_ALTERNATIVE, '$1').replace(/\[(.)\]/g, '$1'));
      continue;
    }
    const eq = arg.indexOf('=');
    const option = eq < 0 ? arg : arg.slice(0, eq);
    if (!PLAYWRIGHT_OPTIONS.get(option)) continue;
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value && !values.has(option)) values.set(option, value);
  }
  const grep = values.get('--grep') ?? values.get('-g');
  const what = files.length
    ? files.length > 1
      ? `${files[0]} and ${files.length - 1} more`
      : files[0]!
    : grep
      ? GREP_PATTERN.test(grep)
        ? 'tests by title'
        : grep
      : 'every test';
  const repeat = Number(values.get('--repeat-each'));
  return Number.isInteger(repeat) && repeat > 1 ? `${what} ×${repeat}` : what;
}

/**
 * A command whose arguments are not one `playwright test`'s named as a run, without `npx`: a chain of `playwright test`
 * whole, any other up to its first option or its next command (`npx @piwitests/reporter flake 42` is `piwi flake 42`).
 */
export function commandName(command: string): string {
  const words = command
    .split(/\s+/)
    .filter((word) => word && word !== 'npx')
    .map((word) => (word === '@piwitests/reporter' ? 'piwi' : word));
  if (words[0] === 'playwright' && words[1] === 'test') return words.join(' ');
  const end = words.findIndex((word) => word.startsWith('-') || ['&&', '||', ';', '|'].includes(word));
  return (end < 0 ? words : words.slice(0, end)).join(' ');
}
