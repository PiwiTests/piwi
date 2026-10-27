import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { probeElementAttrs, type ProbeArg, type ProbedAttrs } from '@piwitests/picker-dom';
import { sanitizePageInteraction, type PageInteraction } from '@piwitests/core/page-interaction';
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Fixtures,
  FrameLocator,
  Locator,
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  Request,
  Response,
  TestInfo,
  TestType,
  WorkerInfo,
} from '@playwright/test';
import {
  generateAlternatives,
  extractAccessibleName,
  approximateAccessibleName,
  captureCallerLocation,
  dedupeSnapshotsByLocation,
  exactAccessibleName,
  resolveAriaRole,
  suggestLocatorsFromAria,
  FORM_FIELD_TAGS,
  LOCATOR_METHODS,
  CHAIN_METHODS,
  ACTION_METHODS,
  LOCATOR_CREATING_CHAINS,
  EXPECT_METHOD,
  EXPECT_CAPTURE_EXPRESSIONS,
  CAPTURED_ATTRIBUTES,
  TAG_TO_ROLE,
  INPUT_TYPE_TO_ROLE,
  renderFailing,
  type LocatorSnapshot,
  type FailedLocatorInfo,
} from './locator-healing.js';
import {
  ATTACHMENT_NAMES,
  FAILURE_SCREENSHOT_ATTACHMENT,
  LOCATOR_SUGGESTION_ANNOTATION,
  USER_PICK_ANNOTATION,
} from './attachments.js';
import { keepsFailureScreenshots, readFailureScreenshot, type ScreenshotOption } from './failure-screenshot.js';
import {
  capPageInventory,
  collectPageInventoryInPage,
  inventoryPageKey,
  type RawPageInventory,
} from './page-inventory.js';
import { LocatorPageLog, noteLocatorCall, noteNavigation } from './locator-pages.js';

// Re-exported for the dogfood fixtures (`apps/application/tests/fixtures.ts`),
// which rebuild this wrapper and must record pages the same way.
export { LocatorPageLog, noteLocatorCall, noteNavigation } from './locator-pages.js';
import {
  isProbeMode,
  probeItemForTest,
  recordProbeOutcome,
  outcomeFromStatus,
  classifyProbeHandled,
} from '../probe/mode.js';
import { installProbeInterception, type ProbeInterception } from '../probe/interception.js';
import type { ProbePlanItem } from '../probe/plan.js';
import {
  flakeResultLine,
  flakeRoleForTest,
  installFlakeConditions,
  isFlakeMode,
  labModeConflict,
  loadFlakePlan,
  pageBrowserName,
  recordFlakeResult,
  unappliedReports,
  type FlakeConditions,
} from '../flake/mode.js';
import type { FlakePlan } from '@piwitests/core/flake-plan';
import { joinErrorMessages } from '@piwitests/core/error-text';
import { finalizeCodeReach } from '@piwitests/core/code-reach';
import { maskUrlFragment } from '@piwitests/core/mask';
import { environmentalSkipReason, inspectionGateFromTestInfo, shouldInspectOnFailure } from './inspect-on-failure.js';
import {
  applyPickToSnapshots,
  deriveFailedLocator,
  runLocatorPicker,
  type PickedLocator,
  type UserPickResult,
} from './pick-on-failure.js';
import {
  atStop,
  BarIntents,
  callSiteLine,
  callSitePlace,
  contextDebugger,
  currentPauseSet,
  goOn,
  logPauseSkipOnce,
  NO_BREAKPOINTS,
  pauseGateFromTestInfo,
  pauseHere,
  pauseSkipReason,
  pauseState,
  pickPayload,
  placeLine,
  postPickToEditor,
  replacePauseSet,
  steerDebugger,
  stopCallSite,
  stopShown,
  wantsStops,
  watchStops,
  withTestTimeoutHeld,
  type GoOn,
  type PauseAnswer,
  type PauseRecord,
  type PauseState,
  type StopReason,
} from './pause-at.js';
import { canRecordFromHere, recordFromHere } from './record-handoff.js';
import {
  closeRunChannel,
  editorSendAddress,
  hideRunChannel,
  holdStop,
  openRunChannel,
  runChannelOpen,
  tellHub,
  type RunControl,
} from './run-channel.js';
import { RUN_INTENT_NAMES, type IntentAnswer, type RunIntent, type RunToHub } from '@piwitests/core/run-channel';
import {
  browserCoverageInWorker,
  browserFunctionCoverage,
  newKnownFunctions,
  browserFunctionsInWorker,
  serverCoverageInWorker,
} from '../collect/coverage-settings.js';
import type { LineRange } from '@piwitests/core/coverage';
import { isDueForAriaSample } from '../support/aria-sampling.js';
import { configDirFromConfig } from '../support/test-paths.js';
import { boxCaptureFrames, callMethod, internalCall } from './quiet-capture.js';
import {
  codeReachRoots,
  pageMapFetcher,
  resolveCodeReach,
  resolveCodeReachFunctions,
  startCodeReach,
  stopCodeReach,
  type CodeReachRoots,
  type CodeReachRootsOption,
} from './code-reach.js';
import {
  activeResourceLedger,
  noteResourceUse,
  recordResourceCensus,
  startResourceLedger,
  stopResourceLedger,
} from './resource-ledger.js';
import { readPageInteraction } from './page-interaction.js';
import {
  apiCallEntry,
  observeApiRequestContext,
  observeApiRequests,
  type ApiCall,
  type ApiCallRecorder,
} from './api-requests.js';

// Re-exported: probeElementAttrs now lives in @piwitests/picker-dom (shared
// with the dashboard's snapshot picker), but the dogfood mirror
// (`application/tests/fixtures.ts`) and this package's own tests import it
// from here, as the mirror does the quiet-capture helpers and the page
// interaction read.
export { probeElementAttrs, internalCall, boxCaptureFrames, callMethod, readPageInteraction };
export { codeReachRoots, pageMapFetcher, resolveCodeReach, startCodeReach, stopCodeReach };
// The dogfood mirror runs the same resource ledger from its own fixtures.
export { activeResourceLedger, noteResourceUse, recordResourceCensus, startResourceLedger, stopResourceLedger };
export type { ProbeArg, ProbedAttrs };

/** A Playwright fixture's `use` callback — hands the fixture value to the test. */
type UseFn<T> = (value: T) => Promise<void>;

// Playwright constrains `TestType`'s args to its internal `KeyValue`
// (`{ [key: string]: any }`) — mirror it so real `test` objects satisfy the
// bound (their args are index-signature-free interfaces) while a non-test
// argument is still rejected by the `TestType` parameter type.
type FixtureArgs = { [key: string]: any };

/** The subset of a Playwright `Dialog` the close-event reader touches. */
interface DialogLike {
  type?: () => string;
  message?: () => string;
  defaultValue?: () => string;
}

/** Shape returned by the in-page web-vitals probe (see `flushSink`). */
interface WebVitals {
  navigation: {
    url: string;
    ttfb: number;
    domInteractive: number;
    domContentLoaded: number;
    loadComplete: number;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
  } | null;
  paint: Record<string, number>;
  /**
   * Core Web Vitals from buffered PerformanceObserver entries. Chromium-only —
   * Firefox/WebKit don't expose these entry types, so each value is null there.
   * `inp` is null when the test produced no interactions (common in short tests).
   */
  vitals: {
    lcp: number | null;
    cls: number | null;
    inp: number | null;
  } | null;
}

/** Plain-object projection of a performance entry, shipped out of the page. */
export interface RawVitalEntry {
  startTime?: number;
  value?: number;
  hadRecentInput?: boolean;
  interactionId?: number;
  duration?: number;
}

/**
 * Aggregate buffered performance entries into LCP/CLS/INP. Pure and Node-side
 * so it is unit-testable; the in-page evaluate only ships raw entry projections.
 * A null entry list means the entry type is unsupported (non-Chromium) — the
 * metric is null rather than 0 so absence is distinguishable from "no shifts".
 */
export function computeCoreVitals(
  lcpEntries: RawVitalEntry[] | null,
  shiftEntries: RawVitalEntry[] | null,
  eventEntries: RawVitalEntry[] | null,
): { lcp: number | null; cls: number | null; inp: number | null } | null {
  // The last LCP candidate is the final LCP.
  const lastLcp = lcpEntries && lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : null;
  const lcp = lastLcp && typeof lastLcp.startTime === 'number' ? Math.round(lastLcp.startTime) : null;

  // Simple sum over shifts without recent input. The spec's session-window
  // grouping matters for long sessions; a test's page lifetime is short enough
  // that the plain sum tracks it closely.
  let cls: number | null = null;
  if (shiftEntries) {
    const sum = shiftEntries.reduce(
      (acc, e) => acc + (e.hadRecentInput ? 0 : typeof e.value === 'number' ? e.value : 0),
      0,
    );
    cls = Math.round(sum * 10000) / 10000;
  }

  // Worst interaction latency: max duration per interactionId, then the p98
  // interaction when there are many (mirrors the INP definition, simplified).
  let inp: number | null = null;
  if (eventEntries && eventEntries.length > 0) {
    const byInteraction = new Map<number, number>();
    for (const e of eventEntries) {
      if (typeof e.interactionId !== 'number' || e.interactionId <= 0) continue;
      const duration = typeof e.duration === 'number' ? e.duration : 0;
      const prev = byInteraction.get(e.interactionId) ?? 0;
      if (duration > prev) byInteraction.set(e.interactionId, duration);
    }
    const durations = [...byInteraction.values()].sort((a, b) => a - b);
    if (durations.length > 0) {
      const index = durations.length > 50 ? Math.floor(durations.length * 0.98) : durations.length - 1;
      inp = Math.round(durations[Math.min(index, durations.length - 1)]!);
    }
  }

  if (lcp === null && cls === null && inp === null) return null;
  return { lcp, cls, inp };
}

/**
 * Per-test capture buffers. One sink is created per test and stashed in the
 * module-level `currentSink` while that test runs; page/locator instrumentation
 * reads `currentSink` live so events route to whichever test is executing.
 */
interface CaptureSink {
  networkRequests: Array<Record<string, unknown>>;
  // The responses of tracked requests that have neither finished nor failed
  // yet; the ones still open at teardown are recorded then.
  openResponses: Map<Request, Response>;
  consoleEntries: Array<Record<string, unknown>>;
  dialogs: Array<Record<string, unknown>>;
  pendingHandlers: Promise<void>[];
  capturedLocators: LocatorSnapshot[];
  capturePromises: Promise<void>[];
  failedLocators: FailedLocatorInfo[];
  // Call sites already probed this test, by action or by assertion. Only one
  // snapshot per location survives `dedupeSnapshotsByLocation` and the server
  // stores one row per location, so every probe after the first at a given
  // line is work whose result is thrown away — a loop or a page-object method
  // called repeatedly hits the same line many times over. A location is
  // removed again if its probe fails, so a later call still gets to try.
  probedLocations: Set<string>;
  // Most-recently-touched instrumented page — used at teardown for the failure
  // ARIA snapshot and web-vitals read when a test drives several pages.
  lastActivePage: Page | null;
  // The running test's info, so close wrappers can see its status mid-teardown.
  testInfo: TestInfo | null;
  // Page-dependent teardown reads, taken by the close wrappers while the page
  // was still open. The auto capture fixture tears down AFTER the built-in
  // page/context fixtures, so by the time flushSink runs the standard test
  // page is already closed and can no longer be read live.
  stashedWebVitals: WebVitals | null;
  stashedPageState: PageState | null;
  stashedAria: string | null;
  // The failure-time aria tree as JSON (Playwright ≥ 1.63), stringified. Feeds
  // the healing, clue and page-diff paths that read a tree; the YAML above feeds
  // the ARIA card.
  stashedAriaJson: string | null;
  // Playwright's `screenshot` option when it keeps this attempt's failure
  // screenshots, null when it keeps none; and the failure-page screenshot the
  // close wrappers took while the page was still open.
  failureScreenshot: ScreenshotOption | null;
  stashedScreenshot: Buffer | null;
  // One window per URL the test navigated to, each stamped with its settle time,
  // so the dashboard can attribute a request to the page that was current when it
  // started rather than to the end-of-test page. Controls/links are filled at
  // most once per page key per worker; revisits keep a content-less window.
  pageInventories: RawPageInventory[];
  // The probe plan item for this test (probe mode only), and the interception
  // handle once installed, so the outcome can be recorded at teardown.
  probeItem: ProbePlanItem | null;
  // While a server probe runs: the page errors nothing caught, and whether the
  // page showed no text as it closed, for the probe's resilience finding.
  probePageErrors: number;
  probeBlankPage: boolean;
  probeInterception: ProbeInterception | null;
  // Flake mode only: the arm's plan, this test's role in it, when the capture
  // started, and (for the target) the conditions installed on its first page.
  flake: {
    plan: FlakePlan;
    role: 'target' | 'companion';
    startedAt: number;
    browserName: string | null;
    conditions: Promise<FlakeConditions> | null;
  } | null;
  // The failure-time overlay was already offered once this test — several
  // close wrappers can fire for the same teardown.
  pickOffered: boolean;
  // A replacement locator the human confirmed in the failure-time picker.
  userPick: UserPickResult | null;
  // The editor's breakpoints (`PIWI_PAUSE_AT`, or the ones its run connection sent) for this attempt, with Step,
  // Finish and the stops the editor asks; null when it has none and no run connection is open, or the gate refuses,
  // until a `page.pause()` Piwi takes over.
  pause: PauseState | null;
  // While the pause is on, the locator calls in flight by call site without its column: a stop on one of their lines
  // highlights the call's element, and a pick there is folded into its snapshot.
  locatorCalls: Map<string, LocatorCall>;
  // The stops shown, with the pause bar or in the editor, for the `piwi-pauses` attachment: each listed as it shows,
  // its duration set as it ends.
  stops: PauseRecord[];
  // The stops shown now, by the handle that ends each when the test ends under it.
  shownStops: Map<AbortController, ShownStop>;
  // Settles once teardown has read the test's pages and attached its data (`markFlushed`): a call held under a bar the
  // test ended under goes on then.
  flushed: Promise<void>;
  markFlushed: () => void;
  // The page each locator call ran on, keyed by call site and chain.
  locatorPages: LocatorPageLog;
  // JavaScript coverage of each page the test has, when code reach is on, and
  // the source files they resolved to once stopped.
  // With `coverage.browser: 'functions'`, every function the scripts declare in those files, run or not.
  codeReach: {
    sessions: Map<Page, CodeReachSession>;
    files: Map<string, LineRange[]>;
    known: Map<string, LineRange[]>;
  };
  // The server coverage request ids (`X-Piwi-Coverage`) the test's responses
  // carried, by origin, when server coverage is on.
  serverCoverage: Map<string, Set<string>>;
  // The test's `baseURL` option, which Playwright gives every request context
  // created during the test that names none of its own.
  baseURL: string | null;
}

function createSink(): CaptureSink {
  let markFlushed = (): void => {};
  const flushed = new Promise<void>((resolve) => (markFlushed = resolve));
  return {
    networkRequests: [],
    openResponses: new Map(),
    consoleEntries: [],
    dialogs: [],
    pendingHandlers: [],
    capturedLocators: [],
    capturePromises: [],
    failedLocators: [],
    probedLocations: new Set(),
    lastActivePage: null,
    testInfo: null,
    stashedWebVitals: null,
    stashedPageState: null,
    stashedAria: null,
    stashedAriaJson: null,
    failureScreenshot: null,
    stashedScreenshot: null,
    pageInventories: [],
    probeItem: null,
    probePageErrors: 0,
    probeBlankPage: false,
    probeInterception: null,
    flake: null,
    pickOffered: false,
    userPick: null,
    pause: null,
    locatorCalls: new Map(),
    stops: [],
    shownStops: new Map(),
    flushed,
    markFlushed,
    locatorPages: new LocatorPageLog(),
    codeReach: { sessions: new Map(), files: new Map(), known: new Map() },
    serverCoverage: new Map(),
    baseURL: null,
  };
}

/** The JavaScript coverage of one page during one test. */
interface CodeReachSession {
  started: Promise<boolean>;
  stopped: boolean;
  /** Settles once the page's coverage is stopped and resolved into the sink's files. */
  stopping?: Promise<void>;
}

/**
 * Pages already open as a test starts that it records JavaScript coverage on at
 * most, with those still recording: a worker may hold many pages a test never
 * drives. A page the test opens always records.
 */
const MAX_CODE_REACH_PAGES = 16;

/** How long the start of a test waits for coverage to run on the pages already open, in ms. */
const CODE_REACH_START_WAIT_MS = 2000;

/**
 * Start JavaScript coverage on a page of the running test when code reach is on
 * (`PIWI_CAPTURE_CODE_REACH=true` or `PIWI_COVERAGE_BROWSER=files`): each page
 * the test opens, and each page already open as it starts. Resolves once
 * coverage is running, so a caller can await it before the test navigates.
 */
function maybeStartCodeReach(page: Page, alreadyOpen = false): Promise<boolean> {
  const sink = currentSink;
  if (!sink || !browserCoverageInWorker() || isPageClosed(page)) return Promise.resolve(false);
  const known = sink.codeReach.sessions.get(page);
  if (known) return known.started;
  if (alreadyOpen) {
    let recording = 0;
    for (const [other, session] of sink.codeReach.sessions) if (!session.stopped && !isPageClosed(other)) recording++;
    if (recording >= MAX_CODE_REACH_PAGES) return Promise.resolve(false);
  }
  const started = startCodeReach(page);
  sink.codeReach.sessions.set(page, { started, stopped: false });
  return started;
}

/**
 * Start coverage on the pages open as a test begins: a page a `beforeAll` or an
 * earlier test opened, which the test drives without creating. Waits a bounded
 * time, so a page that does not answer never holds the test.
 */
async function startCodeReachOnOpenPages(): Promise<void> {
  if (!browserCoverageInWorker() || OPEN_PAGES.size === 0) return;
  const started = Promise.all([...OPEN_PAGES].map((page) => maybeStartCodeReach(page, true)));
  await Promise.race([started, new Promise((resolve) => setTimeout(resolve, CODE_REACH_START_WAIT_MS).unref())]);
}

/**
 * The code reach roots from `PIWI_CODE_REACH_ROOTS`: a JSON array, a JSON object
 * of directories per origin (`*` for every other origin), or a path list.
 */
export function configuredCodeReachRoots(): CodeReachRootsOption | null {
  const raw = process.env.PIWI_CODE_REACH_ROOTS?.trim();
  if (!raw) return null;
  const dirs = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter((r): r is string => typeof r === 'string' && r !== '');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return dirs(parsed);
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(Object.entries(parsed).map(([origin, value]) => [origin, dirs(value)]));
    }
  } catch {
    // Not JSON: a path list.
  }
  return raw.split(path.delimiter).filter(Boolean);
}

/**
 * Stop the test's coverage and resolve it to source files, while each page can
 * still fetch source maps. With `closing`, only on that page, or on the pages of
 * that context; without it, also waits for the stops a closing page or context
 * started. Never throws.
 */
async function stopSinkCodeReach(
  sink: CaptureSink,
  closing?: { page?: Page; context?: BrowserContext },
): Promise<void> {
  const stopping: Array<[Page, CodeReachSession]> = [];
  const underway: Array<Promise<void>> = [];
  for (const [page, session] of sink.codeReach.sessions) {
    if (session.stopped) {
      if (!closing && session.stopping) underway.push(session.stopping);
      continue;
    }
    if (closing && closing.page !== page && (!closing.context || pageContext(page) !== closing.context)) continue;
    session.stopped = true;
    stopping.push([page, session]);
  }
  if (stopping.length > 0) {
    const info = sink.testInfo;
    const roots = codeReachRoots(configDirFromConfig(info?.config), configuredCodeReachRoots());
    for (const [page, session] of stopping) {
      session.stopping = stopPageCodeReach(sink, page, session, roots);
      underway.push(session.stopping);
    }
  }
  await Promise.all(underway);
}

/** Stop one page's coverage and add the files it resolves to the sink's. Never throws. */
async function stopPageCodeReach(
  sink: CaptureSink,
  page: Page,
  session: CodeReachSession,
  roots: CodeReachRoots,
): Promise<void> {
  try {
    if (!(await session.started) || isPageClosed(page)) return;
    const entries = await stopCodeReach(page);
    if (!entries) return;
    const { reached, known } = await resolveCodeReachFunctions(entries, roots, pageMapFetcher(page), page.url(), {
      known: browserFunctionsInWorker(),
    });
    for (const [file, functions] of reached) {
      sink.codeReach.files.set(file, [...(sink.codeReach.files.get(file) ?? []), ...functions]);
    }
    for (const [file, functions] of known) {
      sink.codeReach.known.set(file, [...(sink.codeReach.known.get(file) ?? []), ...functions]);
    }
  } catch {
    /* code reach is best-effort and must never affect the test */
  }
}

/**
 * The capture sink for the test currently running in this worker. Playwright
 * runs a worker's tests sequentially, so a single "current" sink is unambiguous.
 * It is null between tests and during `beforeAll`/`afterAll` — activity outside a
 * test (auth setup, teardown) is intentionally not captured.
 */
let currentSink: CaptureSink | null = null;

/** The browser functions this worker named in a `piwi-browser-functions` attachment, by file, as `start:end`. */
const KNOWN_FUNCTIONS_SENT = new Map<string, Set<string>>();

/**
 * Element probes whose protocol call is still in flight. Closing a page,
 * context, or browser while a probe is mid-flight makes Playwright's
 * connection dispatcher throw a global "Object with guid handle@… was not
 * bound in the connection" error, which fails whichever test happens to be
 * running. The close wrappers drain this set (bounded) before closing.
 */
const PENDING_PROBES = new Set<Promise<unknown>>();

async function drainPendingProbes(capMs: number): Promise<void> {
  if (PENDING_PROBES.size === 0) return;
  let cap: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(PENDING_PROBES),
    new Promise((resolve) => {
      cap = setTimeout(resolve, capMs);
    }),
  ]);
  clearTimeout(cap);
}

function isPageClosed(page: Page): boolean {
  try {
    return typeof page.isClosed === 'function' ? page.isClosed() : false;
  } catch {
    return false;
  }
}

function pageContext(page: Page): BrowserContext | null {
  try {
    return typeof page.context === 'function' ? page.context() : null;
  } catch {
    return null;
  }
}

/** The evaluate's raw result: navigation/paint plus raw core-vitals entries. */
interface WebVitalsProbeResult {
  navigation: WebVitals['navigation'];
  paint: Record<string, number>;
  lcpEntries: RawVitalEntry[] | null;
  shiftEntries: RawVitalEntry[] | null;
  eventEntries: RawVitalEntry[] | null;
}

/** Read navigation/paint timings and core-vitals entries — null when unavailable or the page is gone. */
async function readWebVitals(page: Page): Promise<WebVitals | null> {
  try {
    // Runs in the browser, so the perf-entry reads stay `any` (no DOM lib);
    // the callback return type pins the result. Aggregation happens Node-side
    // in computeCoreVitals so the in-page code stays a thin projection.
    const probe = await page.evaluate(async (): Promise<WebVitalsProbeResult | null> => {
      const navEntries = performance.getEntriesByType('navigation' as any);
      const paintEntries = performance.getEntriesByType('paint' as any);
      const nav = navEntries[0] as any;
      const navigation = nav
        ? {
            url: nav.name,
            ttfb: Math.round(nav.responseStart - nav.fetchStart),
            domInteractive: Math.round(nav.domInteractive - nav.fetchStart),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
            loadComplete: Math.round(nav.loadEventEnd - nav.fetchStart),
            transferSize: nav.transferSize || 0,
            encodedBodySize: nav.encodedBodySize || 0,
            decodedBodySize: nav.decodedBodySize || 0,
          }
        : null;

      const paint: Record<string, number> = {};
      for (const entry of paintEntries) {
        const key = (entry as any).name.replace(/-([a-z])/g, (_: string, l: string) => l.toUpperCase());
        paint[key] = Math.round((entry as any).startTime);
      }

      // Buffered-observer read of an entry type. Returns null when the type is
      // unsupported (non-Chromium); [] when supported but nothing recorded.
      // Buffered entries are dispatched in a queued task, so wait one macrotask
      // before draining with takeRecords().
      const readBuffered = (type: string, extra?: Record<string, unknown>): Promise<any[] | null> =>
        new Promise((resolve) => {
          try {
            const PO = (globalThis as any).PerformanceObserver;
            if (!PO || !(PO.supportedEntryTypes || []).includes(type)) return resolve(null);
            const out: any[] = [];
            const po = new PO((list: any) => out.push(...list.getEntries()));
            po.observe({ type, buffered: true, ...extra });
            setTimeout(() => {
              try {
                out.push(...po.takeRecords());
                po.disconnect();
              } catch {
                // Entries gathered so far still count.
              }
              resolve(out);
            }, 0);
          } catch {
            resolve(null);
          }
        });

      const [lcpRaw, shiftRaw, eventRaw, firstInputRaw] = await Promise.all([
        readBuffered('largest-contentful-paint'),
        readBuffered('layout-shift'),
        // durationThreshold 40 mirrors the web-vitals library — captures every
        // interaction slow enough to matter without flooding the buffer.
        readBuffered('event', { durationThreshold: 40 }),
        readBuffered('first-input'),
      ]);

      const project = (entries: any[] | null): RawVitalEntry[] | null =>
        entries === null
          ? null
          : entries.map((e: any) => ({
              startTime: e.startTime,
              value: e.value,
              hadRecentInput: e.hadRecentInput,
              interactionId: e.interactionId,
              duration: e.duration,
            }));

      const interactionEntries =
        eventRaw === null && firstInputRaw === null ? null : [...(eventRaw ?? []), ...(firstInputRaw ?? [])];

      return {
        navigation,
        paint,
        lcpEntries: project(lcpRaw),
        shiftEntries: project(shiftRaw),
        eventEntries: project(interactionEntries),
      };
    });

    if (!probe) return null;
    const vitals = computeCoreVitals(probe.lcpEntries, probe.shiftEntries, probe.eventEntries);
    if (!probe.navigation && Object.keys(probe.paint).length === 0 && !vitals) return null;
    return { navigation: probe.navigation, paint: probe.paint, vitals };
  } catch {
    return null;
  }
}

/** Page state captured at test end. Storage values and cookie values are NEVER included. */
export interface PageState extends PageInteraction {
  url: string;
  hash: string | null;
  /** `history.state` as JSON, capped and token-masked. */
  historyState: string | null;
  /** Key names + value lengths only. */
  localStorage: Array<{ key: string; length: number }>;
  sessionStorage: Array<{ key: string; length: number }>;
  /** Cookie names + flags only (values are never read). */
  cookies: Array<{
    name: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
    expires?: number;
  }>;
}

/** Raw in-page reads shipped out of the evaluate (see `readPageState`). */
export interface RawPageState {
  url: string;
  hash: string | null;
  historyState: string | null;
  localStorage: Array<{ key: string; length: number }>;
  sessionStorage: Array<{ key: string; length: number }>;
}

const PAGE_STATE_MAX_STORAGE_KEYS = 50;
const PAGE_STATE_MAX_COOKIES = 30;
const PAGE_STATE_HISTORY_CAP = 2048;
const TOKEN_MASK_RES = [/\beyJ[\w-]{10,}\.[\w-]{5,}\.[\w-]{5,}\b/g, /\b[0-9a-f]{32,}\b/gi];

/**
 * Assemble the wire page-state from the in-page reads, the context cookies and
 * what the page was doing (`readPageInteraction`). Pure and Node-side so the
 * sanitization (token masking, caps, value-free cookies, well-formed element
 * paths) is unit-testable. The URL goes without its fragment, which `hash`
 * carries with its credentials masked (`#access_token=[masked]`).
 */
export function buildPageState(
  raw: RawPageState,
  cookies: Array<Record<string, unknown>> | null,
  interaction?: unknown,
): PageState {
  let historyState = raw.historyState;
  if (historyState) {
    for (const re of TOKEN_MASK_RES) historyState = historyState.replace(re, '[masked]');
    if (historyState.length > PAGE_STATE_HISTORY_CAP) {
      historyState = historyState.slice(0, PAGE_STATE_HISTORY_CAP) + '…';
    }
  }
  const capStorage = (entries: Array<{ key: string; length: number }>) =>
    (Array.isArray(entries) ? entries : []).slice(0, PAGE_STATE_MAX_STORAGE_KEYS).map((e) => ({
      key: String(e.key).slice(0, 200),
      length: typeof e.length === 'number' ? e.length : 0,
    }));

  return {
    url: raw.url.split('#')[0]!,
    hash: raw.hash ? maskUrlFragment(raw.hash) : null,
    historyState: historyState || null,
    localStorage: capStorage(raw.localStorage),
    sessionStorage: capStorage(raw.sessionStorage),
    cookies: (cookies ?? []).slice(0, PAGE_STATE_MAX_COOKIES).map((c) => ({
      name: String(c.name ?? ''),
      domain: String(c.domain ?? ''),
      path: String(c.path ?? ''),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      ...(c.sameSite !== undefined ? { sameSite: String(c.sameSite) } : {}),
      ...(typeof c.expires === 'number' ? { expires: c.expires } : {}),
    })),
    ...sanitizePageInteraction(interaction),
  };
}

/** Read the page's state — null when unavailable or the page is gone. */
async function readPageState(page: Page): Promise<PageState | null> {
  try {
    const raw = await page.evaluate((): RawPageState => {
      // Key names + value lengths only — values never leave the page.
      const listStorage = (s: any): Array<{ key: string; length: number }> => {
        const out: Array<{ key: string; length: number }> = [];
        try {
          for (let i = 0; i < s.length; i++) {
            const key = s.key(i);
            if (key != null) out.push({ key, length: (s.getItem(key) ?? '').length });
          }
        } catch {
          // Storage access can throw in sandboxed/opaque-origin pages.
        }
        return out;
      };
      const g = globalThis as any;
      let historyState: string | null = null;
      try {
        historyState = g.history?.state == null ? null : JSON.stringify(g.history.state);
      } catch {
        // Unserializable history state.
      }
      return {
        url: g.location.href,
        hash: g.location.hash || null,
        historyState,
        localStorage: listStorage((globalThis as any).localStorage),
        sessionStorage: listStorage((globalThis as any).sessionStorage),
      };
    });
    if (!raw) return null;

    // Cookie flags are only reachable from the context API, never document.cookie.
    let cookies: Array<Record<string, unknown>> | null = null;
    try {
      cookies = ((await pageContext(page)?.cookies()) as Array<Record<string, unknown>> | undefined) ?? null;
    } catch {
      cookies = null;
    }

    // Focus, hover and selection, which no trace snapshot records.
    const interaction = await page.evaluate(readPageInteraction).catch(() => null);

    return buildPageState(raw, cookies, interaction);
  } catch {
    return null;
  }
}

/**
 * Page keys this worker has already inventoried this run, so a URL visited by
 * many tests is inventoried once. Module-scoped: a worker process serves one
 * run, and the set is a pure de-duplication cache.
 */
const inventoriedPageKeys = new Set<string>();

/**
 * The in-page safety bound: a pathological page cannot serialize more than this
 * many entries. The authoritative per-page cap ({@link capPageInventory}) is
 * applied on the Node side before the attachment is written.
 */
const PAGE_INVENTORY_IN_PAGE_CAP = 2000;

/** How long the in-page inventory read may run before it is abandoned. */
const PAGE_INVENTORY_EVAL_TIMEOUT_MS = 2000;

/**
 * The most page windows kept per test. Windows are recorded on every URL change,
 * so a navigation-heavy SPA test cannot grow the attachment without bound.
 */
const MAX_PAGE_INVENTORY_WINDOWS = 64;

/** Reject a promise after `ms` so a hung in-page read never wedges the capture. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('page inventory read timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Read the interactive controls (role + accessible name) and links (name +
 * href) on the page. Values are never read — only names and hrefs (see
 * {@link collectPageInventoryInPage}). Runs a single in-page pass with a shared
 * entry budget and a timeout, so a table of hundreds of rows or a hung page
 * cannot blow up or stall the capture. Returns null when the page cannot be read.
 */
async function readPageInventory(page: Page): Promise<RawPageInventory | null> {
  try {
    const inventory = await withTimeout(
      page.evaluate(collectPageInventoryInPage, PAGE_INVENTORY_IN_PAGE_CAP),
      PAGE_INVENTORY_EVAL_TIMEOUT_MS,
    );
    // Stamp the settle time so a request can be attributed to the page current
    // when it started, rather than to whichever page the test ended on.
    return inventory ? { ...inventory, capturedAt: Date.now() } : null;
  } catch {
    return null;
  }
}

/**
 * Record the page current on a URL change as an attribution window. The window's
 * settle time is always kept, so a request can be attributed to the page current
 * when it started. The expensive controls/links read runs at most once per page
 * key per worker ({@link inventoriedPageKeys}); a revisited or already-inventoried
 * page records a content-less window, which still cuts the attribution boundary.
 */
async function recordPageWindow(sink: CaptureSink, page: Page): Promise<void> {
  if (sink.pageInventories.length >= MAX_PAGE_INVENTORY_WINDOWS) return;
  let url: string;
  try {
    url = page.url();
  } catch {
    return;
  }
  if (!url || url.startsWith('about:')) return;
  const key = inventoryPageKey(url);
  const capturedAt = Date.now();

  if (sink.pageInventories.length >= MAX_PAGE_INVENTORY_WINDOWS) return;
  if (key && !inventoriedPageKeys.has(key)) {
    inventoriedPageKeys.add(key);
    const content = await internalCall(page, () => readPageInventory(page));
    if (sink.pageInventories.length >= MAX_PAGE_INVENTORY_WINDOWS) return;
    sink.pageInventories.push({
      url: content?.url ?? url,
      controls: content?.controls ?? [],
      links: content?.links ?? [],
      capturedAt,
    });
    return;
  }
  sink.pageInventories.push({ url, controls: [], links: [], capturedAt });
}

/**
 * Take the page-dependent teardown reads (web vitals; page state; ARIA
 * snapshot and screenshot when the test failed) while the last active page is
 * still open.
 * Called by the close wrappers just before a close that would take that page
 * with it — flushSink runs too late for a live read on the standard test page.
 */
async function stashPageState(sink: CaptureSink, closing: { page?: Page; context?: BrowserContext }): Promise<void> {
  const page = sink.lastActivePage;
  if (!page || isPageClosed(page)) return;
  const belongsToClosing =
    closing.page === page || (closing.context !== undefined && pageContext(page) === closing.context);
  if (!belongsToClosing) return;
  await internalCall(page, () => readPageBeforeClose(sink, page));
}

/**
 * Whether the page holds no accessible content once its document has loaded:
 * an empty ARIA snapshot of the body, as the server reads a blank page. An image
 * with a name or an iframe with content is not blank; a read that fails is not
 * either.
 */
async function readBlankPage(page: Page): Promise<boolean> {
  await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {});
  const aria = await ariaSnapshotBestEffort(page.locator('body'), 1000);
  return aria != null && aria.trim() === '';
}

/** The reads {@link stashPageState} takes from the page about to close. */
async function readPageBeforeClose(sink: CaptureSink, page: Page): Promise<void> {
  const vitals = await readWebVitals(page);
  if (vitals) sink.stashedWebVitals = vitals;
  if (sink.probeItem?.level === 'server') sink.probeBlankPage = await readBlankPage(page);

  if (process.env.PIWI_CAPTURE_PAGE_STATE !== 'false') {
    const pageState = await readPageState(page);
    if (pageState) sink.stashedPageState = pageState;
  }

  const status = sink.testInfo?.status;
  const sampleAria = async (): Promise<void> => {
    const root = page.locator(':root');
    const aria = await ariaSnapshotBestEffort(root, 1000);
    if (aria) sink.stashedAria = aria;
    const ariaJson = await ariaSnapshotJSONBestEffort(root, 1000);
    if (ariaJson) sink.stashedAriaJson = ariaJson;
  };
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') {
    await sampleAria();
    if (sink.failureScreenshot)
      sink.stashedScreenshot = (await readFailureScreenshot(page, sink.failureScreenshot)) ?? sink.stashedScreenshot;
  } else if (
    status === 'passed' &&
    process.env.PIWI_SAMPLE_ARIA_ON_PASS !== 'false' &&
    sink.testInfo &&
    isDueForAriaSample(sink.testInfo)
  ) {
    // Sample the green page while it is still open, for the tests the server
    // flagged as due a fresh snapshot this run.
    await sampleAria();
  }

  // Record the passing page as a final attribution window while it is still open,
  // in case the test closed it before teardown could read it.
  if (status === 'passed' && process.env.PIWI_CAPTURE_PAGE_INVENTORY === 'true') {
    await recordPageWindow(sink, page);
  }
}

/**
 * Open Piwi's own failure-time overlay on the still-open page before it closes.
 * This is the single entry point for both `PIWI_PICK_LOCATOR_ON_FAIL` (pick a
 * replacement for the broken locator) and `PIWI_INSPECT_ON_FAIL` (inspect the
 * failing page and pick a locator for any element) — both run our overlay, not
 * Playwright's native inspector, so the experience is fully ours and a
 * confirmed pick flows back into the dashboard.
 *
 * Runs after `stashPageState` so the captured failure evidence reflects the
 * page as the test left it, not as the human poked at it. Gated per
 * `inspect-on-failure.ts` (opt-in, headed, never CI, final attempt only).
 */
async function maybeOpenPicker(sink: CaptureSink, closing?: { page?: Page; context?: BrowserContext }): Promise<void> {
  if (sink.pickOffered) return;
  const page = sink.lastActivePage;
  const testInfo = sink.testInfo;
  if (!page || !testInfo || isPageClosed(page)) return;
  if (closing) {
    const belongsToClosing =
      closing.page === page || (closing.context !== undefined && pageContext(page) === closing.context);
    if (!belongsToClosing) return;
  }
  const pickGate = shouldInspectOnFailure(inspectionGateFromTestInfo(testInfo, process.env.PIWI_PICK_LOCATOR_ON_FAIL));
  const inspectGate = shouldInspectOnFailure(inspectionGateFromTestInfo(testInfo, process.env.PIWI_INSPECT_ON_FAIL));
  if (!pickGate && !inspectGate) return;
  // Gate passed — this is the one shot at the overlay for this test.
  sink.pickOffered = true;
  // A failed locator action was captured with its call site; otherwise (an
  // `expect(...)` assertion) derive the failing locator from the error text.
  // `inspectOnFailure` opens the overlay even with no failing locator (inspect
  // any element); the pick-only flag needs a locator to replace.
  const failed = sink.failedLocators[sink.failedLocators.length - 1] ?? deriveFailedLocator(testInfo);
  if (!failed && !inspectGate) {
    console.log('[piwi] locator picker: no failing locator could be identified in this failure — nothing to replace.');
    return;
  }
  const pick = await internalCall(page, () =>
    runLocatorPicker(page, testInfo, failed, { fn: probeElementAttrs, arg: CAPTURED_ATTRS_ARG }),
  );
  if (!pick) return;
  sink.userPick = pick;
  applyPickToSnapshots(sink.capturedLocators, pick);
}

// Idempotency guards: a page/context/browser can be reached through several
// paths (browser patch, context patch, the `page` fixture, popup events), and
// must be wrapped exactly once.
const INSTRUMENTED_PAGES = new WeakSet<Page>();
/** The instrumented pages still open in this worker, whichever test or hook opened them. */
const OPEN_PAGES = new Set<Page>();
const INSTRUMENTED_CONTEXTS = new WeakSet<BrowserContext>();
/** The instrumented contexts still open in this worker, whichever test or hook opened them. */
const OPEN_CONTEXTS = new Set<BrowserContext>();
const PATCHED_BROWSERS = new WeakSet<Browser>();

// O(1) membership for the proxy `get` trap below, which runs on every property
// access of every wrapped locator. The source arrays from locator-healing are
// turned into Sets once here.
const CHAIN_METHOD_SET = new Set(CHAIN_METHODS);
const ACTION_METHOD_SET = new Set(ACTION_METHODS);
const LOCATOR_METHOD_SET = new Set(LOCATOR_METHODS);

/**
 * Everything the in-page probe needs, serialized into the browser on every
 * action. `tagRoles`/`inputRoles` are the shared role maps (single source of
 * truth in `locator-healing.ts`), and `roleSources` is the CSS selector for
 * every element the probe can resolve a role for — all derived from the map so
 * nothing is hand-maintained twice. Exported so the dogfood mirror
 * (`application/tests/fixtures.ts`) reuses the same assembled object.
 */
export const CAPTURED_ATTRS_ARG: ProbeArg = {
  keep: [...CAPTURED_ATTRIBUTES],
  tagRoles: TAG_TO_ROLE,
  inputRoles: INPUT_TYPE_TO_ROLE,
  // '[role]' plus every tag the maps can resolve (input/select are handled by
  // special-cased logic in the probe, so add them explicitly).
  roleSources: [...new Set(['[role]', 'input', 'select', ...Object.keys(TAG_TO_ROLE)])].join(','),
  // The reporter always wants ancestor-anchored alternatives (the picker's
  // anchors step and generateAnchoredAlternatives both need them).
  includeStructural: true,
};

/**
 * Where the seeded probe lives on the page (see `PROBE_INIT_SCRIPT`).
 * Deliberately unlikely to collide with anything a page defines — and if a page
 * does clobber it, `probeElement` falls back rather than trusting it.
 */
const PROBE_GLOBAL = '__piwiProbeElement';

/**
 * The probe, seeded into the page once per context rather than shipped with
 * every capture. Playwright re-serializes an `evaluate` callback's source and
 * arguments on each call, and `probeElementAttrs` plus `CAPTURED_ATTRS_ARG` is
 * by far the largest thing this path sends; installing it as an init script
 * turns each capture into a small stub call instead. `addInitScript` re-runs on
 * every navigation and in every frame, so it is present whenever a capture
 * needs it.
 *
 * `probeElementAttrs` is already required to be self-contained (Playwright
 * serializes it through `Function.prototype.toString()` today), so embedding
 * its source here relies on nothing new.
 */
const PROBE_INIT_SCRIPT = `(() => {
  const probe = ${probeElementAttrs.toString()};
  const arg = ${JSON.stringify(CAPTURED_ATTRS_ARG)};
  globalThis[${JSON.stringify(PROBE_GLOBAL)}] = (el) => probe(el, arg);
})();`;

/**
 * Documents with no seeded probe — a page whose context was instrumented after
 * it had already navigated, or one where the init script never landed. Cleared
 * on navigation, because the init script runs for the next document even when
 * it missed this one. Without the mark, every capture on such a page would
 * spend a full locator resolution discovering the same thing again.
 */
const PROBE_UNSEEDED_PAGES = new WeakSet<Page>();

/**
 * Read the element through the seeded probe, falling back to shipping the
 * probe's source when the page has none. The stub returns null rather than
 * throwing when the global is absent, so "not seeded" is distinguishable from
 * a genuine probe failure (a detached element, a closing page), which
 * propagates as it would have anyway.
 */
function probeElement(page: Page | null, target: Locator): Promise<ProbedAttrs> {
  const shipSource = () => target.evaluate(probeElementAttrs, CAPTURED_ATTRS_ARG);
  if (!page || PROBE_UNSEEDED_PAGES.has(page)) return internalCall(page, shipSource);

  return internalCall(page, () =>
    target
      .evaluate((el, name) => {
        const seeded = (globalThis as Record<string, any>)[name];
        return typeof seeded === 'function' ? (seeded(el) as ProbedAttrs) : null;
      }, PROBE_GLOBAL)
      .then((attrs) => {
        if (attrs) return attrs;
        PROBE_UNSEEDED_PAGES.add(page);
        return shipSource();
      }),
  );
}

/**
 * ARIA snapshot that tolerates every Playwright version the reporter supports,
 * returning null instead of throwing so a capture can never fail the test. The
 * options validator runs client-side in the user's installed Playwright, so an
 * unsupported key surfaces as a rejected promise (not a synchronous throw):
 *   - ≥ 1.59: `mode: 'ai'` yields the ref-annotated AI snapshot (the ideal);
 *     `ref` is unknown and silently stripped.
 *   - 1.52: `mode: 'ai'` fails validation (only 'raw'/'regex' are accepted) and
 *     rejects; the `{ ref: true }` fallback then yields a ref-annotated snapshot.
 *   - 1.53–1.58: neither `ref` nor `mode` exists — unknown keys are stripped
 *     server-side, so the first call already returns a plain flat snapshot.
 *   - < 1.49: `locator.ariaSnapshot` does not exist — returns null up front.
 */
export async function ariaSnapshotBestEffort(target: Locator, timeout?: number): Promise<string | null> {
  // Playwright < 1.49 predates locator.ariaSnapshot entirely.
  if (typeof target.ariaSnapshot !== 'function') return null;
  try {
    return await target.ariaSnapshot({
      ...(timeout != null ? { timeout } : {}),
      mode: 'ai',
    } as Parameters<Locator['ariaSnapshot']>[0]);
  } catch {
    // 1.52 rejects `mode: 'ai'`; retry with the `ref` flag that release accepts.
    try {
      return await target.ariaSnapshot({
        ...(timeout != null ? { timeout } : {}),
        ref: true,
      } as Parameters<Locator['ariaSnapshot']>[0]);
    } catch {
      return null;
    }
  }
}

/**
 * The aria tree as JSON (Playwright ≥ 1.63's `ariaSnapshotJSON()`), stringified,
 * or null on any older Playwright or on failure. Feature-detected the same way
 * as `ariaSnapshotBestEffort`, so an older Playwright without the method simply
 * yields null and the capture proceeds with the YAML alone.
 */
export async function ariaSnapshotJSONBestEffort(target: Locator, timeout?: number): Promise<string | null> {
  const fn = (target as unknown as { ariaSnapshotJSON?: (opts?: unknown) => Promise<unknown> }).ariaSnapshotJSON;
  if (typeof fn !== 'function') return null;
  try {
    const tree = await fn.call(target, timeout != null ? { timeout } : {});
    return tree == null ? null : JSON.stringify(tree);
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget element capture for a locator that just proved it resolves —
 * a successful action or a passing presence assertion. Probes the element,
 * generates ranked alternatives, and replaces the placeholder at `seq`. The
 * snapshot wait is bounded by a 500ms deadline (evaluate can hang when the
 * page navigates), but the probe's underlying protocol call is tracked in
 * PENDING_PROBES so the close wrappers can drain it — and in capturePromises
 * so flushSink outwaits it — even when the deadline abandons it. An evaluate
 * still in flight when its page closes crashes the connection dispatcher with
 * a global "not bound" error.
 */
function startElementCapture(
  sink: CaptureSink,
  page: Page,
  target: Locator,
  seq: number,
  callerLocation: string | null,
  used: LocatorSnapshot['used'],
): void {
  const probe = probeElement(page, target);
  const settledProbe = probe.then(
    () => undefined,
    () => undefined,
  );
  PENDING_PROBES.add(settledProbe);
  settledProbe.then(() => PENDING_PROBES.delete(settledProbe));
  sink.capturePromises.push(settledProbe);

  const resolveAttrs = (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const attrs = await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('locator capture timeout')), 500);
        }),
      ]);

      // The browser-computed accessible name only feeds role-based and
      // form-field alternatives, so only pay for the extra ARIA
      // snapshot when the element actually has a role or is a field —
      // and, within that, only when the probed attributes have not
      // already settled the name. The snapshot is a second protocol
      // round trip on the same locator, which costs more than the whole
      // probe body; skipping it where it cannot change the answer is
      // the single cheapest saving on this path.
      const role = resolveAriaRole({ ...attrs, accessibleName: null });
      const isFormField = FORM_FIELD_TAGS.has(attrs.tagName);
      const exactName = exactAccessibleName(attrs, role);
      // Bound with a timeout: without it, ariaSnapshot waits up to the
      // test timeout when the page is mid-navigation, which hangs the
      // teardown that drains these capture promises.
      // ariaSnapshotBestEffort adapts the options to the installed
      // Playwright version and never throws (see its doc comment).
      const aria =
        exactName === null && (role || isFormField)
          ? await internalCall(page, () => ariaSnapshotBestEffort(target, 500))
          : null;

      const accessibleName =
        exactName ?? (extractAccessibleName(aria) || approximateAccessibleName({ ...attrs, accessibleName: null }));

      sink.capturedLocators[seq] = {
        location: callerLocation,
        used,
        // hasLabel/selectorCounts inform alternative generation only —
        // keep the stored element to the wire shape. rolePosition and
        // ancestors ARE wire fields: the server's renamed-element match
        // uses them at heal time.
        element: {
          tagName: attrs.tagName,
          attributes: attrs.attributes,
          textContent: attrs.textContent,
          accessibleName,
          center: attrs.center,
          ...(attrs.rolePosition ? { rolePosition: attrs.rolePosition } : {}),
          ...(attrs.ancestors && attrs.ancestors.length > 0 ? { ancestors: attrs.ancestors } : {}),
        },
        alternatives: generateAlternatives({ ...attrs, accessibleName }),
      };
    } catch {
      // Element detached or timeout — keep the placeholder, and release the
      // call site so a later action or assertion on the same line can retry.
      if (callerLocation) sink.probedLocations.delete(callerLocation);
    } finally {
      clearTimeout(deadline);
    }
  })();

  sink.capturePromises.push(resolveAttrs);
}

// Chain methods that take args and define a new locator scope (not just narrow).
// Origin method/args update to the chain call, e.g. .locator('.item') → locator('.item').
// Positional/filter chains that narrow but don't change locator identity.
// Origin stays from the page-level call, e.g. .first(), .nth(2), .filter(...).
/** Record the page a locator call runs on, best-effort: a closed page or an odd URL is skipped. */
function recordLocatorPage(
  sink: CaptureSink,
  page: Page,
  locator: Locator,
  location: string | null,
  arrival: boolean,
): void {
  try {
    sink.locatorPages.record({ location, locator: String(locator), url: page.url(), arrival });
  } catch {
    /* the page record is a side channel; it must never affect the test */
  }
}

/** A locator call the proxy delegated while the pause is on: what a stop on its line shows, and a pick there folds into. */
interface LocatorCall {
  page: Page;
  target: Locator;
  /** The call site, `file:line:col` relative to the working directory. */
  location: string;
  /** The locating call the test made the locator with. */
  origin: { method: string; args: unknown[] };
  /** A locator was picked at a stop on it: its snapshot is the pick, not the call's own capture. */
  picked: boolean;
}

/** Know a locator call by its line while it runs, when the pause is on. */
function knowLocatorCall(
  sink: CaptureSink | null,
  page: Page,
  target: Locator,
  location: string | null,
  origin: { method: string; args: unknown[] },
): LocatorCall | null {
  if (!sink?.pause || !location) return null;
  const call: LocatorCall = { page, target, location, origin, picked: false };
  sink.locatorCalls.set(callSiteLine(location), call);
  return call;
}

/** Forget a locator call once it settled. */
function forgetLocatorCall(sink: CaptureSink | null, call: LocatorCall | null): void {
  if (!sink || !call) return;
  const key = callSiteLine(call.location);
  if (sink.locatorCalls.get(key) === call) sink.locatorCalls.delete(key);
}

/** A locator as source: Playwright's own rendering of it, else its last locating call. */
function locatorSource(target: Locator, method: string, args: unknown[]): string {
  try {
    const text = String(target);
    if (text && !text.startsWith('[object')) return text;
  } catch {
    // Fall back to the locating call.
  }
  return renderFailing({ method, args });
}

/** Each context whose next call is a `page.pause()` Piwi took over, with that call's site. */
const PAGE_PAUSES = new WeakMap<BrowserContext, string>();

/** Each context running a `page.pause()` Piwi left to Playwright: its stop is Playwright's to end. */
const PLAYWRIGHT_PAUSES = new WeakSet<BrowserContext>();

/**
 * A stop shown: the pause bar's page (none for a stop shown in the editor alone, in a context without a page), its
 * context, and a promise that settles once the stop is over.
 */
interface ShownStop {
  page: Page | null;
  context: BrowserContext;
  done: Promise<unknown>;
}

/**
 * While the running attempt wants stops (a breakpoint, a Step, a Pause or a line to run to), have each of `contexts`
 * stop before its next call: every stop then decides whether it shows (`onDebuggerStop`), and goes on.
 */
async function armStops(contexts: Iterable<BrowserContext | null>): Promise<void> {
  const state = currentSink?.pause;
  if (!state || !wantsStops(state)) return;
  await Promise.all(
    [...contexts].map((context) =>
      context && watchStops(context, onDebuggerStop) ? steerDebugger(context, 'pause') : undefined,
    ),
  );
}

/** The stop showing in this worker, which the next one waits for: one stop shows at a time. */
let stopTurn: Promise<unknown> = Promise.resolve();

/**
 * A stop of a context's debugger: shown at a breakpoint's line, at the first call after Step or a Pause from the
 * editor, on the line the editor runs the test to and at a `page.pause()` Piwi took over; the call goes on at once
 * otherwise. A stop outside a test that pauses (one armed before the test ended) resumes at once, and a `page.pause()`
 * left to Playwright is left alone. A stop that comes while another shows waits for it, and goes on when its test
 * ended meanwhile, or when it is a breakpoint's and the other's answer was Finish. Whatever happens while the stop is
 * shown, the call goes on.
 */
function onDebuggerStop(context: BrowserContext): void {
  const details = contextDebugger(context)?.pausedDetails();
  if (!details || PLAYWRIGHT_PAUSES.has(context)) return;
  const sink = currentSink;
  const state = sink?.pause ?? null;
  void (async () => {
    let how: GoOn = 'resume';
    try {
      if (!sink || !state) return;
      const callSite = stopSite(sink, details.location);
      const pagePause = PAGE_PAUSES.get(context);
      const decided = pagePause ? { show: 'page-pause' as const } : atStop(state, callSite);
      if ('go' in decided) {
        how = decided.go;
        return;
      }
      if (pagePause) stopShown(state);
      const shown = stopTurn.then(() =>
        currentSink !== sink || (decided.show === 'breakpoint' && state.finished)
          ? undefined
          : showStop(sink, context, details.title, callSite ?? pagePause!, decided.show),
      );
      stopTurn = shown.catch(() => undefined);
      how = goOn(state, await shown);
    } catch {
      if (state) how = goOn(state);
    } finally {
      await steerDebugger(context, how);
    }
  })();
}

/**
 * A stop's call site, the test's line. Playwright places a locator call the proxy makes at the test's line through the
 * boxed stack prefixes (`quiet-capture.ts`); where they did not take, it places the call in this package's own files,
 * and the locator call in flight names the line.
 */
function stopSite(sink: CaptureSink, location: { file: string; line?: number; column?: number }): string | null {
  if (path.dirname(path.resolve(location.file)) !== __dirname) return stopCallSite(location);
  const calls = [...sink.locatorCalls.values()];
  return calls[calls.length - 1]?.location ?? null;
}

/** The page a stop shows the bar in: its locator call's, else the test's last active one, else the context's last. */
function stopPage(sink: CaptureSink, context: BrowserContext, call: LocatorCall | undefined): Page | null {
  for (const page of [call?.page, sink.lastActivePage]) {
    if (page && !isPageClosed(page) && pageContext(page) === context) return page;
  }
  const open = context.pages().filter((page) => !isPageClosed(page));
  return open[open.length - 1] ?? null;
}

/**
 * Show a stop: the pause bar in a headed page, through `pauseHere`, as an internal call so nothing it does is a step
 * of the test, and the editor while the worker's run connection is open (`holdStop`), with the test timeout held.
 * The two race: the first answer ends the stop, and the bar comes down when the editor's came first. Without a bar,
 * the stop waits for the editor, and goes on when its connection closes. At a locator call the proxy delegated, its
 * element is highlighted, and a locator picked meanwhile is folded into the call site's snapshot (which the call's own
 * capture then leaves as it is); a pick is printed and posted to the editor. The stop is kept for `piwi-pauses` from
 * the moment it shows. A stop the test ended under is ended unanswered (`endShownStops`): its call is held until
 * teardown has read the page, and the answer is Finish. The editor can start the bar's Pick a locator and Record here
 * from outside the page (`intentAt`): the same pick and recording, their results going where the bar's go. Returns the
 * answer; none when neither a bar nor the editor can show the stop.
 */
async function showStop(
  sink: CaptureSink,
  context: BrowserContext,
  title: string,
  location: string,
  reason: StopReason,
): Promise<PauseAnswer | undefined> {
  const testInfo = sink.testInfo;
  const call = sink.locatorCalls.get(callSiteLine(location));
  const page = stopPage(sink, context, call);
  if (!testInfo) return undefined;
  const bar = !!page && (testInfo.project?.use as { headless?: unknown } | undefined)?.headless === false;
  const place = runChannelOpen() ? callSitePlace(location) : null;
  if (!bar && !place) return undefined;
  const onPick = async (picked: PickedLocator) => {
    if (call) {
      call.picked = true;
      const { method, args } = call.origin;
      const rendered = locatorSource(call.target, method, args);
      applyPickToSnapshots(sink.capturedLocators, {
        failing: { method, args, rendered, location: call.location },
        ...picked,
      });
      sink.probedLocations.add(call.location);
    }
    console.log(`[piwi] Locator picked at ${callSiteLine(location)}: ${picked.picked.locator}`);
    await postPickToEditor(editorSendAddress(), pickPayload(picked.picked.locator, location));
  };
  const onRecord =
    bar && page ? recorderAt(page, testInfo, location, reason === 'page-pause' ? 'pause' : 'breakpoint') : undefined;
  const intents = bar && page ? new BarIntents() : null;
  const record: PauseRecord = { title, location, reason, startedAt: Date.now(), duration: 0 };
  sink.stops.push(record);
  // `end`: the test ended under the stop. `over`: that, or the editor answered; the bar comes down then.
  const end = new AbortController();
  const over = new AbortController();
  end.signal.addEventListener('abort', () => over.abort(), { once: true });
  let fromEditor: PauseAnswer | undefined;
  const held = place
    ? holdStop(
        {
          reason,
          title,
          place,
          locator: call ? locatorSource(call.target, call.origin.method, call.origin.args) : null,
          bar,
          page,
          intent: intents ? (what) => intentAt(intents, what, !!onRecord) : undefined,
        },
        (answer) => {
          fromEditor = answer;
          over.abort();
        },
      )
    : null;
  const shown = withTestTimeoutHeld(testInfo, async (): Promise<PauseAnswer> => {
    if (!bar || !page) {
      console.log(`[piwi] Paused at ${callSiteLine(location)} before ${title}: Resume, Step or Finish in the editor.`);
      await abortion(over.signal);
      return 'resume';
    }
    return internalCall(page, () =>
      pauseHere(
        page,
        {
          location,
          call: title,
          attempt: testInfo.retry > 0 ? testInfo.retry + 1 : null,
          target: call?.page === page ? call.target : null,
        },
        { fn: probeElementAttrs, arg: CAPTURED_ATTRS_ARG },
        onPick,
        onRecord,
        over.signal,
        intents ?? undefined,
      ),
    );
  }).finally(() => {
    record.duration = Date.now() - record.startedAt;
    sink.shownStops.delete(end);
    held?.release();
  });
  sink.shownStops.set(end, { page, context, done: shown.catch(() => undefined) });
  const answer = await shown;
  if (end.signal.aborted) {
    // The test ended under the stop: its call goes on once teardown has read the page, and nothing stops after it.
    await sink.flushed;
    return 'finish';
  }
  return fromEditor ?? answer;
}

/**
 * Start the pause bar's Pick a locator or Record here from outside the page, at a stop the bar shows: answered at
 * once, the pick or the recording then running in the test's window as from the bar.
 */
function intentAt(intents: BarIntents, what: RunIntent, canRecord: boolean): IntentAnswer {
  if (what === 'record' && !canRecord) {
    return {
      ok: false,
      message: 'Record here needs the editor that started the run: this run names no record channel.',
    };
  }
  if (!intents.offer(what)) {
    return { ok: false, message: `${RUN_INTENT_NAMES[what]} waits: a pick or a recording runs in the test's window.` };
  }
  return {
    ok: true,
    message:
      what === 'pick'
        ? "Pick an element in the test's window: the locator goes to the editor."
        : "Recording in the test's window: the editor writes the steps above the stopped line.",
  };
}

/** Settles once `signal` aborts. */
function abortion(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** How long teardown waits for a bar it takes down. */
const END_STOP_MS = 2000;

/**
 * End the stops the test ended under (a wait it started before the stop ran out), the pause bar taken down, before
 * teardown reads the page; each record keeps the time it held. With `closing`, only a stop on that page or in that
 * context.
 */
async function endShownStops(sink: CaptureSink, closing?: { page?: Page; context?: BrowserContext }): Promise<void> {
  const ending: Promise<unknown>[] = [];
  for (const [end, { page, context, done }] of sink.shownStops) {
    if (closing && closing.page !== page && (!closing.context || context !== closing.context)) continue;
    end.abort();
    ending.push(done);
  }
  if (ending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(ending), new Promise((resolve) => (timer = setTimeout(resolve, END_STOP_MS)))]);
  clearTimeout(timer);
}

/**
 * What **Record here** runs at a pause, when the editor that started the run can record (`PIWI_RECORD_CHANNEL`): the
 * page handed to its recorder until the recording ends, and why not when it did not start. Undefined otherwise.
 */
function recorderAt(
  page: Page,
  testInfo: TestInfo,
  location: string,
  reason: 'breakpoint' | 'pause',
): (() => Promise<void>) | undefined {
  if (!canRecordFromHere()) return undefined;
  return async () => {
    console.log(`[piwi] Recording from ${callSiteLine(location)}: the editor writes the steps.`);
    const why = await recordFromHere({ page, testInfo, location, reason });
    console.log(why ? `[piwi] Nothing was recorded: ${why}` : '[piwi] The recording ended: the test is paused again.');
  };
}

/** Playwright's `page.pause()`, with the test hook that keeps the test timeout to the runner's own handling. */
type PlaywrightPause = (options?: { __testHookKeepTestTimeout?: boolean }) => Promise<void>;

/**
 * `page.pause()` in a headed local run with breakpoints, in one the editor started (`PIWI_RECORD_CHANNEL`), or while
 * the worker's run connection is open: a stop of Playwright's debugger at its line, shown with Piwi's pause bar in
 * place of Playwright's Inspector, with **Record here** when the editor can record, and in the editor. Step stops at
 * the next call, Finish at no breakpoint more. Anywhere else, Playwright's own pause, with its Inspector, which Piwi
 * leaves to the person to end.
 */
async function pauseInPlace(page: Page, playwrightPause: PlaywrightPause, location: string | null): Promise<void> {
  const sink = currentSink;
  const testInfo = sink?.testInfo;
  const context = pageContext(page);
  if (!sink || !testInfo || !location || !context || !contextDebugger(context)) {
    return leaveToPlaywright(context, playwrightPause);
  }
  if (!sink.pause && (!canRecordFromHere() || pauseSkipReason(pauseGateFromTestInfo(testInfo)))) {
    return leaveToPlaywright(context, playwrightPause);
  }
  sink.pause ??= pauseState(NO_BREAKPOINTS);
  watchStops(context, onDebuggerStop);
  // The pause call stops where Playwright's debugger is on; a pause asked first turns it on.
  await steerDebugger(context, 'pause');
  PAGE_PAUSES.set(context, location);
  try {
    // The runner holds the test timeout while the debugger is stopped.
    await playwrightPause({ __testHookKeepTestTimeout: true });
  } finally {
    PAGE_PAUSES.delete(context);
  }
}

/** Playwright's own `page.pause()`: a stop of the page's context Piwi does not answer while it runs. */
async function leaveToPlaywright(context: BrowserContext | null, playwrightPause: PlaywrightPause): Promise<void> {
  if (!context) return playwrightPause();
  PLAYWRIGHT_PAUSES.add(context);
  try {
    await playwrightPause();
  } finally {
    PLAYWRIGHT_PAUSES.delete(context);
  }
}

function wrapLocator(page: Page, locator: Locator, originMethod: string, originArgs: unknown[]): Locator {
  return new Proxy(locator, {
    get(target, prop) {
      const original = Reflect.get(target, prop) as unknown;
      if (typeof original !== 'function') return original;

      if (CHAIN_METHOD_SET.has(prop as string)) {
        return (...args: unknown[]): Locator => {
          const next = callMethod(target, prop, args) as Locator;
          if (LOCATOR_CREATING_CHAINS.has(prop as string)) {
            return wrapLocator(page, next, String(prop), args);
          }
          return wrapLocator(page, next, originMethod, originArgs);
        };
      }

      if (prop === EXPECT_METHOD) {
        return async (...callArgs: unknown[]): Promise<unknown> => {
          const sink = currentSink;
          const expression = typeof callArgs[0] === 'string' ? callArgs[0] : '';
          const isNot = Boolean((callArgs[1] as { isNot?: boolean } | undefined)?.isNot);
          // Sync, before the await — the caller's frames are gone after it.
          const callerLocation = sink ? captureCallerLocation() : null;
          // Every assertion records the page it ran on, negations included.
          if (sink) recordLocatorPage(sink, page, target, callerLocation, noteLocatorCall(page, EXPECT_METHOD, true));
          const call = knowLocatorCall(sink, page, target, callerLocation, { method: originMethod, args: originArgs });
          try {
            // Only positive presence-proving assertions participate — negations,
            // absence/count/page-level assertions, and any unknown future
            // expression pass through untouched.
            if (!sink || isNot || !EXPECT_CAPTURE_EXPRESSIONS.has(expression)) {
              return await callMethod(target, prop, callArgs);
            }

            sink.lastActivePage = page;
            const used = {
              method: originMethod,
              args: originArgs,
              raw: `${originMethod}(${JSON.stringify(originArgs)})`,
            };

            // One probe per call site (see `probedLocations`). The placeholder
            // pushed on the first visit already marks the location as exercised
            // this run.
            const alreadyProbed = callerLocation !== null && sink.probedLocations.has(callerLocation);
            let seq = -1;
            if (!alreadyProbed) {
              seq = sink.capturedLocators.length;
              sink.capturedLocators.push({ location: callerLocation, used, element: null, alternatives: [] });
            }

            const result = await callMethod(target, prop, callArgs);

            // `_expect` reports the outcome instead of throwing (the matcher
            // layer above does the throw), so read it off the result. A missing
            // `matches` — a future result-shape change — degrades to no capture,
            // never to a broken assertion.
            const matches = (result as { matches?: boolean } | null | undefined)?.matches;
            if (matches === true && !alreadyProbed && !call?.picked) {
              if (callerLocation) sink.probedLocations.add(callerLocation);
              startElementCapture(sink, page, target, seq, callerLocation, used);
            } else if (matches === false) {
              // A presence assertion that missed is a failed-locator signal —
              // feeds the failure-time picker and the fresh-locator suggestion,
              // same as a failed action.
              sink.failedLocators.push({ method: originMethod, args: originArgs, location: callerLocation });
            }

            return result;
          } finally {
            forgetLocatorCall(sink, call);
          }
        };
      }

      if (!ACTION_METHOD_SET.has(prop as string)) return original;

      return async (...callArgs: unknown[]): Promise<unknown> => {
        // Bind to the sink active when the action starts so the async element
        // capture below writes back to the right test even across a boundary.
        const sink = currentSink;
        // Action outside a tracked test (e.g. during beforeAll) — run untouched.
        if (!sink) return callMethod(target, prop, callArgs);

        sink.lastActivePage = page;
        // Capture the test call-site now (sync) so the snapshot's location
        // matches the error stack's first user frame — independent of
        // pw:api step ordering, worker interleaving, or concurrent actions.
        const callerLocation = captureCallerLocation();
        recordLocatorPage(sink, page, target, callerLocation, noteLocatorCall(page, String(prop)));
        // Built once, shared by the placeholder and the resolved snapshot below.
        const used = {
          method: originMethod,
          args: originArgs,
          raw: `${originMethod}(${JSON.stringify(originArgs)})`,
        };
        const call = knowLocatorCall(sink, page, target, callerLocation, used);

        // One probe per call site (see `probedLocations`). Push a placeholder
        // immediately on the first visit — DOM capture runs async below.
        const alreadyProbed = callerLocation !== null && sink.probedLocations.has(callerLocation);
        let seq = -1;
        if (!alreadyProbed) {
          seq = sink.capturedLocators.length;
          sink.capturedLocators.push({
            location: callerLocation,
            used,
            element: null,
            alternatives: [],
          });
        }

        // The location is already on record. If the action throws, note the
        // failed locator (so teardown can suggest a fresh one for the element's
        // current identity) and re-throw so the test still fails.
        let result: unknown;
        try {
          result = await callMethod(target, prop, callArgs);
        } catch (error) {
          sink.failedLocators.push({ method: originMethod, args: originArgs, location: callerLocation });
          throw error;
        } finally {
          forgetLocatorCall(sink, call);
        }

        // Fire-and-forget: capture element data without blocking the test.
        if (!alreadyProbed && !call?.picked) {
          if (callerLocation) sink.probedLocations.add(callerLocation);
          startElementCapture(sink, page, target, seq, callerLocation, used);
        }

        return result;
      };
    },
  });
}

/**
 * Wrap a frame locator so the locators built through it capture like page-level
 * ones. Only the locator-building methods are intercepted; the resulting locator
 * is proxied by `wrapLocator` with the builder call as its origin, so a healing
 * snapshot records `getByRole(…)` rather than the frame path. Frame locators
 * carry no action methods of their own, so nothing else is wrapped.
 */
function wrapFrameLocator(page: Page, frameLocator: FrameLocator): FrameLocator {
  return new Proxy(frameLocator, {
    get(target, prop) {
      const original = Reflect.get(target, prop) as unknown;
      if (typeof original !== 'function') return original;
      if (!LOCATOR_METHOD_SET.has(prop as string)) return original;
      return (...args: unknown[]): Locator => {
        if (currentSink) currentSink.lastActivePage = page;
        return wrapLocator(page, callMethod(target, prop, args) as Locator, String(prop), args);
      };
    },
  });
}

/**
 * The error text each browser gives a request the page cancelled itself:
 * Chromium's `net::ERR_ABORTED`, Firefox's `NS_BINDING_ABORTED`, WebKit's
 * "cancelled". Chromium also gives `net::ERR_ABORTED` to an error response with
 * an empty body the page did not read, once that response arrived.
 */
const CANCELLED_REQUEST = /^net::ERR_ABORTED$|^NS_BINDING_ABORTED$|^NS_ERROR_ABORT$|cancell?ed/i;

/**
 * Instrument a single page: wrap its locator-building methods for healing
 * capture and attach console/network listeners. Idempotent — safe to call on a
 * page already reached through another path (browser patch, `page` fixture).
 */
function instrumentPage(page: Page): void {
  if (!page || INSTRUMENTED_PAGES.has(page)) return;
  INSTRUMENTED_PAGES.add(page);
  if (typeof page.once === 'function') {
    OPEN_PAGES.add(page);
    page.once('close', () => OPEN_PAGES.delete(page));
  }
  void maybeStartCodeReach(page);
  observeOwnApiRequests(page);

  // Probe mode: install the fault interception for this test's plan item on the
  // first page, before the test navigates. Fire-and-forget — page.route
  // registration resolves before the first request in practice.
  const probeSink = currentSink;
  if (probeSink?.probeItem && !probeSink.probeInterception) {
    void installProbeInterception(page, probeSink.probeItem)
      .then((interception) => {
        probeSink.probeInterception = interception;
      })
      .catch(() => {
        /* interception failed to install — the probe is recorded as not applied */
      });
  }

  // Flake mode: apply the arm's conditions to the target test's first page,
  // before it navigates. The paths that hand a new page to the test await the
  // install (`awaitFlakeConditions`).
  const flake = currentSink?.flake;
  if (flake?.role === 'target' && !flake.conditions) {
    flake.browserName = pageBrowserName(page) ?? flake.browserName;
    const plan = flake.plan;
    flake.conditions = installFlakeConditions(page, plan).catch((error: unknown) => {
      const note = `conditions failed to install: ${error instanceof Error ? error.message : String(error)}`;
      const reports = unappliedReports(plan).map((r) =>
        r.outcome === 'by-command' ? r : { ...r, outcome: 'skipped' as const, note },
      );
      return { reports: () => reports };
    });
  }

  // A page reached through the `page` fixture safety net may live in a context
  // the browser patch never saw — instrument it so its close is wrapped too.
  const ctx = pageContext(page);
  if (ctx) instrumentContext(ctx);

  // `page.pause()` in a headed run with breakpoints, or one the editor started, pauses with Piwi's bar, which can
  // record from there.
  if (typeof page.pause === 'function') {
    const originalPause = page.pause.bind(page) as PlaywrightPause;
    // The call site is read here, the frame right above the test's own.
    page.pause = (): Promise<void> => pauseInPlace(page, originalPause, captureCallerLocation());
  }

  // Drain in-flight probes before a user-initiated close (the guard tolerates
  // page-like test fakes without a close method), and preserve the
  // page-dependent teardown reads while the page can still serve them.
  if (typeof page.close === 'function') {
    const originalClose = page.close.bind(page);
    page.close = async (...args: Parameters<Page['close']>): Promise<void> => {
      await drainPendingProbes(1000);
      const sink = currentSink;
      if (sink) {
        await endShownStops(sink, { page });
        await stashPageState(sink, { page });
        await maybeOpenPicker(sink, { page });
        await stopSinkCodeReach(sink, { page });
      }
      return originalClose(...args);
    };
  }

  // Opt-out: skipped when PIWI_CAPTURE_LOCATORS=false (set automatically when
  // the reporter's collectPerformanceMetrics / captureLocators is disabled),
  // so the per-action DOM read + ARIA snapshot cost is never paid when unused.
  const captureLocators = process.env.PIWI_CAPTURE_LOCATORS !== 'false';

  if (captureLocators) {
    // Locator factories are accessed by dynamic name, so a string-indexed view
    // of the page is the cleanest local escape hatch from the static surface.
    const factories = page as unknown as Record<string, (...args: unknown[]) => Locator>;
    for (const method of LOCATOR_METHODS) {
      const original = factories[method]!.bind(page);
      factories[method] = (...args: unknown[]): Locator => {
        // Touching a page's locator factory marks it the active page even for
        // assertion-only tests that never call an action method.
        if (currentSink) currentSink.lastActivePage = page;
        noteResourceUse(page);
        return wrapLocator(page, original(...args), method, args);
      };
    }

    // The no-selector `frameLocator()` searches the whole frame subtree and is a
    // single wrappable entry point. The selector form (`frameLocator('#f')`)
    // stays unwrapped: it predates the no-selector form and is left as Playwright
    // returns it.
    const originalFrameLocator = typeof page.frameLocator === 'function' ? page.frameLocator.bind(page) : null;
    if (originalFrameLocator) {
      (page as unknown as Record<string, (...args: unknown[]) => FrameLocator>).frameLocator = (
        ...args: unknown[]
      ): FrameLocator => {
        const frame = (originalFrameLocator as (...a: unknown[]) => FrameLocator)(...args);
        return args.length === 0 ? wrapFrameLocator(page, frame) : frame;
      };
    }

    // A document that had no seeded probe says nothing about the next one —
    // the init script runs for every navigation, so give each new document a
    // fresh chance at the fast path.
    if (typeof page.on === 'function') {
      page.on('framenavigated', (frame) => {
        PROBE_UNSEEDED_PAGES.delete(page);
        // A new document or a client-side route: locator calls start over "on arrival".
        try {
          if (frame === page.mainFrame()) noteNavigation(page);
        } catch {
          /* a page event handler must never throw */
        }
      });
    }
  }

  // Cut an attribution window on every URL change, so the graph can attribute a
  // request to the page current when it started. `framenavigated` fires on both
  // full loads and same-document (SPA) navigations, where the `load` event never
  // fires — so a client-routed page still gets its own window. Off by default:
  // the reporter opts in via PIWI_CAPTURE_PAGE_INVENTORY=true. Best-effort: a
  // failed read is skipped, and only passing runs keep the inventory (teardown).
  if (typeof page.on === 'function' && process.env.PIWI_CAPTURE_PAGE_INVENTORY === 'true') {
    page.on('framenavigated', (frame) => {
      const sink = currentSink;
      if (!sink || frame !== page.mainFrame()) return;
      void recordPageWindow(sink, page).catch(() => {
        /* an inventory read failure must never affect the test */
      });
    });
  }

  // An exception the page threw and nothing caught once a server probe's fault
  // was applied: its sign the application did not handle the fault.
  page.on('pageerror', () => {
    const sink = currentSink;
    if (sink?.probeItem?.level === 'server' && sink.probeInterception?.applied()) sink.probePageErrors++;
  });

  page.on('console', (msg: ConsoleMessage) => {
    const sink = currentSink;
    if (!sink) return;
    const type = msg.type();
    if (['warning', 'error', 'assert'].includes(type)) {
      const location = msg.location();
      sink.consoleEntries.push({
        type,
        text: msg.text(),
        timestamp: Date.now(),
        location: location ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : null,
      });
    }
  });

  // Dialogs are observed through the close event only. A `dialog` listener would
  // suppress Playwright's automatic dismissal and can hang a test that relied on
  // it; the close event (Playwright ≥ 1.63) never does, so a page on an older
  // Playwright — where the event never fires — simply records no dialogs. The
  // registration is guarded because an unknown event name can throw there.
  if (typeof page.on === 'function') {
    try {
      (page.on as (event: string, handler: (dialog: DialogLike) => void) => void)('dialogclosed', (dialog) => {
        const sink = currentSink;
        if (!sink) return;
        try {
          sink.dialogs.push({
            type: typeof dialog.type === 'function' ? dialog.type() : null,
            message: typeof dialog.message === 'function' ? dialog.message() : null,
            defaultValue: typeof dialog.defaultValue === 'function' ? dialog.defaultValue() || null : null,
            closedAt: Date.now(),
          });
        } catch {
          /* a dialog shape the reader does not expect — skip it */
        }
      });
    } catch {
      /* Playwright predates the dialogclosed event */
    }
  }

  // A request is recorded once it finishes or fails (`recordRequest`). The
  // response of a tracked one is kept from its arrival, so a request whose body
  // never finishes loading is still recorded, at teardown (`flushSink`).
  page.on('response', (response: Response) => {
    const sink = currentSink;
    if (!sink) return;
    try {
      const request = response.request();
      if (isTrackedRequest(request.url(), request.resourceType())) sink.openResponses.set(request, response);
    } catch {
      /* a page event handler must never throw */
    }
  });
  const onRequestEnd = (request: Request, failed: boolean) => {
    const sink = currentSink;
    if (!sink || RECORDED_OPEN.has(request)) return;
    sink.lastActivePage = page;
    const response = sink.openResponses.get(request) ?? null;
    sink.openResponses.delete(request);
    recordRequest(sink, request, failed ? 'failed' : 'finished', response);
  };
  page.on('requestfinished', (request: Request) => onRequestEnd(request, false));
  page.on('requestfailed', (request: Request) => onRequestEnd(request, true));
}

/**
 * How a request's record ends: it finished, it failed, or its response arrived
 * but its body never finished loading (the page cancelled it, or it was still
 * open as the test ended).
 */
type RequestEnd = 'finished' | 'failed' | 'unfinished';

/** Requests recorded while still open at a test's end: their late finish or failure is not recorded again. */
const RECORDED_OPEN = new WeakSet<Request>();

/** An API call or a document: not a static asset (script, style, font, image, media), nor a `data:` or `blob:` URL. */
function isTrackedRequest(url: string, resourceType: string): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return false;
  return TRACKED_REQUEST_TYPES.includes(resourceType);
}

/**
 * Record a request in the background. A failed one (reset, refused) has
 * status 0 and carries Playwright's error text as `failure`. One the page
 * cancelled itself (a navigation, an AbortController, the page closing) did
 * not fail: it is dropped when no response had arrived, and recorded
 * unfinished otherwise. `response` is the one the `response` event delivered,
 * when the capture saw it.
 */
function recordRequest(sink: CaptureSink, request: Request, end: RequestEnd, response: Response | null): void {
  const p = (async () => {
    try {
      const url = request.url();
      const resourceType = request.resourceType();
      if (!isTrackedRequest(url, resourceType)) return;

      let failure = end === 'failed' ? (request.failure()?.errorText ?? 'failed') : null;
      if (failure && CANCELLED_REQUEST.test(failure)) {
        if (!response) return;
        failure = null;
        end = 'unfinished';
      }

      const timing = request.timing();
      if (end === 'failed') response = null;
      else if (end === 'finished') response ??= await request.response();
      const entry: Record<string, unknown> = {
        method: request.method(),
        url,
        status: response ? response.status() : 0,
        duration: requestDuration(timing, end),
        startTime: timing.startTime,
        resourceType,
      };
      if (failure) entry.failure = failure;

      if (response) {
        // No server answered: the test's own route handler fulfilled the request,
        // or a cache or a service worker served it. Playwright then names neither
        // a request start nor a server address.
        if (timing.requestStart < 0 && typeof response.serverAddr === 'function') {
          if ((await response.serverAddr().catch(() => undefined)) === null) entry.fulfilled = true;
        }
        readResponseHeaders(sink, entry, url, response.headers());
      }

      sink.networkRequests.push(entry);
    } catch {
      /* ignore */
    }
  })();
  sink.pendingHandlers.push(p);
}

/**
 * Read a response's headers into its network entry: its content type, and
 * what an instrumented backend said about the request (its logs, its spans,
 * the id of its server coverage). Shared by the page's requests and the
 * calls through an API request context.
 */
function readResponseHeaders(
  sink: CaptureSink,
  entry: Record<string, unknown>,
  url: string,
  headers: Record<string, string>,
): void {
  // Response content type (without charset/boundary params) — relevant
  // per-request metadata for distinguishing API/JSON vs document/HTML calls.
  const contentType = headers['content-type'];
  if (contentType) entry.contentType = contentType.split(';')[0]!.trim();

  const logHeader = headers['x-piwi-logs'];
  if (logHeader) {
    try {
      entry.serverLogs = JSON.parse(gunzipSync(Buffer.from(logHeader, 'base64')).toString('utf-8'));
    } catch {
      /* ignore malformed header */
    }
  }

  // The id the backend gave this request's server coverage, kept per
  // origin for the reporter to collect once the test ends.
  const coverageHeader = headers['x-piwi-coverage'];
  if (coverageHeader && serverCoverageInWorker()) recordServerCoverageIds(sink, url, coverageHeader);

  // Server-side spans emitted by a Piwi instrumentation plugin, in the
  // same gzip+base64 form as the logs header. Skipped when trace capture
  // is disabled; absent header (no instrumentation) is a no-op.
  const traceHeader = headers['x-piwi-trace'];
  if (traceHeader && process.env.PIWI_CAPTURE_SERVER_TRACES !== 'false') {
    try {
      entry.serverTraces = JSON.parse(gunzipSync(Buffer.from(traceHeader, 'base64')).toString('utf-8'));
    } catch {
      /* ignore malformed header */
    }
  }
}

/**
 * Record a call the running test made through an API request context
 * (`api-requests.ts`), as a network entry with what the backend said on its
 * response. Never throws.
 */
function recordApiCall(sink: CaptureSink, call: ApiCall): void {
  try {
    const entry = apiCallEntry(call, sink.baseURL);
    if (!entry) return;
    if (call.response) readResponseHeaders(sink, entry, String(entry.url), call.response.headers());
    sink.networkRequests.push(entry);
  } catch {
    /* the record is a side channel: it never affects the test */
  }
}

/** The running test's API call recorder; null between tests, which leaves a call untouched. */
function apiCallRecorder(): ApiCallRecorder | null {
  const sink = currentSink;
  return sink ? (call) => recordApiCall(sink, call) : null;
}

/**
 * Hand out a browser context's API request context (`context.request`, which
 * its pages share as `page.request`) behind the call proxy. A Playwright whose
 * property cannot be set keeps the context's own, its calls unrecorded.
 */
function observeOwnApiRequests(owner: BrowserContext | Page): void {
  try {
    const holder = owner as unknown as { request?: unknown };
    if (holder.request && typeof holder.request === 'object') {
      holder.request = observeApiRequestContext(holder.request, apiCallRecorder);
    }
  } catch {
    /* the context keeps its own */
  }
}

/**
 * Record the requests whose response arrived but which neither finished nor
 * failed before the test ended: a response whose body the page never read can
 * stay open in Chromium. A later event for one of them adds no record.
 */
function recordOpenRequests(sink: CaptureSink): void {
  for (const [request, response] of sink.openResponses) {
    RECORDED_OPEN.add(request);
    recordRequest(sink, request, 'unfinished', response);
  }
  sink.openResponses.clear();
}

/** Wait until the running test's flake conditions are on its page, so they apply before it navigates. */
async function awaitFlakeConditions(): Promise<void> {
  await currentSink?.flake?.conditions;
}

/**
 * Instrument a browser context so every page it opens — via `newPage()` or as a
 * popup/`window.open` — is captured. Idempotent.
 */
function instrumentContext(context: BrowserContext): void {
  if (!context || INSTRUMENTED_CONTEXTS.has(context)) return;
  INSTRUMENTED_CONTEXTS.add(context);
  if (typeof context.once === 'function') {
    OPEN_CONTEXTS.add(context);
    context.once('close', () => OPEN_CONTEXTS.delete(context));
  }
  observeOwnApiRequests(context);

  // Seed the probe for every document this context loads, so a capture ships a
  // stub call instead of the probe's source. Best-effort: `probeElement` falls
  // back to shipping the source for any document this does not reach.
  if (process.env.PIWI_CAPTURE_LOCATORS !== 'false' && typeof context.addInitScript === 'function') {
    void Promise.resolve(context.addInitScript({ content: PROBE_INIT_SCRIPT })).catch(() => {
      /* the fallback covers it */
    });
  }

  const originalNewPage = context.newPage.bind(context);
  context.newPage = async (...args: Parameters<BrowserContext['newPage']>): Promise<Page> => {
    const page = await originalNewPage(...args);
    instrumentPage(page);
    await awaitFlakeConditions();
    await maybeStartCodeReach(page);
    return page;
  };

  // The built-in context fixture closes here at test teardown — BEFORE the
  // auto capture fixture flushes. Drain in-flight probes (an evaluate crossing
  // the close crashes the connection with a global "not bound" error) and take
  // the page-dependent reads (web vitals, failure ARIA snapshot) while the
  // test's page is still open.
  if (typeof context.close === 'function') {
    const originalClose = context.close.bind(context);
    context.close = async (...args: Parameters<BrowserContext['close']>): Promise<void> => {
      await drainPendingProbes(1000);
      const sink = currentSink;
      if (sink) {
        await endShownStops(sink, { context });
        await stashPageState(sink, { context });
        await maybeOpenPicker(sink, { context });
        await stopSinkCodeReach(sink, { context });
      }
      return originalClose(...args);
    };
  }

  // Popups and pages the context opens on its own (idempotent with the above).
  context.on('page', (page: Page) => instrumentPage(page));
}

/**
 * Patch a browser so any page or context created directly from it is
 * instrumented. This is what makes capture work for suites that build their own
 * pages from the worker-scoped `browser` (e.g. `browser.newPage()` /
 * `browser.newContext().newPage()`) instead of using the `page` fixture.
 * Idempotent.
 */
function patchBrowser(browser: Browser): void {
  if (!browser || PATCHED_BROWSERS.has(browser)) return;
  PATCHED_BROWSERS.add(browser);

  const originalNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...args: Parameters<Browser['newPage']>): Promise<Page> => {
    const page = await originalNewPage(...args);
    instrumentPage(page);
    await armStops([pageContext(page)]);
    await awaitFlakeConditions();
    await maybeStartCodeReach(page);
    return page;
  };

  const originalNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser['newContext']>): Promise<BrowserContext> => {
    const context = await originalNewContext(...args);
    instrumentContext(context);
    await armStops([context]);
    return context;
  };

  // Worker shutdown closes the browser; a probe still in flight would crash
  // the connection dispatcher.
  if (typeof browser.close === 'function') {
    const originalClose = browser.close.bind(browser);
    browser.close = async (...args: Parameters<Browser['close']>): Promise<void> => {
      await drainPendingProbes(1000);
      return originalClose(...args);
    };
  }
}

/** The whole page's ARIA snapshot, read as an internal call. */
function readRootAria(page: Page): Promise<string | null> {
  return internalCall(page, () => ariaSnapshotBestEffort(page.locator(':root')));
}

/** The whole page's ARIA tree as JSON, read as an internal call. */
function readRootAriaJson(page: Page): Promise<string | null> {
  return internalCall(page, () => ariaSnapshotJSONBestEffort(page.locator(':root')));
}

/** Request types worth keeping: API calls and documents, not static assets. */
const TRACKED_REQUEST_TYPES = ['fetch', 'xhr', 'document', 'other'];

/** A server coverage request id: printable ASCII without spaces, 128 characters at most. */
const SERVER_COVERAGE_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * Keep the request ids an `X-Piwi-Coverage` header value names (one, or
 * several separated by commas or whitespace) under the origin of the
 * request's URL, for http and https URLs only.
 */
function recordServerCoverageIds(sink: CaptureSink, url: string, value: string): void {
  let origin: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    origin = parsed.origin;
  } catch {
    return;
  }
  for (const id of value.split(/[\s,]+/)) {
    if (!SERVER_COVERAGE_ID.test(id)) continue;
    let ids = sink.serverCoverage.get(origin);
    if (!ids) {
      ids = new Set();
      sink.serverCoverage.set(origin, ids);
    }
    ids.add(id);
  }
}

/**
 * A request's duration in ms: to the response end when there is one, else, for
 * a request that failed before answering, to the moment the failure was seen.
 * An unfinished one has no response end: it is timed to its response headers.
 */
function requestDuration(
  timing: { startTime: number; requestStart: number; responseStart: number; responseEnd: number },
  end: RequestEnd,
): number {
  if (end === 'unfinished') {
    return timing.responseStart >= 0 ? Math.max(0, Math.round(timing.responseStart - timing.requestStart)) : 0;
  }
  if (timing.responseEnd > 0) return Math.round(timing.responseEnd - timing.requestStart);
  if (end === 'failed' && timing.startTime > 0) return Math.max(0, Math.round(Date.now() - timing.startTime));
  return 0;
}

/**
 * Drain in-flight capture work and attach the collected `piwi-*` data to the
 * test, sourced from the sink so it works regardless of how the test's pages
 * were made.
 */
async function flushSink(sink: CaptureSink, testInfo: TestInfo): Promise<void> {
  // The test is over: a pause bar still up comes down before the page is read.
  await endShownStops(sink);
  // Record the requests still open, then wait for all in-flight request
  // handlers before snapshotting networkRequests: the last request (often the
  // one that failed the test) races with teardown and its serverLogs would
  // otherwise be lost.
  recordOpenRequests(sink);
  await Promise.allSettled(sink.pendingHandlers);

  // ── Attach locator snapshots ──────────────────────────────────────────
  // Cap the drain so a stuck capture (e.g. a navigation in flight) can never
  // hang teardown past the test timeout; per-action evaluate/ariaSnapshot are
  // already bounded, this is a backstop.
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(sink.capturePromises),
    new Promise((resolve) => {
      drainDeadline = setTimeout(resolve, 2000);
    }),
  ]);
  clearTimeout(drainDeadline);

  const page = sink.lastActivePage;
  const pageReadable = page !== null && !isPageClosed(page);

  // A page the test left open (e.g. a raw browser.newPage) never passes
  // through the close wrappers — offer the picker here instead, before the
  // snapshots are attached (a confirmed pick is folded into them).
  if (pageReadable) await maybeOpenPicker(sink);

  // The stops the pause bar showed: the reporter takes the time they held out of the steps' timings.
  if (sink.stops.length > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.pauses, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(sink.stops)),
    });
  }

  if (sink.capturedLocators.length > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.locators, {
      contentType: 'application/json',
      // Repeated call sites (loops) keep only their latest capture — the
      // server stores one row per location anyway, so shipping every
      // iteration is pure payload bloat.
      body: Buffer.from(JSON.stringify(dedupeSnapshotsByLocation(sink.capturedLocators))),
    });
  }

  // The source files the test executed, whatever the outcome.
  await stopSinkCodeReach(sink);
  if (sink.codeReach.files.size > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.codeReach, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(finalizeCodeReach(sink.codeReach.files.keys()))),
    });
    // With `coverage.browser: 'functions'`, the line ranges of the functions that ran in each file.
    const functions = browserFunctionsInWorker() ? browserFunctionCoverage(sink.codeReach.files) : null;
    if (functions) {
      await testInfo.attach(ATTACHMENT_NAMES.browserCoverage, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(functions)),
      });
    }
  }
  // Every function the browser files declare, run or not, the first time this worker finds it: the run's function
  // ratio counts them.
  const known = browserFunctionsInWorker() ? newKnownFunctions(sink.codeReach.known, KNOWN_FUNCTIONS_SENT) : [];
  for (const part of known) {
    await testInfo.attach(ATTACHMENT_NAMES.browserFunctions, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(part)),
    });
  }

  // The server coverage request ids, per origin, for the reporter to collect.
  if (sink.serverCoverage.size > 0) {
    const requests: Record<string, string[]> = {};
    for (const [origin, ids] of sink.serverCoverage) requests[origin] = [...ids];
    await testInfo.attach(ATTACHMENT_NAMES.serverCoverageRequests, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(requests)),
    });
  }

  // The page each locator call ran on, whatever the outcome: a failed run's
  // calls were still made on those pages.
  if (sink.locatorPages.size > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.locatorPages, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(sink.locatorPages.list())),
    });
  }

  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
    try {
      // Prefer a live read; fall back to the snapshot the close wrappers
      // stashed — the standard test page is already closed when this auto
      // fixture tears down.
      const snapshot = (pageReadable ? await readRootAria(page) : null) ?? sink.stashedAria;
      if (snapshot) {
        await testInfo.attach(ATTACHMENT_NAMES.ariaSnapshot, {
          contentType: 'text/plain',
          body: snapshot,
        });

        const snapshotJson = (pageReadable ? await readRootAriaJson(page) : null) ?? sink.stashedAriaJson;
        if (snapshotJson) {
          await testInfo.attach(ATTACHMENT_NAMES.ariaSnapshotJson, {
            contentType: 'application/json',
            body: snapshotJson,
          });
        }

        // Suggest a fresh locator for the failed action from the current page.
        // When the element was renamed/moved, the pre-captured alternatives
        // describe the old element, so this points at where it went now — as a
        // Playwright annotation (shown in the report + trace) and an attachment
        // (shown in the trace viewer). It does NOT change the locator.
        const failed = sink.failedLocators[sink.failedLocators.length - 1];
        const suggestion = failed ? suggestLocatorsFromAria(failed, snapshot) : null;
        if (suggestion) {
          testInfo.annotations.push({
            type: LOCATOR_SUGGESTION_ANNOTATION,
            description: `${suggestion.failing} matched nothing on the failing page — the element may have been renamed or moved. Suggested: ${suggestion.suggestions.join('  |  ')}`,
          });
          await testInfo.attach(ATTACHMENT_NAMES.locatorSuggestion, {
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(suggestion)),
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // The page the test failed on, as a screenshot. Playwright's own failure
  // screenshots cover every page still open and every context the test closed,
  // none of them marked as the page the test failed on; this one is.
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped' && sink.failureScreenshot) {
    const option = sink.failureScreenshot;
    const shot =
      (pageReadable ? await internalCall(page, () => readFailureScreenshot(page, option)) : null) ??
      sink.stashedScreenshot;
    if (shot) {
      try {
        await testInfo.attach(FAILURE_SCREENSHOT_ATTACHMENT, { contentType: 'image/png', body: shot });
      } catch {
        /* ignore */
      }
    }
  }

  // Sample the ARIA snapshot at the end of a passing test, but only for the
  // tests the server flagged as due a fresh green sample this run. The same
  // attachment carries it as a failure snapshot, so ingest and the diff read it
  // the same way. Rate-limited server-side; a null sample set never samples.
  if (
    testInfo.status === 'passed' &&
    process.env.PIWI_SAMPLE_ARIA_ON_PASS !== 'false' &&
    isDueForAriaSample(testInfo)
  ) {
    try {
      const snapshot = (pageReadable ? await readRootAria(page) : null) ?? sink.stashedAria;
      if (snapshot) {
        await testInfo.attach(ATTACHMENT_NAMES.ariaSnapshot, {
          contentType: 'text/plain',
          body: snapshot,
        });
        const snapshotJson = (pageReadable ? await readRootAriaJson(page) : null) ?? sink.stashedAriaJson;
        if (snapshotJson) {
          await testInfo.attach(ATTACHMENT_NAMES.ariaSnapshotJson, {
            contentType: 'application/json',
            body: snapshotJson,
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // A confirmed picker choice — attach it and surface it in the report. The
  // snapshot write-back already happened at pick time (applyPickToSnapshots).
  if (sink.userPick) {
    const pick = sink.userPick;
    testInfo.annotations.push({
      type: USER_PICK_ANNOTATION,
      description: pick.failing
        ? `Replacement locator picked on the failing page for ${pick.failing.rendered}` +
          `${pick.failing.location ? ` at ${pick.failing.location}` : ''}: ${pick.picked.locator}`
        : `Locator picked while inspecting the failing page: ${pick.picked.locator}`,
    });
    try {
      await testInfo.attach(ATTACHMENT_NAMES.userPick, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(pick)),
      });
    } catch {
      /* ignore */
    }
  } else if (!sink.pickOffered) {
    // The overlay never ran on this failure. If a failure-time tool was
    // *enabled* but the gate refused for an environmental reason (headless /
    // CI), say so — a silent no-op after opting in is baffling. The picker's
    // gate wins the message when both flags are enabled.
    const reason =
      environmentalSkipReason(inspectionGateFromTestInfo(testInfo, process.env.PIWI_PICK_LOCATOR_ON_FAIL)) ??
      environmentalSkipReason(inspectionGateFromTestInfo(testInfo));
    if (reason) console.log(`[piwi] failure-time locator tools enabled but skipped: ${reason}`);
  }

  if (sink.consoleEntries.length > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.console, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(sink.consoleEntries)),
    });
  }

  if (sink.dialogs.length > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.dialogs, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(sink.dialogs)),
    });
  }

  if (sink.networkRequests.length > 0) {
    await testInfo.attach(ATTACHMENT_NAMES.network, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(sink.networkRequests)),
    });
  }

  // Live read when the page still exists (e.g. a browser.newPage the test left
  // open); otherwise the vitals the close wrappers stashed before the page went.
  const webVitals =
    (pageReadable ? await internalCall(page, () => readWebVitals(page)) : null) ?? sink.stashedWebVitals;
  if (webVitals) {
    await testInfo.attach(ATTACHMENT_NAMES.webVitals, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(webVitals)),
    });
  }

  // Page state at test end (pass AND fail — the pass side is the diff baseline).
  if (process.env.PIWI_CAPTURE_PAGE_STATE !== 'false') {
    const pageState =
      (pageReadable ? await internalCall(page, () => readPageState(page)) : null) ?? sink.stashedPageState;
    if (pageState) {
      await testInfo.attach(ATTACHMENT_NAMES.pageState, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(pageState)),
      });
    }
  }

  // Page inventory (controls and links) on passing runs only. Every window the
  // test recorded is attached in settle order, each with its settle time, so the
  // dashboard can attribute a request to the page current when it started — a
  // revisited page keeps its own window rather than being deduped away. The
  // still-open end page is recorded once more so a no-navigation test (and the
  // final page state) is captured; its controls/links are read at most once per
  // page key per worker.
  if (testInfo.status === 'passed' && process.env.PIWI_CAPTURE_PAGE_INVENTORY === 'true') {
    if (pageReadable) await recordPageWindow(sink, page);
    const windows = sink.pageInventories.slice(0, MAX_PAGE_INVENTORY_WINDOWS).map((inv) => capPageInventory(inv));
    if (windows.length > 0) {
      await testInfo.attach(ATTACHMENT_NAMES.pageInventory, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(windows)),
      });
    }
  }
}

/**
 * The fixtures `piwiFixtures` / `extendPiwiFixtures` contribute. The single
 * added fixture is `piwiCapture`: an auto, test-scoped teardown hook that
 * attaches the collected `piwi-*` data. Its name is **reserved** — a user
 * fixture of the same name replaces the capture teardown and silently disables
 * all capture. Exported so `piwiFixtures` and the extended `test` carry it in
 * their types (and a collision surfaces to the type checker).
 */
export interface PiwiFixtures {
  piwiCapture: void;
}

/** A pause the editor asked between tests: the next test stops at its first call. */
let pauseNextTest = false;

/** What the editor asks on the run connection, applied to the running test's stops. */
const runControl: RunControl = {
  pause() {
    const sink = currentSink;
    if (!sink) {
      pauseNextTest = true;
      return;
    }
    if (!sink.pause) {
      const why = sink.testInfo ? pauseSkipReason({ ...pauseGateFromTestInfo(sink.testInfo), channel: true }) : null;
      tellHub({ type: 'notice', message: `This test does not stop${why ? `: ${why}` : ''}.` });
      return;
    }
    sink.pause.pause = true;
    void armStops(OPEN_CONTEXTS);
  },
  breakpoints(places) {
    const set = replacePauseSet(places);
    const state = currentSink?.pause;
    if (!state) return;
    state.set = set;
    void armStops(OPEN_CONTEXTS);
  },
  runTo(place) {
    const state = currentSink?.pause;
    if (!state) return;
    state.runTo = placeLine(place);
    void armStops(OPEN_CONTEXTS);
  },
};

/** A file of the run as the run channel names it: relative to the working directory, with forward slashes. */
function runFile(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/') || file;
}

/** The run channel's word that a test begins, with why it never stops (null when it can). */
function testBegin(testInfo: TestInfo, cannotPause: string | null): RunToHub {
  const title = testInfo.titlePath.slice(1);
  return {
    type: 'test-begin',
    testId: testInfo.testId,
    title: title.length ? title : [testInfo.title],
    file: runFile(testInfo.file),
    line: Math.max(1, testInfo.line),
    project: testInfo.project.name,
    retry: testInfo.retry,
    cannotPause,
  };
}

/** The run channel's word that a test ended, with how long it stood stopped. */
function testEnd(sink: CaptureSink, testInfo: TestInfo): RunToHub {
  return {
    type: 'test-end',
    testId: testInfo.testId,
    status: testInfo.status ?? 'passed',
    pausedMs: sink.stops.reduce((sum, stop) => sum + stop.duration, 0),
  };
}

/**
 * The worker fixture `piwiFixtures` / `extendPiwiFixtures` contribute:
 * `piwiResources`, an auto, worker-scoped fixture that keeps the worker's
 * resource ledger (the browsers, contexts, pages and API request contexts its
 * tests open) from before the first hook to the worker's shutdown, records
 * the calls tests make through the API request contexts `playwright.request`
 * creates, the `request` fixture's among them, and holds the worker's run
 * connection to the editor that started the run. Its name is **reserved** like
 * `piwiCapture`'s: a fixture of your own with that name replaces it and turns
 * the ledger, those calls' capture and the run connection off.
 */
export interface PiwiWorkerFixtures {
  piwiResources: void;
}

/**
 * Playwright fixtures that collect network requests, console entries,
 * web vitals, ARIA snapshots, and locator interaction data during a test.
 *
 * Capture is wired at the `browser` level, so it works whether a test uses the
 * standard `page` fixture or builds its own pages from `browser` /
 * `browser.newContext()`. The calls a test makes through an API request
 * context (the `request` fixture, `playwright.request.newContext()`,
 * `page.request`) are recorded with its network requests. Collected data is
 * attached as `piwi-*` test-info attachments which the Piwi Dashboard reporter
 * parses on `onTestEnd`.
 */
export const piwiFixtures: Fixtures<
  PiwiFixtures,
  PiwiWorkerFixtures,
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
  // Auto, worker-scoped: the worker's resource ledger, and the API request
  // contexts its tests create, handed out behind the call proxy. Set up before
  // any hook (worker fixtures come first), so a `beforeAll` context is in the
  // ledger and records the calls the tests make through it, and torn down after
  // the browser closed, so its census sees what only the worker's shutdown
  // closed. Depends on `playwright` alone, which launches nothing. The worker's
  // run connection to the editor (`PIWI_RUN_CHANNEL`) opens here, before the
  // first test, and closes as the worker ends.
  piwiResources: [
    async ({ playwright }: PlaywrightWorkerArgs, use: UseFn<void>, workerInfo: WorkerInfo) => {
      // A browser launched in the first `beforeAll` goes through the ledger's
      // wrapper: box it before any hook runs so the step names the spec's line.
      boxCaptureFrames();
      startResourceLedger(playwright, workerInfo.workerIndex);
      observeApiRequests(playwright, apiCallRecorder);
      await openRunChannel(workerInfo, runControl);
      try {
        await use();
      } finally {
        closeRunChannel();
        stopResourceLedger();
      }
    },
    { scope: 'worker', auto: true },
  ],

  // Worker-scoped: patch the shared browser so every page/context created from
  // it — including by user fixtures that take `browser` directly — is captured.
  browser: [
    async ({ browser }: PlaywrightWorkerArgs, use: UseFn<Browser>) => {
      patchBrowser(browser);
      await use(browser);
    },
    { scope: 'worker' },
  ],

  // Safety net for the standard `page` fixture, in case its page is created
  // through an internal path the browser patch doesn't see. Idempotent, so it
  // never double-wraps a page the browser patch already instrumented.
  page: async ({ page }: PlaywrightTestArgs, use: UseFn<Page>) => {
    instrumentPage(page);
    await armStops([pageContext(page)]);
    await awaitFlakeConditions();
    await maybeStartCodeReach(page);
    await use(page);
  },

  // Auto, test-scoped: open a capture sink for the running test and flush it
  // (attach the collected data) at teardown. Runs for every test without being
  // requested, so suites that never destructure `page` are still captured.
  piwiCapture: [
    async (
      { screenshot, baseURL }: PlaywrightWorkerOptions & PlaywrightTestOptions,
      use: UseFn<void>,
      testInfo: TestInfo,
    ) => {
      boxCaptureFrames();
      const conflict = labModeConflict();
      if (conflict) throw new Error(conflict);
      const sink = createSink();
      sink.testInfo = testInfo;
      sink.baseURL = baseURL ?? null;
      if (keepsFailureScreenshots(screenshot, testInfo.retry)) sink.failureScreenshot = screenshot;
      const pauseSet = currentPauseSet();
      const channel = runChannelOpen();
      const cannotPause = pauseSkipReason({ ...pauseGateFromTestInfo(testInfo), channel });
      if (pauseSet.size || channel) {
        if (!cannotPause) sink.pause = pauseState(pauseSet, pauseNextTest);
        else if (pauseSet.size) logPauseSkipOnce(cannotPause);
      }
      pauseNextTest = false;
      if (channel) tellHub(testBegin(testInfo, cannotPause));
      if (isFlakeMode()) {
        const plan = loadFlakePlan();
        const role = flakeRoleForTest(plan, {
          file: testInfo.file,
          base: configDirFromConfig(testInfo.config),
          title: testInfo.title,
          titlePath: testInfo.titlePath,
          project: testInfo.project.name,
        });
        if (role) {
          const browserName = (testInfo.project.use as { browserName?: string } | undefined)?.browserName ?? null;
          sink.flake = { plan, role, startedAt: Date.now(), browserName, conditions: null };
        }
      }
      if (isProbeMode())
        sink.probeItem = probeItemForTest({
          title: testInfo.title,
          file: testInfo.file,
          titlePath: testInfo.titlePath,
          base: configDirFromConfig(testInfo.config),
        });
      activeResourceLedger()?.testStarted(testInfo);
      currentSink = sink;
      const showRunChannel = hideRunChannel();
      try {
        // The contexts a hook or an earlier test opened stop at this test's breakpoints too.
        await armStops(OPEN_CONTEXTS);
        await startCodeReachOnOpenPages();
        await use();
      } finally {
        showRunChannel();
        currentSink = null;
        // A pause the editor asked that no call of this test took stops the next test's first call.
        if (sink.pause?.pause) pauseNextTest = true;
        // Record the probe outcome (this test noticed the fault iff it failed)
        // before flushing the rest of the capture.
        if (sink.probeItem) {
          const applied = sink.probeInterception?.applied() ?? false;
          const level = sink.probeItem.level ?? 'client';
          // `handled` classifies an applied server fault for the resilience
          // findings, from the page errors after it applied, the console errors
          // and dialogs this test collected, the blank page and the backend error
          // the probe response's trace carried. Client faults never reach the
          // server and a fault not applied did nothing, so both record `n/a`.
          const handled =
            level === 'server' && applied
              ? classifyProbeHandled({
                  consoleErrors: sink.consoleEntries.filter((e) => e.type === 'error').length,
                  dialogs: sink.dialogs.length,
                  backendError: sink.probeInterception?.serverError() ?? false,
                  pageErrors: sink.probePageErrors,
                  blankPage: sink.probeBlankPage,
                })
              : 'n/a';
          recordProbeOutcome({
            testCaseId: sink.probeItem.testCaseId,
            routeKey: sink.probeItem.routeKey,
            fault: sink.probeItem.fault,
            applied,
            outcome: outcomeFromStatus(testInfo.status, applied),
            level,
            dependency: sink.probeItem.dependency ?? null,
            handled,
          });
        }
        if (sink.flake) await recordFlakeAttempt(sink.flake, testInfo);
        try {
          await flushSink(sink, testInfo);
        } finally {
          sink.markFlushed();
          if (runChannelOpen()) tellHub(testEnd(sink, testInfo));
        }
        // Last: the test-scoped fixtures have torn down, so what is still open
        // now outlived the test. Throws under `PIWI_LEAK_CHECK=fail`.
        await recordResourceCensus(testInfo);
      }
    },
    { auto: true },
  ],
};

/**
 * Append the flake results line for a finished attempt. Its span runs from the
 * capture fixture's setup to its teardown, which wraps the test body and its
 * test-scoped fixtures.
 */
async function recordFlakeAttempt(flake: NonNullable<CaptureSink['flake']>, testInfo: TestInfo): Promise<void> {
  const installed = flake.conditions ? await flake.conditions : null;
  recordFlakeResult(
    flakeResultLine(flake.plan, {
      role: flake.role,
      file: testInfo.file,
      base: configDirFromConfig(testInfo.config),
      title: testInfo.title,
      project: testInfo.project.name || null,
      browserName: flake.browserName,
      status: testInfo.status ?? 'passed',
      errorText: joinErrorMessages(testInfo.errors),
      startedAt: flake.startedAt,
      duration: Date.now() - flake.startedAt,
      workerIndex: testInfo.workerIndex,
      parallelIndex: testInfo.parallelIndex,
      repeatEachIndex: testInfo.repeatEachIndex,
      retry: testInfo.retry,
      conditions: installed ? installed.reports() : unappliedReports(flake.plan),
    }),
  );
}

/**
 * Extend a Playwright `test` object with the Piwi capture fixtures. The
 * returned `test` carries the existing fixtures plus {@link PiwiFixtures}.
 *
 * Use this instead of importing `@playwright/test` directly from this package
 * to avoid the "Requiring @playwright/test second time" error caused by
 * duplicate module resolution.
 *
 * @example
 * ```ts
 * import { test as base } from '@playwright/test';
 * import { extendPiwiFixtures } from '@piwitests/reporter';
 *
 * export const test = extendPiwiFixtures(base);
 * ```
 */
export function extendPiwiFixtures<TestArgs extends FixtureArgs, WorkerArgs extends FixtureArgs>(
  test: TestType<TestArgs, WorkerArgs>,
): TestType<TestArgs & PiwiFixtures, WorkerArgs & PiwiWorkerFixtures> {
  return (
    test as unknown as {
      extend: (f: typeof piwiFixtures) => TestType<TestArgs & PiwiFixtures, WorkerArgs & PiwiWorkerFixtures>;
    }
  ).extend(piwiFixtures);
}
