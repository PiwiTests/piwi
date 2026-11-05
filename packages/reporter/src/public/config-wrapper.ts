import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';
import { applyOptionsToEnv, readBool, PIWI_ENV_KEYS, PIWI_DEFAULTED_CAPTURE_ENV } from '../internal/config/env.js';
import { isProbeMode } from '../internal/probe/mode.js';
import { isFlakeMode, labModeConflict } from '../internal/flake/mode.js';
import { PIWI_REPORTER_MODULE, isPiwiReporterModule } from '../internal/support/reporter-entry.js';
import type { PiwiDashboardOptions } from './options.js';

/**
 * Playwright `use` options `wrapConfig` fills in for failure evidence when the
 * config leaves them unset (see `defaultCapture`). A trace and a failure-time
 * screenshot are what the dashboard derives the DOM snapshot, full stack, full
 * network and visual diff from without the capture fixtures. The trace is the
 * plain mode string, which records Playwright's own snapshot set: DOM snapshots,
 * no ARIA snapshots. A project that wants ARIA snapshots sets `trace` itself.
 */
const CAPTURE_DEFAULTS = {
  screenshot: 'only-on-failure',
  trace: 'retain-on-failure',
} as const;

type CaptureUse = NonNullable<PlaywrightTestConfig['use']>;

/**
 * Fill the top-level `use` block's `screenshot` / `trace` with the capture
 * defaults when unset, recording a human-readable summary of what was filled in
 * the `PIWI_DEFAULTED_CAPTURE` marker so the reporter can log it once in
 * `onBegin`. An explicit value (including `'off'`) is left untouched, and
 * per-project `use` blocks are never considered. Returns the `use` block to put
 * on the wrapped config — the original reference when nothing changed.
 */
function applyCaptureDefaults(
  use: CaptureUse | undefined,
  piwiOptions: PiwiDashboardOptions | undefined,
): CaptureUse | undefined {
  delete process.env[PIWI_DEFAULTED_CAPTURE_ENV];

  const enabled = piwiOptions?.defaultCapture ?? readBool(process.env[PIWI_ENV_KEYS.defaultCapture]) ?? true;
  if (!enabled) return use;

  const next = { ...use } as CaptureUse;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(CAPTURE_DEFAULTS) as Array<[keyof typeof CAPTURE_DEFAULTS, string]>) {
    if (use?.[key] === undefined) {
      (next as Record<string, unknown>)[key] = value;
      applied.push(`${key}: '${value}'`);
    }
  }
  if (applied.length === 0) return use;

  process.env[PIWI_DEFAULTED_CAPTURE_ENV] = applied.join(', ');
  return next;
}

/**
 * Whether a reporter entry is Piwi's own. Playwright resolves a relative path from the config's folder, read here as
 * the working directory, which holds the config of a plain `npx playwright test`.
 */
function isPiwiReporterEntry(entry: unknown): boolean {
  const id = Array.isArray(entry) ? entry[0] : entry;
  return typeof id === 'string' && isPiwiReporterModule(id, process.cwd());
}

function injectReporter(
  reporter: PlaywrightTestConfig['reporter'],
  piwiOptions?: PiwiDashboardOptions,
): PlaywrightTestConfig['reporter'] {
  const piwiEntry: [string] | [string, PiwiDashboardOptions] = piwiOptions
    ? [PIWI_REPORTER_MODULE, piwiOptions]
    : [PIWI_REPORTER_MODULE];

  if (!reporter) return [piwiEntry];
  if (Array.isArray(reporter)) {
    if (reporter.some(isPiwiReporterEntry)) return reporter;
    return [...reporter, piwiEntry];
  }
  return [[reporter] as [string], piwiEntry];
}

function resolveSetupModule(): string {
  // In the bundled package this file's code runs from `dist/index.js`, so the
  // global-setup module sits next to it at `dist/global-setup-module.js`. When
  // running from source (dev/tests) it lives one level up as `.ts`. Locate it by
  // probing rather than `require.resolve` so the path survives bundling.
  const candidates = [
    path.join(__dirname, 'global-setup-module.js'),
    path.join(__dirname, '..', 'global-setup-module.js'),
    path.join(__dirname, '..', 'global-setup-module.ts'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Wrap a Playwright config to auto-inject the Piwi Dashboard reporter and
 * chain its global setup module. Returns a new config object (shallow merge)
 * without mutating the original.
 *
 * The `globalSetup` field is set to a `string` (or `string[]` if the user
 * already has a global setup) referencing the Piwi global setup module,
 * which registers the run on the server. Piwi's module is chained first so the
 * run registers before the user's own setup, appearing as "initializing" on the
 * dashboard while that setup runs; the original setup path(s) are preserved and
 * executed after it.
 *
 * Playwright options required in `globalSetup` are forwarded via `PIWI_*`
 * environment variables (see `applyOptionsToEnv` in `internal/config/env.ts`
 * for the supported set).
 *
 * The top-level `use` block's `screenshot` and `trace` are defaulted to
 * `'only-on-failure'` / `'retain-on-failure'` when unset so failure evidence is
 * captured without the fixtures; the trace records DOM snapshots, not ARIA
 * snapshots (set `trace` yourself to record them, see `defaultCapture`). An
 * explicit value (including `'off'`) is kept. Opt out with `defaultCapture:
 * false` (or `PIWI_DEFAULT_CAPTURE=false`).
 *
 * @param config      The user's Playwright config.
 * @param piwiOptions Optional Piwi Dashboard options (serverUrl, projectName, …).
 */
export function wrapConfig<T extends PlaywrightTestConfig>(config: T, piwiOptions?: PiwiDashboardOptions): T {
  if (piwiOptions) applyOptionsToEnv(piwiOptions);

  // Piwi's module runs first so the run is registered before the user's own
  // globalSetup, showing as "initializing" on the dashboard while that setup runs.
  // It is chained once, also in a config wrapped twice.
  const setupModule = resolveSetupModule();
  const globalSetupModules: string[] = [setupModule];
  if (config.globalSetup) {
    const orig = Array.isArray(config.globalSetup) ? config.globalSetup : [config.globalSetup];
    globalSetupModules.push(...orig.filter((module) => module !== setupModule));
  }

  // Forward Piwi's CI-gate options into Playwright's own config so the run
  // exits non-zero locally, with no server round-trip (Playwright 1.52+).
  // The env var is read here rather than via `resolveOptions`: that runs when
  // the *reporter* is constructed, long after Playwright has read this config.
  const forwarded: Record<string, unknown> = {};
  const failOnFlaky = piwiOptions?.failOnFlakyTests ?? readBool(process.env[PIWI_ENV_KEYS.failOnFlakyTests]);
  if (failOnFlaky === true) forwarded.failOnFlakyTests = true;

  // A probe run replays each passing test once to see whether it notices an
  // injected fault. A retry would re-run the test after it "noticed" (failed),
  // muddying the outcome and doubling the run, so retries are forced off.
  // A flake-lab arm counts failures per attempt against a control; a retry
  // would hide the failure it is there to count, so retries are off there too.
  // A run never mixes the two modes.
  const conflict = labModeConflict();
  if (conflict) throw new Error(conflict);
  if (isProbeMode() || isFlakeMode()) forwarded.retries = 0;

  // Default the Playwright capture options that unlock trace-derived evidence
  // without the fixtures. `use` is only overridden when a default was actually
  // applied, so an unchanged config keeps its original reference.
  const use = applyCaptureDefaults(config.use, piwiOptions);

  return {
    ...config,
    ...forwarded,
    reporter: injectReporter(config.reporter, piwiOptions),
    globalSetup: globalSetupModules.length === 1 ? globalSetupModules[0] : globalSetupModules,
    ...(use === config.use ? {} : { use }),
  } as T;
}
