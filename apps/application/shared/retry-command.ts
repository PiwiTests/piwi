import { specPattern } from '@piwitests/core/spec-filter';

export { specPattern };

export type RetryMode = 'file-line' | 'grep' | 'file';

export interface RetryCase {
  filePath: string;
  title: string;
  line?: number | null;
  projectName?: string | null;
}

/** How the browser runs: `headed` shows it, `debug` opens the inspector, `ui` opens UI mode. */
export type RetryRunMode = 'normal' | 'headed' | 'debug' | 'ui';

/** What `--trace` records: every test, or only the tests that fail. */
export type RetryTraceMode = 'on' | 'retain-on-failure';

/** The Playwright options a retry command can carry, beyond what it runs. */
export interface RetryRunOptions {
  runMode?: RetryRunMode;
  trace?: RetryTraceMode | null;
  /** Run every matched test N times; 1 adds nothing. */
  repeatEach?: number | null;
  /** The number of workers; unset keeps the config's. */
  workers?: number | null;
  /** One Playwright project for every test, instead of each test's own. */
  project?: string | null;
}

/** The values the dashboard offers for a run's options: the bounds of a run request. */
export const RETRY_OPTION_LIMITS = {
  repeatEach: { min: 1, max: 10 },
  workers: { min: 1, max: 4 },
} as const;

/** The largest count a copied command carries, whatever offered it. */
const MAX_OPTION_COUNT = 1000;

const RUN_MODE_FLAGS: Record<RetryRunMode, string> = {
  normal: '',
  headed: ' --headed',
  debug: ' --debug',
  ui: ' --ui',
};

const MAX_CMD_LENGTH = 4096;

export function escapeGrep(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Characters bash, zsh, PowerShell or cmd expand inside double quotes, the curly double quotes PowerShell reads as `"`
// (`“`, `”`, `„`), and control characters: the set `packages/editor/src/commands.ts` refuses too.
const SHELL_EXPANDED = /[$`"\\%!\u201C\u201D\u201E\p{Cc}]/u;

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

/** The quoted spec paths of `values`: one that starts with `-` would be read as an option, so it is left out too. */
function quoteSpecs(values: string[]): string[] {
  return quoteAll(values.filter((value) => !value.startsWith('-')));
}

/** ` --project="<name>"`, or nothing when the name cannot be quoted safely (the tests then run in every project). */
function projectFlag(project: string): string {
  const quoted = quoteShellArg(project);
  return quoted ? ` --project=${quoted}` : '';
}

/**
 * One ` --project="<name>"` per project, or nothing when one of them cannot be
 * quoted safely: the tests then run in every project rather than miss that one.
 */
function projectFlags(projects: string[]): string {
  return projects.every((project) => quoteShellArg(project)) ? projects.map(projectFlag).join('') : '';
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

/** A whole count from 1 to {@link MAX_OPTION_COUNT}, or null for anything else. */
function optionCount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_OPTION_COUNT ? value : null;
}

/**
 * The flags of `options`, in a fixed order: the run mode, `--trace`,
 * `--repeat-each` and `--workers`. A value that is not a whole count in bounds
 * is left out, as is a repeat count of 1. A repeat adds `--retries=0`, as the
 * editor's repeat does, so each repetition reports its own result.
 */
export function retryOptionFlags(options?: RetryRunOptions | null): string {
  if (!options) return '';
  let flags = RUN_MODE_FLAGS[options.runMode ?? 'normal'] ?? '';
  if (options.trace === 'on' || options.trace === 'retain-on-failure') flags += ` --trace=${options.trace}`;
  const repeatEach = optionCount(options.repeatEach);
  if (repeatEach && repeatEach > 1) flags += ` --repeat-each=${repeatEach} --retries=0`;
  const workers = optionCount(options.workers);
  if (workers) flags += ` --workers=${workers}`;
  return flags;
}

/**
 * The cases under the one project the options name, when it can be quoted
 * safely; otherwise each case keeps its own project.
 */
function withProject(cases: RetryCase[], project: string | null | undefined): RetryCase[] {
  if (!project || !quoteShellArg(project)) return cases;
  return cases.map((c) => ({ ...c, projectName: project }));
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

export function buildRetryCommand(
  allCases: RetryCase[],
  opts?: { mode?: RetryMode; pkgRunner?: string; options?: RetryRunOptions | null },
): string {
  const mode = opts?.mode ?? 'file-line';
  const pkgRunner = opts?.pkgRunner ?? 'npx';
  const baseCmd = `${pkgRunner} playwright test`;
  const flags = retryOptionFlags(opts?.options);

  if (allCases.length === 0) return '';

  const cases = withProject(allCases, opts?.options?.project);
  const groups = groupByProject(cases);
  const commands: string[] = [];

  for (const [project, projectCases] of groups) {
    let cmd: string;

    if (mode === 'file') {
      const args = quoteSpecs(dedupeFiles(projectCases).map(specPattern));
      if (args.length === 0) continue;
      cmd = `${baseCmd} ${args.join(' ')}`;
    } else if (mode === 'file-line') {
      const seen = new Set<string>();
      const args = quoteSpecs(
        projectCases
          .filter((c) => {
            const key = c.filePath + ':' + c.line;
            if (c.line && seen.has(key)) return false;
            if (c.line) seen.add(key);
            return true;
          })
          .map((c) => (c.line ? `${specPattern(c.filePath)}:${c.line}` : specPattern(c.filePath))),
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

    commands.push(cmd + flags);
  }

  let result = commands.join(' && ');

  if (result.length > MAX_CMD_LENGTH) {
    if (mode === 'grep') {
      return buildRetryCommand(cases, { ...opts, mode: 'file-line' });
    }
    if (mode === 'file-line') {
      return buildRetryCommand(cases, { ...opts, mode: 'file' });
    }
    const args = quoteSpecs(dedupeFilePaths(cases).map(specPattern));
    if (args.length === 0) return '';
    const project = opts?.options?.project;
    const tail = (project && quoteShellArg(project) ? projectFlag(project) : '') + flags;
    // Whole quoted specs only, as many as fit before the tail.
    let cmd = baseCmd;
    for (const arg of args) {
      if (cmd.length + 1 + arg.length + tail.length > MAX_CMD_LENGTH) break;
      cmd += ` ${arg}`;
    }
    return cmd === baseCmd ? '' : cmd + tail;
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
    ...new Set(cases.map((c) => (c.line ? `${specPattern(c.filePath)}:${c.line}` : specPattern(c.filePath)))),
  ];
  const quoted = quoteSpecs(specs);
  if (quoted.length === 0) return '';
  return quoted.join(' ') + projectFlags(caseProjects(cases));
}

/**
 * The one `npx playwright test` command that runs these cases wherever their
 * lines moved: their files, their titles (`-g`) and the projects they ran in.
 * It is the same on every shell and a single command, so it can be copied,
 * handed to `git bisect run` across commits, or shown as the command that
 * verifies a fix. Past {@link MAX_CMD_LENGTH} it drops the titles and runs the
 * files whole. Without cases it runs the whole suite.
 */
export function buildRerunCommand(cases: RetryCase[]): string {
  const base = 'npx playwright test';
  if (cases.length === 0) return base;
  const files = quoteSpecs([...new Set(cases.map((c) => specPattern(c.filePath)))]);
  const projects = projectFlags(caseProjects(cases));
  const head = [base, ...files].join(' ');
  const withTitles = `${head}${buildTitleGrepFlag([...new Set(cases.map((c) => c.title))])}${projects}`;
  return withTitles.length <= MAX_CMD_LENGTH ? withTitles : `${head}${projects}`;
}

/**
 * The Playwright projects a retry command can run these cases in, in their order: the projects they ran in whose
 * names every shell leaves as they are.
 */
export function retryProjects(cases: RetryCase[]): string[] {
  return caseProjects(cases).filter((project) => quoteShellArg(project) !== null);
}

/** The distinct Playwright projects of these cases, in their order. */
function caseProjects(cases: RetryCase[]): string[] {
  return [...new Set(cases.map((c) => c.projectName || '').filter(Boolean))];
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
