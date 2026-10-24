import * as path from 'node:path';
import type { PiwiDashboardOptions } from '../../public/options.js';
import { defaultDesktopConfigPath, readDesktopConfig } from './desktop.js';
import { readDotEnv } from './dotenv.js';
import { detectCi } from '../support/ci.js';

/**
 * Built-in option defaults, merged *under* any user-provided or env-derived
 * value (see `resolveOptions`).
 */
const DEFAULTS: PiwiDashboardOptions = {
  projectName: 'default-project',
  uploadTraces: true,
  uploadReport: true,
  liveFileUploads: true,
  collectScmInfo: true,
  collectCiInfo: true,
  collectPerformanceMetrics: true,
  captureLocators: true,
  capturePageState: true,
  // Off by default: the page inventory reads control and link names from every
  // visited page, so it stays opt-in until a project turns it on.
  capturePageInventory: false,
  // Off by default: JavaScript coverage adds time to every test, so a scheduled job opts in.
  captureCodeReach: false,
  captureServerTraces: true,
  captureResources: true,
  leakCheck: 'report',
  sampleAriaOnPass: true,
  uploadManifest: true,
  defaultCapture: true,
  checkBaseUrl: false,
  streaming: true,
  streamingBatchSize: 20,
  streamingBatchDelay: 2000,
  maxStreamBufferBytes: 100 * 1024 * 1024,
  submitTimeout: 15 * 60 * 1000,
  failOnFlakyTests: false,
  username: null,
  password: null,
  apiKey: null,
  verbose: false,
} as const;

/**
 * Single source of truth for the `PIWI_*` env-var → option mapping. Both
 * `resolveOptions` (env → option) and `applyOptionsToEnv` (option → env, used
 * by `wrapConfig` to bridge into the global-setup process) read these names so
 * the mapping lives in exactly one place.
 */
export const PIWI_ENV_KEYS = {
  serverUrl: 'PIWI_DASHBOARD_URL',
  desktopApp: 'PIWI_DESKTOP_APP',
  projectName: 'PIWI_PROJECT_NAME',
  verbose: 'PIWI_VERBOSE',
  apiKey: 'PIWI_API_KEY',
  username: 'PIWI_USERNAME',
  password: 'PIWI_PASSWORD',
  environment: 'PIWI_ENVIRONMENT',
  label: 'PIWI_LABEL',
  runLabel: 'PIWI_RUN_LABEL',
  keep: 'PIWI_KEEP',
  streaming: 'PIWI_STREAMING',
  streamingBatchSize: 'PIWI_STREAMING_BATCH_SIZE',
  streamingBatchDelay: 'PIWI_STREAMING_BATCH_DELAY',
  maxStreamBufferBytes: 'PIWI_MAX_STREAM_BUFFER_BYTES',
  submitTimeout: 'PIWI_SUBMIT_TIMEOUT',
  liveFileUploads: 'PIWI_LIVE_FILE_UPLOADS',
  failOnFlakyTests: 'PIWI_FAIL_ON_FLAKY_TESTS',
  uploadTraces: 'PIWI_UPLOAD_TRACES',
  uploadReport: 'PIWI_UPLOAD_REPORT',
  captureLocators: 'PIWI_CAPTURE_LOCATORS',
  capturePageState: 'PIWI_CAPTURE_PAGE_STATE',
  capturePageInventory: 'PIWI_CAPTURE_PAGE_INVENTORY',
  captureCodeReach: 'PIWI_CAPTURE_CODE_REACH',
  codeReachRoots: 'PIWI_CODE_REACH_ROOTS',
  coverageBrowser: 'PIWI_COVERAGE_BROWSER',
  coverageServer: 'PIWI_COVERAGE_SERVER',
  externalIdPattern: 'PIWI_EXTERNAL_ID_PATTERN',
  externalIdOnDuplicate: 'PIWI_EXTERNAL_ID_ON_DUPLICATE',
  captureServerTraces: 'PIWI_CAPTURE_SERVER_TRACES',
  captureResources: 'PIWI_CAPTURE_RESOURCES',
  leakCheck: 'PIWI_LEAK_CHECK',
  sampleAriaOnPass: 'PIWI_SAMPLE_ARIA_ON_PASS',
  uploadManifest: 'PIWI_UPLOAD_MANIFEST',
  defaultCapture: 'PIWI_DEFAULT_CAPTURE',
  checkBaseUrl: 'PIWI_CHECK_BASE_URL',
  inspectOnFailure: 'PIWI_INSPECT_ON_FAIL',
  pickLocatorOnFailure: 'PIWI_PICK_LOCATOR_ON_FAIL',
  outputFile: 'PIWI_OUTPUT_FILE',
  aiMode: 'PIWI_AI',
  aiDir: 'PIWI_AI_DIR',
  aiOnMiss: 'PIWI_AI_ON_MISS',
  aiMaxSteps: 'PIWI_AI_MAX_FLOW_STEPS',
  aiMaxSnapshotChars: 'PIWI_AI_MAX_SNAPSHOT_CHARS',
  aiOptionalProbeTimeout: 'PIWI_AI_OPTIONAL_PROBE_TIMEOUT',
  aiResponseWaitTimeout: 'PIWI_AI_RESPONSE_WAIT_TIMEOUT',
  aiScreenshotFallback: 'PIWI_AI_SCREENSHOT_FALLBACK',
} as const;

/**
 * Set by an editor on the test run it starts, beside the two failure-time aids
 * (`inspectOnFailure`, `pickLocatorOnFailure`) the workers read. Not options:
 * the breakpoints change with every run, so the editor writes them and the
 * capture fixtures read them directly. Headed local runs only, never under CI:
 *  - `pauseAt` lists the lines to pause at before a locator action or
 *    assertion, semicolon-separated `file:line` relative to the working directory
 *    (forward slashes) or absolute: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`;
 *  - `editorSend` is the editor's Send to editor pairing address
 *    (`<url>#<token>`), which a locator picked while paused is posted to with
 *    the line it was picked at.
 * Beside them, `PIWI_RECORD_CHANNEL` (`@piwitests/core/ide-recorder`) names the
 * local socket of the editor service that built the command, over which the
 * pause bar's Record here hands the page to the editor's recorder.
 */
export const PIWI_LOCAL_DEBUG_ENV = {
  pauseAt: 'PIWI_PAUSE_AT',
  editorSend: 'PIWI_EDITOR_SEND',
} as const;

/**
 * Relocates the file `resolveOptions` reads the desktop app's connection details
 * from. Not part of `PIWI_ENV_KEYS` because it maps to no option — it only moves
 * the lookup off `defaultDesktopConfigPath()`.
 */
export const PIWI_DESKTOP_CONFIG_ENV = 'PIWI_DESKTOP_CONFIG';

/**
 * Marker `wrapConfig` writes when it fills in Playwright's `screenshot` / `trace`
 * options (see `defaultCapture`), carrying the comma-separated list of option
 * names it defaulted. Not part of `PIWI_ENV_KEYS` because it maps to no option —
 * the reporter reads it once in `onBegin` to log a single line naming the
 * defaults it applied.
 */
export const PIWI_DEFAULTED_CAPTURE_ENV = 'PIWI_DEFAULTED_CAPTURE';

/**
 * Env vars `piwi run` sets on the Playwright child process so the reporter can
 * stamp the run with the selection it resolved. Not options — the reporter reads
 * them directly when building `filterDetails`.
 */
export const PIWI_SELECTION_ENV = {
  key: 'PIWI_SELECTION',
  version: 'PIWI_SELECTION_VERSION',
  hash: 'PIWI_SELECTION_HASH',
  count: 'PIWI_SELECTION_COUNT',
} as const;

/**
 * What launched the run, set by the launcher on the Playwright process: the
 * desktop app, an editor, `piwi preflight`, `piwi bug`, a CI re-run dispatched
 * from the dashboard. Not options — the reporter reads them once to stamp the
 * run's `piwiOrigin` metadata:
 *  - `kind` is one of `RUN_ORIGIN_KINDS` (`@piwitests/core/wire`); unset, the
 *    run is `ci` when a CI provider is detected and `local` otherwise;
 *  - `ref` names what the run was launched for: a dispatch, a cluster or a bug
 *    report id.
 */
export const PIWI_ORIGIN_ENV = {
  kind: 'PIWI_ORIGIN',
  ref: 'PIWI_ORIGIN_REF',
} as const;

/** The environment a launcher adds to the Playwright process it starts, naming itself as the run's origin. */
export function originEnv(kind: string, ref?: string | number): Record<string, string> {
  return ref === undefined
    ? { [PIWI_ORIGIN_ENV.kind]: kind }
    : { [PIWI_ORIGIN_ENV.kind]: kind, [PIWI_ORIGIN_ENV.ref]: String(ref) };
}

/**
 * The `i/n` shard `piwi run --shard` sets on the Playwright child process. The
 * run's tests are already narrowed to that shard, so Playwright gets no `--shard`
 * of its own; the reporter reads this to report the shard to the dashboard, which
 * merges the shards of a run into one. Not an option — a `piwi select` job that
 * shards its own command line sets it by hand.
 */
export const PIWI_SHARD_ENV = 'PIWI_SHARD';

/**
 * Env vars a `piwi probe` run sets on the Playwright child process so the
 * capture fixtures run in probe mode. Not options — the probe CLI writes them and
 * the probe module reads them directly:
 *  - `flag` marks the run as a probe run;
 *  - `plan` / `results` point at the plan file and the JSONL outcomes file;
 *  - `secret` is the shared HMAC secret a server-level fault signs the
 *    `X-Piwi-Probe` header with.
 */
export const PIWI_PROBE_ENV = {
  flag: 'PIWI_PROBE',
  plan: 'PIWI_PROBE_PLAN',
  results: 'PIWI_PROBE_RESULTS',
  secret: 'PIWI_PROBE_SECRET',
} as const;

/**
 * Env vars a flake-lab run sets on the Playwright child process so the capture
 * fixtures run in flake mode. Not options — the lab writes them and the flake
 * module reads them directly:
 *  - `plan` points at the arm's plan file (`@piwitests/core/flake-plan`); a
 *    non-empty value switches flake mode on;
 *  - `results` points at the JSONL file each finished attempt is appended to.
 * A run is a probe run or a flake-lab run, never both: setting `PIWI_PROBE` and
 * `PIWI_FLAKE_PLAN` together stops the run (see `labModeConflict`).
 */
export const PIWI_FLAKE_ENV = {
  plan: 'PIWI_FLAKE_PLAN',
  results: 'PIWI_FLAKE_RESULTS',
} as const;

/**
 * The JSONL file each worker appends its last resource census to when it shuts
 * down: what was still open when no test was left to attach it to. The reporter
 * sets it in `onBegin`, before any worker starts, and reads it in `onEnd`. Not
 * an option — without it the census of a worker's last test stands in.
 */
export const PIWI_RESOURCES_RESULTS_ENV = 'PIWI_RESOURCES_RESULTS';

export function readBool(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined;
  return val === 'true';
}

/** How an env var's string value coerces into its option value. */
type EnvKind = 'string' | 'number' | 'bool';

/**
 * Declarative env → option fallback table. `resolveOptions` walks this instead
 * of repeating ~15 near-identical merge lines, so adding an env-backed option
 * means adding one row.
 *
 * Guard semantics:
 *  - `string` / `number`: a *truthy* env value fills the option, so an empty
 *    string is ignored.
 *  - `bool`: any *defined* env value fills it (via `readBool`), so
 *    `PIWI_STREAMING=false` actually disables streaming.
 *
 * `verbose` is intentionally absent — it *overrides* rather than falls back, and
 * is applied after the `DEFAULTS` merge in `resolveOptions`.
 */
const ENV_FALLBACK_SPECS: ReadonlyArray<{
  option: keyof PiwiDashboardOptions;
  env: string;
  kind: EnvKind;
}> = [
  { option: 'serverUrl', env: PIWI_ENV_KEYS.serverUrl, kind: 'string' },
  { option: 'projectName', env: PIWI_ENV_KEYS.projectName, kind: 'string' },
  { option: 'apiKey', env: PIWI_ENV_KEYS.apiKey, kind: 'string' },
  { option: 'username', env: PIWI_ENV_KEYS.username, kind: 'string' },
  { option: 'password', env: PIWI_ENV_KEYS.password, kind: 'string' },
  { option: 'environment', env: PIWI_ENV_KEYS.environment, kind: 'string' },
  { option: 'label', env: PIWI_ENV_KEYS.label, kind: 'string' },
  { option: 'runLabel', env: PIWI_ENV_KEYS.runLabel, kind: 'string' },
  { option: 'keep', env: PIWI_ENV_KEYS.keep, kind: 'bool' },
  { option: 'streaming', env: PIWI_ENV_KEYS.streaming, kind: 'bool' },
  { option: 'streamingBatchSize', env: PIWI_ENV_KEYS.streamingBatchSize, kind: 'number' },
  { option: 'streamingBatchDelay', env: PIWI_ENV_KEYS.streamingBatchDelay, kind: 'number' },
  { option: 'maxStreamBufferBytes', env: PIWI_ENV_KEYS.maxStreamBufferBytes, kind: 'number' },
  { option: 'submitTimeout', env: PIWI_ENV_KEYS.submitTimeout, kind: 'number' },
  { option: 'liveFileUploads', env: PIWI_ENV_KEYS.liveFileUploads, kind: 'bool' },
  { option: 'failOnFlakyTests', env: PIWI_ENV_KEYS.failOnFlakyTests, kind: 'bool' },
  { option: 'uploadTraces', env: PIWI_ENV_KEYS.uploadTraces, kind: 'bool' },
  { option: 'uploadReport', env: PIWI_ENV_KEYS.uploadReport, kind: 'bool' },
  { option: 'captureLocators', env: PIWI_ENV_KEYS.captureLocators, kind: 'bool' },
  { option: 'capturePageState', env: PIWI_ENV_KEYS.capturePageState, kind: 'bool' },
  { option: 'capturePageInventory', env: PIWI_ENV_KEYS.capturePageInventory, kind: 'bool' },
  { option: 'captureCodeReach', env: PIWI_ENV_KEYS.captureCodeReach, kind: 'bool' },
  { option: 'captureServerTraces', env: PIWI_ENV_KEYS.captureServerTraces, kind: 'bool' },
  { option: 'captureResources', env: PIWI_ENV_KEYS.captureResources, kind: 'bool' },
  { option: 'leakCheck', env: PIWI_ENV_KEYS.leakCheck, kind: 'string' },
  { option: 'sampleAriaOnPass', env: PIWI_ENV_KEYS.sampleAriaOnPass, kind: 'bool' },
  { option: 'uploadManifest', env: PIWI_ENV_KEYS.uploadManifest, kind: 'bool' },
  { option: 'defaultCapture', env: PIWI_ENV_KEYS.defaultCapture, kind: 'bool' },
  { option: 'checkBaseUrl', env: PIWI_ENV_KEYS.checkBaseUrl, kind: 'bool' },
  { option: 'inspectOnFailure', env: PIWI_ENV_KEYS.inspectOnFailure, kind: 'bool' },
  { option: 'pickLocatorOnFailure', env: PIWI_ENV_KEYS.pickLocatorOnFailure, kind: 'bool' },
  { option: 'outputFile', env: PIWI_ENV_KEYS.outputFile, kind: 'string' },
];

/**
 * The options `resolveOptions` also reads from the `.env` file in the
 * Playwright config's folder, the file `piwi init` writes: the connection,
 * under the variable names the CLI commands and the editors read from the same
 * file. Other variables in the file are not read: the workers take the rest of
 * the `PIWI_*` variables from the environment, which the file does not reach.
 */
const DOTENV_OPTIONS = ['serverUrl', 'apiKey', 'projectName'] as const;

/** The `.env` file a `resolveOptions` call took options from, and their variables. */
export interface DotEnvUse {
  file: string;
  keys: string[];
}

type DesktopAppMode = NonNullable<PiwiDashboardOptions['desktopApp']>;

const DESKTOP_APP_MODES: ReadonlyArray<DesktopAppMode> = ['prefer', 'fallback', 'off'];

/**
 * The `desktopApp` mode in force: `PIWI_DESKTOP_APP` over the option, and
 * `'fallback'` when neither names a known mode.
 */
function desktopAppMode(option: unknown, envValue: string | undefined): DesktopAppMode {
  const fromEnv = envValue?.trim().toLowerCase();
  if (DESKTOP_APP_MODES.includes(fromEnv as DesktopAppMode)) return fromEnv as DesktopAppMode;
  if (DESKTOP_APP_MODES.includes(option as DesktopAppMode)) return option as DesktopAppMode;
  return 'fallback';
}

let desktopDiscovered = false;
let desktopReplacedServerUrl: string | null = null;
let dotEnvUse: DotEnvUse | null = null;

/**
 * Whether the last `resolveOptions` call took its server URL and API key from
 * the running desktop app. The reporter logs this, so results never land in a
 * dashboard the user did not visibly configure.
 */
export function usedDesktopDiscovery(): boolean {
  return desktopDiscovered;
}

/**
 * The configured server the last `resolveOptions` call set aside for the
 * desktop app under `desktopApp: 'prefer'`, or `null` when it replaced none.
 */
export function desktopReplacedServer(): string | null {
  return desktopReplacedServerUrl;
}

/**
 * The `.env` file the last `resolveOptions` call took options from, and the
 * variables it took; null when it took none. The reporter logs it in verbose mode.
 */
export function usedDotEnv(): DotEnvUse | null {
  return dotEnvUse;
}

/**
 * Merge raw user options with defaults, reading from `PIWI_*` env vars when
 * options are not provided, then from the `.env` file in `configDir` for the
 * connection, and turning to the running desktop app as `desktopApp` says:
 * by default only when nothing points at a server at all.
 *
 * Env semantics: env vars fill in values the caller didn't provide (fallback).
 * They're applied to `raw` *before* the `DEFAULTS` merge so a built-in default
 * never masks an env var (`PIWI_PROJECT_NAME` would otherwise be masked by the
 * `default-project` default).
 *
 * `configDir` is the Playwright config's folder. The reporter and the global
 * setup both pass it, so the two processes read the same file and resolve the
 * same connection; without it, no `.env` file is read.
 *
 * `PIWI_VERBOSE` and `PIWI_DESKTOP_APP` win over both the default *and* an
 * explicit user option.
 */
export function resolveOptions(raw: Record<string, any>, configDir?: string): PiwiDashboardOptions {
  const env = process.env;
  const mergedRaw: Record<string, any> = { ...raw };

  for (const spec of ENV_FALLBACK_SPECS) {
    if (mergedRaw[spec.option] !== undefined) continue;
    const value = env[spec.env];
    if (spec.kind === 'bool') {
      if (value !== undefined) mergedRaw[spec.option] = readBool(value);
    } else if (value) {
      mergedRaw[spec.option] = spec.kind === 'number' ? Number(value) : value;
    }
  }

  // Below the options and the environment: the connection the config folder's
  // `.env` records, one variable at a time, as if the file were loaded into the
  // environment without overriding it. An empty value is ignored, as in the
  // environment.
  dotEnvUse = null;
  if (configDir) {
    const file = path.join(configDir, '.env');
    const dotEnv = readDotEnv(file);
    const keys: string[] = [];
    for (const option of DOTENV_OPTIONS) {
      const value = dotEnv[PIWI_ENV_KEYS[option]];
      if (mergedRaw[option] !== undefined || !value) continue;
      mergedRaw[option] = value;
      keys.push(PIWI_ENV_KEYS[option]);
    }
    if (keys.length > 0) dotEnvUse = { file, keys };
  }

  // Below everything else: the desktop app running on this machine. URL and
  // token always move together, so a hosted `serverUrl` is never paired with
  // the desktop's local token, nor the desktop with a hosted credential.
  // `'fallback'` adopts it only when *neither* is configured anywhere else, so
  // an explicit config, a `.env` value or a CI secret is never redirected;
  // `'prefer'` also sets a configured server aside for it outside CI.
  desktopDiscovered = false;
  desktopReplacedServerUrl = null;
  const mode = desktopAppMode(mergedRaw.desktopApp, env[PIWI_ENV_KEYS.desktopApp]);
  mergedRaw.desktopApp = mode;
  const serverUrlUnset = mergedRaw.serverUrl === undefined;
  const apiKeyUnset = mergedRaw.apiKey === undefined || mergedRaw.apiKey === null;
  const nothingConfigured = serverUrlUnset && apiKeyUnset;
  const preferLocally = mode === 'prefer' && !detectCi(env);
  if (mode !== 'off' && (nothingConfigured || preferLocally)) {
    const desktop = readDesktopConfig(env[PIWI_DESKTOP_CONFIG_ENV] || defaultDesktopConfigPath());
    if (desktop) {
      if (!serverUrlUnset && mergedRaw.serverUrl !== desktop.url) desktopReplacedServerUrl = mergedRaw.serverUrl;
      mergedRaw.serverUrl = desktop.url;
      mergedRaw.apiKey = desktop.token;
      mergedRaw.username = null;
      mergedRaw.password = null;
      desktopDiscovered = true;
    }
  }

  // Coverage is nested, so each of its variables fills the member the options leave unset.
  type CoverageOptions = NonNullable<PiwiDashboardOptions['coverage']>;
  const coverage: CoverageOptions = { ...mergedRaw.coverage };
  const coverageBrowser = env[PIWI_ENV_KEYS.coverageBrowser];
  const coverageServer = env[PIWI_ENV_KEYS.coverageServer];
  if (coverage.browser === undefined && coverageBrowser)
    coverage.browser = coverageBrowser as CoverageOptions['browser'];
  if (coverage.server === undefined && coverageServer) coverage.server = coverageServer as CoverageOptions['server'];
  if (coverage.browser !== undefined || coverage.server !== undefined) mergedRaw.coverage = coverage;

  // So are external IDs.
  type ExternalIdOptions = NonNullable<PiwiDashboardOptions['externalId']>;
  const externalId: ExternalIdOptions = { ...mergedRaw.externalId };
  const externalIdPattern = env[PIWI_ENV_KEYS.externalIdPattern];
  const externalIdOnDuplicate = env[PIWI_ENV_KEYS.externalIdOnDuplicate];
  if (externalId.pattern === undefined && externalIdPattern) externalId.pattern = externalIdPattern;
  if (externalId.onDuplicate === undefined && externalIdOnDuplicate)
    externalId.onDuplicate = externalIdOnDuplicate as ExternalIdOptions['onDuplicate'];
  if (Object.keys(externalId).length > 0) mergedRaw.externalId = externalId;

  const opts: PiwiDashboardOptions = { ...DEFAULTS, ...mergedRaw };

  // PIWI_VERBOSE wins over both default and user option.
  if (env[PIWI_ENV_KEYS.verbose] !== undefined) opts.verbose = env[PIWI_ENV_KEYS.verbose] === 'true';

  return opts;
}

/**
 * Write the options that the isolated `global-setup-module` process needs into
 * `PIWI_*` env vars. `wrapConfig` calls this so the global setup (which runs
 * `resolveOptions` in a separate module) picks up the same server/auth
 * config the reporter instance uses. Only writes values that are actually set:
 * one the config leaves unset, both processes take from the environment or the
 * config folder's `.env` on their own, at the same precedence.
 */
export function applyOptionsToEnv(options: PiwiDashboardOptions): void {
  const env = process.env;
  if (options.serverUrl !== undefined) env[PIWI_ENV_KEYS.serverUrl] = options.serverUrl;
  // `PIWI_DESKTOP_APP` overrides the option, so one already set is kept.
  if (options.desktopApp !== undefined && !env[PIWI_ENV_KEYS.desktopApp])
    env[PIWI_ENV_KEYS.desktopApp] = options.desktopApp;
  if (options.projectName !== undefined) env[PIWI_ENV_KEYS.projectName] = options.projectName!;
  if (options.verbose !== undefined) env[PIWI_ENV_KEYS.verbose] = String(options.verbose);
  if (options.apiKey) env[PIWI_ENV_KEYS.apiKey] = options.apiKey;
  if (options.username) env[PIWI_ENV_KEYS.username] = options.username;
  if (options.password) env[PIWI_ENV_KEYS.password] = options.password;
  if (options.environment) env[PIWI_ENV_KEYS.environment] = options.environment;
  if (options.label) env[PIWI_ENV_KEYS.label] = options.label;
  if (options.runLabel) env[PIWI_ENV_KEYS.runLabel] = options.runLabel;
  if (options.keep) env[PIWI_ENV_KEYS.keep] = 'true';
  if (options.checkBaseUrl !== undefined) env[PIWI_ENV_KEYS.checkBaseUrl] = String(options.checkBaseUrl);
  // Locator capture is part of performance-metric collection; switch it off in
  // the worker when either flag is disabled so the fixture skips the per-action
  // cost. Only an explicit `true` overrides the unset (default-on) state.
  if (options.captureLocators === false || options.collectPerformanceMetrics === false)
    env[PIWI_ENV_KEYS.captureLocators] = 'false';
  else if (options.captureLocators === true) env[PIWI_ENV_KEYS.captureLocators] = 'true';
  // Page-state capture follows the same bridge: off when either flag disables
  // it, explicit true otherwise (unset keeps the fixture's default-on).
  if (options.capturePageState === false || options.collectPerformanceMetrics === false)
    env[PIWI_ENV_KEYS.capturePageState] = 'false';
  else if (options.capturePageState === true) env[PIWI_ENV_KEYS.capturePageState] = 'true';
  // Page-inventory capture (controls and links per visited page, passing runs
  // only) follows the page-state bridge.
  if (options.capturePageInventory === false || options.collectPerformanceMetrics === false)
    env[PIWI_ENV_KEYS.capturePageInventory] = 'false';
  else if (options.capturePageInventory === true) env[PIWI_ENV_KEYS.capturePageInventory] = 'true';
  // Code reach (JavaScript coverage, Chromium only) follows the same bridge.
  if (options.captureCodeReach === false || options.collectPerformanceMetrics === false)
    env[PIWI_ENV_KEYS.captureCodeReach] = 'false';
  else if (options.captureCodeReach === true) env[PIWI_ENV_KEYS.captureCodeReach] = 'true';
  const roots = options.codeReachRoots;
  if (roots && (Array.isArray(roots) ? roots.length : Object.keys(roots).length)) {
    env[PIWI_ENV_KEYS.codeReachRoots] = JSON.stringify(roots);
  }
  // Coverage rides the same bridge: both sides off when performance metrics
  // are, each side's explicit value otherwise (unset keeps them off).
  if (options.collectPerformanceMetrics === false) {
    env[PIWI_ENV_KEYS.coverageBrowser] = 'off';
    env[PIWI_ENV_KEYS.coverageServer] = 'off';
  } else {
    if (options.coverage?.browser !== undefined) env[PIWI_ENV_KEYS.coverageBrowser] = options.coverage.browser;
    if (options.coverage?.server !== undefined) env[PIWI_ENV_KEYS.coverageServer] = options.coverage.server;
  }
  // Server-trace capture rides the same bridge: off when either flag disables
  // it, explicit true otherwise (unset keeps the fixture's default-on).
  if (options.captureServerTraces === false || options.collectPerformanceMetrics === false)
    env[PIWI_ENV_KEYS.captureServerTraces] = 'false';
  else if (options.captureServerTraces === true) env[PIWI_ENV_KEYS.captureServerTraces] = 'true';
  // The resource ledger runs in the worker fixtures; bridge only an explicit
  // value so an unset option keeps their defaults (on, report only).
  if (options.captureResources !== undefined) env[PIWI_ENV_KEYS.captureResources] = String(options.captureResources);
  if (options.leakCheck !== undefined) env[PIWI_ENV_KEYS.leakCheck] = options.leakCheck;
  // Green ARIA sampling runs in the worker fixture; bridge only an explicit
  // value so an unset option keeps the fixture's default-on behavior.
  if (options.sampleAriaOnPass === false) env[PIWI_ENV_KEYS.sampleAriaOnPass] = 'false';
  else if (options.sampleAriaOnPass === true) env[PIWI_ENV_KEYS.sampleAriaOnPass] = 'true';
  // Failure-time inspection and the locator picker run in the worker fixture,
  // so bridge them into the env the same way (default-off: only an explicit
  // option value is written).
  if (options.inspectOnFailure !== undefined) env[PIWI_ENV_KEYS.inspectOnFailure] = String(options.inspectOnFailure);
  if (options.pickLocatorOnFailure !== undefined)
    env[PIWI_ENV_KEYS.pickLocatorOnFailure] = String(options.pickLocatorOnFailure);
  // AI-step config is nested, so it can't ride the flat env-fallback table; bridge
  // it into the worker env by hand (the AI fixtures read these directly).
  if (options.ai?.mode !== undefined) env[PIWI_ENV_KEYS.aiMode] = options.ai.mode;
  if (options.ai?.dir !== undefined) env[PIWI_ENV_KEYS.aiDir] = options.ai.dir;
  if (options.ai?.onMiss !== undefined) env[PIWI_ENV_KEYS.aiOnMiss] = options.ai.onMiss;
  if (options.ai?.maxSteps !== undefined) env[PIWI_ENV_KEYS.aiMaxSteps] = String(options.ai.maxSteps);
  if (options.ai?.maxSnapshotChars !== undefined)
    env[PIWI_ENV_KEYS.aiMaxSnapshotChars] = String(options.ai.maxSnapshotChars);
  if (options.ai?.optionalProbeTimeout !== undefined)
    env[PIWI_ENV_KEYS.aiOptionalProbeTimeout] = String(options.ai.optionalProbeTimeout);
  if (options.ai?.responseWaitTimeout !== undefined)
    env[PIWI_ENV_KEYS.aiResponseWaitTimeout] = String(options.ai.responseWaitTimeout);
  if (options.ai?.screenshotFallback !== undefined)
    env[PIWI_ENV_KEYS.aiScreenshotFallback] = String(options.ai.screenshotFallback);
}
