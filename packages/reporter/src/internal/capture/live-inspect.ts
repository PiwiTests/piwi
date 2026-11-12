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
 *   call, feature-checked) from as Inspect opens, stopped unsaved as it closes, its files deleted; a test that starts
 *   tracing itself meanwhile gets it, Piwi's stopped first (`guardTracing`). A runner's trace that takes no snapshots,
 *   or a page Piwi cannot trace, sends why in place of a snapshot.
 * - **What goes.** The watched page's snapshots since its last navigation (the main frame's last full one onward, of
 *   every frame), `MAX_SNAPSHOT_BACKLOG` bytes at most, the oldest left out, then each new one, in the trace's order,
 *   each numbered in its frame as Playwright numbers it (a reference names the snapshot `back` places before).
 *   `SNAPSHOTS_PER_SECOND` at most, one post in flight, after the bytes the live view's frames and Inspect's own posts
 *   took (`LiveByteBudget`, a wait of a second at most): a frame never waits on one. Each snapshot has what the page's
 *   secrets show and the credentials its addresses and texts hold removed before it goes, its scripts emptied
 *   (`hideFrameSnapshotSecrets`, with the attempt's secrets `lane-layers.ts` keeps: the values its secret fields held,
 *   read through internal calls, and those its calls typed into one); its title is the runner's, the text it types and
 *   its credentials hidden. A snapshot past `MAX_SNAPSHOT_BYTES`, or one that cannot be read whole, does not go. A
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

/** Why no snapshot goes, as a viewer reads it. */
export const INSPECT_MASKED =
  'This project masks elements: Inspect sends no page of it, since a snapshot cannot hide what its masks name.';
const NO_SNAPSHOTS =
  "Inspect has no page to show: this project's trace takes no DOM snapshots (its trace option's snapshots is off).";
const NO_TRACE = 'Inspect cannot trace this page: the test traces it itself, or its browser keeps no trace folder.';

/** The trace lines read: a call as it begins, a DOM snapshot, a resource the page loaded. */
const BEFORE_LINE = '{"type":"before"';
const SNAPSHOT_LINE = '{"type":"frame-snapshot"';
const RESOURCE_LINE = '{"type":"resource-snapshot"';

/**
 * The bytes a second the live view posts, shared by its frames and Inspect: a frame never waits on it, and each of
 * Inspect's posts waits until the bytes posted before it would have gone at `LIVE_FRAME_BYTE_RATE`, a second at most.
 */
export class LiveByteBudget {
  private freeAt = 0;

  /** `bytes` were posted now. */
  spend(bytes: number): void {
    this.freeAt = Math.max(Date.now(), this.freeAt) + (bytes * 1000) / LIVE_FRAME_BYTE_RATE;
  }

  /** How long an Inspect post waits now, in milliseconds. */
  wait(): number {
    return Math.min(MAX_BUDGET_WAIT_MS, Math.max(0, this.freeAt - Date.now()));
  }
}

/** Piwi's own live trace of a context, while Inspect has it open. */
interface OwnTrace {
  context: BrowserContext;
  tracing: Tracing;
  dir: string;
  name: string;
  /** Stops it unsaved and deletes its files; once. */
  stop: () => Promise<void>;
}

type Tracing = BrowserContext['tracing'] & { _tracesDir?: unknown };

/** Each context's tracing as Playwright made it, for the guard `guardTracing` handed the test in its place. */
const REAL_TRACINGS = new WeakMap<object, Tracing>();
/** Piwi's own live trace of each context that runs one. */
const OWN_TRACES = new WeakMap<BrowserContext, OwnTrace>();
/** How many own traces were started: each one's name is new. */
let ownTraces = 0;

/** The context's tracing as Playwright made it, behind the guard the test is handed. */
function tracingOf(context: BrowserContext): Tracing | null {
  const seen = (context as unknown as { tracing?: Tracing }).tracing;
  if (!seen || typeof seen !== 'object') return null;
  return REAL_TRACINGS.get(seen) ?? seen;
}

/**
 * Hand the test `context.tracing` behind a guard: its `start` first stops Piwi's own trace of the context, unsaved,
 * so the test's own goes through. Every other call goes to the tracing as it is.
 */
export function guardTracing(context: BrowserContext): void {
  const own = (context as unknown as { tracing?: unknown }).tracing;
  if (!own || typeof own !== 'object' || REAL_TRACINGS.has(own)) return;
  const guarded = new Proxy(own, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (prop !== 'start') return (...args: unknown[]) => callMethod(target, prop, args);
      return (...args: unknown[]) => {
        const piwi = OWN_TRACES.get(context);
        return piwi ? piwi.stop().then(() => callMethod(target, prop, args)) : callMethod(target, prop, args);
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

/**
 * Start Piwi's own live trace of `context`, through an internal call: in the browser's trace folder, named for it
 * alone, DOM snapshots alone. `busy` when the context traces already (the runner, or the test itself); null when its
 * tracing has no trace folder, or did not start.
 */
async function startOwnTrace(context: BrowserContext): Promise<OwnTrace | 'busy' | null> {
  const tracing = tracingOf(context);
  const dir = tracing?._tracesDir;
  if (!tracing || typeof tracing.start !== 'function' || typeof dir !== 'string' || !dir) return null;
  const name = `piwi-inspect-${process.pid}-${++ownTraces}`;
  const start = (live: boolean) =>
    internalCall(context, () =>
      tracing.start({ name, snapshots: true, screenshots: false, ...(live ? { live: true } : {}) } as Parameters<
        Tracing['start']
      >[0]),
    );
  try {
    await start(true).catch((error: unknown) => {
      // A Playwright that does not take `live` still writes the trace as it goes.
      if (/live/i.test(String(error)) && !/already/i.test(String(error))) return start(false);
      throw error;
    });
  } catch (error) {
    return /already/i.test(String(error)) ? 'busy' : null;
  }
  let stopping: Promise<void> | null = null;
  const own: OwnTrace = {
    context,
    tracing,
    dir,
    name,
    stop: () =>
      (stopping ??= (async () => {
        if (OWN_TRACES.get(context) === own) OWN_TRACES.delete(context);
        await internalCall(context, () => tracing.stop()).catch(() => undefined);
        for (const ext of ['.trace', '.network', '.stacks']) {
          await fs.rm(path.join(dir, `${name}${ext}`), { force: true }).catch(() => undefined);
        }
      })()),
  };
  OWN_TRACES.set(context, own);
  return own;
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
  /** The runner's step and a title of each call, by the trace's id of it. */
  private readonly calls = new Map<string, { step: string; title: string }>();
  /** The resources the trace recorded, by address. */
  private readonly recorded = new Map<string, Recorded>();
  /** The resources a stylesheet names, by its file. */
  private readonly cssNames = new Map<string, string[]>();
  private posting = false;
  private readonly pace = new RateWindow(SNAPSHOTS_PER_SECOND);
  private secrets: { values: string[]; at: number } | null = null;

  constructor(
    private readonly page: Page,
    private readonly link: InspectLink,
  ) {}

  /** Start: say why none goes, or find the page's trace and read it. Never throws. */
  async open(): Promise<void> {
    const masks = this.link.masks();
    if (masks === null || masks.length) return void this.refuse(INSPECT_MASKED);
    const source = await this.findSource().catch(() => null);
    if (this.closed) return void (typeof source === 'object' ? source?.own?.stop() : undefined);
    if (typeof source === 'string' || !source) return void this.refuse(source ?? NO_TRACE);
    this.source = source;
    this.schedule(0);
  }

  /** Stop reading and posting; Piwi's own trace, if it ran one, stops unsaved. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.timer = null;
    this.pumpTimer = null;
    this.queue = [];
    this.chains.clear();
    this.chainSizes.clear();
    await this.source?.own?.stop();
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
    if (traced && runner) {
      if (test?.snapshots?.() === false) return NO_SNAPSHOTS;
      return { dir: runner.dir, files: () => attemptFiles(runner.dir, runner.base), own: null };
    }
    const own = await startOwnTrace(this.page.context());
    if (own && own !== 'busy') {
      return { dir: own.dir, files: async () => [path.join(own.dir, `${own.name}.trace`)], own };
    }
    if (own === 'busy' && traced === null && runner) {
      return { dir: runner.dir, files: () => attemptFiles(runner.dir, runner.base), own: null };
    }
    return null;
  }

  private schedule(wait: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.turn();
    }, wait);
    this.timer.unref?.();
  }

  /** Read what the trace gained, then post what waits; again `READ_MS` later. */
  private async turn(): Promise<void> {
    if (this.closed || this.reading) return;
    this.reading = true;
    try {
      await this.read();
    } catch {
      // A trace that cannot be read now is read again next turn.
    } finally {
      this.reading = false;
    }
    this.pump();
    this.schedule(READ_MS);
  }

  private tail(file: string, maxLine: number, onLong: ((head: string) => void) | null): TraceTail {
    let tail = this.tails.get(file);
    if (!tail) {
      tail = new TraceTail(file, maxLine, onLong);
      this.tails.set(file, tail);
    }
    return tail;
  }

  /** Read each file of the trace from where it stopped: its resources first, then its calls and snapshots. */
  private async read(): Promise<void> {
    const source = this.source;
    if (!source) return;
    for (const file of await source.files()) {
      const network = this.tail(file.replace(/\.trace$/, '.network'), MAX_NETWORK_LINE, null);
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await network.read()) if (line.startsWith(RESOURCE_LINE)) this.takeResource(line);
        if (!network.behind) break;
      }
      const trace = this.tail(file, MAX_SNAPSHOT_LINE, (head) => this.passedOver(head));
      for (let i = 0; i < MAX_READS_A_TURN && !this.closed; i++) {
        for (const line of await trace.read()) {
          if (line.startsWith(BEFORE_LINE)) this.takeCall(line);
          else if (line.startsWith(SNAPSHOT_LINE)) this.takeSnapshot(line);
        }
        if (!trace.behind) break;
      }
    }
  }

  /** Playwright's id of the watched page, as its trace names it. */
  private pageId(): string | null {
    const id = (this.page as unknown as { _guid?: unknown })._guid;
    return typeof id === 'string' && id ? id : null;
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

  /** A snapshot's line passed over for its length: its frame still counts it, though it does not go. */
  private passedOver(head: string): void {
    const page = this.pageId();
    const frame = /"frameId":"([^"]{1,200})"/.exec(head)?.[1];
    if (!head.startsWith(SNAPSHOT_LINE) || !page || !frame || !head.includes(`"pageId":"${page}"`)) return;
    this.counts.set(frame, (this.counts.get(frame) ?? 0) + 1);
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
    const phase = snapshotPhase(snapshot);
    if (!phase || !isLayerCallId(callId) || !Array.isArray(snapshot.html)) return;
    const full = isFullSnapshot(snapshot.html);
    const main = snapshot.isMainFrame !== false;
    this.keepInChain(frameId, index, full, snapshot, line.length);
    if (main && full) {
      // The page navigated: the snapshots before it go unsent.
      this.queue = [];
      this.queued = 0;
    }
    const call = this.calls.get(callId);
    const at = typeof wallTime === 'number' && wallTime > 1e12 ? wallTime : Date.now();
    this.queue.push({
      fields: { call: call?.step ?? callId, phase, page, frame: frameId, main, full, index, at },
      snapshot,
      bytes: line.length,
    });
    this.queued += line.length;
    while (this.queued > MAX_SNAPSHOT_BACKLOG && this.queue.length > 1) this.queued -= this.queue.shift()!.bytes;
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
    // Past the backlog's bound, the oldest kept go: a label they held is not read.
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

  /** The attempt's secrets: read from its pages at most once a `SECRETS_MS`, else those known. */
  private async readSecrets(): Promise<string[]> {
    if (this.secrets && Date.now() - this.secrets.at < SECRETS_MS) return this.secrets.values;
    const values = (this.page.isClosed() ? null : await attemptSecrets(this.page).catch(() => null)) ?? knownSecrets();
    this.secrets = { values, at: Date.now() };
    return values;
  }

  /** Post the next snapshot that waits, its resources first, as the pace and the budget allow. */
  private pump(): void {
    if (this.closed || this.posting || this.pumpTimer || !this.queue.length) return;
    const wait = this.link.budget.wait();
    if (wait > 0 || !this.pace.take(1)) {
      this.pumpTimer = setTimeout(
        () => {
          this.pumpTimer = null;
          this.pump();
        },
        Math.max(wait, 1000 / SNAPSHOTS_PER_SECOND),
      );
      this.pumpTimer.unref?.();
      return;
    }
    const next = this.queue.shift()!;
    this.queued -= next.bytes;
    this.posting = true;
    void this.send(next)
      .catch(() => undefined)
      .finally(() => {
        this.posting = false;
        this.pump();
      });
  }

  /**
   * Post a snapshot, what the page's secrets show and its credentials removed, after the resources it names that did not
   * go yet; none it cannot read whole.
   */
  private async send(waiting: Waiting): Promise<void> {
    const { fields, snapshot } = waiting;
    const secrets = await this.readSecrets();
    if (this.closed) return;
    const shown = hideFrameSnapshotSecrets(snapshot, { secrets, resolve: this.resolver(fields.frame, fields.index) });
    if (!shown) return;
    const data = Buffer.from(JSON.stringify(shown));
    if (data.length > MAX_SNAPSHOT_BYTES) return;
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
   * `MAX_RESOURCE_BYTES` at most.
   */
  private async sendResource(resource: LiveSnapshotResource & Recorded): Promise<void> {
    const bytes = await this.resourceBytes(resource.sha1);
    if (!bytes || this.closed || !isInspectResourceBytes(resource.contentType, bytes)) return;
    const wait = this.link.budget.wait();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
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
