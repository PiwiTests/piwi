import {
  MAX_COVERAGE_FILES,
  MAX_COVERAGE_RANGES,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  sanitizeCoverage,
  type CoverageCapture,
  type CoverageGranularity,
  type LineRange,
} from '@piwitests/core/coverage';
import type { PiwiDashboardOptions } from '../../public/options.js';
import { PIWI_ENV_KEYS } from '../config/env.js';

/** What the browser side of coverage records: the files that ran, or also the lines of each function that ran. */
export type BrowserCoverageSetting = 'off' | 'files' | 'functions';

/** What the server side of coverage records. */
export type ServerCoverageSetting = 'off' | CoverageGranularity;

/** The coverage a run records, per runtime. */
export interface CoverageSettings {
  browser: BrowserCoverageSetting;
  server: ServerCoverageSetting;
}

const SERVER_VALUES: ReadonlySet<string> = new Set(['files', 'functions', 'lines']);

/** Whether a value names a server coverage granularity (`files`, `functions` or `lines`). */
export function isServerGranularity(value: unknown): value is CoverageGranularity {
  return typeof value === 'string' && SERVER_VALUES.has(value);
}

/**
 * The coverage the options switch on. Both sides are off with
 * `collectPerformanceMetrics: false`. The browser records functions when
 * `coverage.browser` is `'functions'`, files when it is `'files'` or
 * `captureCodeReach` is true; the server records the granularity
 * `coverage.server` names, anything else is off.
 */
export function coverageSettings(options: PiwiDashboardOptions): CoverageSettings {
  if (options.collectPerformanceMetrics === false) return { browser: 'off', server: 'off' };
  const browser: BrowserCoverageSetting =
    options.coverage?.browser === 'functions'
      ? 'functions'
      : options.coverage?.browser === 'files' || options.captureCodeReach === true
        ? 'files'
        : 'off';
  const server = isServerGranularity(options.coverage?.server) ? options.coverage.server : 'off';
  return { browser, server };
}

/** In a test worker: whether the browser side records, from `PIWI_CAPTURE_CODE_REACH` or `PIWI_COVERAGE_BROWSER`. */
export function browserCoverageInWorker(): boolean {
  const browser = process.env[PIWI_ENV_KEYS.coverageBrowser];
  return process.env[PIWI_ENV_KEYS.captureCodeReach] === 'true' || browser === 'files' || browser === 'functions';
}

/** In a test worker: whether the browser side records the lines of each function, from `PIWI_COVERAGE_BROWSER`. */
export function browserFunctionsInWorker(): boolean {
  return process.env[PIWI_ENV_KEYS.coverageBrowser] === 'functions';
}

/**
 * A test's browser coverage at function granularity, from the files code reach
 * resolved and the line ranges of their functions that ran: paths normalized,
 * ranges merged, capped as any coverage is. Null when no file remains.
 */
export function browserFunctionCoverage(files: ReadonlyMap<string, LineRange[]>): CoverageCapture | null {
  return sanitizeCoverage({
    v: 1,
    files: [...files].map(([path, functions]) => ({ path, runtime: 'browser', functions })),
  });
}

/** The functions a worker's tests found in the browser files, run or not, as the `piwi-browser-functions` attachment holds them. */
export interface BrowserKnownFunctions {
  v: 1;
  files: Array<{ path: string; allFunctions: LineRange[] }>;
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
  const parts: BrowserKnownFunctions[] = [];
  let files: BrowserKnownFunctions['files'] = [];
  let budget = MAX_COVERAGE_RANGES;
  const close = () => {
    if (files.length > 0) parts.push({ v: 1, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) });
    files = [];
    budget = MAX_COVERAGE_RANGES;
  };
  for (const [raw, ranges] of known) {
    const path = normalizeCoveragePath(raw);
    if (path === null) continue;
    let named = sent.get(path);
    let fresh = normalizeFunctionRanges(ranges).filter((range) => !named?.has(`${range[0]}:${range[1]}`));
    if (fresh.length === 0) continue;
    if (!named) sent.set(path, (named = new Set()));
    for (const range of fresh) named.add(`${range[0]}:${range[1]}`);
    while (fresh.length > 0) {
      if (budget === 0 || files.length >= MAX_COVERAGE_FILES) close();
      const part = fresh.slice(0, budget);
      fresh = fresh.slice(part.length);
      budget -= part.length;
      files.push({ path, allFunctions: part });
    }
  }
  close();
  return parts;
}

/** In a test worker: whether the server side records, from `PIWI_COVERAGE_SERVER`. */
export function serverCoverageInWorker(): boolean {
  return isServerGranularity(process.env[PIWI_ENV_KEYS.coverageServer]);
}
