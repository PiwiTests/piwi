/**
 * What a target checks before it asks the person about a run request, and the command it runs after **Run**: built
 * here from the request's tests and options, never taken from the instance (`@piwitests/core/run-request`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { specFileArgument, specFilePattern, type RunRequest } from '@piwitests/core/run-request';
import {
  runVariableAssignments,
  withRunVariables,
  type RunVariable,
  type RunVariablesParse,
} from '@piwitests/core/run-variables';
import { currentBranch, hasUncommittedChanges, headCommit, playwrightConfigFile, repositoryRoot } from './workspace';

/**
 * What a check says, as a code a window words in its own language from the check's `args`; `message` is the same
 * sentence in English (`requestCheckSentence`).
 */
export type RequestCheckCode =
  | 'folder-none'
  | 'folder-gone'
  | 'folder-linked'
  | 'variables-invalid'
  | 'variables-set'
  | 'folder-busy'
  | 'config-missing'
  | 'specs-missing'
  | 'specs-found'
  | 'playwright-missing'
  | 'playwright-installed'
  | 'commit-differs'
  | 'commit-same'
  | 'changes-uncommitted'
  | 'command-too-long';

/**
 * The values a check's sentence names, by code: the linked folder (`folder`), why the project's run variables cannot
 * be set (`problems`, the instance's English sentences) or how they are set (`variables`, as the shell writes them),
 * the missing specs named and how many
 * more (`files`, `more`), the folder's branch and short commit and the run's (`branch`, `commit`, `sourceBranch`,
 * `sourceCommit`, empty when unknown), and the longest command (`max`).
 */
export type RequestCheckArgs = Readonly<Record<string, string | number>>;

/** One row of the confirmation: a check that failed stops **Run**, a warning does not. */
export interface RequestCheck {
  id: 'folder' | 'variables' | 'busy' | 'config' | 'specs' | 'playwright' | 'command' | 'commit' | 'changes';
  level: 'ok' | 'warn' | 'fail';
  code: RequestCheckCode;
  args: RequestCheckArgs;
  message: string;
}

/** What a check of `code` says in English, with the values of `args`. */
export function requestCheckSentence(code: RequestCheckCode, args: RequestCheckArgs = {}): string {
  const value = (name: string) => String(args[name] ?? '');
  switch (code) {
    case 'folder-none':
      return 'No folder is linked to this project on this machine.';
    case 'folder-gone':
      return 'The linked folder no longer exists: choose it again.';
    case 'folder-linked':
      return `Linked folder: ${value('folder')}`;
    case 'variables-invalid':
      return `The project's run variables cannot be set: ${value('problems')}`;
    case 'variables-set':
      return `Runs with the project's run variables: ${value('variables')}.`;
    case 'folder-busy':
      return 'Another run is going in this folder: this one can run once it ends.';
    case 'config-missing':
      return 'The folder holds no Playwright config.';
    case 'specs-missing': {
      const more = Number(args.more ?? 0);
      return `Not in the folder: ${value('files')}${more > 0 ? ` and ${more} more` : ''}.`;
    }
    case 'specs-found':
      return 'The specs are in the folder.';
    case 'playwright-missing':
      return 'Playwright is not installed in the folder: run `npm install` there.';
    case 'playwright-installed':
      return 'Playwright is installed.';
    case 'commit-differs': {
      const at = (branch: string, commit: string) =>
        [branch ? `on ${branch}` : null, commit ? `at ${commit}` : null].filter(Boolean).join(' ');
      const here = at(value('branch'), value('commit')) || 'outside a git repository';
      return `Your folder is ${here}; the run you came from was ${at(value('sourceBranch'), value('sourceCommit'))}. The tests are selected by title.`;
    }
    case 'commit-same':
      return 'Your folder is on the commit the run came from.';
    case 'changes-uncommitted':
      return 'Your folder has uncommitted changes.';
    case 'command-too-long':
      return `The command for these tests is longer than ${Number(args.max).toLocaleString('en-US')} characters: ask for fewer tests.`;
  }
}

/** A check, its English sentence from its code. */
function check(
  id: RequestCheck['id'],
  level: RequestCheck['level'],
  code: RequestCheckCode,
  args: RequestCheckArgs = {},
): RequestCheck {
  return { id, level, code, args, message: requestCheckSentence(code, args) };
}

/** What the target found in the folder, and the command it would run there. */
export interface RequestPlan {
  checks: RequestCheck[];
  /** Whether **Run** may start the run: no check failed. */
  runnable: boolean;
  /** The arguments after `playwright test`, each one argv element; empty while a check fails. */
  args: string[];
  /** The command as the confirmation shows it, starting with the run variables. */
  display: string;
  /** The project's run variables the run gets, checked; empty while a check fails. */
  variables: RunVariable[];
  /** Whether the tests are selected by title, because the folder is not on the request's commit or has changes. */
  byTitle: boolean;
  branch: string | null;
  commit: string | null;
}

/** How many missing spec files a check names before it counts the rest. */
const NAMED_SPECS = 3;

/**
 * The most characters the arguments after `playwright test` may take, each counted with one separator, so the whole
 * command stays within what every platform starts. The shell refuses a launch past it too (`run_target.rs`).
 */
export const REQUESTED_RUN_ARGS_MAX_CHARS = 24_000;

/** The characters `args` take as `REQUESTED_RUN_ARGS_MAX_CHARS` counts them. */
export function argsLength(args: string[]): number {
  return args.reduce((total, arg) => total + arg.length + 1, 0);
}

/** A folder's real path, or null when it is gone. */
function realFolder(folder: string): string | null {
  try {
    return fs.realpathSync(folder);
  } catch {
    return null;
  }
}

/** A spec of the request that is an existing regular file inside `folder`, its path as Playwright loads it. */
function specInFolder(folder: string, filePath: string): string | null {
  const joined = path.resolve(folder, filePath.replaceAll('\\', '/'));
  const relative = path.relative(folder, joined);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    return fs.lstatSync(joined).isFile() ? joined : null;
  } catch {
    return null;
  }
}

/** Whether the folder, or a folder above it, has `@playwright/test` installed. */
function playwrightInstalled(folder: string): boolean {
  try {
    createRequire(path.join(folder, 'package.json')).resolve('@playwright/test/package.json');
    return true;
  } catch {
    return false;
  }
}

/** Text as a regular expression matches it literally. */
function escapeGrep(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether two commits are one: a full name and an abbreviated one of it count as the same. */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** Whether a request's tests are picked by title: off its commit, with changes, or when a test has no line. */
export function picksByTitle(request: RunRequest, offCommit: boolean): boolean {
  return offCommit || request.tests.some((t) => !t.line);
}

/**
 * The arguments after `playwright test` for `request` in `folder` (its real path, as Playwright resolves the
 * config's folder): each test by `file:line`, or with `byTitle` each spec file and one `--grep` of the titles, then
 * the project and the options. A test with no line is never run as its whole file: the request goes by title. A
 * `--grep` value is one element written `--grep=<pattern>`, so it never reads as an option. `windows`: whether
 * Playwright runs on Windows, where each spec is also matched by its `file:` URL.
 */
export function requestedRunArgs(
  request: RunRequest,
  folder: string,
  byTitle: boolean,
  windows = process.platform === 'win32',
): string[] {
  byTitle = picksByTitle(request, byTitle);
  const unique = (values: string[]) => [...new Set(values)];
  const files = (test: { filePath: string }) => path.resolve(folder, test.filePath.replaceAll('\\', '/'));
  // On Windows, each spec's `file:` URL too, which Playwright up to 1.62 tests in place of the `/`-separated path.
  const url = (file: string) => (windows ? pathToFileURL(file, { windows: true }).href : undefined);
  const args = byTitle
    ? unique(request.tests.map((t) => specFilePattern(files(t), url(files(t)))))
    : unique(request.tests.map((t) => specFileArgument(files(t), t.line!, url(files(t)))));
  if (byTitle) {
    // Playwright matches the title path (project, file, describe blocks, title) and the tags, joined by spaces, and
    // ignores case. Each title is anchored at the end, before the tags, and after a space or the start: a test whose
    // title path ends with the title as whole words is selected too, in any case ("logs in" selects "user logs in"
    // and "LOGS IN"), within the request's spec files.
    const titles = unique(request.tests.map((t) => t.title)).map(escapeGrep);
    args.push(`--grep=(?:^| )(?:${titles.join('|')})(?: @\\S+)*$`);
  }
  const { options } = request;
  const projects = options.project
    ? [options.project]
    : unique(request.tests.map((t) => t.projectName ?? '').filter(Boolean));
  for (const project of projects) args.push(`--project=${project}`);
  if (options.headed) args.push('--headed');
  if (options.trace) args.push(`--trace=${options.trace}`);
  // Each repetition reports its own result, as the editors' repeat does.
  if (options.repeatEach && options.repeatEach > 1) args.push(`--repeat-each=${options.repeatEach}`, '--retries=0');
  if (options.workers) args.push(`--workers=${options.workers}`);
  return args;
}

/** One argument as the confirmation shows it: quoted when it holds a space or a quote. */
function displayArg(arg: string): string {
  return /[\s"']/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

/** The shell the confirmation writes the run variables for: this machine's. */
const DISPLAY_SHELL = process.platform === 'win32' ? 'powershell' : 'bash';

/**
 * Check `folder`, the folder linked to the request's project on this machine (null when none is), against
 * `request`, and build the command. A failed check names its fix and leaves the command empty; a branch or a commit
 * other than the request's, or uncommitted changes, warns and selects the tests by title, since a line may have moved.
 * `runningIn` names the folders a run of this app is going in, requested or the person's own: one of them fails the
 * check, and so does a command past `REQUESTED_RUN_ARGS_MAX_CHARS`. `variables` are the project's run variables as
 * `parseRunVariables` read them from the instance: a problem fails the check, and the command starts with them.
 */
export async function planRequestedRun(
  request: RunRequest,
  folder: string | null,
  runningIn: string[] = [],
  variables: RunVariablesParse = { ok: true, value: [] },
): Promise<RequestPlan> {
  const checks: RequestCheck[] = [];
  const done = (extra: Partial<RequestPlan> = {}): RequestPlan => {
    const runnable = !checks.some((c) => c.level === 'fail');
    const args = runnable ? (extra.args ?? []) : [];
    const applied = runnable && variables.ok ? variables.value : [];
    const command = ['npx', 'playwright', 'test', ...args.map(displayArg)].join(' ');
    return {
      checks,
      runnable,
      args,
      display: runnable ? withRunVariables(command, applied, DISPLAY_SHELL) : '',
      variables: applied,
      byTitle: extra.byTitle ?? false,
      branch: extra.branch ?? null,
      commit: extra.commit ?? null,
    };
  };

  if (!folder) {
    checks.push(check('folder', 'fail', 'folder-none'));
    return done();
  }
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
  } catch {
    checks.push(check('folder', 'fail', 'folder-gone'));
    return done();
  }
  checks.push(check('folder', 'ok', 'folder-linked', { folder }));
  if (!variables.ok) {
    checks.push(check('variables', 'fail', 'variables-invalid', { problems: variables.problems.join(' ') }));
  } else if (variables.value.length > 0) {
    checks.push(
      check('variables', 'ok', 'variables-set', {
        variables: runVariableAssignments(variables.value, DISPLAY_SHELL),
      }),
    );
  }
  if (runningIn.some((other) => realFolder(other) === real)) checks.push(check('busy', 'fail', 'folder-busy'));

  if (!playwrightConfigFile(real)) checks.push(check('config', 'fail', 'config-missing'));

  const missing = [...new Set(request.tests.map((t) => t.filePath))].filter((f) => !specInFolder(real, f));
  if (missing.length > 0) {
    const files = missing.slice(0, NAMED_SPECS).join(', ');
    checks.push(check('specs', 'fail', 'specs-missing', { files, more: Math.max(0, missing.length - NAMED_SPECS) }));
  } else {
    checks.push(check('specs', 'ok', 'specs-found'));
  }

  if (!playwrightInstalled(real)) checks.push(check('playwright', 'fail', 'playwright-missing'));
  else checks.push(check('playwright', 'ok', 'playwright-installed'));

  const root = await repositoryRoot(real);
  const [branch, commit, changed] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    hasUncommittedChanges(root),
  ]);
  const { source } = request;
  const onCommit = !!source.commit && !!commit && sameCommit(source.commit, commit);
  if (source.commit && !onCommit) {
    checks.push(
      check('commit', 'warn', 'commit-differs', {
        branch: branch ?? '',
        commit: commit ? commit.slice(0, 7) : '',
        sourceBranch: source.branch ?? '',
        sourceCommit: source.commit.slice(0, 7),
      }),
    );
  } else if (onCommit) {
    checks.push(check('commit', 'ok', 'commit-same'));
  }
  if (changed) checks.push(check('changes', 'warn', 'changes-uncommitted'));
  const byTitle = picksByTitle(request, !onCommit || changed);
  const args = requestedRunArgs(request, real, byTitle);
  if (argsLength(args) > REQUESTED_RUN_ARGS_MAX_CHARS) {
    checks.push(check('command', 'fail', 'command-too-long', { max: REQUESTED_RUN_ARGS_MAX_CHARS }));
  }
  return done({ args, byTitle, branch, commit });
}
