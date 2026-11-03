import {
  MAX_COVERAGE_FILES,
  MAX_COVERAGE_RANGES,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  normalizeLineRanges,
  sanitizeCoverage,
  type CoverageCapture,
  type CoverageGranularity,
  type LineRange,
} from '@piwitests/core/coverage';
import type { PiwiDashboardOptions } from '../../public/options.js';
import { PIWI_ENV_KEYS } from '../config/env.js';

/**
 * What the browser side of coverage records: the files that ran, also the lines of each function that ran, or also
 * the lines that ran and the executable ones, from V8's block coverage.
 */
export type BrowserCoverageSetting = 'off' | 'files' | 'functions' | 'lines';

/** What the server side of coverage records. */
export type ServerCoverageSetting = 'off' | CoverageGranularity;

/** Whether the browser's style sheets record the rules that matched an element. */
export type CssCoverageSetting = 'off' | 'rules';

/** The coverage a run records, per runtime, and for the browser's style sheets. */
export interface CoverageSettings {
  browser: BrowserCoverageSetting;
  server: ServerCoverageSetting;
  /** Off when unset. */
  css?: CssCoverageSetting;
}

const SERVER_VALUES: ReadonlySet<string> = new Set(['files', 'functions', 'lines']);

/** Whether a value names a server coverage granularity (`files`, `functions` or `lines`). */
export function isServerGranularity(value: unknown): value is CoverageGranularity {
  return typeof value === 'string' && SERVER_VALUES.has(value);
}

/**
 * The coverage the options switch on. Both sides are off with
 * `collectPerformanceMetrics: false`. The browser records lines when
 * `coverage.browser` is `'lines'`, functions when it is `'functions'`, files
 * when it is `'files'` or `captureCodeReach` is true; the server records the granularity
 * `coverage.server` names, anything else is off; the style sheets record their
 * matched rules with `coverage.css: 'rules'`.
 */
export function coverageSettings(options: PiwiDashboardOptions): CoverageSettings {
  if (options.collectPerformanceMetrics === false) return { browser: 'off', server: 'off', css: 'off' };
  const browser: BrowserCoverageSetting =
    options.coverage?.browser === 'lines' || options.coverage?.browser === 'functions'
      ? options.coverage.browser
      : options.coverage?.browser === 'files' || options.captureCodeReach === true
        ? 'files'
        : 'off';
  const server = isServerGranularity(options.coverage?.server) ? options.coverage.server : 'off';
  const css = options.coverage?.css === 'rules' ? 'rules' : 'off';
  return { browser, server, css };
}

/** In a test worker: whether the style sheets record the rules that matched, from `PIWI_COVERAGE_CSS`. */
export function cssCoverageInWorker(): boolean {
  return process.env[PIWI_ENV_KEYS.coverageCss] === 'rules';
}

/** In a test worker: whether the browser side records, from `PIWI_CAPTURE_CODE_REACH` or `PIWI_COVERAGE_BROWSER`. */
export function browserCoverageInWorker(): boolean {
  const browser = process.env[PIWI_ENV_KEYS.coverageBrowser];
  return (
    process.env[PIWI_ENV_KEYS.captureCodeReach] === 'true' ||
    browser === 'files' ||
    browser === 'functions' ||
    browser === 'lines'
  );
}

/** In a test worker: whether the browser side records the lines of each function, from `PIWI_COVERAGE_BROWSER`. */
export function browserFunctionsInWorker(): boolean {
  const browser = process.env[PIWI_ENV_KEYS.coverageBrowser];
  return browser === 'functions' || browser === 'lines';
}

/** In a test worker: whether the browser side records the lines that ran, from `PIWI_COVERAGE_BROWSER`. */
export function browserLinesInWorker(): boolean {
  return process.env[PIWI_ENV_KEYS.coverageBrowser] === 'lines';
}

/**
 * A test's browser coverage at function granularity, from the files code reach
 * resolved and the line ranges of their functions that ran, and at line
 * granularity the lines that ran in those files: paths normalized, ranges
 * merged, capped as any coverage is. Null when no file remains.
 */
export function browserFunctionCoverage(
  files: ReadonlyMap<string, LineRange[]>,
  lines?: ReadonlyMap<string, LineRange[]>,
): CoverageCapture | null {
  return sanitizeCoverage({
    v: 1,
    files: [...files].map(([path, functions]) => ({
      path,
      runtime: 'browser',
      functions,
      ...(lines?.get(path)?.length ? { lines: lines.get(path) } : {}),
    })),
  });
}

/** The functions a worker's tests found in the browser files, run or not, as the `piwi-browser-functions` attachment holds them. */
export interface BrowserKnownFunctions {
  v: 1;
  files: Array<{ path: string; allFunctions: LineRange[] }>;
}

/**
 * The ranges of each file not named yet, recorded in `sent` (by file, as
 * `start:end`), split into parts within the capture caps: at most
 * {@link MAX_COVERAGE_FILES} files and {@link MAX_COVERAGE_RANGES} ranges each,
 * a file with more ranges than one part holds spread over several.
 */
function newRangeParts(
  known: ReadonlyMap<string, LineRange[]>,
  sent: Map<string, Set<string>>,
  normalize: (ranges: LineRange[]) => LineRange[],
): Array<Array<{ path: string; ranges: LineRange[] }>> {
  const parts: Array<Array<{ path: string; ranges: LineRange[] }>> = [];
  let files: Array<{ path: string; ranges: LineRange[] }> = [];
  let budget = MAX_COVERAGE_RANGES;
  const close = () => {
    if (files.length > 0) parts.push(files.sort((a, b) => (a.path < b.path ? -1 : 1)));
    files = [];
    budget = MAX_COVERAGE_RANGES;
  };
  for (const [raw, ranges] of known) {
    const path = normalizeCoveragePath(raw);
    if (path === null) continue;
    let named = sent.get(path);
    let fresh = normalize(ranges).filter((range) => !named?.has(`${range[0]}:${range[1]}`));
    if (fresh.length === 0) continue;
    if (!named) sent.set(path, (named = new Set()));
    for (const range of fresh) named.add(`${range[0]}:${range[1]}`);
    while (fresh.length > 0) {
      if (budget === 0 || files.length >= MAX_COVERAGE_FILES) close();
      const part = fresh.slice(0, budget);
      fresh = fresh.slice(part.length);
      budget -= part.length;
      files.push({ path, ranges: part });
    }
  }
  close();
  return parts;
}

/**
 * The functions of the browser files the worker has not named yet, run or
 * not, as `piwi-browser-functions` attachments, and records them in `sent`:
 * paths normalized, ranges normalized as function ranges, each attachment
 * within the capture caps, a file with more ranges than one holds spread over
 * several. A worker names each function once; the reporter adds every
 * attachment's up for the run. Empty when none is new.
 */
export function newKnownFunctions(
  known: ReadonlyMap<string, LineRange[]>,
  sent: Map<string, Set<string>>,
): BrowserKnownFunctions[] {
  return newRangeParts(known, sent, normalizeFunctionRanges).map((files) => ({
    v: 1,
    files: files.map(({ path, ranges }) => ({ path, allFunctions: ranges })),
  }));
}

/**
 * The browser files' lines, as the `piwi-browser-lines` attachments hold them: per file, its executable lines and
 * the lines that ran in any of the worker's tests, its top-level code's included.
 */
export interface BrowserFileLines {
  v: 1;
  files: Array<{ path: string; executable?: LineRange[]; lines?: LineRange[] }>;
}

/**
 * The executable lines and the lines that ran of the browser files that the
 * worker has not named yet, as `piwi-browser-lines` attachments, recorded in
 * `sentExecutable` and `sentLines` as {@link newKnownFunctions} records the
 * functions, within the same caps. Empty when none is new.
 */
export function newBrowserLines(
  executable: ReadonlyMap<string, LineRange[]>,
  lines: ReadonlyMap<string, LineRange[]>,
  sentExecutable: Map<string, Set<string>>,
  sentLines: Map<string, Set<string>>,
): BrowserFileLines[] {
  return [
    ...newRangeParts(executable, sentExecutable, normalizeLineRanges).map((files): BrowserFileLines => ({
      v: 1,
      files: files.map(({ path, ranges }) => ({ path, executable: ranges })),
    })),
    ...newRangeParts(lines, sentLines, normalizeLineRanges).map((files): BrowserFileLines => ({
      v: 1,
      files: files.map(({ path, ranges }) => ({ path, lines: ranges })),
    })),
  ];
}

/** In a test worker: whether the server side records, from `PIWI_COVERAGE_SERVER`. */
export function serverCoverageInWorker(): boolean {
  return isServerGranularity(process.env[PIWI_ENV_KEYS.coverageServer]);
}
