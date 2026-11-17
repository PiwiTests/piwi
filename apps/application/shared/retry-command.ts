import { specPattern } from '@piwitests/core/spec-filter';
import { RUN_REQUEST_LIMITS } from '@piwitests/core/run-request';

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
  /** End the run after this many failures; unset runs every test. */
  maxFailures?: number | null;
  /** One Playwright project for every test, instead of each test's own. */
  project?: string | null;
}

/** The values the dashboard offers for a run's options: the bounds of a run request. */
export const RETRY_OPTION_LIMITS = {
  repeatEach: RUN_REQUEST_LIMITS.repeatEach,
  workers: RUN_REQUEST_LIMITS.workers,
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

/**
 * Whether Playwright takes `spec` as the test filter it names: one that starts with `-` would be read as an option,
 * and one whose path, or whose `/pattern/flags` form, holds nothing but `.` and `/` (empty included) matches every
 * file, or, with a `:<line>[:<column>]`, that line of every file.
 */
export function isSpecFilter(spec: string): boolean {
  if (spec.startsWith('-') || spec.startsWith(':')) return false;
  const file = spec.replace(/(?::\d+){1,2}$/, '');
  const pattern = /^\/(.*)\/[gi]*$/.exec(file)?.[1] ?? file;
  return !/^[./]*$/.test(file) && !/^[./]*$/.test(pattern);
}

/**
 * Whether a title still names its tests in a copied command: it holds a character that is neither blank nor one
 * {@link titleGrepPattern} turns into `.`. A title made only of those would match every test.
 */
export function isTitleFilter(title: string): boolean {
  return [...title].some((ch) => ch.trim() !== '' && !SHELL_EXPANDED.test(ch));
}

/**
 * A spec filter (`specPattern`'s path relative to the config's folder, with its `:line`) after a `/`, as a copied
 * command names it. Playwright matches a file filter anywhere in a spec's whole path, so the `/` keeps the match at a
 * folder's start: `tests/a.spec.ts` alone would also take `xtests/a.spec.ts`. A spec of a folder whose path ends as
 * its own (`e2e/tests/a.spec.ts`) still matches, since the dashboard does not know the checkout's folder. A path that
 * already starts at a root is left as it is.
 */
function atFolderStart(spec: string): string {
  return spec.startsWith('/') || /^[A-Za-z]:\//.test(spec) ? spec : `/${spec}`;
}

/** The ASCII characters Node's `pathToFileURL` may percent-encode in a Windows path. */
const URL_ENCODED = new Set(' "#%<>?[]^`{|}~');

/**
 * `ch` as a regular expression of its percent-encoding in a `file:` URL (`.C3.A9` for `é`), or null for a character
 * the URL keeps as it is. Each `%` stands as `.`, which every shell leaves as it is.
 */
function urlEncodedPattern(ch: string): string | null {
  if (ch.charCodeAt(0) < 0x80 && !URL_ENCODED.has(ch)) return null;
  return [...new TextEncoder().encode(ch)]
    .map((byte) => `.${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/**
 * A spec's path as a copied command names it: {@link specPattern}'s pattern after a `/` (see {@link atFolderStart}),
 * in which a character the spec's `file:` URL may percent-encode (a space, `#`, `%`, `[`, `~`, a non-ASCII character)
 * also matches its encoding: `my(?: |.20)tests/a.spec.ts`. On Windows, Playwright up to 1.62 tests a filter against
 * the native path, whose separator is `\`, and against the `file:` URL, never against the `/`-separated path.
 */
export function commandSpec(filePath: string): string {
  let pattern = '';
  for (const ch of toPosixPath(filePath)) {
    const encoded = urlEncodedPattern(ch);
    pattern += encoded ? `(?:${specPattern(ch)}|${encoded})` : specPattern(ch);
  }
  return atFolderStart(pattern);
}

/** A spec and the line a filter names in it, if any. */
interface SpecLine {
  filePath: string;
  line?: number | null;
}

/**
 * The quoted filters of `specs` that Playwright takes as test filters (see {@link isSpecFilter}), each written by
 * {@link commandSpec} then its `:line`, and each that every shell leaves as it is.
 */
function quoteSpecs(specs: SpecLine[]): string[] {
  return quoteAll(
    specs
      .filter((s) => isSpecFilter(specPattern(s.filePath)))
      .map((s) => (s.line ? `${commandSpec(s.filePath)}:${s.line}` : commandSpec(s.filePath))),
  );
}

/**
 * Whether a retry command in `mode` names this case: by title, when its title can name it in a shell
 * ({@link isTitleFilter}); by file, when its spec path is a filter Playwright takes and every shell leaves as it is.
 */
export function retryCommandNames(c: RetryCase, mode: RetryMode = 'file-line'): boolean {
  return mode === 'grep' ? isTitleFilter(c.title) : quoteSpecs([{ filePath: c.filePath }]).length > 0;
}

/** What a copy of a retry command says when no case has a file path or title a command can name. */
export const NO_RETRY_COMMAND = 'No test here has a file path or title a command can name.';

/** What a re-run dispatch answers when no case has a file path its arguments can name. */
export const NO_RETRY_ARGS = 'None of these tests has a file path a re-run can name.';

/**
 * A re-run's availability once its cases are known: unavailable, with {@link NO_RETRY_ARGS}, when it would be
 * available but no case has a file path its arguments can name, so the button never offers a dispatch the POST refuses.
 */
export function withRetryCases<T extends { available: boolean; reason: string | null }>(
  availability: T,
  cases: RetryCase[],
): T {
  if (!availability.available || buildRetryArgs(cases)) return availability;
  return { ...availability, available: false, reason: NO_RETRY_ARGS };
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
 * titles, or an empty string without titles. A title that would match every
 * test is left out (see {@link isTitleFilter}). See {@link titleGrepPattern}.
 */
export function buildTitleGrepFlag(titles: string[]): string {
  const named = titles.filter(isTitleFilter);
  if (named.length === 0) return '';
  return ` -g "${named.map(titleGrepPattern).join('|')}"`;
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
 * `--repeat-each`, `--workers` and `--max-failures`. A value that is not a whole count in bounds
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
  const maxFailures = optionCount(options.maxFailures);
  if (maxFailures) flags += ` --max-failures=${maxFailures}`;
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
      const args = quoteSpecs(dedupeFiles(projectCases).map((filePath) => ({ filePath })));
      if (args.length === 0) continue;
      cmd = `${baseCmd} ${args.join(' ')}`;
    } else if (mode === 'file-line') {
      const seen = new Set<string>();
      const args = quoteSpecs(
        projectCases.filter((c) => {
          const key = c.filePath + ':' + c.line;
          if (c.line && seen.has(key)) return false;
          if (c.line) seen.add(key);
          return true;
        }),
      );
      if (args.length === 0) continue;
      cmd = `${baseCmd} ${args.join(' ')}`;
    } else {
      const patterns = projectCases.filter((c) => isTitleFilter(c.title)).map((c) => titleGrepPattern(c.title));
      if (patterns.length === 0) continue;
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
    const args = quoteSpecs(dedupeFilePaths(cases).map((filePath) => ({ filePath })));
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
 * Cases from several projects run each spec in each of those projects. A case
 * with no file path Playwright takes (see {@link isSpecFilter}) is left out,
 * with its project.
 */
export function buildRetryArgs(allCases: RetryCase[]): string {
  const cases = allCases.filter((c) => isSpecFilter(specPattern(c.filePath)));
  if (cases.length === 0) return '';
  const quoted = [...new Set(quoteSpecs(cases))];
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
 *
 * A test runs only when it matches both a file and the title pattern, so each
 * filter is kept only when every case passes it on: the titles are dropped when
 * one of them cannot name its test (see {@link isTitleFilter}), and the files
 * when one cannot (see {@link isSpecFilter}) and the titles name them all. When
 * neither names every case, the files it can name run whole; when it names no
 * case at all, or only by titles too long to pass on, it is empty, since it would
 * run every test. {@link buildRerunPlan} also names the cases it leaves out.
 */
export function buildRerunCommand(cases: RetryCase[]): string {
  return buildRerunPlan(cases).command;
}

/** The command of {@link buildRerunCommand} and the cases it leaves out, every case when it is empty. */
export function buildRerunPlan(cases: RetryCase[]): { command: string; leftOut: RetryCase[] } {
  const base = 'npx playwright test';
  if (cases.length === 0) return { command: base, leftOut: [] };
  const byFile = cases.filter((c) => retryCommandNames(c));
  const allByFile = byFile.length === cases.length;
  const allByTitle = cases.every((c) => isTitleFilter(c.title));
  const named = allByFile || allByTitle ? cases : byFile;
  const leftOut = cases.filter((c) => !named.includes(c));
  const files =
    allByFile || !allByTitle
      ? quoteSpecs([...new Set(byFile.map((c) => c.filePath))].map((filePath) => ({ filePath })))
      : [];
  const grep = allByTitle ? buildTitleGrepFlag([...new Set(cases.map((c) => c.title))]) : '';
  if (files.length === 0 && !grep) return { command: '', leftOut: cases };
  const projects = projectFlags(caseProjects(named));
  const head = [base, ...files].join(' ');
  const withTitles = `${head}${grep}${projects}`;
  if (withTitles.length <= MAX_CMD_LENGTH) return { command: withTitles, leftOut };
  return files.length > 0 ? { command: `${head}${projects}`, leftOut } : { command: '', leftOut: cases };
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
