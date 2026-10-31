import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';
import { applyOptionsToEnv, readBool, PIWI_ENV_KEYS, PIWI_DEFAULTED_CAPTURE_ENV } from '../internal/config/env.js';
import { isProbeMode } from '../internal/probe/mode.js';
import { isFlakeMode, labModeConflict } from '../internal/flake/mode.js';
import { playwrightVersionAtLeast } from '../internal/support/playwright-version.js';
import type { PiwiDashboardOptions } from './options.js';

const PIWI_MODULE = '@piwitests/reporter';

/**
 * Playwright `use` options `wrapConfig` fills in for failure evidence when the
 * config leaves them unset (see `defaultCapture`). A trace and a failure-time
 * screenshot are what the dashboard derives the DOM snapshot, full stack, full
 * network and visual diff from without the capture fixtures.
 */
const CAPTURE_DEFAULTS = {
  screenshot: 'only-on-failure',
  trace: 'retain-on-failure',
} as const;

/**
 * First Playwright version whose `trace.snapshots` accepts the
 * `{ dom, aria, screen }` object. Earlier versions declare `snapshots` as a
 * boolean in the protocol validator and reject an object, so on them `trace`
 * stays the plain `'retain-on-failure'` string.
 */
const TRACE_SNAPSHOTS_MIN = '1.63';

/**
 * Read `@playwright/test`'s installed version. Aliased through a variable so the
 * bundler leaves the lookup as a runtime `require`, resolving the version in the
 * user's project rather than freezing the one present at build time.
 */
function installedPlaywrightVersion(): string | undefined {
  try {
    const nodeRequire: NodeRequire = require;
    return (nodeRequire('@playwright/test/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

let readPlaywrightVersion: () => string | undefined = installedPlaywrightVersion;

/** Swap how the installed Playwright version is read; pass `null` to restore. */
export function setPlaywrightVersionReader(reader: (() => string | undefined) | null): void {
  readPlaywrightVersion = reader ?? installedPlaywrightVersion;
}

type CaptureUse = NonNullable<PlaywrightTestConfig['use']>;

/**
 * Fill the top-level `use` block's `screenshot` / `trace` with the capture
 * defaults when unset, recording a human-readable summary of what was filled in
 * the `PIWI_DEFAULTED_CAPTURE` marker so the reporter can log it once in
 * `onBegin`. On Playwright 1.63 or later the trace default is the object form
 * `{ mode: 'retain-on-failure', snapshots: { dom: true, aria: true } }`, adding
 * the per-action aria tree to the trace; `screen` snapshots stay opt-in. An
 * explicit value (including `'off'`) is left untouched, and per-project `use`
 * blocks are never considered. Returns the `use` block to put on the wrapped
 * config — the original reference when nothing changed.
 */
function applyCaptureDefaults(
  use: CaptureUse | undefined,
  piwiOptions: PiwiDashboardOptions | undefined,
): CaptureUse | undefined {
  delete process.env[PIWI_DEFAULTED_CAPTURE_ENV];

  const enabled = piwiOptions?.defaultCapture ?? readBool(process.env[PIWI_ENV_KEYS.defaultCapture]) ?? true;
  if (!enabled) return use;

  const ariaSnapshots = playwrightVersionAtLeast(readPlaywrightVersion(), TRACE_SNAPSHOTS_MIN);
  const traceValue = ariaSnapshots
    ? { mode: CAPTURE_DEFAULTS.trace, snapshots: { dom: true, aria: true } }
    : CAPTURE_DEFAULTS.trace;
  const defaults: ReadonlyArray<{ key: 'screenshot' | 'trace'; value: unknown; display: string }> = [
    { key: 'screenshot', value: CAPTURE_DEFAULTS.screenshot, display: `screenshot: '${CAPTURE_DEFAULTS.screenshot}'` },
    {
      key: 'trace',
      value: traceValue,
      display: ariaSnapshots
        ? `trace: '${CAPTURE_DEFAULTS.trace}' with dom and aria snapshots`
        : `trace: '${CAPTURE_DEFAULTS.trace}'`,
    },
  ];

  const next = { ...use } as CaptureUse;
  const applied: string[] = [];
  for (const { key, value, display } of defaults) {
    if ((use as Record<string, unknown> | undefined)?.[key] === undefined) {
      (next as Record<string, unknown>)[key] = value;
      applied.push(display);
    }
  }
  if (applied.length === 0) return use;

  process.env[PIWI_DEFAULTED_CAPTURE_ENV] = applied.join(', ');
  return next;
}

function isPiwiReporterEntry(entry: unknown): boolean {
  if (typeof entry === 'string') return entry.toLowerCase().includes('piwi');
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0].toLowerCase().includes('piwi');
  return false;
}

function injectReporter(
  reporter: PlaywrightTestConfig['reporter'],
  piwiOptions?: PiwiDashboardOptions,
): PlaywrightTestConfig['reporter'] {
  const piwiEntry: [string] | [string, PiwiDashboardOptions] = piwiOptions ? [PIWI_MODULE, piwiOptions] : [PIWI_MODULE];

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
 * captured without the fixtures; on Playwright 1.63 or later `trace` also turns
 * on the per-action aria tree (`snapshots: { dom: true, aria: true }`). An
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
  const globalSetupModules: string[] = [resolveSetupModule()];
  if (config.globalSetup) {
    const orig = Array.isArray(config.globalSetup) ? config.globalSetup : [config.globalSetup];
    globalSetupModules.push(...orig);
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
