/**
 * The command lines the editor runs in a terminal: built here from arguments checked one by one, never taken as an
 * instance's command text. An instance names what to run (the Playwright arguments of a test or a selection, the
 * verification of a fix plan), or the editor names tests by their location in a spec; an argument that is not a test
 * filter or an option of {@link PLAYWRIGHT_OPTIONS}, or that a shell would expand, refuses the whole command.
 */

/** Characters bash, zsh, PowerShell or cmd expand inside double quotes, plus control characters. */
const SHELL_EXPANDED = /[$`"\\%!\p{Cc}]/u;

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

/** `arg` as a shell word: bare when no shell changes it, else double-quoted; null when a shell would expand it. */
export function shellWord(arg: string): string | null {
  if (SHELL_PLAIN.test(arg)) return arg;
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
 * Whether `location` names a test as Playwright's location filter takes it: a spec's path relative to the Playwright
 * config's folder, with forward slashes, then the 1-based line of its `test(…)` call (`tests/checkout.spec.ts:42`).
 */
export function isTestLocation(location: unknown): location is string {
  if (typeof location !== 'string') return false;
  const match = /^([^:]+):[1-9]\d*$/.exec(location);
  const file = match?.[1];
  return !!file && !file.startsWith('/') && !file.startsWith('-') && !file.split('/').includes('..');
}

/** `npx playwright test` with `args`, or null when they are not {@link validPlaywrightArgs} or one cannot be quoted. */
export function playwrightTestCommand(args: unknown): string | null {
  if (!Array.isArray(args) || !validPlaywrightArgs(args)) return null;
  const words = args.map(shellWord);
  return words.every((w) => w !== null) ? ['npx playwright test', ...words].join(' ') : null;
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

/** The `piwi flake` command that reproduces a test, or verifies its fix. */
export function flakeCommand(testCaseId: number, kind: 'reproduce' | 'verify'): string | null {
  if (!Number.isSafeInteger(testCaseId) || testCaseId <= 0) return null;
  return kind === 'verify'
    ? `npx @piwitests/reporter flake verify ${testCaseId}`
    : `npx @piwitests/reporter flake ${testCaseId}`;
}
