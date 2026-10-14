import type { CoverageGranularity } from '@piwitests/core/coverage';
import type { PiwiDashboardOptions } from '../../public/options.js';
import { PIWI_ENV_KEYS } from '../config/env.js';

/** What the browser side of coverage records. */
export type BrowserCoverageSetting = 'off' | 'files';

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
 * `collectPerformanceMetrics: false`. The browser records files when
 * `coverage.browser` is `'files'` or `captureCodeReach` is true; the server
 * records the granularity `coverage.server` names, anything else is off.
 */
export function coverageSettings(options: PiwiDashboardOptions): CoverageSettings {
  if (options.collectPerformanceMetrics === false) return { browser: 'off', server: 'off' };
  const browser = options.coverage?.browser === 'files' || options.captureCodeReach === true ? 'files' : 'off';
  const server = isServerGranularity(options.coverage?.server) ? options.coverage.server : 'off';
  return { browser, server };
}

/** In a test worker: whether the browser side records files, from `PIWI_CAPTURE_CODE_REACH` or `PIWI_COVERAGE_BROWSER`. */
export function browserCoverageInWorker(): boolean {
  return (
    process.env[PIWI_ENV_KEYS.captureCodeReach] === 'true' || process.env[PIWI_ENV_KEYS.coverageBrowser] === 'files'
  );
}

/** In a test worker: whether the server side records, from `PIWI_COVERAGE_SERVER`. */
export function serverCoverageInWorker(): boolean {
  return isServerGranularity(process.env[PIWI_ENV_KEYS.coverageServer]);
}
