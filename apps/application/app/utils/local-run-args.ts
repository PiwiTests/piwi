/**
 * Pure builders for running `playwright test` locally from the desktop shell.
 *
 * Unlike `buildRetryCommand` (a copy-pastable shell string), the shell executes
 * the run itself with no shell in between, so each step is a plain argv array —
 * no escaping, no `&&`. Cases are grouped by Playwright project exactly like
 * the copyable command: a `--project` filter and a `file:line` filter must pair
 * up, so mixed-project retries become sequential steps.
 */
import {
  escapeGrep,
  isSpecFilter,
  specPattern,
  type RetryCase,
  type RetryMode,
  type RetryRunMode,
  type RetryRunOptions,
} from './retry-command';

/** How the browser runs. `debug` opens the inspector, `ui` opens UI mode. */
export type LocalRunMode = RetryRunMode;

export interface LocalRunOptions {
  mode?: RetryMode;
  runMode?: LocalRunMode;
  /** Force trace recording (`--trace=on`). */
  trace?: boolean;
  /** Run every matched test N times — flake reproduction. Clamped to 1–1000. */
  repeatEach?: number;
  /** A repeated run ends at its first failing repetition (`--max-failures=1`), so a person can attend it. */
  stopAtFirstFailure?: boolean;
  /** The run holds each failing test at its line from its start (**Hold failures**), when a person can attend it. */
  holdFailures?: boolean;
}

export interface LocalRunStep {
  /** Arguments to `playwright test`, one argv entry each. */
  args: string[];
  /** Human-readable preview of the step. */
  display: string;
  /** The preview cut to fit a menu or a tooltip: at most three test filters, then how many more it holds. */
  summary?: string;
}

const RUN_MODE_FLAGS: Record<LocalRunMode, string[]> = {
  normal: [],
  headed: ['--headed'],
  debug: ['--debug'],
  ui: ['--ui'],
};

function groupByProject(cases: RetryCase[]): Map<string, RetryCase[]> {
  const groups = new Map<string, RetryCase[]>();
  for (const c of cases) {
    const key = c.projectName || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return groups;
}

/** How many test filters a short command shows before it counts the rest. */
const SUMMARY_FILTERS = 3;

function elided(items: string[]): string[] {
  if (items.length <= SUMMARY_FILTERS + 1) return items;
  return [...items.slice(0, SUMMARY_FILTERS), `… ${items.length - SUMMARY_FILTERS} more`];
}

/**
 * The test filters of a step, and the same filters as its short preview shows them. A spec path Playwright would not
 * take as the filter it names (`isSpecFilter`) is left out, and so is a blank title.
 */
function specArgs(cases: RetryCase[], mode: RetryMode): { args: string[]; summary: string[] } {
  if (mode === 'grep') {
    const escaped = cases.filter((c) => c.title.trim()).map((c) => escapeGrep(c.title));
    if (escaped.length === 0) return { args: [], summary: [] };
    // One argument, so a title that starts with `-` is never read as an option.
    const grep = (titles: string[]) => `--grep=${titles.length === 1 ? titles[0]! : `(${titles.join('|')})`}`;
    return { args: [grep(escaped)], summary: [displayArg(grep(elided(escaped)))] };
  }
  const seen = new Set<string>();
  const specs: string[] = [];
  for (const c of cases) {
    const file = specPattern(c.filePath);
    if (!isSpecFilter(file)) continue;
    const spec = mode === 'file-line' && c.line ? `${file}:${c.line}` : file;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return { args: specs, summary: elided(specs.map(displayArg)) };
}

/** Quote an argument for display only — execution never goes through a shell. An option's value is quoted alone. */
function displayArg(arg: string): string {
  const option = /^--[\w-]+=/.exec(arg)?.[0] ?? '';
  const value = arg.slice(option.length);
  return option + (/[\s"'()|]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
}

/**
 * A single argv for reproducing or bisecting the failing test(s) in one worktree
 * run: the deduped `file:line` specs plus one `--project=` per distinct project.
 * Unlike `buildLocalRunPlan` this never splits into per-project steps — a bisect
 * runs one command at each commit, and running the union of the failing tests is
 * exactly the probe a bisect needs. Empty when no case has a spec path Playwright can take; a case without one is
 * left out with its project.
 */
export function buildReproduceArgs(allCases: RetryCase[]): string[] {
  const cases = allCases.filter((c) => isSpecFilter(specPattern(c.filePath)));
  const args = specArgs(cases, 'file-line').args;
  if (args.length === 0) return [];
  const projects = [...new Set(cases.map((c) => c.projectName || '').filter(Boolean))];
  for (const project of projects) args.push(`--project=${project}`);
  return args;
}

/**
 * The argv a bisect runs at each commit: the failing tests' files, their titles
 * as one `--grep=` pattern, and one `--project=` per project, so a test whose
 * line moved between commits still matches. A path that starts with `-` would
 * be read as an option and is left out. Empty when the cases name neither a
 * file nor a title: each step would run every test.
 */
export function buildBisectArgs(cases: RetryCase[]): string[] {
  const files = [...new Set(cases.map((c) => specPattern(c.filePath)))].filter(isSpecFilter);
  const titles = [...new Set(cases.map((c) => c.title).filter((title) => title.trim()))].map(escapeGrep);
  if (files.length === 0 && titles.length === 0) return [];
  const args = [...files];
  if (titles.length > 0) args.push(`--grep=${titles.length === 1 ? titles[0]! : `(${titles.join('|')})`}`);
  for (const project of new Set(cases.map((c) => c.projectName || '').filter(Boolean))) {
    args.push(`--project=${project}`);
  }
  return args;
}

/** Whether a bisect has a test to run at each step: a Flake Lab arm, or a file or title of the cases. */
export function canBisect(cases: RetryCase[], flakeTestCaseId?: number | null): boolean {
  return flakeTestCaseId != null || buildBisectArgs(cases).length > 0;
}

/** The options of a local run as a copied command carries them, so the copy runs what Run locally runs. */
export function localRunCopyOptions(options: LocalRunOptions): RetryRunOptions {
  return {
    runMode: options.runMode ?? 'normal',
    trace: options.trace ? 'on' : null,
    repeatEach: Math.min(1000, Math.max(1, Math.floor(options.repeatEach ?? 1))),
    maxFailures: stopsAtFirstFailure(options) ? 1 : null,
  };
}

/**
 * Why a run with these options holds no failure whatever **Hold failures** says, as the shell names it one nobody
 * attends (UI mode, or a repeat that does not stop at its first failure); null for one that can.
 */
export function localRunHoldRefusal(options: LocalRunOptions): string | null {
  if (options.runMode === 'ui') return 'UI mode goes on past each failure.';
  if (Math.floor(options.repeatEach ?? 1) > 1 && !stopsAtFirstFailure(options)) {
    return 'A repeated run goes on past each failure, unless it stops at the first one.';
  }
  return null;
}

/** Whether a run with these options holds its failures from its start: Hold failures on, for a run that can. */
export function localRunHoldsFailures(options: LocalRunOptions): boolean {
  return !!options.holdFailures && !localRunHoldRefusal(options);
}

/** Whether a run with these options repeats its tests and ends at the first failing repetition. */
export function stopsAtFirstFailure(options: LocalRunOptions): boolean {
  return !!options.stopAtFirstFailure && Math.floor(options.repeatEach ?? 1) > 1;
}

export function buildLocalRunPlan(cases: RetryCase[], options: LocalRunOptions = {}): LocalRunStep[] {
  if (cases.length === 0) return [];
  const mode = options.mode ?? 'file-line';
  const runMode = options.runMode ?? 'normal';
  const repeatEach = Math.min(1000, Math.max(1, Math.floor(options.repeatEach ?? 1)));

  const steps: LocalRunStep[] = [];
  for (const [project, projectCases] of groupByProject(cases)) {
    const specs = specArgs(projectCases, mode);
    // A step left with no filter would run every test of its project.
    if (specs.args.length === 0) continue;
    const flags: string[] = [];
    if (project) flags.push(`--project=${project}`);
    flags.push(...RUN_MODE_FLAGS[runMode]);
    if (options.trace) flags.push('--trace=on');
    // Each repetition reports its own result, as the editors' repeat does.
    if (repeatEach > 1) flags.push(`--repeat-each=${repeatEach}`, '--retries=0');
    if (stopsAtFirstFailure(options)) flags.push('--max-failures=1');
    const args = [...specs.args, ...flags];
    steps.push({
      args,
      display: ['playwright', 'test', ...args.map(displayArg)].join(' '),
      summary: ['playwright', 'test', ...specs.summary, ...flags.map(displayArg)].join(' '),
    });
  }
  return steps;
}
