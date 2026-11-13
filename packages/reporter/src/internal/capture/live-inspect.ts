import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { isLayerCallId } from '@piwitests/core/live-layers';
import {
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_URL,
  MAX_SNAPSHOT_BACKLOG,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_RESOURCES,
  SNAPSHOTS_PER_SECOND,
  cssReferences,
  hideFrameSnapshotSecrets,
  hideResourceUrl,
  inspectResourceType,
  isFullSnapshot,
  isInspectResourceBytes,
  isResourceSha1,
  resolveResourceUrl,
  snapshotNodes,
  snapshotPhase,
  snapshotResourceUrls,
  type LiveSnapshot,
  type LiveSnapshotResource,
  type SnapshotResolver,
} from '@piwitests/core/live-inspect';
import {
  LIVE_FRAME_BYTE_RATE,
  encodeLiveMessage,
  liveResourceHeader,
  liveSnapshotHeader,
  liveSnapshotRefusalHeader,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { hideSecretsInText, hideTypedText } from '@piwitests/core/mask';
import { RateWindow } from '@piwitests/core/run-view';
import { TraceTail, attemptFiles, attemptSecrets, knownSecrets, layersTest, layersTitleOf } from './lane-layers.js';
import { callMethod, internalCall } from './quiet-capture.js';

/**
 * **Inspect** on the instance's live view (`@piwitests/core/live-inspect`): while a viewer of the worker in full has it
 * open, the DOM snapshots Playwright's trace takes of the watched page at each call, and the stylesheets, fonts and
 * images they name, posted as live messages. Nothing here runs while no viewer has it open.
 *
 * - **Where the snapshots come from.** When the runner traces the attempt, its own growing trace: the files
 *   `lane-layers.ts` reads (`attemptFiles`), each `.trace` beside its `.network`, read with its `TraceTail` from their
 *   start as Inspect opens, then as they grow. Nothing is written, nor any option of the runner's trace changed. When
 *   it does not, a live trace of Piwi's own (`context.tracing.start({ snapshots: true, live: true })` through an internal
 *   call, feature-checked) from as Inspect opens, stopped unsaved as it closes, its files deleted, and each file of the
 *   folder's `resources/` it wrote that no other trace there names (`removeOwnTrace`). A test that starts tracing
 *   itself meanwhile gets it (`guardTracing`): its call waits for Piwi's trace to start, stops it, and goes once it
 *   stopped; the viewers hear why no more comes. A runner's trace that takes no DOM snapshots, or a page Piwi cannot
 *   trace, sends why in place of a snapshot.
 * - **What goes.** Once the reads caught up with the trace, the watched page's snapshots since its last navigation (the
 *   main frame's last full one onward, of every frame), `MAX_SNAPSHOT_BACKLOG` bytes at most (past them, the oldest of
 *   those after a frame's full one left out, never a full one), then each new one, in the trace's order, each numbered
 *   in its frame as Playwright numbers it (a reference names the snapshot `back` places before), a line passed over for
 *   its length counted where it was. `SNAPSHOTS_PER_SECOND` at most, one post in flight, each waiting once, a second
 *   at most, for the bytes the live view's frames and Inspect's own posts took (`LiveByteBudget`), its own counted
 *   so the frames after it are spaced. Each has what the page's secrets show and the credentials its addresses and
 *   texts hold removed before it goes (`hideFrameSnapshotSecrets`, with the attempt's secrets `lane-layers.ts` keeps:
 *   the values its secret fields held, read through internal calls, and those its calls typed into one); its title is
 *   the runner's, the text it types and its credentials hidden. A snapshot that does not go (past `MAX_SNAPSHOT_BYTES`,
 *   one that cannot be read whole, one whose page's secret fields could not be read, one past `MAX_SNAPSHOT_BACKLOG`
 *   waiting) stops its frame's chain until its next full snapshot, and the viewers hear why for the main frame. A
 *   project that masks elements gets no snapshot, and the viewers hear why: its masks are locators, which a snapshot
 *   cannot find.
 * - **Resources.** Before a snapshot, each resource it names (`snapshotResourceUrls`, and what a stylesheet among them
 *   names, `cssReferences`, two imports deep) that the trace recorded (`resource-snapshot` of the `.network` file: its
 *   address, its file under `resources/`, its content type) and `inspectResourceType` allows: a stylesheet, a font, an
 *   image other than SVG, its bytes of that kind (`isInspectResourceBytes`), `MAX_RESOURCE_BYTES` at most, once per
 *   run. Never a script, a document nor an SVG. Read from the trace folder's `resources/` alone. The header names each
 *   by its address hidden as the snapshot's are (`hideResourceUrl`).
 */

/** How often the trace is read for new snapshots while Inspect is open. */
const READ_MS = 400;
/** The most reads of a file a turn takes as Inspect opens, to catch up with it: the rest waits for the next turn. */
const MAX_READS_A_TURN = 16;
/** The longest line of a trace read whole: a snapshot's event of `MAX_SNAPSHOT_BYTES` and its wrapping. */
const MAX_SNAPSHOT_LINE = MAX_SNAPSHOT_BYTES + 64 * 1024;
/** The longest line of a trace's network file read: a resource's record, its headers included. */
const MAX_NETWORK_LINE = 1024 * 1024;
/** The most resources the trace recorded that are kept by address: past them, the oldest go. */
const MAX_RECORDED_RESOURCES = 4096;
/** The most calls whose step and title are kept: past them, the oldest go. */
const MAX_CALLS = 4096;
/** How long the attempt's secrets read from its pages serve before they are read again. */
const SECRETS_MS = 1000;
/** The longest a post of Inspect waits for the bytes the frames took. */
const MAX_BUDGET_WAIT_MS = 1000;
/** The most bytes the resources a snapshot names take in its header. */
const MAX_RESOURCE_LIST = 32 * 1024;
/** How deep stylesheets are followed through their imports for the resources they name. */
const CSS_DEPTH = 3;
/** The bytes of a trace file read at once, as one is searched for the resources it names. */
const SEARCH_CHUNK = 1024 * 1024;

/** Why no snapshot goes, as a viewer reads it. */
export const INSPECT_MASKED =
  'This project masks elements: Inspect sends no page of it, since a snapshot cannot hide what its masks name.';
export const INSPECT_UNREAD_MASKS =
  'Inspect sends no page: the project masks elements this reporter cannot read. Update the Piwi reporter.';
export const INSPECT_TRACES_ITSELF =
  'This test traces itself, and a context has one trace: Inspect has no page of it while the test’s own trace runs. Open Inspect again once it stopped.';
const NO_SNAPSHOTS =
  "Inspect has no page to show: this project's trace takes no DOM snapshots (its trace option's snapshots, or their dom, is off).";
const NO_TRACE = 'Inspect cannot trace this page: its browser keeps no trace folder, or its trace did not start.';
/** Why a page's snapshots stop until its next navigation, as a viewer reads it. */
const UNREAD_SECRETS = 'The page is not sent: its secret fields could not be read, so Inspect could not hide them.';
const UNREAD_SNAPSHOT =
  'The page is not sent: Inspect could not read its snapshot whole (too deep, too large, or naming one it no longer holds), so it could not hide its secrets.';
const TOO_LARGE = `The page is not sent: its snapshot is larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB.`;
const BEHIND = 'The page is not sent: Inspect fell behind the test’s calls.';
const OVER_BACKLOG = `The page is not sent: its snapshots since its navigation are larger than ${MAX_SNAPSHOT_BACKLOG / 1024 / 1024} MB.`;
const UNTIL_NAVIGATION = 'Inspect sends it again from its next navigation.';

/** The trace lines read: a call as it begins, a DOM snapshot, a resource the page loaded. */
const BEFORE_LINE = '{"type":"before"';
const SNAPSHOT_LINE = '{"type":"frame-snapshot"';
const RESOURCE_LINE = '{"type":"resource-snapshot"';

/**
 * The bytes a second the live view posts, shared by its frames and Inspect: each of Inspect's posts waits once until the
 * bytes posted before it would have gone at `LIVE_FRAME_BYTE_RATE`, a second at most, then goes, and a frame is spaced
 * after it the same way.
 */
export class LiveByteBudget {
  private freeAt = 0;

  /** `bytes` were posted now. */
  spend(bytes: number): void {
    this.freeAt = Math.max(Date.now(), this.freeAt) + (bytes * 1000) / LIVE_FRAME_BYTE_RATE;
  }

  /** How long a post waits now for the bytes posted before it, in milliseconds: a second at most. */
  wait(): number {
    return Math.min(MAX_BUDGET_WAIT_MS, Math.max(0, this.freeAt - Date.now()));
  }
}

/** Piwi's own live trace of a context, from the call that starts it until its stop settles. */
interface OwnTrace {
  dir: string;
  name: string;
  /** Whether it started, once its start settled. */
  started: Promise<boolean>;
  /** Whether the test's own trace took its place. */
  taken: boolean;
  /** Told once as the test's own trace takes its place. */
  onTaken: (() => void) | null;
  /** Stop it unsaved and delete what it wrote, once its start settled; `byTest` as the test's own trace takes over. */
  stop: (byTest?: boolean) => Promise<void>;
}

type Tracing = BrowserContext['tracing'] & { _tracesDir?: unknown };

/** Each context's tracing as Playwright made it, for the guard `guardTracing` handed the test in its place. */
const REAL_TRACINGS = new WeakMap<object, Tracing>();
/** Piwi's own live trace of each context that runs one, from the call that starts it until its stop settles. */
const OWN_TRACES = new WeakMap<BrowserContext, OwnTrace>();
/** The contexts whose tracing the test started and has not stopped: Piwi starts no trace of its own there. */
const TEST_TRACES = new WeakSet<BrowserContext>();
/** How many own traces were started: each one's name is new. */
let ownTraces = 0;

/** The test's calls on its context's tracing that wait for Piwi's own trace to stop first. */
const TRACING_CALLS: ReadonlySet<string | symbol> = new Set(['start', 'startChunk', 'stop', 'stopChunk']);

/** The context's tracing as Playwright made it, behind the guard the test is handed. */
function tracingOf(context: BrowserContext): Tracing | null {
  const seen = (context as unknown as { tracing?: Tracing }).tracing;
  if (!seen || typeof seen !== 'object') return null;
  return REAL_TRACINGS.get(seen) ?? seen;
}

/**
 * Hand the test `context.tracing` behind a guard: its `start`, `startChunk`, `stop` and `stopChunk` first stop Piwi's
 * own trace of the context, unsaved, whether it starts, runs or stops now, and go once it stopped, so the test's own
 * goes through; from the test's `start` to its `stop`, Piwi starts no trace of the context. Every other call goes to
 * the tracing as it is.
 */
export function guardTracing(context: BrowserContext): void {
  const own = (context as unknown as { tracing?: unknown }).tracing;
  if (!own || typeof own !== 'object' || REAL_TRACINGS.has(own)) return;
  const guarded = new Proxy(own, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (!TRACING_CALLS.has(prop)) return (...args: unknown[]) => callMethod(target, prop, args);
      return (...args: unknown[]) => {
        if (prop === 'start') TEST_TRACES.add(context);
        const piwi = OWN_TRACES.get(context);
        const call = (): unknown => callMethod(target, prop, args);
        const result = piwi ? piwi.stop(true).then(call) : call();
        if (prop !== 'start' && prop !== 'stop') return result;
        return Promise.resolve(result).then(
          (value: unknown) => {
            if (prop === 'stop') TEST_TRACES.delete(context);
            return value;
          },
          (error: unknown) => {
            TEST_TRACES.delete(context);
            throw error;
          },
        );
      };
    },
  });
  REAL_TRACINGS.set(guarded, own as Tracing);
  try {
    (context as unknown as { tracing: object }).tracing = guarded;
  } catch {
    // A context whose tracing cannot be replaced keeps it: the test's own start then fails while Piwi's runs.
  }
}

/** The files of a trace folder's `resources/`; none when it cannot be read. */
async function resourceFiles(dir: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(path.join(dir, 'resources')));
  } catch {
    return new Set();
  }
}

/** Those of `names` that `file` holds, added to `found`; false when it cannot be read. */
async function namesIn(file: string, names: ReadonlySet<string>, found: Set<string>): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return false;
  }
  try {
    const overlap = Math.max(...[...names].map((name) => name.length));
    let tail = Buffer.alloc(0);
    for (let at = 0; ;) {
      const chunk = Buffer.alloc(SEARCH_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, SEARCH_CHUNK, at);
      if (bytesRead === 0) return true;
      at += bytesRead;
      const text = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      for (const name of names) if (!found.has(name) && text.includes(name)) found.add(name);
      if (found.size === names.size) return true;
      tail = text.subarray(Math.max(0, text.length - overlap));
    }
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The resources the server's tracing of the context wrote, by `resources/<name>` (by `<name>` before Playwright 1.64)
 * (Playwright internal, in-process alone, feature-checked): one taken out of it is written again by a later trace of
 * the context that names it.
 */
function writtenResources(context: BrowserContext): Set<string> | null {
  const connection = (context as unknown as { _connection?: { toImpl?: unknown } })._connection;
  if (typeof connection?.toImpl !== 'function') return null;
  try {
    const impl = (connection.toImpl as (object: unknown) => unknown)(context) as { tracing?: unknown } | null;
    const written = (impl?.tracing as { _allResources?: unknown } | undefined)?._allResources;
    return written instanceof Set ? (written as Set<string>) : null;
  } catch {
    return null;
  }
}

/**
 * Delete what Piwi's own trace `name` wrote in `dir`: its `.trace`, `.network` and `.stacks`, and each file of
 * `resources/` that is not one of `before` (there as it started) and that no other `.trace` or `.network` file of the
 * folder names, none when one of them cannot be read. The context's tracing is told to write each again, so a later
 * trace of it that names one holds it; where it cannot be told, they go as the context closes (at once when it closed).
 */
async function removeOwnTrace(context: BrowserContext, dir: string, name: string, before: Set<string>): Promise<void> {
  for (const ext of ['.trace', '.network', '.stacks']) {
    await fs.rm(path.join(dir, `${name}${ext}`), { force: true }).catch(() => undefined);
  }
  const remove = async (): Promise<void> => {
    const added = new Set([...(await resourceFiles(dir))].filter((file) => !before.has(file) && isResourceSha1(file)));
    if (!added.size) return;
    const named = new Set<string>();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/\.(?:trace|network)$/.test(entry) || entry.startsWith(`${name}.`)) continue;
      if (!(await namesIn(path.join(dir, entry), added, named))) return;
    }
    const written = writtenResources(context);
    for (const file of added) {
      if (named.has(file)) continue;
      await fs.rm(path.join(dir, 'resources', file), { force: true }).catch(() => undefined);
      written?.delete(`resources/${file}`);
      written?.delete(file);
    }
  };
  const closed = (context as unknown as { _closingStatus?: unknown })._closingStatus === 'closed';
  if (closed || writtenResources(context)) await remove();
  else context.once('close', () => void remove().catch(() => undefined));
}

/**
 * Start Piwi's own live trace of `context`, through an internal call: in the browser's trace folder, named for it
 * alone, DOM snapshots alone, once a trace of Piwi's that stops there stopped. `busy` when the context traces already
 * (the runner), `test` while the test's own trace runs; null when its tracing has no trace folder, or did not start.
 */
async function startOwnTrace(context: BrowserContext): Promise<OwnTrace | 'busy' | 'test' | null> {
  await OWN_TRACES.get(context)?.stop();
  if (TEST_TRACES.has(context)) return 'test';
  if (OWN_TRACES.has(context)) return 'busy';
  const tracing = tracingOf(context);
  const dir = tracing?._tracesDir;
  if (!tracing || typeof tracing.start !== 'function' || typeof dir !== 'string' || !dir) return null;
  const name = `piwi-inspect-${process.pid}-${++ownTraces}`;
  let settle: (started: boolean) => void = () => undefined;
  const started = new Promise<boolean>((resolve) => (settle = resolve));
  let before = new Set<string>();
  let stopping: Promise<void> | null = null;
  const own: OwnTrace = {
    dir,
    name,
    started,
    taken: false,
    onTaken: null,
    stop: (byTest = false) => {
      if (byTest && !stopping) {
        own.taken = true;
        own.onTaken?.();
      }
      return (stopping ??= (async () => {
        if (await started) {
          await internalCall(context, () => tracing.stop()).catch(() => undefined);
          await removeOwnTrace(context, dir, name, before).catch(() => undefined);
        }
        if (OWN_TRACES.get(context) === own) OWN_TRACES.delete(context);
      })());
    },
  };
  // From here, a test's own call on the tracing waits for this trace to settle and stop.
  OWN_TRACES.set(context, own);
  const start = (live: boolean) =>
    internalCall(context, () =>
      tracing.start({ name, snapshots: true, screenshots: false, ...(live ? { live: true } : {}) } as Parameters<
        Tracing['start']
      >[0]),
    );
  try {
    before = await resourceFiles(dir);
    if (stopping) throw new Error('stopped');
    await start(true).catch((error: unknown) => {
      // A Playwright that does not take `live` still writes the trace as it goes.
      if (/live/i.test(String(error)) && !/already/i.test(String(error))) return start(false);
      throw error;
    });
    settle(true);
    return own;
  } catch (error) {
    settle(false);
    await own.stop();
    if (own.taken || TEST_TRACES.has(context)) return 'test';
    return /already/i.test(String(error)) ? 'busy' : null;
  }
}

/** A resource the trace recorded: its file under `resources/` and its content type, if Inspect may send it. */
interface Recorded {
  sha1: string;
  contentType: string;
}

/** A snapshot read, as it waits to go. */
interface Waiting {
  fields: Omit<LiveSnapshot, 'resources' | 'title'>;
  snapshot: Record<string, unknown>;
  bytes: number;
  /** Whether it waited for the bytes posted before it: it waits once. */
  waited: boolean;
}

/** What the trace's files are read from: the folder, and the files of the attempt now. */
interface Source {
  dir: string;
  files: () => Promise<string[]>;
  own: OwnTrace | null;
}

/** What an Inspect of a page posts through: the live view's link. */
export interface InspectLink {
  id: LiveWorkerId;
  /** The running test's title, which each message names. */
  test: () => string | null;
  /** The project's masked elements, as the instance last said; null for those this reporter cannot read. */
  masks: () => readonly string[] | null;
  /** Post a live message's bytes; resolves with the answer's status, null for none. Never throws. */
  post: (body: Uint8Array) => Promise<number | null>;
  budget: LiveByteBudget;
  /** The resources posted to the run so far, by name: each goes once. */
  sent: Set<string>;
}

/** A wait of `ms` milliseconds that keeps no process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * Inspect of `page` while a viewer has it open: reads its trace from as it opens and posts its snapshots and their
 * resources through `link` until `close`.
 */
export class LiveInspect {
  private closed = false;
  private source: Source | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The next post's turn, once the pace and the budget allow it. */
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  /** Whether the reads caught up with the trace once: no snapshot goes before, so the latest page's go first. */
  private caughtUp = false;
  private readonly tails = new Map<string, TraceTail>();
  /** How many snapshots of each frame of the page the trace holds so far: the next one's place. */
  private readonly counts = new Map<string, number>();
  /** Each frame's snapshots since its last full one, by place, for the labels a later one's references name. */
  private readonly chains = new Map<string, Map<number, Record<string, unknown>>>();
  private chainBytes = 0;
  private readonly chainSizes = new Map<Record<string, unknown>, number>();
  /** The snapshots that wait to go, oldest first, and their bytes. */
  private queue: Waiting[] = [];
  private queued = 0;
  /** The frames whose chain stopped: none of their snapshots goes until their next full one. */
  private readonly stopped = new Set<string>();
  /** The runner's step and a title of each call, by the trace's id of it. */
  private readonly calls = new Map<string, { step: string; title: string }>();
  /** The resources the trace recorded, by address. */
  private readonly recorded = new Map<string, Recorded>();
  /** The resources a stylesheet names, by its file. */
  private readonly cssNames = new Map<string, string[]>();
  private posting = false;
  private readonly pace = new RateWindow(SNAPSHOTS_PER_SECOND);
  private secrets: { values: string[] | null; at: number } | null = null;

  constructor(
    private readonly page: Page,
    private readonly link: InspectLink,
  ) {}

  /** Start: say why none goes, or find the page's trace and read it. Never throws. */
  async open(): Promise<void> {
    const masks = this.link.masks();
    if (masks === null) return void this.refuse(INSPECT_UNREAD_MASKS);
    if (masks.length) return void this.refuse(INSPECT_MASKED);
    const source = await this.findSource().catch(() => null);
    const own = typeof source === 'object' ? (source?.own ?? null) : null;
    if (this.closed) return void own?.stop();
    if (typeof source === 'string' || !source) return void this.refuse(source ?? NO_TRACE);
    if (own?.taken) return void this.refuse(INSPECT_TRACES_ITSELF);
    if (own) own.onTaken = () => this.taken();
    this.source = source;
    this.schedule(0);
  }

  /** Stop reading and posting; Piwi's own trace, if it ran one, stops unsaved. */
  async close(): Promise<void> {
    this.halt();
    await this.source?.own?.stop();
  }

  /** Nothing more is read nor posted. */
  private halt(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.timer = null;
    this.pumpTimer = null;
    this.queue = [];
    this.queued = 0;
    this.chains.clear();
    this.chainSizes.clear();
  }

  /** The test's own trace took the context's tracing from Piwi's: the viewers hear why nothing more comes. */
  private taken(): void {
    this.refuse(INSPECT_TRACES_ITSELF);
    this.halt();
  }

  private refuse(why: string): void {
    if (this.closed) return;
    void this.link.post(encodeLiveMessage(liveSnapshotRefusalHeader(this.link.id, why, this.link.test())));
  }

  /** The runner's trace of the attempt, else Piwi's own of the page's context; why there is none, as a sentence. */
  private async findSource(): Promise<Source | string | null> {
    const test = layersTest();
    const traced = test?.traced?.() ?? null;
    const runner = test?.trace ?? null;
    const runnerSource = (dir: string, base: string): Source => ({
      dir,
      files: () => attemptFiles(dir, base),
      own: null,
    });
    if (traced && runner) {
      if (test?.snapshots?.() === false) return NO_SNAPSHOTS;
      return runnerSource(runner.dir, runner.base);
    }
    const own = await startOwnTrace(this.page.context());
    if (own && typeof own === 'object') {
      return { dir: own.dir, files: async () => [path.join(own.dir, `${own.name}.trace`)], own };
    }
    if (own !== null && traced === null && runner) return runnerSource(runner.dir, runner.base);
    return own === 'test' ? INSPECT_TRACES_ITSELF : null;
  }

  private schedule(wait: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.turn();
    }, wait);
    this.timer.unref?.();
  }

  /** Read what the trace gained, then post what waits once the reads caught up with it; again `READ_MS` later. */
  private async turn(): Promise<void> {
    if (this.closed || this.reading) return;
    this.reading = true;
    try {
      if (!(await this.read())) this.caughtUp = true;
    } catch {
      // A trace that cannot be read now is read again next turn.
    } finally {
      this.reading = false;
    }
    this.pump();
    this.schedule(READ_MS);
  }

  private tail(file: string, maxLine: number): TraceTail {
    let tail = this.tails.get(file);
    if (!tail) {
      tail = new TraceTail(file, maxLine);
      this.tails.set(file, tail);
    }
    return tail;
  }

  /**
   * Read each file of the trace from where it stopped: its resources first, then its calls and snapshots, in their
   * order. Whether a file holds more than the reads took.
   */
  private async read(): Promise<boolean> {
    const source = this.source;
    if (!source) return false;
    let behind = false;
    for (const file of await source.files()) {
      const network = this.tail(file.replace(/\.trace$/, '.network'), MAX_NETWORK_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await network.read()) {
          if (typeof line === 'string' && line.startsWith(RESOURCE_LINE)) this.takeResource(line);
        }
        if (!network.behind) break;
      }
      const trace = this.tail(file, MAX_SNAPSHOT_LINE);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await trace.read()) {
          if (typeof line !== 'string') this.passedOver(line.head);
          else if (line.startsWith(BEFORE_LINE)) this.takeCall(line);
          else if (line.startsWith(SNAPSHOT_LINE)) this.takeSnapshot(line);
        }
        if (!trace.behind) break;
      }
      behind ||= network.behind || trace.behind;
    }
    return behind;
  }

  /** Playwright's id of the watched page, as its trace names it. */
  private pageId(): string | null {
    const id = (this.page as unknown as { _guid?: unknown })._guid;
    return typeof id === 'string' && id ? id : null;
  }

  /** Whether `frame` is the watched page's main frame, by Playwright's id of it; true when the page does not say. */
  private isMainFrame(frame: string): boolean {
    try {
      const id = (this.page.mainFrame() as unknown as { _guid?: unknown })._guid;
      return typeof id !== 'string' || id === frame;
    } catch {
      return true;
    }
  }

  /** A resource the page loaded: kept by its address when Inspect may send it. */
  private takeResource(line: string): void {
    let event: { snapshot?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    const record = event.snapshot;
    if (!record || record.pageref !== this.pageId()) return;
    const url = (record.request as { url?: unknown } | undefined)?.url;
    const content = (record.response as { content?: Record<string, unknown> } | undefined)?.content;
    const file = typeof content?._file === 'string' ? content._file : content?._sha1;
    const sha1 = typeof file === 'string' ? file.replace(/^resources\//, '') : null;
    const contentType = inspectResourceType(content?.mimeType);
    if (typeof url !== 'string' || url.length > MAX_RESOURCE_URL || !isResourceSha1(sha1) || !contentType) return;
    const at = resolveResourceUrl(url, null);
    if (!at) return;
    this.recorded.delete(at);
    this.recorded.set(at, { sha1, contentType });
    if (this.recorded.size > MAX_RECORDED_RESOURCES) this.recorded.delete(this.recorded.keys().next().value!);
  }

  /** A call as it begins: its runner's step, and a title of its own for a call the runner names none of. */
  private takeCall(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const { callId, stepId, title, apiName, method } = event;
    if (!isLayerCallId(callId)) return;
    const step = isLayerCallId(stepId) ? stepId : callId;
    const own = [title, apiName, method].find((one): one is string => typeof one === 'string' && !!one.trim());
    this.calls.set(callId, { step, title: own ?? 'Call' });
    if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!);
  }

  /** A snapshot's line passed over for its length: its frame counts it where it was, and its chain stops there. */
  private passedOver(head: string): void {
    const page = this.pageId();
    const frame = /"frameId":"([^"]{1,200})"/.exec(head)?.[1];
    if (!head.startsWith(SNAPSHOT_LINE) || !page || !frame || !head.includes(`"pageId":"${page}"`)) return;
    this.counts.set(frame, (this.counts.get(frame) ?? 0) + 1);
    this.stopChain(frame, this.isMainFrame(frame), TOO_LARGE, 'kept');
  }

  /** A snapshot of the watched page: numbered in its frame, kept for its chain, and queued to go. */
  private takeSnapshot(line: string): void {
    const page = this.pageId();
    if (!page || !line.slice(0, 2048).includes(`"pageId":"${page}"`)) return;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = (JSON.parse(line) as { snapshot: Record<string, unknown> }).snapshot;
    } catch {
      return;
    }
    const { frameId, callId, pageId, wallTime } = snapshot ?? {};
    if (pageId !== page || typeof frameId !== 'string' || !isLayerCallId(frameId)) return;
    const index = this.counts.get(frameId) ?? 0;
    this.counts.set(frameId, index + 1);
    if (!Array.isArray(snapshot.html)) return;
    const full = isFullSnapshot(snapshot.html);
    const main = snapshot.isMainFrame !== false;
    this.keepInChain(frameId, index, full, snapshot, line.length);
    if (full) this.stopped.delete(frameId);
    const phase = snapshotPhase(snapshot);
    if (!phase || !isLayerCallId(callId) || this.stopped.has(frameId)) return;
    if (main && full) {
      // The page navigated: the snapshots before it go unsent.
      this.queue = [];
      this.queued = 0;
    }
    if (this.caughtUp && this.queued + line.length > MAX_SNAPSHOT_BACKLOG) {
      this.stopChain(frameId, main, BEHIND, 'kept');
      return;
    }
    const call = this.calls.get(callId);
    const at = typeof wallTime === 'number' && wallTime > 1e12 ? wallTime : Date.now();
    this.queue.push({
      fields: { call: call?.step ?? callId, phase, page, frame: frameId, main, full, index, at },
      snapshot,
      bytes: line.length,
      waited: false,
    });
    this.queued += line.length;
    if (!this.caughtUp) this.trimBacklog();
  }

  /**
   * The snapshots waiting as Inspect opens, within `MAX_SNAPSHOT_BACKLOG`: past it, the oldest after a frame's full one
   * go, never a full one; with full ones alone left, the oldest one's frame sends none of its chain.
   */
  private trimBacklog(): void {
    while (this.queued > MAX_SNAPSHOT_BACKLOG && this.queue.length) {
      const at = this.queue.findIndex((one) => !one.fields.full);
      if (at >= 0) {
        this.queued -= this.queue.splice(at, 1)[0]!.bytes;
        continue;
      }
      const { frame, main } = this.queue[0]!.fields;
      this.stopChain(frame, main, OVER_BACKLOG, 'none');
    }
  }

  /**
   * A snapshot of `frame` does not go, for `why`: its chain stops until its next full snapshot, and the viewers hear why
   * for the page's main frame. The frame's snapshots waiting stay (`kept`: they come before it), go up to a full one,
   * which starts its chain again (`until-full`: they come after it), or all go (`none`).
   */
  private stopChain(frame: string, main: boolean, why: string, waiting: 'kept' | 'until-full' | 'none'): void {
    let restarts = false;
    if (waiting !== 'kept') {
      const kept: Waiting[] = [];
      for (const one of this.queue) {
        if (one.fields.frame === frame && one.fields.full && waiting === 'until-full') restarts = true;
        if (one.fields.frame === frame && !restarts) this.queued -= one.bytes;
        else kept.push(one);
      }
      this.queue = kept;
    }
    if (restarts) return;
    const told = this.stopped.has(frame);
    this.stopped.add(frame);
    if (main && !told) this.refuse(`${why} ${UNTIL_NAVIGATION}`);
  }

  /** Keep a frame's snapshot for the references of later ones, its chain started again by a full one. */
  private keepInChain(
    frame: string,
    index: number,
    full: boolean,
    snapshot: Record<string, unknown>,
    bytes: number,
  ): void {
    let chain = this.chains.get(frame);
    if (full || !chain) {
      for (const old of chain?.values() ?? []) this.forget(old);
      chain = new Map();
      this.chains.set(frame, chain);
    }
    chain.set(index, snapshot);
    this.chainSizes.set(snapshot, bytes);
    this.chainBytes += bytes;
    // Past the backlog's bound, the oldest kept go: a snapshot that names one of them does not go.
    for (const kept of this.chains.values()) {
      for (const [at, old] of kept) {
        if (this.chainBytes <= 2 * MAX_SNAPSHOT_BACKLOG) return;
        if (old === snapshot) continue;
        kept.delete(at);
        this.forget(old);
      }
    }
  }

  private forget(snapshot: Record<string, unknown>): void {
    this.chainBytes -= this.chainSizes.get(snapshot) ?? 0;
    this.chainSizes.delete(snapshot);
  }

  /** The nodes the references of the frame's snapshot at `index` name, from its chain kept. */
  private resolver(frame: string, index: number): SnapshotResolver {
    const chain = this.chains.get(frame);
    const nodes = new Map<number, unknown[] | null>();
    const at =
      (from: number): SnapshotResolver =>
      (back, node) => {
        const target = from - back;
        const snapshot = back > 0 ? chain?.get(target) : undefined;
        if (!snapshot) return null;
        let list = nodes.get(target);
        if (list === undefined) {
          list = snapshotNodes(snapshot.html);
          nodes.set(target, list);
        }
        return list && node >= 0 && node < list.length ? { node: list[node], resolve: at(target) } : null;
      };
    return at(index);
  }

  /**
   * The attempt's secrets: read from its pages at most once a `SECRETS_MS`, those known once the page closed; null when
   * a page's secret fields could not be read.
   */
  private async readSecrets(): Promise<string[] | null> {
    if (this.secrets && Date.now() - this.secrets.at < SECRETS_MS) return this.secrets.values;
    const values = this.page.isClosed() ? knownSecrets() : await attemptSecrets(this.page).catch(() => null);
    this.secrets = { values, at: Date.now() };
    return values;
  }

  /** Post the next snapshot that waits, its resources first, as the pace allows, once it waited for the budget. */
  private pump(): void {
    if (this.closed || !this.caughtUp || this.posting || this.pumpTimer || !this.queue.length) return;
    const next = this.queue[0]!;
    const wait = next.waited ? 0 : this.link.budget.wait();
    if (wait > 0) {
      next.waited = true;
      return this.pumpLater(wait);
    }
    if (!this.pace.take(1)) return this.pumpLater(1000 / SNAPSHOTS_PER_SECOND);
    this.queue.shift();
    this.queued -= next.bytes;
    this.posting = true;
    void this.send(next)
      .catch(() => undefined)
      .finally(() => {
        this.posting = false;
        this.pump();
      });
  }

  private pumpLater(ms: number): void {
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, ms);
    this.pumpTimer.unref?.();
  }

  /**
   * Post a snapshot, what the page's secrets show and its credentials removed, after the resources it names that did not
   * go yet; its frame's chain stops when it does not go.
   */
  private async send(waiting: Waiting): Promise<void> {
    const { fields, snapshot } = waiting;
    const secrets = await this.readSecrets();
    if (this.closed) return;
    if (!secrets) return this.stopChain(fields.frame, fields.main, UNREAD_SECRETS, 'until-full');
    const resolve = this.resolver(fields.frame, fields.index);
    const shown = hideFrameSnapshotSecrets(snapshot, { secrets, resolve });
    if (!shown) return this.stopChain(fields.frame, fields.main, UNREAD_SNAPSHOT, 'until-full');
    const data = Buffer.from(JSON.stringify(shown));
    if (data.length > MAX_SNAPSHOT_BYTES) return this.stopChain(fields.frame, fields.main, TOO_LARGE, 'until-full');
    const resources = await this.resourcesOf(snapshot);
    for (const resource of resources) {
      if (this.closed) return;
      if (!this.link.sent.has(resource.sha1)) await this.sendResource(resource);
    }
    if (this.closed) return;
    const named: LiveSnapshotResource[] = [];
    for (const { url, sha1 } of resources) {
      const shownUrl = this.link.sent.has(sha1) ? hideResourceUrl(url, secrets) : null;
      if (shownUrl) named.push({ url: shownUrl, sha1 });
    }
    const live: LiveSnapshot = { ...fields, title: this.titleOf(fields.call, snapshot.callId), resources: named };
    const body = encodeLiveMessage(liveSnapshotHeader(this.link.id, live, this.link.test()), data);
    this.link.budget.spend(body.length);
    await this.link.post(body);
  }

  /** The call's title: the runner's, else the trace's own; the text it types and its credentials hidden. */
  private titleOf(step: string, callId: unknown): string {
    const runner = layersTitleOf(step);
    if (runner) return runner;
    const own = typeof callId === 'string' ? this.calls.get(callId)?.title : undefined;
    return hideSecretsInText(hideTypedText(own ?? 'Call')).slice(0, 300);
  }

  /**
   * Post a resource from the trace folder's `resources/`, its bytes of the kind its content type says, once per run,
   * after one wait for the budget.
   */
  private async sendResource(resource: LiveSnapshotResource & Recorded): Promise<void> {
    const bytes = await this.resourceBytes(resource.sha1);
    if (!bytes || this.closed || !isInspectResourceBytes(resource.contentType, bytes)) return;
    const wait = this.link.budget.wait();
    if (wait > 0) await sleep(wait);
    if (this.closed) return;
    const body = encodeLiveMessage(
      liveResourceHeader(this.link.id, { sha1: resource.sha1, contentType: resource.contentType }),
      bytes,
    );
    this.link.budget.spend(body.length);
    const status = await this.link.post(body);
    if (status !== null && status >= 200 && status < 300) this.link.sent.add(resource.sha1);
  }

  /** A resource's bytes, from the trace folder's `resources/` alone; null past `MAX_RESOURCE_BYTES` or unread. */
  private async resourceBytes(sha1: string): Promise<Buffer | null> {
    const dir = this.source?.dir;
    if (!dir || !isResourceSha1(sha1)) return null;
    const file = path.join(dir, 'resources', sha1);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_RESOURCE_BYTES) return null;
      return await fs.readFile(file);
    } catch {
      return null;
    }
  }

  /**
   * The resources a snapshot names that the trace recorded and Inspect may send, by their addresses as the page asked
   * for them, with those its stylesheets name, `MAX_SNAPSHOT_RESOURCES` at most and `MAX_RESOURCE_LIST` bytes of header.
   */
  private async resourcesOf(snapshot: Record<string, unknown>): Promise<Array<LiveSnapshotResource & Recorded>> {
    const found = new Map<string, LiveSnapshotResource & Recorded>();
    let bytes = 0;
    const add = async (urls: readonly string[], depth: number): Promise<void> => {
      for (const url of urls) {
        if (found.has(url) || found.size >= MAX_SNAPSHOT_RESOURCES) continue;
        const recorded = this.recorded.get(url);
        if (!recorded) continue;
        bytes += url.length + recorded.sha1.length + 20;
        if (bytes > MAX_RESOURCE_LIST) return;
        found.set(url, { url, ...recorded });
        if (recorded.contentType === 'text/css' && depth < CSS_DEPTH) {
          const named = (await this.cssNamesOf(recorded.sha1))
            .map((ref) => resolveResourceUrl(ref, url))
            .filter((one): one is string => one !== null);
          await add(named, depth + 1);
        }
      }
    };
    await add(snapshotResourceUrls(snapshot), 0);
    return [...found.values()];
  }

  /** What a stylesheet of the trace names, read once. */
  private async cssNamesOf(sha1: string): Promise<string[]> {
    let names = this.cssNames.get(sha1);
    if (!names) {
      const bytes = await this.resourceBytes(sha1);
      names = bytes && isInspectResourceBytes('text/css', bytes) ? cssReferences(bytes.toString('utf8')) : [];
      this.cssNames.set(sha1, names);
    }
    return names;
  }
}
