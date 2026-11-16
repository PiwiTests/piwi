/**
 * The listing: the tests Playwright lists for a config (`playwright test --list`), run with the project's own
 * Playwright and the service's reporter (`piwi-use-reporter.cjs` with `PIWI_LIST_TESTS=1`), for the test tree.
 * `TestListings` keeps each config's last listing, runs one listing per config at a time, and lists a config whole or
 * some of its specs alone. A spec that does not load is listed again without the others failing: Playwright lists
 * nothing once one spec fails, so the listing is run once more without the specs that failed.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configFingerprint, firstLine, ProjectOptionsError, type ListOutput } from './recorder/project-options.js';
import { ERROR_LINE, TESTS_LINE, type ListErrorLine, type ListedTestLine } from './recorder/use-reporter.js';

export type ListedTest = ListedTestLine;

/** Runs the config's Playwright in list mode with the service's reporter, then `args` (the file filters). */
export type ListRunner = (configFile: string, args: string[]) => Promise<ListOutput>;

/** A config's last listing. */
export interface ConfigListing {
  /** The tests by spec, relative to the config's folder with forward slashes, in the order Playwright lists them. */
  specs: Map<string, ListedTest[]>;
  /** When each spec was last listed: the time its listing started (ms). */
  listedAt: Map<string, number>;
  /** The specs that did not load, with why: Playwright's first line and the line it names. */
  broken: Map<string, string>;
  /** When the whole config was last listed: the time that listing started (ms). */
  at: number;
}

/** What the tree says of a config's listing. */
export interface ListingState {
  listing: ConfigListing | null;
  /** Why the last listing failed (Playwright missing, a config that throws, a timeout); null when it did not. */
  error: string | null;
  /** Whether a listing runs now. */
  running: boolean;
}

/** More specs than this in one change list the whole config. */
const MAX_SPECS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Whether a listed file is the config folder's: relative to it, with no `..`. */
const inConfigFolder = (file: string) => !path.isAbsolute(file) && !file.split('/').includes('..');

/**
 * A listed test as the reporter printed it, checked field by field; null when one does not hold, and for a spec outside
 * the config's folder, which the editors' answers leave out.
 */
function listedTest(value: unknown): ListedTest | null {
  if (!isRecord(value)) return null;
  const { id, file, line, column, title, suites, project, tags } = value;
  if (!isString(id) || !isString(file) || !isLine(line) || !isString(title) || !isString(project)) return null;
  if (!inConfigFolder(file)) return null;
  if (!Array.isArray(suites) || !Array.isArray(tags)) return null;
  const kept = suites.flatMap((s) =>
    isRecord(s) && isString(s.title) && isLine(s.line) ? [{ title: s.title, line: s.line }] : [],
  );
  if (kept.length !== suites.length) return null;
  return {
    id,
    file,
    line,
    column: isLine(column) ? column : 1,
    title,
    suites: kept,
    project,
    tags: tags.filter(isString),
  };
}

/** The tests of the reporter's `PIWI_TESTS` line; null when it printed none (Playwright did not reach its `onBegin`). */
export function parseTestsLine(output: string): ListedTest[] | null {
  const line = output.split(/\r?\n/).find((l) => l.startsWith(TESTS_LINE));
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(TESTS_LINE.length));
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  return value.flatMap((t) => {
    const test = listedTest(t);
    return test ? [test] : [];
  });
}

/** The errors of the reporter's `PIWI_ERROR` lines. */
export function parseErrorLines(output: string): ListErrorLine[] {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(ERROR_LINE)) return [];
    try {
      const value: unknown = JSON.parse(line.slice(ERROR_LINE.length));
      if (!isRecord(value) || !isString(value.message)) return [];
      return [
        {
          message: value.message,
          file: isString(value.file) ? value.file : null,
          line: isLine(value.line) ? value.line : null,
        },
      ];
    } catch {
      return [];
    }
  });
}

/** A path (`/work/tests/cart.spec.ts`) as a regular expression's text: its parts, either separator. */
function filePattern(file: string): string {
  return file
    .split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
}

/**
 * The paths Playwright tests a file filter against, for a spec of the config's folder `root`: the whole path, and
 * its `file:` URL (`%20` for a space), which Playwright also tries on Windows.
 */
function spellings(root: string, file: string): string[] {
  const absolute = path.join(root, file);
  return [absolute.split(path.sep).join('/'), pathToFileURL(absolute).href].map(filePattern);
}

/** Playwright's file filter for one spec of the config's folder `root`: a regular expression its whole path matches. */
export function specFilter(root: string, file: string): string {
  return `^(?:${spellings(root, file).join('|')})$`;
}

/** Playwright's file filter for every spec of the config's folder `root` but these. */
export function excludingFilter(root: string, files: readonly string[]): string {
  return `^(?!(?:${files.flatMap((file) => spellings(root, file)).join('|')})$)`;
}

/** A file an error names, when it is a spec of the config's folder. */
function specOfError(error: ListErrorLine): string | null {
  return error.file && inConfigFolder(error.file) ? error.file : null;
}

/** Why a spec did not load, as the tree says it: Playwright's words, then the line they name. */
function brokenWhy(error: ListErrorLine): string {
  return error.line ? `${error.message} (line ${error.line})` : error.message;
}

/** What one listing gave: its tests and the specs that did not load; or why it gave none. */
export type ListResult = { tests: ListedTest[]; broken: Map<string, string> } | { error: string };

/**
 * Lists the tests of a config, or of the specs `files` names (relative to the config's folder), with `run`. When a
 * spec does not load, Playwright lists none: the listing runs once more without the specs that failed.
 */
export async function listTests(
  run: ListRunner,
  configFile: string,
  files: readonly string[] | null,
): Promise<ListResult> {
  const name = path.basename(configFile);
  const root = path.dirname(configFile);
  type Once = { output: ListOutput; tests: ListedTest[] | null; errors: ListErrorLine[] } | { error: string };
  const once = async (args: string[]): Promise<Once> => {
    try {
      const output = await run(configFile, args);
      return { output, tests: parseTestsLine(output.stdout), errors: parseErrorLines(output.stdout) };
    } catch (error) {
      return {
        error: error instanceof ProjectOptionsError ? error.message : `Playwright could not list the tests of ${name}.`,
      };
    }
  };
  if (files && !files.length) return { tests: [], broken: new Map() };
  let result = await once(files ? files.map((f) => specFilter(root, f)) : []);
  const broken = new Map<string, string>();
  for (let tries = 0; tries < 2; tries++) {
    if ('error' in result) return { error: result.error };
    const failed = result.errors.flatMap((e) => {
      const spec = specOfError(e);
      return spec && !broken.has(spec) ? [{ spec, why: brokenWhy(e) }] : [];
    });
    if (!failed.length) break;
    for (const { spec, why } of failed) broken.set(spec, why);
    const left = files ? files.filter((f) => !broken.has(f)) : null;
    if (left && !left.length) return { tests: [], broken };
    result = await once(left ? left.map((f) => specFilter(root, f)) : [excludingFilter(root, [...broken.keys()])]);
  }
  if ('error' in result) return { error: result.error };
  if (!result.tests || (!result.tests.length && result.errors.length)) {
    const said = result.errors[0]?.message ?? firstLine(result.output.stderr || result.output.stdout);
    return { error: `Playwright could not list the tests of ${name}: ${said.replace(/[.!?…]?$/, '.')}` };
  }
  return { tests: result.tests, broken };
}

interface Kept extends ListingState {
  configFile: string;
  /** The config's fingerprint when its last whole listing started. */
  fingerprint: string | null;
  /** What waits for the running listing: the whole config, or these specs. */
  pending: 'all' | Set<string> | null;
}

/**
 * Each config's last listing, by the config's folder. A listing is asked for the whole config or for some of its
 * specs; one runs at a time per config, and what is asked meanwhile runs after it, merged. `changed` is called with
 * the config's folder after each listing, whatever it gave.
 */
export class TestListings {
  private readonly kept = new Map<string, Kept>();

  constructor(
    private readonly run: ListRunner,
    private readonly changed: (root: string) => void,
    private readonly fingerprint: (configFile: string) => string | null = configFingerprint,
  ) {}

  /** What the tree says of a config's listing; null when none was asked for. */
  state(root: string): ListingState | null {
    const kept = this.kept.get(root);
    return kept ? { listing: kept.listing, error: kept.error, running: kept.running } : null;
  }

  /** Whether a listing of the config was asked for: only those follow the changes of their files. */
  listed(root: string): boolean {
    return this.kept.has(root);
  }

  /** List the whole config. */
  listAll(root: string, configFile: string): void {
    const kept = this.keep(root, configFile);
    this.ask(root, kept, 'all');
  }

  /** List these specs of a listed config alone (relative to its folder); the whole config past `MAX_SPECS`. */
  listSpecs(root: string, files: readonly string[]): void {
    const kept = this.kept.get(root);
    if (!kept || !files.length) return;
    this.ask(root, kept, files.length > MAX_SPECS ? 'all' : new Set(files));
  }

  /** List a listed config whole again when one of the files it reads changed (`configFingerprint`). */
  checkConfig(root: string): void {
    const kept = this.kept.get(root);
    if (kept && this.fingerprint(kept.configFile) !== kept.fingerprint) this.ask(root, kept, 'all');
  }

  private keep(root: string, configFile: string): Kept {
    let kept = this.kept.get(root);
    if (!kept || kept.configFile !== configFile) {
      kept = { configFile, listing: null, error: null, running: false, fingerprint: null, pending: null };
      this.kept.set(root, kept);
    }
    return kept;
  }

  private ask(root: string, kept: Kept, what: 'all' | Set<string>): void {
    if (kept.running) {
      if (what === 'all' || kept.pending === 'all') kept.pending = 'all';
      else kept.pending = new Set([...(kept.pending ?? []), ...what]);
      return;
    }
    void this.start(root, kept, what);
  }

  private async start(root: string, kept: Kept, what: 'all' | Set<string>): Promise<void> {
    kept.running = true;
    const at = Date.now();
    // The whole listing of a config never listed stands for every spec, whatever was asked.
    const whole = what === 'all' || !kept.listing;
    if (whole) kept.fingerprint = this.fingerprint(kept.configFile);
    const files = whole ? null : [...what];
    const result = await listTests(this.run, kept.configFile, files);
    kept.running = false;
    // A config forgotten or replaced meanwhile keeps nothing.
    if (this.kept.get(root) !== kept) return;
    if ('error' in result) kept.error = result.error;
    else {
      kept.error = null;
      kept.listing = merged(kept.listing, result, files, at);
    }
    const next = kept.pending;
    kept.pending = null;
    if (next) void this.start(root, kept, next);
    this.changed(root);
  }
}

/** A listing with a new one's tests: in place of every spec when `files` is null, else of those specs alone. */
function merged(
  before: ConfigListing | null,
  result: { tests: ListedTest[]; broken: Map<string, string> },
  files: string[] | null,
  at: number,
): ConfigListing {
  const listing: ConfigListing =
    files && before
      ? {
          specs: new Map(before.specs),
          listedAt: new Map(before.listedAt),
          broken: new Map(before.broken),
          at: before.at,
        }
      : { specs: new Map(), listedAt: new Map(), broken: new Map(), at };
  for (const file of files ?? []) {
    listing.specs.delete(file);
    listing.broken.delete(file);
    listing.listedAt.set(file, at);
  }
  // A listing of some specs keeps theirs alone, each spec's tests in an array of its own.
  const asked = files ? new Set(files) : null;
  const added = new Map<string, ListedTest[]>();
  for (const test of result.tests) {
    if (asked && !asked.has(test.file)) continue;
    added.set(test.file, [...(added.get(test.file) ?? []), test]);
  }
  for (const [file, tests] of added) {
    listing.specs.set(file, tests);
    listing.listedAt.set(file, at);
  }
  for (const [file, why] of result.broken) {
    listing.broken.set(file, why);
    listing.listedAt.set(file, at);
  }
  return listing;
}
