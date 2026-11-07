/**
 * Wire leaf shapes — the small, identical building blocks of the JSON contract
 * exchanged between the reporter and the server. The single source of truth
 * shared by the app (`#shared/types`) and the reporter (`types/wire.ts`).
 *
 * The per-case *payloads* are intentionally NOT here: the reporter produces a
 * loose `WireTestCase` superset while the server receives the stricter
 * `TestCasePayload` / `StreamEventPayload`. Those live on each side and are kept
 * field-compatible by `apps/application/tests/unit/wire-shared-drift.test.ts`.
 */
import type { CoverageCapture, CoverageFile } from './coverage';

/** One entry per level in a test's suite path (parallel to `suitePath`). */
export interface SuiteConfigEntry {
  mode: 'parallel' | 'serial' | 'default';
  annotations: Array<{ type: string; description?: string }>;
}

export interface TestAnnotation {
  type: string;
  description?: string;
}

export type { TestMetadata } from './test-meta';

/**
 * A run produced by resolving a named selection (`piwi run <key>`), stamped onto
 * the run so the dashboard can name the subset and re-resolve the same
 * definition when a gate requires it.
 */
export interface SelectionStamp {
  /** The selection's project-unique slug. */
  key: string;
  /** The definition version this run resolved (definitions increment on edit). */
  version: number;
  /** SHA-256 over the sorted stable test identities the definition resolved to. */
  resolvedHash: string;
  /** How many tests the definition resolved to. */
  resolvedCount: number;
}

/**
 * Filter that narrowed a run to a subset of tests, recorded when `isFullRun`
 * is false.
 */
export interface FilterDetails {
  /** A non-default `--grep` pattern (Playwright's default `.*` is excluded). */
  grep?: string;
  /** A `--grep-invert` pattern. */
  grepInvert?: string;
  /** Positional file/path filters from the CLI invocation (e.g. ["tests/login.spec.ts"]). */
  files?: string[];
  /** Set when the run came from `piwi run <key>` resolving a saved selection. */
  selection?: SelectionStamp;
}

export interface BrowserConfig {
  projectName?: string;
  browserName?: string | null;
  channel?: string | null;
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number | null;
  isMobile?: boolean | null;
  hasTouch?: boolean | null;
  locale?: string | null;
  timezoneId?: string | null;
  geolocation?: { longitude: number; latitude: number; accuracy?: number } | null;
  colorScheme?: string | null;
  reducedMotion?: string | null;
  forcedColors?: string | null;
  contrast?: string | null;
  offline?: boolean | null;
  bypassCSP?: boolean | null;
  javaScriptEnabled?: boolean | null;
  serviceWorkers?: string | null;
  userAgent?: string | null;
}

/**
 * An error Playwright reported outside any test, through a reporter's `onError`: a global setup that threw, a spec
 * file that failed to load (`No tests found` and a web server that did not start come the same way), a worker
 * fixture whose teardown threw, the run stopped by `maxFailures`. A run carries at most `MAX_RUN_ERRORS` of them
 * (`@piwitests/core/run-errors`), each text with what may be a secret hidden and cut to `MAX_RUN_ERROR_CHARS`.
 */
export interface WireRunError {
  /** The error's message, its causes after it (`[cause]: …`), or the value thrown when it was not an `Error`. */
  message: string;
  /** The stack's frames (its `at …` lines), the message left out; null when it has none. */
  stack?: string | null;
  /** Where it was thrown: the file relative to the Playwright config's folder, with POSIX separators. */
  location?: { file: string; line: number; column: number } | null;
}

/**
 * One in-project source frame from a failure's call stack — the failing line
 * plus the callers above it — so the interesting code that led into the
 * assertion is visible, not just the test line that triggered it.
 */
export interface TestSourceFrame {
  /** Project-relative source path (e.g. `tests/checkout.spec.ts`). */
  file: string;
  /** 1-based line within `file` the stack frame points at. */
  line: number;
  /** Line-numbered snippet around `line`, with a `>` marker on it. */
  snippet: string;
}

/**
 * A hook/fixture/step event with absolute timings (for the timelines). A `pause` event is a stop at Piwi's pause bar
 * or in the editor: the call it held as its title, its call site as its location.
 */
export interface TestStepEvent {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string | null;
  category: 'hook' | 'fixture' | 'test.step' | 'expect' | 'wait' | 'pause';
  startedAt: number;
  duration: number;
  /**
   * `passed` or `failed`; `wasted` for a wait; for a stop, why it stopped: `breakpoint`, `step`, `pause` (asked from
   * the editor), `run-to` or `page-pause`.
   */
  status: string;
  location?: string | null;
  /** The first line of the step's error, when it failed — hook and fixture events only. */
  error?: string | null;
  /** The hooks and fixtures a hook section (`Before Hooks`, `After Hooks`) ran, in order. */
  hooks?: TestStepEventHook[] | null;
}

/** One hook or fixture a hook section ran: `beforeAll hook`, `Fixture "db"`, a titled hook. */
export interface TestStepEventHook {
  title: string;
  category: 'hook' | 'fixture';
  duration: number;
  /** True when it failed; absent when it passed. */
  failed?: boolean;
}

/**
 * One locator call and the page it ran on, as the capture fixtures record it
 * in the `piwi-locator-pages` attachment: a test's calls, deduped by call
 * site, chain and page. The dashboard joins it to the locator index, so a use
 * of a chain knows the pages it was made on.
 */
export interface LocatorPageUse {
  /** `file:line:col` of the call, as a step location reports it (absolute; the server makes it project-relative). */
  location: string;
  /** The chain as Playwright prints it (`Locator.toString()`). */
  locator: string;
  /** The page's origin (`https://shop.test`), to tell the application's pages from third-party ones. */
  origin: string;
  /** The page key: the path with ids and tokens collapsed, no query, no hash (`/orders/:id`). */
  page: string;
  /** No locator interaction happened on the page since it was navigated to: the element was there as it loaded. */
  arrival: boolean;
}

/**
 * One request a test made, as the capture fixtures record it in the
 * `piwi-network` attachment: its pages' API calls and documents, not static
 * assets, and its calls through an API request context.
 */
export interface WireNetworkRequest {
  method: string;
  url: string;
  /** The HTTP status; 0 when no response arrived (the request failed, or finished without one). */
  status: number;
  /**
   * Milliseconds to the response end; for a failed request, to the moment it failed; for a response whose body never
   * finished loading (the page cancelled it, or it was still open as the test ended), to its headers.
   */
  duration: number;
  /** Request start, Unix epoch milliseconds. */
  startTime?: number;
  /**
   * Playwright's resource type: `fetch`, `xhr`, `document` or `other`. Absent for a call through an API request
   * context (the `request` fixture, `page.request`), which no page made.
   */
  resourceType?: string;
  /** The response's content type, without parameters. */
  contentType?: string;
  /** Backend logs from the `X-Piwi-Logs` response header. */
  serverLogs?: unknown;
  /** Backend spans from the `X-Piwi-Trace` response header. */
  serverTraces?: unknown;
  /**
   * Why the request failed, as Playwright reports it (`net::ERR_CONNECTION_RESET`; for an API call, its error's first
   * line: `connect ECONNREFUSED …`); absent when it finished.
   */
  failure?: string;
  /**
   * True when no server sent the response: the test's own route handler fulfilled it (`route.fulfill`), or a cache
   * or a service worker served it. Absent for a response a server sent.
   */
  fulfilled?: boolean;
}

// ── Coverage ───────────────────────────────────────────────────────────────────

/** One file's coverage on the wire: its path, runtime, blob, and the function and line ranges that ran. */
export type WireCoverageFile = CoverageFile;

/** A test attempt's coverage on the wire, read by the server through `sanitizeCoverage`. */
export type WireCoverage = CoverageCapture;

// ── Resources ──────────────────────────────────────────────────────────────────

/** What a process is for the run, from its command line. */
export type ProcessRole =
  | 'runner'
  | 'worker'
  | 'browser'
  | 'renderer'
  | 'gpu'
  | 'utility'
  | 'ffmpeg'
  | 'webServer'
  | 'other';

/** The kinds of files tests attach, by Playwright's attachment names. */
export type ArtifactKind = 'trace' | 'video' | 'screenshot' | 'other';

/**
 * Name of the PNG the capture fixtures attach to a failed test: the page the
 * test last acted on. The reporter uploads it with the execution's files, and
 * the dashboard shows it as the page at the failure.
 */
export const FAILURE_SCREENSHOT_ATTACHMENT = 'piwi-failure-screenshot';

/** What the processes of one role used during a test. */
export interface RoleCost {
  cpuMs: number;
  /** Time runnable but waiting for a CPU. */
  runWaitMs: number | null;
  /** The largest process of the role during the test (its peak RSS). */
  peakRssMb: number | null;
  processes: number;
}

/**
 * What one execution cost its worker and the browsers the worker started, and
 * what it found and left open, as the capture fixtures measured it at the
 * test's start and end.
 */
export interface WireExecutionResources {
  /** CPU of the worker process. */
  workerCpuMs: number;
  /** The processes the worker started (its browsers), by role; Linux only. */
  roles?: Partial<Record<ProcessRole, RoleCost>> | null;
  /** Share of the test's time the worker's event loop was busy. */
  loopUtilization: number;
  loopDelayP99Ms: number;
  involuntarySwitches: number;
  heapUsedMb: number;
  /** Contexts and pages already open in the worker when the test started. */
  openAtStart?: { contexts: number; pages: number } | null;
  /** Objects the test opened itself and left open. */
  leftOpen?: number | null;
  /** Bytes of the files the test attached, by kind. */
  artifactBytes?: Partial<Record<ArtifactKind, number>> | null;
}

/**
 * `leaked`: open past the scope that opened it. `lingering`: closed within its
 * test, but long after the test last used it. `idle`: opened and never used.
 * `piling`: a long-lived owner that grows test after test. `handle`: a server
 * or process left running. `probable`: counted from the steps of a run without
 * the capture fixtures.
 */
export type ResourceVerdict = 'leaked' | 'lingering' | 'idle' | 'piling' | 'handle' | 'probable';

/** One finding of the end-of-run resource report: leaked objects, idle pages, piling handlers, Node handles. */
export interface WireResourceFinding {
  verdict: ResourceVerdict;
  /** The object kind, `handle` for a Node handle, `worker` for what piles up in a worker process itself. */
  kind: 'browser' | 'context' | 'page' | 'request' | 'handle' | 'worker';
  /** Where it was opened: `file:line`, a fixture, or a popup's trigger. */
  where: string;
  /** The line that opened it, `file:line`, when one is known. */
  site?: string | null;
  /** Leaked: the scope it outlived. */
  scope?: 'test' | 'describe';
  tests: number;
  /** The objects (or the leaks, for handles) grouped in this finding. */
  count: number;
  /** Leaked: how long the longest one stayed open past its scope, in ms; lingering: past its last use. */
  heldMs?: number;
  /** Leaked and lingering: the line of the last call a test made on it, where its close belongs. */
  lastUse?: string | null;
  /** Leaked: at least one was still open when its worker shut down. */
  untilWorkerEnd?: boolean;
  /** Leaked contexts and browsers: the open pages that went with them. */
  pages?: number;
  /** Leaked: closed by `PIWI_LEAK_CHECK=close`. */
  closedByPiwi?: boolean;
  /** Leaked past its test: main-thread CPU its pages used after the test (Chromium). */
  afterTestCpuMs?: number;
  /**
   * Piling: what grew, from how many to how many, over how many tests. A page
   * or a context counts its open pages, listeners, route handlers or attached
   * DOM elements; a worker process its heap after full garbage collections
   * (MB) or its open file descriptors.
   */
  growth?: {
    what: 'pages' | 'listeners' | 'routes' | 'elements' | 'heapMb' | 'descriptors';
    from: number;
    to: number;
    tests: number;
  };
  /** The describe a `beforeAll` belongs to, the fixtures set up with an idle page, a handle's test. */
  detail?: string;
}

/** What the processes of one role used over the run. */
export interface RoleUsage {
  cpuMs: number;
  /** Time runnable but waiting for a CPU; null where the platform cannot tell. */
  runWaitMs: number | null;
  processes: number;
}

/** What a run cost the machine it ran on, sampled by the reporter. */
export interface WireRunProfile {
  platform: string;
  wallMs: number;
  machine: {
    cores: number;
    memoryBytes: number;
    /** The container's memory limit, when it is below the machine's memory. */
    memoryLimitBytes: number | null;
    /** The container's CPU quota in cores, when it has one. */
    cpuQuotaCores: number | null;
  };
  cpu: {
    busyPct: number | null;
    iowaitPct: number | null;
    stealPct: number | null;
    /** Share of the run's wall time some task waited for a CPU (PSI). */
    pressurePct: number | null;
    /** Machine busy share per sample, in order. */
    series: number[];
    byRole: Partial<Record<ProcessRole, RoleUsage>> | null;
    throttledMs: number | null;
  };
  memory: {
    kind: 'pss' | 'rss' | null;
    peakBytes: number | null;
    /** When the peak was sampled, ms after the run started. */
    peakAtMs: number | null;
    largest: { role: ProcessRole; bytes: number } | null;
    rssFallbacks: number;
    pressurePct: number | null;
    lowestAvailableBytes: number | null;
    /** The container's peak, when the run raised it. */
    containerPeakBytes: number | null;
    oomKills: number | null;
  };
  disk: {
    peakInUseBytes: number | null;
    peakInUseIsLowerBound: boolean;
    lowestFreeBytes: number | null;
    leftoverBytes: number | null;
  };
  /** Metrics the machine could not read. */
  notMeasured: string[];
}

/** The workers' health over the run's tests, from their censuses. */
export interface WorkerHealth {
  tests: number;
  /** Mean share of each test's time the worker's event loop was busy. */
  loopUtilization: number;
  /** The worst test's p99 event-loop delay. */
  loopDelayP99Ms: number;
  /** Mean involuntary context switches of the worker per test. */
  involuntarySwitchesPerTest: number;
}

/** One point of a series over time: milliseconds after the series' `startedAt`, and the value then. */
export type SeriesPoint = [atMs: number, value: number];

/**
 * What the run used over time, on the clock of the reporter's machine, which
 * the tests' start times use too. Each series is in time order and bounded.
 */
export interface WireResourceTimeline {
  /** Epoch milliseconds every point counts from. */
  startedAt: number;
  /** The machine's busy CPU share, 0 to 100, over the interval ending at each point. Empty without the run sampler. */
  cpuPct: SeriesPoint[];
  /** Bytes the run's processes held in memory, as `profile.memory.kind` measures them. */
  memoryBytes: SeriesPoint[];
  /** Pages open in each worker, one point at each change. Empty without the capture fixtures. */
  pages: Array<{ worker: number; points: SeriesPoint[] }>;
  /**
   * The objects behind the run's leaked and lingering findings, each with the
   * stretch it stayed open for nothing: a leak from the end of the scope that
   * opened it to its close or its worker's end, a lingering object from its
   * last use to its close. Absent from reporters before it.
   */
  spans?: WireResourceSpan[];
  /**
   * Each worker process with the browsers it started: the cores they used
   * over the interval ending at each point, and the bytes they held, measured
   * as `profile.memory.kind` says. Needs the run sampler, and the capture
   * fixtures to tell which process is which worker; absent from reporters
   * before it.
   */
  workers?: Array<{ worker: number; cpuCores: SeriesPoint[]; memoryBytes: SeriesPoint[] }>;
}

/** An object open for nothing over a stretch of the run, as the timeline draws it. */
export interface WireResourceSpan {
  /** The worker process (Playwright's `workerIndex`). */
  worker: number;
  verdict: 'leaked' | 'lingering';
  kind: 'browser' | 'context' | 'page' | 'request';
  /** Where it was opened, as its finding names it. */
  where: string;
  site?: string | null;
  /** The line of the last call a test made on it. */
  lastUse?: string | null;
  /** Ms after the timeline's `startedAt` the stretch starts: its scope's end for a leak, its last use when lingering. */
  from: number;
  /** Ms after `startedAt` it ends: its close, or its worker's end. */
  to: number;
  /** A leak still open when its worker shut down. */
  untilWorkerEnd?: boolean;
  /** A leak: the scope it outlived. */
  scope?: 'test' | 'describe';
  /** The open pages that went with it: 1 for a page. */
  pages?: number;
  /** The test it outlived, or lingered in; for a `beforeAll` leak, the test that ran the hook. */
  test?: { title: string; file: string } | null;
}

/**
 * The request header a reporter sends a streaming run's token in, besides the
 * body: its setup token to `/api/test-runs/:id/begin`, its stream token to
 * `events`, `finish` and `live-resources`. The dashboard checks it before it
 * reads the body.
 */
export const RUN_TOKEN_HEADER = 'X-Piwi-Run-Token';

/**
 * What a reporter posts to `/api/test-runs/:id/live-resources` while someone
 * has the run open, beside its `streamToken`: the resources it measured since
 * its last post, so the run's timeline draws them as the run goes. The run's
 * stored report is still the one `finish` sends.
 */
export interface WireLiveResources {
  /** The reporter's shard, as its `begin` named it; null for a run that is not sharded. */
  shardIndex: number | null;
  /**
   * True when `timeline` holds every point so far and replaces what the server
   * holds for this reporter; false when its series only add the points read
   * since the last post.
   */
  reset: boolean;
  /**
   * The series, on the clock of the first post's `startedAt`. Each `pages`
   * entry replaces that worker's open pages, and a `workers` entry adds to that
   * worker's series.
   */
  timeline: WireResourceTimeline;
  /** The machine's memory, or its container's limit when lower; null without the run sampler. */
  memoryCapacityBytes: number | null;
  /** How the run's memory is measured: PSS, or RSS where PSS cannot be read; null until it is read. */
  memoryKind: 'pss' | 'rss' | null;
}

/** The dashboard's answer to a live resources post. */
export interface WireLiveResourcesAnswer {
  /** Whether anyone still has the run open; the reporter posts only while it is true. */
  watched: boolean;
  /** True when the dashboard holds nothing for this reporter: the next post carries every point so far. */
  resync?: boolean;
  /** True when the run's project declined the resources capability: the reporter posts nothing more for this run. */
  declined?: boolean;
}

/**
 * One reporter's resource report, sent with the run's end: the findings, what
 * the run cost its machine, and the pages open in each worker test after test.
 * A sharded run sends one per shard, each from its own machine.
 */
export interface WireResourceReport {
  v: 1;
  shardIndex?: number | null;
  findings: WireResourceFinding[];
  counts: Record<ResourceVerdict, number>;
  profile: WireRunProfile | null;
  /** Open pages in each worker at the end of each of its tests, in order. */
  workers: Array<{ worker: number; openPages: number[] }>;
  artifactBytes: Partial<Record<ArtifactKind, number>>;
  workerHealth: WorkerHealth | null;
  /** CPU, memory and open pages over time; absent from reporters before it. */
  timeline?: WireResourceTimeline | null;
}

/**
 * What launched a run. The launcher sets `PIWI_ORIGIN` (and `PIWI_ORIGIN_REF`)
 * on the Playwright process; the reporter stamps the run's metadata with it
 * under {@link RUN_ORIGIN_METADATA_KEY}, and the dashboard decides from it
 * which analyses the run may feed.
 *
 * - `ci`: a CI pipeline, the default when a CI provider is detected;
 * - `ci-rerun`: a CI pipeline the dashboard dispatched to re-run a cluster;
 * - `local`: a developer's machine, the default otherwise;
 * - `desktop`, `editor`: a run started from the desktop app or an editor;
 * - `preflight`, `bug`: `piwi preflight --run` and `piwi bug --write`;
 * - `flake-lab`, `probe`: runs replaying tests under injected conditions;
 * - `bisect`, `reproduce`: steps of a bisect and reproductions of a failure
 *   at an older commit;
 * - `import`: a report imported into the dashboard, stamped by the server.
 */
export const RUN_ORIGIN_KINDS = [
  'ci',
  'ci-rerun',
  'local',
  'desktop',
  'editor',
  'preflight',
  'bug',
  'flake-lab',
  'probe',
  'bisect',
  'reproduce',
  'import',
] as const;

export type RunOriginKind = (typeof RUN_ORIGIN_KINDS)[number];

/** A run's origin: its kind, and what it was launched for (a dispatch, a cluster, a bug report). */
export interface RunOrigin {
  kind: RunOriginKind;
  ref?: string;
}

/** The run-metadata key holding the {@link RunOrigin}. */
export const RUN_ORIGIN_METADATA_KEY = 'piwiOrigin';

/**
 * The run-metadata key holding the launcher's name for the run itself (`PIWI_RUN_REF`), a string read by
 * {@link parseRunOriginRef}, beside the origin's `ref`, which names what the run was launched for.
 */
export const RUN_REF_METADATA_KEY = 'piwiRunRef';

/** The longest `ref` kept. */
export const RUN_ORIGIN_REF_MAX_LENGTH = 200;

const RUN_ORIGIN_REF = /^[A-Za-z0-9._:/#@-]+$/;

/** True for one of the {@link RUN_ORIGIN_KINDS}. */
export function isRunOriginKind(value: unknown): value is RunOriginKind {
  return typeof value === 'string' && (RUN_ORIGIN_KINDS as readonly string[]).includes(value);
}

/**
 * A `ref` as stored: trimmed, at most {@link RUN_ORIGIN_REF_MAX_LENGTH}
 * characters of letters, digits and `._:/#@-`. Anything else is dropped.
 */
export function parseRunOriginRef(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ref = String(value).trim();
  return ref && ref.length <= RUN_ORIGIN_REF_MAX_LENGTH && RUN_ORIGIN_REF.test(ref) ? ref : undefined;
}

/**
 * A {@link RunOrigin} read from untrusted input, rebuilt as `{ kind, ref? }`,
 * or null when its kind is not one of the {@link RUN_ORIGIN_KINDS}.
 */
export function parseRunOrigin(value: unknown): RunOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { kind, ref } = value as { kind?: unknown; ref?: unknown };
  if (!isRunOriginKind(kind)) return null;
  const parsedRef = parseRunOriginRef(ref);
  return parsedRef === undefined ? { kind } : { kind, ref: parsedRef };
}

/**
 * A run a local hub steers: the editor service's or the desktop app's, whose run channel the run's workers connect to
 * (`@piwitests/core/run-channel`), where a person stops its tests at their breakpoints. The reporter stamps the run's
 * metadata with it under {@link RUN_INTERACTIVE_METADATA_KEY}; a run that follows no hub carries none.
 */
export interface RunInteractive {
  /**
   * The hub's client as the reporter knows it: the editor's own name from its discovery file, else the launcher the
   * run's `PIWI_ORIGIN` names (`editor`, `desktop`); null when nothing names it.
   */
  client: string | null;
  /** The run's name on the hub, as its workers give it in `run-attach`: letters, digits, `_` and `-`, 64 at most. */
  ref: string;
}

/** The run-metadata key holding the {@link RunInteractive}. */
export const RUN_INTERACTIVE_METADATA_KEY = 'piwiInteractive';

/** The longest `client` kept. */
export const RUN_INTERACTIVE_CLIENT_MAX_LENGTH = 200;

const HUB_RUN_REF = /^[\w-]{1,64}$/;

/** A control character (C0, DEL, C1), a line or paragraph separator, or a bidirectional mark. */
function isControlOrMark(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * A {@link RunInteractive} read from untrusted input, rebuilt as `{ client, ref }`, or null when its `ref` is not a
 * hub's name for a run. A `client` that is not text of at most {@link RUN_INTERACTIVE_CLIENT_MAX_LENGTH} characters
 * without control characters (C0, DEL, C1), line or paragraph separators and bidirectional marks reads as null.
 */
export function parseRunInteractive(value: unknown): RunInteractive | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { client, ref } = value as { client?: unknown; ref?: unknown };
  if (typeof ref !== 'string' || !HUB_RUN_REF.test(ref)) return null;
  const name = typeof client === 'string' ? client.trim() : '';
  const oneLine = ![...name].some((char) => isControlOrMark(char.codePointAt(0)!));
  const readable = name.length > 0 && name.length <= RUN_INTERACTIVE_CLIENT_MAX_LENGTH && oneLine;
  return { client: readable ? name : null, ref };
}

/** Why a test stopped on a developer's machine; `other` for a reason of a newer reporter. */
export type TestStopReason = 'breakpoint' | 'step' | 'pause' | 'run-to' | 'page-pause' | 'failure' | 'other';

const TEST_STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause', 'failure'];

/** The longest call title a {@link TestStop} carries, in characters: a longer one is cut. */
export const MAX_TEST_STOP_TITLE = 500;

/**
 * A test stopped on a developer's machine, as its reporter tells the instance (`test-stopped`) while someone has the
 * run open: why, the call it stands before (its title, without the text it types, and its place in the test's code,
 * relative to the run's folder), whether the test's browser shows Piwi's pause bar, when it stopped (`since`, epoch
 * ms), and how long its attempt stood stopped before this stop (`pausedMs`).
 */
export interface TestStop {
  reason: TestStopReason;
  title: string;
  file: string | null;
  line: number | null;
  bar: boolean;
  since: number;
  pausedMs: number;
}

/** A whole number of milliseconds, 0 or more, within a year. */
function ms(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 31_536_000_000;
}

/**
 * A {@link TestStop} read from untrusted input, rebuilt field by field, or null when it does not read: an unknown
 * reason reads as `other`, a title is cut to {@link MAX_TEST_STOP_TITLE} characters, a place that does not read as
 * none.
 */
export function parseTestStop(value: unknown): TestStop | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { reason, title, file, line, bar, since, pausedMs } = value as Record<string, unknown>;
  if (typeof reason !== 'string' || typeof title !== 'string' || typeof bar !== 'boolean') return null;
  if (typeof since !== 'number' || !Number.isInteger(since) || since <= 0 || !ms(pausedMs)) return null;
  const placed = typeof file === 'string' && file.length > 0 && file.length <= 1000;
  return {
    reason: TEST_STOP_REASONS.includes(reason) ? (reason as TestStopReason) : 'other',
    title: title.slice(0, MAX_TEST_STOP_TITLE),
    file: placed ? file : null,
    line: placed && typeof line === 'number' && Number.isInteger(line) && line > 0 ? line : null,
    bar,
    since,
    pausedMs,
  };
}

/** How long an attempt stood stopped, in ms, as a `test-resumed` says it; null when it does not read. */
export function parsePausedMs(value: unknown): number | null {
  return ms(value) ? value : null;
}
