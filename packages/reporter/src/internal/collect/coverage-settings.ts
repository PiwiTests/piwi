import {
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

/** In a test worker: whether the server side records, from `PIWI_COVERAGE_SERVER`. */
export function serverCoverageInWorker(): boolean {
  return isServerGranularity(process.env[PIWI_ENV_KEYS.coverageServer]);
}
