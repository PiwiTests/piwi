export type RetryMode = 'file-line' | 'grep' | 'file';

export interface RetryCase {
  filePath: string;
  title: string;
  line?: number | null;
  projectName?: string | null;
}

const MAX_CMD_LENGTH = 4096;

export function escapeGrep(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Characters bash, zsh, PowerShell or cmd expand inside double quotes, plus control characters.
const SHELL_EXPANDED = /[$`"\\%!\p{Cc}]/u;

/**
 * `arg` double-quoted for a copy-pasteable command, or null when it holds a
 * character one of bash, zsh, PowerShell or cmd expands inside double quotes.
 * No single escaping is safe in all of them, so such an argument is left out.
 */
export function quoteShellArg(arg: string): string | null {
  return SHELL_EXPANDED.test(arg) ? null : `"${arg}"`;
}

/**
 * A title as a Playwright grep pattern that is safe to double-quote in any
 * shell: regex metacharacters are escaped, and each character a shell would
 * expand matches as `.`.
 */
export function titleGrepPattern(title: string): string {
  let pattern = '';
  for (const ch of title) pattern += SHELL_EXPANDED.test(ch) ? '.' : escapeGrep(ch);
  return pattern;
}

/** The quoted arguments of `values` that every shell leaves as they are; the others are left out. */
function quoteAll(values: string[]): string[] {
  return values.map(quoteShellArg).filter((arg): arg is string => arg !== null);
}

/** ` --project="<name>"`, or nothing when the name cannot be quoted safely (the tests then run in every project). */
function projectFlag(project: string): string {
  const quoted = quoteShellArg(project);
  return quoted ? ` --project=${quoted}` : '';
}

/**
 * The ` -g "<title|title>"` flag that narrows a `playwright test` run to these
 * titles, or an empty string without titles. See {@link titleGrepPattern}.
 */
export function buildTitleGrepFlag(titles: string[]): string {
  if (titles.length === 0) return '';
  return ` -g "${titles.map(titleGrepPattern).join('|')}"`;
}

// Playwright's CLI file filter is matched as a regex against forward-slash paths,
// so a Windows-captured backslash path (e.g. "tests\foo.spec.ts:10") never matches.
// Normalize to POSIX separators, which Playwright accepts on every platform.
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function groupByProject(cases: RetryCase[]): Map<string, RetryCase[]> {
  const groups = new Map<string, RetryCase[]>();
  for (const c of cases) {
    const key = c.projectName || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return groups;
}

function dedupeFiles(cases: RetryCase[]): string[] {
  const seen = new Set<string>();
  return cases
    .filter((c) => {
      const key = c.filePath;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => c.filePath);
}

export function buildRetryCommand(cases: RetryCase[], opts?: { mode?: RetryMode; pkgRunner?: string }): string {
  const mode = opts?.mode ?? 'file-line';
  const pkgRunner = opts?.pkgRunner ?? 'npx';
  const baseCmd = `${pkgRunner} playwright test`;

  if (cases.length === 0) return '';

  const groups = groupByProject(cases);
  const commands: string[] = [];

  for (const [project, projectCases] of groups) {
    let cmd: string;

    if (mode === 'file') {
      const args = quoteAll(dedupeFiles(projectCases).map(toPosixPath));
      if (args.length === 0) continue;
      cmd = `${baseCmd} ${args.join(' ')}`;
    } else if (mode === 'file-line') {
      const seen = new Set<string>();
      const args = quoteAll(
        projectCases
          .filter((c) => {
            const key = c.filePath + ':' + c.line;
            if (c.line && seen.has(key)) return false;
            if (c.line) seen.add(key);
            return true;
          })
          .map((c) => (c.line ? `${toPosixPath(c.filePath)}:${c.line}` : toPosixPath(c.filePath))),
      );
      if (args.length === 0) continue;
      cmd = `${baseCmd} ${args.join(' ')}`;
    } else {
      const patterns = projectCases.map((c) => titleGrepPattern(c.title));
      const grepArg = patterns.length === 1 ? patterns[0]! : `(${patterns.join('|')})`;
      cmd = `${baseCmd} --grep "${grepArg}"`;
    }

    if (project) {
      cmd += projectFlag(project);
    }

    commands.push(cmd);
  }

  let result = commands.join(' && ');

  if (result.length > MAX_CMD_LENGTH) {
    if (mode === 'grep') {
      return buildRetryCommand(cases, { ...opts, mode: 'file-line' });
    }
    if (mode === 'file-line') {
      return buildRetryCommand(cases, { ...opts, mode: 'file' });
    }
    const args = quoteAll(dedupeFilePaths(cases).map(toPosixPath));
    if (args.length === 0) return '';
    let cmd = `${baseCmd} ${args.join(' ')}`;
    if (cmd.length > MAX_CMD_LENGTH) {
      cmd = cmd.slice(0, MAX_CMD_LENGTH - 3) + '...';
    }
    return cmd;
  }

  return result;
}

/**
 * The Playwright *arguments* for re-running these cases — the file:line specs
 * (deduped, POSIX-normalized, quoted) plus one `--project=` per Playwright
 * project they ran in. Unlike {@link buildRetryCommand} it omits the
 * `playwright test` prefix, so it can be handed to CI as the value of a
 * workflow input / pipeline variable that a job appends to its own command.
 * Always `file-line` shaped; a case without a line contributes its file path.
 * Cases from several projects run each spec in each of those projects.
 */
export function buildRetryArgs(cases: RetryCase[]): string {
  if (cases.length === 0) return '';
  const specs = [
    ...new Set(cases.map((c) => (c.line ? `${toPosixPath(c.filePath)}:${c.line}` : toPosixPath(c.filePath)))),
  ];
  const quoted = quoteAll(specs);
  if (quoted.length === 0) return '';

  const projects = [...new Set(cases.map((c) => c.projectName || '').filter(Boolean))];
  return quoted.join(' ') + projects.map(projectFlag).join('');
}

/**
 * The one `npx playwright test` command that runs these cases as a CI re-run
 * does ({@link buildRetryArgs}): a single command whatever their projects, so
 * it can be copied on any shell, handed to `git bisect run` or shown as the
 * command that verifies a fix. Without cases it runs the whole suite.
 */
export function buildRerunCommand(cases: RetryCase[]): string {
  const args = buildRetryArgs(cases);
  return args ? `npx playwright test ${args}` : 'npx playwright test';
}

function dedupeFilePaths(cases: RetryCase[]): string[] {
  const seen = new Set<string>();
  return cases.reduce<string[]>((acc, c) => {
    if (!seen.has(c.filePath)) {
      seen.add(c.filePath);
      acc.push(c.filePath);
    }
    return acc;
  }, []);
}
