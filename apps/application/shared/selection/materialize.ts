/**
 * Turn a resolved test list into arguments Playwright understands.
 *
 * This is the selection-shaped counterpart to `buildRetryCommand`: same
 * `file-line → grep → file` fallback ladder and the same Windows-safe path
 * normalization, but it emits a structured result (bare args plus a
 * copy-pasteable command) rather than only a shell string, and it works from a
 * resolved selection rather than a set of failures.
 */
import { quoteShellArg, specPattern, titleGrepPattern } from '../retry-command';
import type { MaterializedSelection, ResolvedTest, SelectionFormat } from './types';

const MAX_CMD_LENGTH = 4096;

/** Whether a token can be double-quoted safely in every shell; a file token that cannot is left out. */
function isShellSafe(arg: string): boolean {
  return quoteShellArg(arg) !== null;
}

function fileLineArgs(tests: ResolvedTest[]): string[] {
  const seen = new Set<string>();
  const args: string[] = [];
  for (const t of tests) {
    const token = t.line ? `${specPattern(t.filePath)}:${t.line}` : specPattern(t.filePath);
    if (seen.has(token) || !isShellSafe(token)) continue;
    seen.add(token);
    args.push(token);
  }
  return args;
}

function fileArgs(tests: ResolvedTest[]): string[] {
  const seen = new Set<string>();
  const args: string[] = [];
  for (const t of tests) {
    const posix = specPattern(t.filePath);
    if (seen.has(posix) || !isShellSafe(posix)) continue;
    seen.add(posix);
    args.push(posix);
  }
  return args;
}

function grepArgs(tests: ResolvedTest[]): string[] {
  const escaped = [...new Set(tests.map((t) => titleGrepPattern(t.title)))];
  const pattern = escaped.length === 1 ? escaped[0]! : `(${escaped.join('|')})`;
  return ['--grep', pattern];
}

type CommandFormat = Exclude<SelectionFormat, 'json'>;

function buildArgs(tests: ResolvedTest[], format: CommandFormat): { format: CommandFormat; args: string[] } {
  if (format === 'grep') return { format, args: grepArgs(tests) };
  const args = format === 'files' ? fileArgs(tests) : fileLineArgs(tests);
  // Every file left out as unsafe: select by title rather than run the whole suite.
  return args.length > 0 ? { format, args } : { format: 'grep', args: grepArgs(tests) };
}

/** Every token is shell-safe by construction: file tokens are filtered, grep patterns are built safe. */
function render(base: string, args: string[]): string {
  return `${base} ${args.map((arg) => `"${arg}"`).join(' ')}`;
}

/**
 * Materialize a resolved test list to the requested format. Falls the format
 * down the `grep → args → files` ladder when the rendered command would exceed
 * a safe length, and reports the format it actually produced.
 */
export function materializeSelection(
  tests: ResolvedTest[],
  format: SelectionFormat = 'args',
  opts?: { pkgRunner?: string },
): MaterializedSelection {
  if (format === 'json' || tests.length === 0) {
    return { format, args: [], command: '' };
  }

  const base = `${opts?.pkgRunner ?? 'npx'} playwright test`;

  let current: CommandFormat = format;
  let built = buildArgs(tests, current);
  let command = render(base, built.args);

  while (command.length > MAX_CMD_LENGTH && current !== 'files') {
    current = current === 'grep' ? 'args' : 'files';
    built = buildArgs(tests, current);
    command = render(base, built.args);
  }

  if (command.length > MAX_CMD_LENGTH) {
    command = command.slice(0, MAX_CMD_LENGTH - 3) + '...';
  }

  return { format: built.format, args: built.args, command };
}
