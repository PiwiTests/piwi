/**
 * What a target checks before it asks the person about a run request, and the command it runs after **Run**: built
 * here from the request's tests and options, never taken from the instance (`@piwitests/core/run-request`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { specFileArgument, specFilePattern, type RunRequest } from '@piwitests/core/run-request';
import { currentBranch, hasUncommittedChanges, headCommit, playwrightConfigFile, repositoryRoot } from './workspace';

/** One row of the confirmation: a check that failed stops **Run**, a warning does not. */
export interface RequestCheck {
  id: 'folder' | 'config' | 'specs' | 'playwright' | 'commit' | 'changes';
  level: 'ok' | 'warn' | 'fail';
  message: string;
}

/** What the target found in the folder, and the command it would run there. */
export interface RequestPlan {
  checks: RequestCheck[];
  /** Whether **Run** may start the run: no check failed. */
  runnable: boolean;
  /** The arguments after `playwright test`, each one argv element; empty while a check fails. */
  args: string[];
  /** The command as the confirmation shows it. */
  display: string;
  /** Whether the tests are selected by title, because the folder is not on the request's commit or has changes. */
  byTitle: boolean;
  branch: string | null;
  commit: string | null;
}

/** How many missing spec files a check names before it counts the rest. */
const NAMED_SPECS = 3;

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

/**
 * The arguments after `playwright test` for `request` in `folder` (its real path, as Playwright resolves the
 * config's folder): each test by `file:line`, or with `byTitle` each spec file and one `--grep` of the titles, then
 * the project and the options. A `--grep` value is one element written `--grep=<pattern>`, so it never reads as an
 * option.
 */
export function requestedRunArgs(request: RunRequest, folder: string, byTitle: boolean): string[] {
  const unique = (values: string[]) => [...new Set(values)];
  const files = (test: { filePath: string }) => path.resolve(folder, test.filePath.replaceAll('\\', '/'));
  const args = byTitle
    ? unique(request.tests.map((t) => specFilePattern(files(t))))
    : unique(request.tests.map((t) => (t.line ? specFileArgument(files(t), t.line) : specFilePattern(files(t)))));
  if (byTitle) {
    const titles = unique(request.tests.map((t) => t.title)).map(escapeGrep);
    args.push(`--grep=${titles.length === 1 ? titles[0]! : `(${titles.join('|')})`}`);
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

/**
 * Check `folder`, the folder linked to the request's project on this machine (null when none is), against
 * `request`, and build the command. A failed check names its fix and leaves the command empty; a branch or a commit
 * other than the request's, or uncommitted changes, warns and selects the tests by title, since a line may have moved.
 */
export async function planRequestedRun(request: RunRequest, folder: string | null): Promise<RequestPlan> {
  const checks: RequestCheck[] = [];
  const done = (extra: Partial<RequestPlan> = {}): RequestPlan => {
    const runnable = !checks.some((c) => c.level === 'fail');
    const args = runnable ? (extra.args ?? []) : [];
    return {
      checks,
      runnable,
      args,
      display: runnable ? ['npx', 'playwright', 'test', ...args.map(displayArg)].join(' ') : '',
      byTitle: extra.byTitle ?? false,
      branch: extra.branch ?? null,
      commit: extra.commit ?? null,
    };
  };

  if (!folder) {
    checks.push({ id: 'folder', level: 'fail', message: 'No folder is linked to this project on this machine.' });
    return done();
  }
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
  } catch {
    checks.push({ id: 'folder', level: 'fail', message: 'The linked folder no longer exists: choose it again.' });
    return done();
  }
  checks.push({ id: 'folder', level: 'ok', message: 'The folder is linked.' });

  if (!playwrightConfigFile(real)) {
    checks.push({ id: 'config', level: 'fail', message: 'The folder holds no Playwright config.' });
  }

  const missing = [...new Set(request.tests.map((t) => t.filePath))].filter((f) => !specInFolder(real, f));
  if (missing.length > 0) {
    const named = missing.slice(0, NAMED_SPECS).join(', ');
    const more = missing.length > NAMED_SPECS ? ` and ${missing.length - NAMED_SPECS} more` : '';
    checks.push({ id: 'specs', level: 'fail', message: `Not in the folder: ${named}${more}.` });
  } else {
    checks.push({ id: 'specs', level: 'ok', message: 'The specs are in the folder.' });
  }

  if (!playwrightInstalled(real)) {
    checks.push({
      id: 'playwright',
      level: 'fail',
      message: 'Playwright is not installed in the folder: run `npm install` there.',
    });
  } else {
    checks.push({ id: 'playwright', level: 'ok', message: 'Playwright is installed.' });
  }

  const root = await repositoryRoot(real);
  const [branch, commit, changed] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    hasUncommittedChanges(root),
  ]);
  const { source } = request;
  const onCommit = !!source.commit && !!commit && sameCommit(source.commit, commit);
  if (source.commit && !onCommit) {
    const here = [branch ? `on ${branch}` : null, commit ? `at ${commit.slice(0, 7)}` : null].filter(Boolean);
    const there = [source.branch ? `on ${source.branch}` : null, `at ${source.commit.slice(0, 7)}`].filter(Boolean);
    checks.push({
      id: 'commit',
      level: 'warn',
      message: `Your folder is ${here.join(' ') || 'outside a git repository'}; the run you came from was ${there.join(' ')}. The tests are selected by title.`,
    });
  } else if (onCommit) {
    checks.push({ id: 'commit', level: 'ok', message: 'Your folder is on the commit the run came from.' });
  }
  if (changed) {
    checks.push({ id: 'changes', level: 'warn', message: 'Your folder has uncommitted changes.' });
  }
  const byTitle = !onCommit || changed;
  return done({ args: requestedRunArgs(request, real, byTitle), byTitle, branch, commit });
}
