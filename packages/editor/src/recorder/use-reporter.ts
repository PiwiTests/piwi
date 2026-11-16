/**
 * A Playwright reporter for the editor service, run as `playwright test --list`, so nothing runs. It always prints the
 * configuration Playwright resolved: one line, `PIWI_USE <json>`, with the config file, its root directory, Piwi's
 * section of the config (`'@piwi'`, which Playwright hands to reporters as written) and each project's name, test
 * directory and `use` options, without the functions and other values JSON cannot hold; the options read passes a
 * filter no spec file matches, so no spec is loaded. With `PIWI_LIST_TESTS=1`, it also prints the tests Playwright
 * lists (`PIWI_TESTS <json>`) and each error Playwright reports while it loads the specs (`PIWI_ERROR <json>`), for
 * the test tree. Bundled on its own as `dist/piwi-use-reporter.cjs`; it imports only Node's own modules at run time.
 */
import * as path from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase, TestError } from '@playwright/test/reporter';
import { PIWI_CONFIG_KEY } from '@piwitests/core/piwi-config';

/** What the reporter's line starts with. */
export const USE_LINE = 'PIWI_USE ';
/** What the line of the listed tests starts with. */
export const TESTS_LINE = 'PIWI_TESTS ';
/** What the line of an error Playwright reports starts with. */
export const ERROR_LINE = 'PIWI_ERROR ';
/** The variable that asks the reporter for the tests and the errors. */
export const LIST_TESTS_ENV = 'PIWI_LIST_TESTS';

/** A test as the reporter lists it, once per Playwright project. */
export interface ListedTestLine {
  /** Playwright's id of the test in its project. */
  id: string;
  /** Its spec, relative to the config's folder, with forward slashes. */
  file: string;
  /** Where its `test(…)` call starts, 1-based. */
  line: number;
  column: number;
  title: string;
  /** Its titled `test.describe(…)` blocks, outermost first, each with the 1-based line it starts on. */
  suites: Array<{ title: string; line: number }>;
  /** Its Playwright project's name; empty for a config without projects. */
  project: string;
  /** Its Playwright tags, as Playwright writes them (`@smoke`). */
  tags: string[];
}

/** An error Playwright reported while it loaded the specs: a spec that does not load, or the config itself. */
export interface ListErrorLine {
  /** Its first line, at most 500 characters. */
  message: string;
  /** The file it names, relative to the config's folder with forward slashes when inside it; null when it names none. */
  file: string | null;
  /** The 1-based line it names; null when it names none. */
  line: number | null;
}

/** How deep `use` options are kept. */
const MAX_DEPTH = 20;
/** The longest error message printed. */
const MAX_MESSAGE = 500;

/**
 * A value as JSON holds it: strings, finite numbers, booleans, null, arrays and plain objects. Anything else (a
 * function, a class instance, a cycle) is left out of an object, and null in an array.
 */
function plain(value: unknown, parents: unknown[] = []): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || parents.includes(value) || parents.length >= MAX_DEPTH) return undefined;
  const inner = [...parents, value];
  if (Array.isArray(value)) return value.map((item) => plain(item, inner) ?? null);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const kept = plain(item, inner);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** A file relative to `folder` with forward slashes when it is inside it, else as given. */
function relativeFile(folder: string, file: string): string {
  const relative = path.relative(folder, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : file;
}

/** A test as the reporter lists it. */
export function listedTest(folder: string, test: TestCase): ListedTestLine {
  const suites: ListedTestLine['suites'] = [];
  for (let suite: Suite | undefined = test.parent; suite && suite.type === 'describe'; suite = suite.parent) {
    if (suite.title) suites.unshift({ title: suite.title, line: suite.location?.line ?? test.location.line });
  }
  return {
    id: test.id,
    file: relativeFile(folder, test.location.file),
    line: test.location.line,
    column: test.location.column,
    title: test.title,
    suites,
    project: test.parent.project()?.name ?? '',
    tags: [...(test.tags ?? [])],
  };
}

export default class UseReporter implements Reporter {
  /** The config's folder: the service runs Playwright there, so an error before `onBegin` is placed from it too. */
  private folder = process.cwd();

  private readonly lists = process.env[LIST_TESTS_ENV] === '1';

  onBegin(config: FullConfig, suite: Suite): void {
    this.folder = config.configFile ? path.dirname(config.configFile) : config.rootDir;
    const resolved = {
      configFile: config.configFile ?? null,
      rootDir: config.rootDir,
      piwi: plain((config as unknown as Record<string, unknown>)[PIWI_CONFIG_KEY]) ?? null,
      projects: config.projects.map((project) => ({
        name: project.name,
        testDir: project.testDir,
        use: plain(project.use) ?? {},
      })),
    };
    process.stdout.write(`${USE_LINE}${JSON.stringify(resolved)}\n`);
    if (!this.lists) return;
    const tests = suite.allTests().map((test) => listedTest(this.folder, test));
    process.stdout.write(`${TESTS_LINE}${JSON.stringify(tests)}\n`);
  }

  onError(error: TestError): void {
    if (!this.lists) return;
    const first = (error.message ?? error.value ?? '').split(/\r?\n/).find((l) => l.trim()) ?? 'Unknown error';
    const line: ListErrorLine = {
      message: first.trim().slice(0, MAX_MESSAGE),
      file: error.location?.file ? relativeFile(this.folder, error.location.file) : null,
      line: error.location?.line ?? null,
    };
    process.stdout.write(`${ERROR_LINE}${JSON.stringify(line)}\n`);
  }

  printsToStdio(): boolean {
    return true;
  }
}
