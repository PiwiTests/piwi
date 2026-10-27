import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { PIWI_ENV_KEYS, PIWI_RESOURCES_RESULTS_ENV } from '../config/env.js';
import { ATTACHMENT_NAMES } from './attachments.js';
import { internalCall, resolvePlaywrightPackageJson } from './quiet-capture.js';
import { PageReader, WorkerMetrics, type PageMain, type TestMetrics } from './worker-metrics.js';
import { roleOf } from '../support/system-readers.js';

/**
 * The resource ledger: every browser, context, page and API request context a
 * worker opens, where it was opened, whether anything ran on it, and when it
 * closed. One per worker process, started by the `piwiResources` worker fixture
 * before any hook runs. At the end of each test the capture fixture takes a
 * census — what was born and closed since the last one, and what is open now —
 * and attaches it as `piwi-resources`; the reporter turns the censuses into
 * findings (`internal/collect/resource-verdicts.ts`). It never throws into a
 * test, and every Playwright internal it reads is feature-detected.
 */

export type ResourceKind = 'browser' | 'context' | 'page' | 'request';

/** What the capture fixtures do with an object a test left open: list it, fail the test, or close it. */
export type LeakCheck = 'report' | 'fail' | 'close';

/** The kind of code Playwright was running when an object was opened or closed. */
export type ResourcePhase = 'test' | 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll' | 'worker';

/** A test, as a census and the objects it saw name it. */
export interface ResourceTestRef {
  id: string;
  /** Spec file relative to the working directory, POSIX separators. */
  file: string;
  /** The describe blocks between the file and the test. */
  suite: string[];
  /** Set on the test a census closes. */
  title?: string;
  /** Set on the test a census closes when it failed: Playwright shuts its worker down right after it. */
  failed?: boolean;
}

export interface ResourceBirth {
  id: number;
  kind: ResourceKind;
  /** The context of a page, the browser of a context. */
  parent: number | null;
  at: number;
  phase: ResourcePhase;
  /** The fixture being set up when the object was opened; `worker` when that fixture is worker-scoped. */
  fixture: { title: string; location: string | null; worker: boolean } | null;
  /** The test it was opened during; for a `beforeAll`, the test that ran the hook. */
  test: ResourceTestRef | null;
  /** The line that opened it, `file:line`. */
  site: string | null;
  /** A popup: the page that opened it. */
  opener?: number;
  /** A popup: the call that was running or last ran when it appeared. */
  trigger?: string;
  /** A context `browser.newPage()` opened for its page. */
  implicit?: boolean;
  /** A context Playwright reuses across tests on purpose (UI mode, `--reuse-context`). */
  reused?: boolean;
}

export interface ResourceClose {
  id: number;
  at: number;
  phase: ResourcePhase;
  test: ResourceTestRef | null;
  /** Pages: whether anything ever ran on it. */
  used?: boolean;
  /** Closed by `PIWI_LEAK_CHECK=close`. */
  byPiwi?: boolean;
}

export interface ResourceOpen {
  id: number;
  /** Pages: whether anything ran on it so far. */
  used?: boolean;
  /** Pages: the current URL, without query or hash. */
  url?: string;
  /** Pages: listeners on Playwright's page events. */
  listeners?: number;
  /** Pages and contexts: `route()` handlers. */
  routes?: number;
  /** Contexts: open pages. */
  pages?: number;
  /** Pages, over CDP: main-thread CPU and weight. */
  main?: PageMain;
}

/** One census: what changed since the previous one in this worker, and what is open now. */
export interface ResourceCensus {
  v: 1;
  /** Playwright's worker index and the worker's process id. */
  worker: number;
  pid: number;
  at: number;
  /** The test this census closes; null for the census a worker takes as it shuts down. */
  test: ResourceTestRef | null;
  born: ResourceBirth[];
  closed: ResourceClose[];
  open: ResourceOpen[];
  /** Counts of the tracked Node handle types in the worker at the test's start and end. */
  handles?: { start: Record<string, number>; end: Record<string, number> };
  /** What the test cost the worker and the browsers it started. */
  metrics?: TestMetrics;
  /** Contexts and pages already open in the worker when the test started. */
  openAtStart?: { contexts: number; pages: number };
  /** Objects the test opened itself and left open (what `PIWI_LEAK_CHECK` judges). */
  leftOpen?: number;
  /**
   * The servers and child processes the test started (its body, its
   * each-hooks or a test-scoped fixture) and left running in the worker, with
   * the line that started each. Present when the ledger tracks them; the
   * `handles` counts then leave servers out.
   */
  running?: RunningHandle[];
}

/** A server or a child process a test left running in the worker. */
export interface RunningHandle {
  type: NodeHandleType;
  /** The line that started it, `file:line`. */
  site: string | null;
  /** A child process: the program it runs, without its arguments. */
  command?: string;
}

/** The Node handles the ledger tracks one by one, by Node's own type names. */
export type NodeHandleType = 'TCPServerWrap' | 'ChildProcess';

/** An object a test opened itself and left open: what `PIWI_LEAK_CHECK` fails or closes. */
export interface LeakedResource {
  id: number;
  kind: ResourceKind;
  site: string | null;
  /** Contexts and browsers: how many open pages go with it. */
  pages: number;
  implicit: boolean;
  /** A popup: the call that opened it. */
  trigger?: string;
}

/**
 * Node handle types a test can leave in the worker: a server left listening, a
 * file watcher. Sockets, timers and child processes are not counted: Playwright's
 * own connections and timers make them move on every test. A ledger that
 * tracks servers one by one (`RunningHandle`) counts the file watchers alone.
 */
export const TRACKED_HANDLE_TYPES: readonly string[] = ['TCPServerWrap', 'FSEventWrap', 'StatWatcher'];
const COUNTED_WITH_RUNNING: readonly string[] = ['FSEventWrap', 'StatWatcher'];

/** Process roles Playwright starts itself: a child process with one of them is never the test's. */
const PLAYWRIGHT_ROLES = new Set(['worker', 'runner', 'browser', 'renderer', 'gpu', 'utility', 'ffmpeg']);

/** Frames a call through a library can take before it reaches the test's line. */
const HANDLE_STACK_LIMIT = 40;

/** Page methods that count as using the page even when it never navigated. */
const USE_METHODS = ['evaluate', 'evaluateHandle', '$eval', '$$eval', 'waitForFunction', 'addScriptTag', 'addStyleTag'];

/** How long `PIWI_LEAK_CHECK=close` waits for one close before moving on. */
const CLOSE_TIMEOUT_MS = 5000;

/** The most open pages read over CDP at one census, and how long the reads may take together. */
const PAGE_READ_CAP = 50;
const PAGE_READ_TIMEOUT_MS = 1000;

/** The parts of Playwright's API-call zone the ledger reads (internal). */
interface ApiZone {
  apiName?: string;
  frames?: Array<{ file?: string; line?: number }>;
}

interface Instrumentation {
  addListener?: (listener: object) => void;
  removeListener?: (listener: object) => void;
}

type BrowserTypeLike = Record<string, unknown>;

interface PlaywrightLike {
  _instrumentation?: Instrumentation;
  chromium?: BrowserTypeLike;
  firefox?: BrowserTypeLike;
  webkit?: BrowserTypeLike;
}

/** The parts of Playwright's worker `TestInfo` the ledger reads (`_timeoutManager` is internal). */
export interface TestInfoLike {
  testId?: string;
  title?: string;
  file?: string;
  titlePath?: string[];
  status?: string;
  expectedStatus?: string;
  _timeoutManager?: {
    _running?: {
      runnable?: {
        type?: string;
        fixture?: { title?: string; location?: { file?: string; line?: number }; slot?: unknown };
      };
    } | null;
  };
}

interface Entry {
  birth: ResourceBirth;
  object: object | null;
  closed: ResourceClose | null;
  used: boolean;
}

/** A server or child process the worker started, where and while what it was started, and whether it still runs. */
interface HandleEntry {
  type: NodeHandleType;
  phase: ResourcePhase;
  fixture: ResourceBirth['fixture'];
  test: ResourceTestRef | null;
  site: string | null;
  command?: string;
  running: () => boolean;
  /** A server whose `listen` has not bound yet: read again a tick later. */
  pending?: () => boolean;
}

const HOOK_PHASES = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const KIND_ORDER: Record<ResourceKind, number> = { browser: 0, context: 1, page: 2, request: 3 };

/** A path relative to the working directory, POSIX separators. */
function relativePath(file: string): string {
  return path
    .relative(process.cwd(), file.replace(/^file:\/\//, ''))
    .split(path.sep)
    .join('/');
}

/** Frames that are never the line a test wrote: Node itself, installed packages, this module. */
function isLibraryFile(file: string): boolean {
  return (
    file.startsWith('node:') ||
    file.startsWith('internal/') ||
    file.includes(`${path.sep}node_modules${path.sep}`) ||
    file.includes('/node_modules/') ||
    file === __filename
  );
}

/** The first frame of a stack that belongs to the test code, `file:line`. */
export function userSite(stack: string | undefined): string | null {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = /^\s*at\s+(?:.*?\s+\()?(.+?):(\d+):\d+\)?$/.exec(line);
    if (!match) continue;
    const file = match[1]!.replace(/^file:\/\//, '');
    if (isLibraryFile(file) || !/\.[a-z]+$/i.test(file)) continue;
    return `${relativePath(file)}:${match[2]}`;
  }
  return null;
}

/** The first frame of an API call that belongs to the test code. */
function zoneSite(zone: ApiZone | null): string | null {
  for (const frame of zone?.frames ?? []) {
    if (!frame?.file || isLibraryFile(frame.file)) continue;
    return `${relativePath(frame.file)}:${frame.line ?? 0}`;
  }
  return null;
}

/** The test a `TestInfo` describes, when it describes one. */
function testRef(info: TestInfoLike | null): ResourceTestRef | null {
  if (!info?.testId) return null;
  const titlePath = Array.isArray(info.titlePath) ? info.titlePath : [];
  return {
    id: info.testId,
    file: info.file ? relativePath(info.file) : '',
    suite: titlePath.slice(1, -1).map(String),
  };
}

/** What Playwright is running, from the test info it holds while it runs it. */
function runnableOf(info: TestInfoLike | null): { phase: ResourcePhase; fixture: ResourceBirth['fixture'] } {
  if (!info) return { phase: 'worker', fixture: null };
  const runnable = info._timeoutManager?._running?.runnable;
  const type = typeof runnable?.type === 'string' ? runnable.type : 'test';
  const phase: ResourcePhase = HOOK_PHASES.has(type)
    ? (type as ResourcePhase)
    : type === 'teardown'
      ? 'worker'
      : 'test';
  const raw = runnable?.fixture;
  const fixture =
    raw && typeof raw.title === 'string'
      ? {
          title: raw.title,
          location: raw.location?.file ? `${relativePath(raw.location.file)}:${raw.location.line ?? 0}` : null,
          worker: raw.slot !== undefined && raw.slot !== null,
        }
      : null;
  return { phase, fixture };
}

/** Without Playwright's test info: inside a census window it is the test, outside it the worker. */
function fallbackRunnable(window: ResourceTestRef | null): { phase: ResourcePhase; fixture: null } {
  return { phase: window ? 'test' : 'worker', fixture: null };
}

/**
 * Reads the test info Playwright's worker holds for what it runs right now,
 * from `playwright/lib/globals.js` (internal). Loaded by absolute path through
 * the same resolution the runner uses, so it is the runner's own instance; on a
 * layout this cannot follow, it reads nothing and objects carry no phase.
 */
function playwrightTestInfoSource(): () => TestInfoLike | null {
  try {
    const packageJson = resolvePlaywrightPackageJson();
    if (!packageJson) return () => null;
    const globals = createRequire(packageJson)(path.join(path.dirname(packageJson), 'lib', 'globals.js')) as {
      currentTestInfo?: () => TestInfoLike | null;
    };
    const read = globals.currentTestInfo;
    if (typeof read !== 'function') return () => null;
    return () => {
      try {
        return read() ?? null;
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}

/** The `PIWI_LEAK_CHECK` mode; anything unknown is `report`. */
export function readLeakCheck(value = process.env[PIWI_ENV_KEYS.leakCheck]): LeakCheck {
  return value === 'fail' || value === 'close' ? value : 'report';
}

/** Counts of the given Node handle types in this process. */
function countHandles(types: readonly string[] = TRACKED_HANDLE_TYPES): Record<string, number> {
  const counts: Record<string, number> = {};
  const read = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (typeof read !== 'function') return counts;
  for (const type of read.call(process)) {
    if (types.includes(type)) counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/**
 * The handle counts at a test's end. A server reports a second handle until a
 * timer tick after it starts listening, so a count above the start is read
 * again one tick later; most tests open none and pay nothing.
 */
async function settledHandles(
  start: Record<string, number>,
  types: readonly string[] = TRACKED_HANDLE_TYPES,
): Promise<Record<string, number>> {
  const end = countHandles(types);
  if (!Object.entries(end).some(([type, n]) => n > (start[type] ?? 0))) return end;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return countHandles(types);
}

/** The line of the test code that made the current call, read through a deeper stack than Node's default. */
function deepUserSite(): string | null {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = HANDLE_STACK_LIMIT;
  try {
    return userSite(new Error().stack);
  } finally {
    Error.stackTraceLimit = limit;
  }
}

const SHELLS = /^(?:sh|bash|dash|zsh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh)$/i;

/**
 * The program a child process runs, its file name alone; for a command a
 * shell runs (`exec`, `shell: true`), the command's first word.
 */
export function commandOf(spawnfile: unknown, spawnargs: unknown): string {
  const name = (file: string) => path.basename(file.replace(/\\/g, '/').replace(/^["']|["']$/g, ''));
  const program = typeof spawnfile === 'string' ? name(spawnfile) : '';
  const args = Array.isArray(spawnargs) ? spawnargs.map(String) : [];
  const script = args.findIndex((arg) => arg === '-c' || /^\/c$/i.test(arg));
  if (SHELLS.test(program) && script >= 0 && args[script + 1]) {
    const first = args[script + 1]!.trim().split(/\s+/)[0];
    if (first) return name(first);
  }
  return program || 'a child process';
}

/** Resolve with `undefined` after `ms` when the promise has not settled. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class ResourceLedger {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();
  private readonly byObject = new WeakMap<object, Entry>();
  private readonly pendingCalls = new Set<ApiZone>();
  private lastCall: ApiZone | null = null;
  /** The page a wrapped page method is calling into: its first reported API call marks it used. */
  private usingPage: Entry | null = null;
  private born: ResourceBirth[] = [];
  private closed: ResourceClose[] = [];
  private handlesAtStart: Record<string, number> = {};
  private openAtStart: { contexts: number; pages: number } = { contexts: 0, pages: 0 };
  /** The test between `testStarted` and `testEnded`, for when Playwright's own test info cannot be read. */
  private window: ResourceTestRef | null = null;
  private listener: object | null = null;
  /** A browser or a context was opened in this worker: there are browser processes for the metrics to read. */
  private sawBrowser = false;
  /** The servers and child processes still running, while the ledger tracks them. */
  private readonly handles = new Set<HandleEntry>();
  private readonly byHandle = new WeakMap<object, HandleEntry>();
  private trackingHandles = false;
  private readonly restores: Array<() => void> = [];

  constructor(
    private readonly playwright: PlaywrightLike,
    readonly workerIndex: number,
    readonly leakCheck: LeakCheck = readLeakCheck(),
    private readonly resultsFile: string | null = process.env[PIWI_RESOURCES_RESULTS_ENV] || null,
    private readonly testInfoSource: () => TestInfoLike | null = playwrightTestInfoSource(),
    private readonly now: () => number = Date.now,
    private readonly readers: { metrics?: WorkerMetrics | null; pages?: PageReader | null } = {},
    /** Track the servers and child processes the worker starts, by wrapping Node's `listen` and `spawn`. */
    private readonly nodeHandles = false,
  ) {}

  /** Listen to the worker's Playwright and wrap its browser types. False when the instrumentation is missing. */
  install(): boolean {
    const instrumentation = this.playwright?._instrumentation;
    if (!instrumentation || typeof instrumentation.addListener !== 'function') return false;
    this.listener = {
      onApiCallBegin: (zone: ApiZone) => {
        if (this.pendingCalls.size > 1000) this.pendingCalls.clear();
        this.pendingCalls.add(zone);
        this.lastCall = zone;
        // Internal calls (Piwi's own reads among them) never reach this hook.
        if (this.usingPage) {
          this.usingPage.used = true;
          this.usingPage = null;
        }
      },
      onApiCallEnd: (zone: ApiZone) => {
        this.pendingCalls.delete(zone);
      },
      runAfterCreateBrowserContext: async (context: BrowserContext) => {
        this.guard(() => this.onContext(context, userSite(new Error().stack)));
      },
      runAfterCreateRequestContext: async (request: APIRequestContext) => {
        this.guard(() => this.track(request, 'request', null, userSite(new Error().stack)));
      },
      runBeforeCloseRequestContext: async (request: APIRequestContext) => {
        this.guard(() => this.onClosed(request));
      },
    };
    instrumentation.addListener(this.listener);
    for (const type of [this.playwright.chromium, this.playwright.firefox, this.playwright.webkit]) {
      if (type) this.wrapBrowserType(type);
    }
    if (this.nodeHandles) this.guard(() => this.wrapNodeHandles());
    return true;
  }

  /** Stop listening, and put Node's `listen` and `spawn` back; the objects already tracked stay in the ledger. */
  uninstall(): void {
    const remove = this.playwright?._instrumentation?.removeListener;
    if (this.listener && typeof remove === 'function') remove.call(this.playwright._instrumentation, this.listener);
    this.listener = null;
    for (const restore of this.restores.splice(0)) restore();
    this.trackingHandles = false;
  }

  /**
   * Wrap `net.Server.prototype.listen` (every HTTP, HTTPS and TCP server) and
   * `ChildProcess.prototype.spawn` (`spawn`, `exec`, `execFile` and `fork`), so
   * each server and child process the worker starts carries the line and the
   * runnable that started it, as a context does. A worker-scoped fixture's
   * server is then the worker's, never the first test's. Each wrapper calls the
   * original on its receiver and only records; it never throws.
   */
  private wrapNodeHandles(): void {
    const onServer = (server: net.Server, site: string | null) => this.guard(() => this.onServer(server, site));
    const onChild = (child: childProcess.ChildProcess, site: string | null) =>
      this.guard(() => this.onChild(child, site));
    const server = net.Server.prototype as unknown as Record<string, unknown>;
    const listen = server.listen as (this: net.Server, ...args: unknown[]) => net.Server;
    if (typeof listen === 'function') {
      const wrapped = function (this: net.Server, ...args: unknown[]): net.Server {
        onServer(this, deepUserSite());
        return listen.apply(this, args);
      };
      server.listen = wrapped;
      this.restores.push(() => {
        if (server.listen === wrapped) server.listen = listen;
      });
    }
    const child = childProcess.ChildProcess?.prototype as unknown as Record<string, unknown> | undefined;
    const spawn = child?.spawn as ((this: childProcess.ChildProcess, ...args: unknown[]) => unknown) | undefined;
    if (child && typeof spawn === 'function') {
      const wrapped = function (this: childProcess.ChildProcess, ...args: unknown[]): unknown {
        const site = deepUserSite();
        const result = spawn.apply(this, args);
        onChild(this, site);
        return result;
      };
      child.spawn = wrapped;
      this.restores.push(() => {
        if (child.spawn === wrapped) child.spawn = spawn;
      });
    }
    this.trackingHandles = true;
  }

  private trackHandle(object: object, entry: Omit<HandleEntry, 'phase' | 'fixture' | 'test'>): HandleEntry {
    const info = this.testInfoSource();
    const { phase, fixture } = info ? runnableOf(info) : fallbackRunnable(this.window);
    const tracked: HandleEntry = { ...entry, phase, fixture, test: testRef(info) ?? this.window };
    this.handles.add(tracked);
    this.byHandle.set(object, tracked);
    return tracked;
  }

  private onServer(server: net.Server, site: string | null): void {
    const known = this.byHandle.get(server);
    if (known && this.handles.has(known)) return;
    let bound = false;
    let closed = false;
    const entry = this.trackHandle(server, {
      type: 'TCPServerWrap',
      site,
      // `close()` unbinds at once, while its 'close' event waits for open connections.
      running: () => server.listening,
      pending: () => !bound && !closed && !server.listening,
    });
    server.once('listening', () => {
      bound = true;
    });
    server.once('close', () => {
      closed = true;
      this.handles.delete(entry);
    });
  }

  private onChild(child: childProcess.ChildProcess, site: string | null): void {
    // Playwright's own browsers and ffmpeg are tracked as browsers, or are the browser's.
    const command = commandOf(child.spawnfile, child.spawnargs);
    const role = roleOf(command, (child.spawnargs ?? []).join(' '));
    if ((role && PLAYWRIGHT_ROLES.has(role)) || child.pid === undefined) return;
    const entry = this.trackHandle(child, {
      type: 'ChildProcess',
      site,
      command,
      running: () => child.exitCode === null && child.signalCode === null,
    });
    child.once('exit', () => this.handles.delete(entry));
  }

  /**
   * The servers and child processes a test started (its body, its each-hooks
   * or a test-scoped fixture) that still run. A server whose `listen` has not
   * bound yet is read again one tick later.
   */
  private async runningOf(testId: string): Promise<RunningHandle[]> {
    const own = () =>
      [...this.handles].filter(
        (entry) =>
          entry.test?.id === testId &&
          !entry.fixture?.worker &&
          (entry.phase === 'test' || entry.phase === 'beforeEach' || entry.phase === 'afterEach'),
      );
    if (own().some((entry) => entry.pending?.())) await new Promise((resolve) => setTimeout(resolve, 0));
    return own()
      .filter((entry) => entry.running())
      .map((entry) => ({ type: entry.type, site: entry.site, ...(entry.command ? { command: entry.command } : {}) }));
  }

  /** Mark a page used: a locator was built on it. */
  notePageUse(page: object): void {
    const entry = this.byObject.get(page);
    if (entry) entry.used = true;
  }

  /** Open the census window of a test. */
  testStarted(info: TestInfoLike): void {
    this.window = testRef(info);
    this.handlesAtStart = countHandles(this.countedHandleTypes());
    this.openAtStart = { contexts: 0, pages: 0 };
    for (const entry of this.openEntries()) {
      if (entry.birth.kind === 'page') this.openAtStart.pages++;
      else if (entry.birth.kind === 'context') this.openAtStart.contexts++;
    }
    this.readers.metrics?.start(this.sawBrowser);
  }

  /**
   * Close the census window of a test: apply `PIWI_LEAK_CHECK=close` to what the
   * test left open, then take the census. Called after the test-scoped fixtures
   * tore down, so what the test opened through them is closed by now.
   */
  async testEnded(info: TestInfoLike): Promise<{ census: ResourceCensus; leaks: LeakedResource[] }> {
    const test = testRef(info) ?? this.window;
    // Playwright shuts the worker down right after a failed test, and what the
    // test left open goes with it: it is neither listed, failed again nor closed.
    const failed =
      typeof info.status === 'string' && typeof info.expectedStatus === 'string' && info.status !== info.expectedStatus;
    const leaks = test && !failed ? this.leaksOf(test.id) : [];
    if (this.leakCheck === 'close' && leaks.length > 0) await this.closeLeaks(leaks);
    const ref = test
      ? { ...test, title: typeof info.title === 'string' ? info.title : '', ...(failed ? { failed: true } : {}) }
      : null;
    const metrics = this.readers.metrics?.end(this.sawBrowser) ?? null;
    const handles = {
      start: this.handlesAtStart,
      end: await settledHandles(this.handlesAtStart, this.countedHandleTypes()),
    };
    const running = this.trackingHandles && test ? await this.runningOf(test.id) : null;
    const census = this.census(ref, handles, await this.readPages());
    if (metrics) census.metrics = metrics;
    if (running) census.running = running;
    if (test) {
      census.openAtStart = this.openAtStart;
      if (!failed) census.leftOpen = leaks.length;
    }
    this.window = null;
    return { census, leaks };
  }

  /** The open pages' main thread and weight, over CDP, within a deadline. */
  private async readPages(): Promise<Map<number, PageMain>> {
    const out = new Map<number, PageMain>();
    const reader = this.readers.pages;
    if (!reader) return out;
    const pages = this.openEntries()
      .filter((entry) => entry.birth.kind === 'page')
      .slice(0, PAGE_READ_CAP);
    await settleWithin(
      Promise.all(
        pages.map(async (entry) => {
          const main = entry.object ? await reader.read(entry.object) : null;
          if (main) out.set(entry.birth.id, main);
        }),
      ),
      PAGE_READ_TIMEOUT_MS,
    );
    return out;
  }

  /** The census a worker takes as it shuts down, appended to the results file when the reporter set one. */
  workerEnded(): ResourceCensus {
    const census = this.census(null);
    if (this.resultsFile) {
      try {
        fs.appendFileSync(this.resultsFile, `${JSON.stringify(census)}\n`);
      } catch {
        // The census of the worker's last test stands in.
      }
    }
    this.readers.metrics?.dispose();
    this.uninstall();
    return census;
  }

  /** The handle types counted at each boundary: servers leave the count once they are tracked one by one. */
  private countedHandleTypes(): readonly string[] {
    return this.trackingHandles ? COUNTED_WITH_RUNNING : TRACKED_HANDLE_TYPES;
  }

  private guard(run: () => void): void {
    try {
      run();
    } catch {
      // The ledger is a side channel: it must never affect the test.
    }
  }

  private wrapBrowserType(type: BrowserTypeLike): void {
    for (const method of ['launch', 'connect', 'connectOverCDP']) {
      const original = type[method];
      if (typeof original !== 'function') continue;
      const bound = (original as (...args: unknown[]) => Promise<Browser>).bind(type);
      type[method] = async (...args: unknown[]): Promise<Browser> => {
        const site = userSite(new Error().stack);
        const browser = await bound(...args);
        this.guard(() => this.onBrowser(browser, site));
        return browser;
      };
    }
  }

  private track(object: object, kind: ResourceKind, parent: object | null, site: string | null): Entry {
    const existing = this.byObject.get(object);
    if (existing) return existing;
    const info = this.testInfoSource();
    const { phase, fixture } = info ? runnableOf(info) : fallbackRunnable(this.window);
    const birth: ResourceBirth = {
      id: this.nextId++,
      kind,
      parent: parent ? (this.byObject.get(parent)?.birth.id ?? null) : null,
      at: this.now(),
      phase,
      fixture,
      test: testRef(info) ?? this.window,
      site,
    };
    const entry: Entry = { birth, object, closed: null, used: false };
    if (kind === 'browser' || kind === 'context') this.sawBrowser = true;
    this.entries.set(birth.id, entry);
    this.byObject.set(object, entry);
    this.born.push(birth);
    return entry;
  }

  private onBrowser(browser: Browser, site: string | null): Entry {
    const known = this.byObject.get(browser);
    if (known) return known;
    const entry = this.track(browser, 'browser', null, site);
    browser.on('disconnected', () => this.guard(() => this.onClosed(browser)));
    return entry;
  }

  private onContext(context: BrowserContext, site: string | null): void {
    if (this.byObject.has(context)) return;
    const browser = context.browser();
    if (browser) this.onBrowser(browser, site);
    const entry = this.track(context, 'context', browser, site);
    const zone = this.latestPendingCall();
    if (zone?.apiName?.endsWith('.newPage')) entry.birth.implicit = true;
    if ((context as unknown as { _forReuse?: boolean })._forReuse) entry.birth.reused = true;
    context.on('close', () => this.guard(() => this.onClosed(context)));
    context.on('page', (page: Page) => this.guard(() => this.onPage(page, context)));
    for (const page of context.pages()) this.onPage(page, context, { site });
  }

  /** `initial` is set for a page that came with its context (a persistent context's), which is no popup. */
  private onPage(page: Page, context: BrowserContext, initial?: { site: string | null }): void {
    if (this.byObject.has(page)) return;
    // A page `newPage` opened arrives while that call is still running; anything
    // else is a popup, opened by its page through the call that last ran.
    const zone = this.latestPendingCall();
    const viaNewPage = !!zone?.apiName?.endsWith('.newPage');
    const popup = !viaNewPage && !initial;
    const site = viaNewPage ? zoneSite(zone) : initial ? initial.site : zoneSite(this.lastCall);
    const entry = this.track(page, 'page', context, site);
    if (popup) {
      const opener = (page as unknown as { _opener?: object | null })._opener;
      const openerEntry = opener ? this.byObject.get(opener) : undefined;
      if (openerEntry) entry.birth.opener = openerEntry.birth.id;
      if (this.lastCall?.apiName) entry.birth.trigger = this.lastCall.apiName;
    }
    const markUsed = () => {
      entry.used = true;
    };
    page.on('load', markUsed);
    page.on('domcontentloaded', markUsed);
    page.on('framenavigated', (frame) => {
      try {
        if (frame === page.mainFrame() && frame.url() !== 'about:blank') entry.used = true;
      } catch {
        // A frame that is already gone.
      }
    });
    page.on('close', () => this.guard(() => this.onClosed(page)));
    const methods = page as unknown as Record<string, unknown>;
    for (const method of USE_METHODS) {
      const original = methods[method];
      if (typeof original !== 'function') continue;
      const bound = (original as (...args: unknown[]) => unknown).bind(page);
      methods[method] = (...args: unknown[]): unknown => {
        const previous = this.usingPage;
        this.usingPage = entry;
        try {
          return bound(...args);
        } finally {
          this.usingPage = previous;
        }
      };
    }
  }

  private onClosed(object: object, byPiwi = false): void {
    const entry = this.byObject.get(object);
    if (!entry || entry.closed) return;
    const info = this.testInfoSource();
    const { phase } = info ? runnableOf(info) : fallbackRunnable(this.window);
    const close: ResourceClose = {
      id: entry.birth.id,
      at: this.now(),
      phase,
      test: testRef(info) ?? this.window,
    };
    if (entry.birth.kind === 'page') close.used = entry.used;
    if (byPiwi) close.byPiwi = true;
    entry.closed = close;
    entry.object = null;
    this.closed.push(close);
  }

  private latestPendingCall(): ApiZone | null {
    let latest: ApiZone | null = null;
    for (const zone of this.pendingCalls) latest = zone;
    return latest;
  }

  private openEntries(): Entry[] {
    return [...this.entries.values()].filter((entry) => !entry.closed && entry.object);
  }

  /**
   * Objects a test opened itself, by its body or its each-hooks, and left open.
   * A page in a leaked context, or a context in a leaked browser, goes with it;
   * the context `browser.newPage()` opened for its page goes with the page.
   */
  private leaksOf(testId: string): LeakedResource[] {
    const open = this.openEntries().filter(
      (entry) =>
        entry.birth.test?.id === testId &&
        entry.birth.fixture === null &&
        (entry.birth.phase === 'test' || entry.birth.phase === 'beforeEach' || entry.birth.phase === 'afterEach') &&
        !entry.birth.reused,
    );
    const openIds = new Set(open.map((entry) => entry.birth.id));
    const foldsIntoLeak = (entry: Entry): boolean => {
      let parentId = entry.birth.parent;
      while (parentId !== null) {
        if (!this.isImplicit(parentId)) return openIds.has(parentId);
        parentId = this.entries.get(parentId)?.birth.parent ?? null;
      }
      return false;
    };
    return open
      .filter((entry) => !(entry.birth.kind === 'context' && this.isImplicit(entry.birth.id)))
      .filter((entry) => !foldsIntoLeak(entry))
      .map((entry) => ({
        id: entry.birth.id,
        kind: entry.birth.kind,
        site: entry.birth.site,
        pages: entry.birth.kind === 'page' ? 0 : this.pagesUnder(entry.birth.id),
        implicit: false,
        ...(entry.birth.opener !== undefined ? { trigger: entry.birth.trigger ?? 'a click' } : {}),
      }))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  }

  /** Open pages under a context, or under any context of a browser. */
  private pagesUnder(id: number): number {
    let count = 0;
    for (const entry of this.openEntries()) {
      if (entry.birth.kind !== 'page' || entry.birth.parent === null) continue;
      const context = this.entries.get(entry.birth.parent);
      if (entry.birth.parent === id || context?.birth.parent === id) count++;
    }
    return count;
  }

  private isImplicit(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.birth.kind !== 'context') return false;
    if (entry.birth.implicit) return true;
    const owner = entry.object ? (entry.object as { _ownerPage?: unknown })._ownerPage : undefined;
    if (owner) entry.birth.implicit = true;
    return !!owner;
  }

  private openPagesOf(contextId: number): number {
    let count = 0;
    for (const entry of this.openEntries())
      if (entry.birth.kind === 'page' && entry.birth.parent === contextId) count++;
    return count;
  }

  private async closeLeaks(leaks: LeakedResource[]): Promise<void> {
    for (const leak of leaks) {
      const entry = this.entries.get(leak.id);
      const object = entry?.object;
      if (!entry || entry.closed || !object) continue;
      const close =
        leak.kind === 'request'
          ? () => (object as APIRequestContext).dispose()
          : () => (object as { close: () => Promise<void> }).close();
      await settleWithin(internalCall(object, close), CLOSE_TIMEOUT_MS);
      // Closed by Piwi, whether or not its close event has arrived during the await.
      const closedMeanwhile = entry.closed as ResourceClose | null;
      if (closedMeanwhile) closedMeanwhile.byPiwi = true;
      else this.onClosed(object, true);
    }
  }

  private census(
    test: ResourceTestRef | null,
    handles?: ResourceCensus['handles'],
    mains: Map<number, PageMain> = new Map(),
  ): ResourceCensus {
    const open: ResourceOpen[] = [];
    for (const entry of this.openEntries()) {
      const object = entry.object as Record<string, unknown>;
      if (entry.birth.kind === 'page') {
        const main = mains.get(entry.birth.id);
        open.push({
          id: entry.birth.id,
          used: entry.used,
          url: this.pageUrl(object),
          listeners: this.listenerCount(object),
          routes: this.routeCount(object),
          ...(main ? { main } : {}),
        });
      } else if (entry.birth.kind === 'context') {
        this.isImplicit(entry.birth.id);
        open.push({ id: entry.birth.id, pages: this.openPagesOf(entry.birth.id), routes: this.routeCount(object) });
      } else {
        open.push({ id: entry.birth.id });
      }
    }
    const census: ResourceCensus = {
      v: 1,
      worker: this.workerIndex,
      pid: process.pid,
      at: this.now(),
      test,
      born: this.born,
      closed: this.closed,
      open,
    };
    if (handles) census.handles = handles;
    // A closed object is in this census for good: the worker needs only what is open.
    for (const close of this.closed) this.entries.delete(close.id);
    this.born = [];
    this.closed = [];
    return census;
  }

  private pageUrl(page: Record<string, unknown>): string | undefined {
    try {
      const url = typeof page.url === 'function' ? String((page.url as () => string)()) : '';
      return url ? url.split(/[?#]/)[0] : undefined;
    } catch {
      return undefined;
    }
  }

  private listenerCount(emitter: Record<string, unknown>): number | undefined {
    try {
      if (typeof emitter.eventNames !== 'function' || typeof emitter.listenerCount !== 'function') return undefined;
      const names = (emitter.eventNames as () => Array<string | symbol>)();
      return names.reduce((sum, name) => sum + (emitter.listenerCount as (n: string | symbol) => number)(name), 0);
    } catch {
      return undefined;
    }
  }

  private routeCount(object: Record<string, unknown>): number | undefined {
    const routes = object._routes;
    return Array.isArray(routes) ? routes.length : undefined;
  }
}

/** The ledger of this worker process, between its worker fixture's setup and teardown. */
let activeLedger: ResourceLedger | null = null;

/**
 * Start this worker's ledger on the Playwright the worker fixtures hold, unless
 * `PIWI_CAPTURE_RESOURCES=false` or that Playwright has no instrumentation to
 * listen to. Starting it again returns the running one.
 */
export function startResourceLedger(playwright: unknown, workerIndex: number): ResourceLedger | null {
  if (process.env[PIWI_ENV_KEYS.captureResources] === 'false') return null;
  if (activeLedger) return activeLedger;
  const metrics = new WorkerMetrics();
  const ledger = new ResourceLedger(
    playwright as PlaywrightLike,
    workerIndex,
    readLeakCheck(),
    process.env[PIWI_RESOURCES_RESULTS_ENV] || null,
    playwrightTestInfoSource(),
    Date.now,
    { metrics, pages: new PageReader() },
    true,
  );
  if (!ledger.install()) {
    metrics.dispose();
    return null;
  }
  activeLedger = ledger;
  return ledger;
}

/** This worker's running ledger, if any. */
export function activeResourceLedger(): ResourceLedger | null {
  return activeLedger;
}

/** Take the shutdown census of this worker's ledger and stop it. */
export function stopResourceLedger(): ResourceCensus | null {
  const ledger = activeLedger;
  activeLedger = null;
  return ledger ? ledger.workerEnded() : null;
}

/** Mark a page used, for the locator wrappers. */
export function noteResourceUse(page: object): void {
  activeLedger?.notePageUse(page);
}

const ARTICLE: Record<ResourceKind, string> = {
  browser: 'a browser',
  context: 'a context',
  page: 'a page',
  request: 'an API request context',
};

/** The error `PIWI_LEAK_CHECK=fail` fails a test with. */
export function leakFailureMessage(leaks: LeakedResource[]): string {
  const lines = leaks.map((leak) => {
    const what = leak.trigger ? `a popup opened by ${leak.trigger}` : ARTICLE[leak.kind];
    const where = leak.site ? `${leak.trigger ? '' : ' opened'} at ${leak.site}` : '';
    const pages = leak.pages > 0 ? `, with ${leak.pages} page${leak.pages === 1 ? '' : 's'}` : '';
    return `  - ${what}${where}${pages}`;
  });
  return [
    `Piwi: this test left ${leaks.length === 1 ? 'one object' : `${leaks.length} objects`} open:`,
    ...lines,
    'Close each before the test ends (await using, close() or dispose()), or set PIWI_LEAK_CHECK=report to only list them.',
  ].join('\n');
}

/**
 * Take the census at the end of a test, attach it as `piwi-resources`, and fail
 * the test under `PIWI_LEAK_CHECK=fail` when it left open what it opened. A
 * no-op when no ledger runs in this worker.
 */
export async function recordResourceCensus(testInfo: TestInfo): Promise<void> {
  const ledger = activeLedger;
  if (!ledger) return;
  const { census, leaks } = await ledger.testEnded(testInfo as unknown as TestInfoLike);
  try {
    await testInfo.attach(ATTACHMENT_NAMES.resources, {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(census)),
    });
  } catch {
    // An attachment that cannot be written leaves the census out of the summary.
  }
  if (ledger.leakCheck === 'fail' && leaks.length > 0) throw new Error(leakFailureMessage(leaks));
}
