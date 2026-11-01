/**
 * Pure builders for running `playwright test` locally from the desktop shell.
 *
 * Unlike `buildRetryCommand` (a copy-pastable shell string), the shell executes
 * the run itself with no shell in between, so each step is a plain argv array —
 * no escaping, no `&&`. Cases are grouped by Playwright project exactly like
 * the copyable command: a `--project` filter and a `file:line` filter must pair
 * up, so mixed-project retries become sequential steps.
 */
import { escapeGrep, specPattern, type RetryCase, type RetryMode } from './retry-command';

/** How the browser runs. `debug` opens the inspector, `ui` opens UI mode. */
export type LocalRunMode = 'normal' | 'headed' | 'debug' | 'ui';

export interface LocalRunOptions {
  mode?: RetryMode;
  runMode?: LocalRunMode;
  /** Force trace recording (`--trace=on`). */
  trace?: boolean;
  /** Run every matched test N times — flake reproduction. Clamped to 1–1000. */
  repeatEach?: number;
}

export interface LocalRunStep {
  /** Arguments to `playwright test`, one argv entry each. */
  args: string[];
  /** Human-readable preview of the step. */
  display: string;
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

function specArgs(cases: RetryCase[], mode: RetryMode): string[] {
  if (mode === 'grep') {
    const escaped = cases.map((c) => escapeGrep(c.title));
    return ['--grep', escaped.length === 1 ? escaped[0]! : `(${escaped.join('|')})`];
  }
  const seen = new Set<string>();
  const specs: string[] = [];
  for (const c of cases) {
    const spec = mode === 'file-line' && c.line ? `${specPattern(c.filePath)}:${c.line}` : specPattern(c.filePath);
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }
  return specs;
}

/** Quote an argument for display only — execution never goes through a shell. */
function displayArg(arg: string): string {
  return /[\s"'()|]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * A single argv for reproducing or bisecting the failing test(s) in one worktree
 * run: the deduped `file:line` specs plus one `--project=` per distinct project.
 * Unlike `buildLocalRunPlan` this never splits into per-project steps — a bisect
 * runs one command at each commit, and running the union of the failing tests is
 * exactly the probe a bisect needs.
 */
export function buildReproduceArgs(cases: RetryCase[]): string[] {
  const args = specArgs(cases, 'file-line');
  const projects = [...new Set(cases.map((c) => c.projectName || '').filter(Boolean))];
  for (const project of projects) args.push(`--project=${project}`);
  return args;
}

/**
 * The argv a bisect runs at each commit: the failing tests' files, their titles
 * as one `--grep=` pattern, and one `--project=` per project, so a test whose
 * line moved between commits still matches. A path that starts with `-` would
 * be read as an option and is left out.
 */
export function buildBisectArgs(cases: RetryCase[]): string[] {
  const files = [...new Set(cases.map((c) => specPattern(c.filePath)))].filter((f) => f && !f.startsWith('-'));
  const titles = [...new Set(cases.map((c) => c.title).filter(Boolean))].map(escapeGrep);
  const args = [...files];
  if (titles.length > 0) args.push(`--grep=${titles.length === 1 ? titles[0]! : `(${titles.join('|')})`}`);
  for (const project of new Set(cases.map((c) => c.projectName || '').filter(Boolean))) {
    args.push(`--project=${project}`);
  }
  return args;
}

export function buildLocalRunPlan(cases: RetryCase[], options: LocalRunOptions = {}): LocalRunStep[] {
  if (cases.length === 0) return [];
  const mode = options.mode ?? 'file-line';
  const runMode = options.runMode ?? 'normal';
  const repeatEach = Math.min(1000, Math.max(1, Math.floor(options.repeatEach ?? 1)));

  const steps: LocalRunStep[] = [];
  for (const [project, projectCases] of groupByProject(cases)) {
    const args = specArgs(projectCases, mode);
    if (project) args.push(`--project=${project}`);
    args.push(...RUN_MODE_FLAGS[runMode]);
    if (options.trace) args.push('--trace=on');
    if (repeatEach > 1) args.push(`--repeat-each=${repeatEach}`);
    steps.push({ args, display: ['playwright', 'test', ...args.map(displayArg)].join(' ') });
  }
  return steps;
}
