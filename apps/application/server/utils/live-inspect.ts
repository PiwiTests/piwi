import {
  MAX_SNAPSHOT_BACKLOG,
  MAX_SNAPSHOT_BYTES,
  hideFrameSnapshotSecrets,
  resolveResourceUrl,
  type LiveResource,
  type LiveSnapshot,
  type SnapshotPhase,
} from '@piwitests/core/live-inspect';
import { stripNetworkReferences } from '#shared/snapshot-picker-document';
import { DOM_SNAPSHOT_CAP_CHARS, renderSanitizedSnapshot } from './dom-snapshot-render';
import { inlineSnapshotAssets, type SnapshotAssets } from './dom-snapshot';
import type { TraceFrameSnapshot, TraceResource } from './trace-events';

/**
 * What the run page's live view keeps for **Inspect** (`@piwitests/core/live-inspect`), in memory alone, for one run:
 * each worker's snapshots of its running test's pages' main frames as they came, and the resources they name. Each
 * snapshot counts its JSON and its header (`heldBytes`). A worker's are bounded by `MAX_WORKER_SNAPSHOTS` bytes and
 * `MAX_WORKER_SNAPSHOT_COUNT` snapshots, the run's by `MAX_RUN_SNAPSHOTS` and `MAX_RUN_SNAPSHOT_COUNT`, the oldest going
 * first; the resources by `MAX_RUN_RESOURCES` bytes and `MAX_RUN_RESOURCE_COUNT`, the least recently used first; and
 * every run's store together by the instance's `InspectBudget`, past which a new one is refused (`full`). Nothing is
 * written anywhere: the run's live view drops it with the run, a worker's snapshots go as its test ends, and every
 * snapshot and resource as the project starts masking elements. A snapshot of a frame other than a page's main one is
 * not kept: the snapshot view renders a page's main frame alone. Every lookup and change takes a constant time, but
 * what goes, each once.
 *
 * A frame's snapshots read as chains (`Chain`), each from a full one (`full`), each that is not full referring to the
 * snapshots before it by how many back, which their place in the frame (`index`) names. The worker sends a frame's
 * snapshots in the trace's order, and those of its watched page again as Inspect opens, so a snapshot of a frame the
 * store holds already (the same call and moment) is not kept twice, and a full one it does not hold starts a chain:
 * the frame's chains before it whose full one the store does not hold (let go, or never sent) go, an earlier
 * navigation's whole chain stays. A snapshot whose chain lacks a snapshot it refers to does not render, saying why: the
 * instance let it go (`SNAPSHOT_GONE`), or the worker never sent it (`SNAPSHOT_UNSENT`). Each page rendered goes
 * through `hideFrameSnapshotSecrets` again, after the worker's own pass, one it cannot read whole refused
 * (`SNAPSHOT_UNREADABLE`), and is kept rendered (`MAX_CACHED_PAGES`) until
 * its chain lets a snapshot go or a resource goes: what comes later never changes it.
 */

const MB = 1024 * 1024;
/** The most bytes of snapshots kept of one worker, headers included: the oldest go first. */
export const MAX_WORKER_SNAPSHOTS = 32 * MB;
/** The most snapshots kept of one worker: the oldest go first. */
export const MAX_WORKER_SNAPSHOT_COUNT = 8192;
/** The most bytes of snapshots kept of one run, its workers together: the run's oldest go first. */
export const MAX_RUN_SNAPSHOTS = 128 * MB;
/** The most snapshots kept of one run, its workers together: the run's oldest go first. */
export const MAX_RUN_SNAPSHOT_COUNT = 32_768;
/** The most bytes of resources kept of one run: the least recently used go first. */
export const MAX_RUN_RESOURCES = 64 * MB;
/** The most resources kept of one run: the least recently used go first. */
export const MAX_RUN_RESOURCE_COUNT = 4096;
/** The most bytes every run's Inspect keeps together, rendered pages included: past them, nothing new is kept. */
export const MAX_INSPECT_BYTES = 512 * MB;
/** The most pages of a run kept rendered, and the most characters they hold together: the least recently read go. */
export const MAX_CACHED_PAGES = 8;
const MAX_CACHED_CHARS = 8_000_000;
/** What one snapshot or resource held counts beyond its bytes and its names. */
const HELD_OVERHEAD = 256;
/** The most places of a frame a render reads back from the snapshot it renders: a reference further back is a gap. */
const MAX_CHAIN_SPAN = 65_536;
/** The most moments let go a worker's store remembers, with why, to tell a page no longer kept from one never sent. */
const MAX_LET_GO = 4096;

/** What a snapshot view says of a page whose snapshot, or one it refers to, the instance let go at its bounds. */
export const SNAPSHOT_GONE = `The page at this call is no longer kept: the instance keeps a worker’s latest ${MAX_WORKER_SNAPSHOTS / MB} MB of pages while the run runs.`;
/** What it says of a page whose chain lacks a snapshot the worker never sent. */
export const SNAPSHOT_UNSENT = `The worker did not send the page this one builds on: it leaves out a page over ${MAX_SNAPSHOT_BYTES / MB} MB, and, as Inspect opens, the oldest past ${MAX_SNAPSHOT_BACKLOG / MB} MB.`;
/** What it says of a page of a test that ended. */
export const SNAPSHOT_TEST_ENDED =
  'The page at this call is of a test that ended: the instance keeps the running test’s.';
/** What it says while the project masks elements, as the worker says it in place of a page. */
export const SNAPSHOT_MASKED =
  'This project masks elements: Inspect sends no page of it, since a snapshot cannot hide what its masks name.';
/** What it says of a page let go as the project began masking elements. */
export const SNAPSHOT_MASKED_GONE = 'The page at this call was let go as the project began masking elements.';
/** What it says of a call and moment the worker sent no page of. */
export const SNAPSHOT_MISSING = 'The worker sent no page of this call at that moment.';
/** What it says of a page the instance cannot read whole, to hide its secrets again. */
export const SNAPSHOT_UNREADABLE = 'The worker sent the page at this call in a form the instance cannot read whole.';
/** What it says of a page that costs more to render than a render may (`MAX_RENDER_NODES` and the others). */
export const SNAPSHOT_TOO_LARGE = 'The page at this call is too large to show: rendering it would take too long.';

/** Why a snapshot went: the store's bounds, its chain's start never sent, its test's end, or the project's masks. */
type LetGo = 'bounds' | 'unsent' | 'test-ended' | 'masked';

const LET_GO_SAYS: Record<LetGo, string> = {
  bounds: SNAPSHOT_GONE,
  unsent: SNAPSHOT_UNSENT,
  'test-ended': SNAPSHOT_TEST_ENDED,
  masked: SNAPSHOT_MASKED_GONE,
};

/**
 * The bytes every run's Inspect keeps together, against `limit`: each store adds and takes back its own as they
 * change, and frees them all as its run's view ends (`RunInspect.clear`).
 */
export class InspectBudget {
  used = 0;
  constructor(readonly limit: number = MAX_INSPECT_BYTES) {}

  /** Whether `bytes` more fit. */
  fits(bytes: number): boolean {
    return this.used + bytes <= this.limit;
  }
}

/** A frame's snapshots from one full snapshot on, by their place in the frame, and how it starts. */
interface Chain {
  frame: string;
  snapshots: Map<number, HeldSnapshot>;
  /** Its full snapshot is held (`full`), was let go (`let-go`), or never came (`unsent`). */
  start: 'full' | 'let-go' | 'unsent';
}

/** A snapshot as the store keeps it: its header, its worker and test, its JSON, its chain, and what it counts. */
interface HeldSnapshot extends LiveSnapshot {
  worker: string;
  test: string | null;
  data: Uint8Array;
  /** When it came among the run's. */
  seq: number;
  bytes: number;
  chain: Chain;
  /** Its viewport, once read; null for none. */
  viewport?: { width: number; height: number } | null;
}

/** A snapshot of a worker as the store tells it: its header, less its resources, and the test it is of. */
export type HeardSnapshot = Omit<LiveSnapshot, 'resources'> & { test: string | null };

/**
 * A page rendered from a snapshot: its sanitized HTML, its resources inlined, what would fetch stripped
 * (`stripNetworkReferences`), and the viewport it was taken at.
 */
export interface LiveSnapshotPage {
  html: string;
  viewport: { width: number; height: number } | null;
}

/** Why a page does not render: the worker sent none of that call and moment, or the store does not keep it. */
export type LiveSnapshotRefusal = { status: 404 | 410; message: string };

/**
 * What `addSnapshot` and `addResource` did: kept it (`kept`), held it already (`held`), passed it over (`ignored`: a
 * frame other than a page's main one, or one past a worker's bound alone), or refused it, the instance's Inspect full
 * (`full`).
 */
export type InspectAdded = 'kept' | 'held' | 'ignored' | 'full';

/** The key of a call's moment: the one snapshot of a page's main frame taken then. */
function momentKey(call: string, phase: SnapshotPhase): string {
  return `${call}\n${phase}`;
}

/** What a snapshot counts against the bounds: its JSON, its header's names, and what holding it costs. */
function heldBytes(snapshot: LiveSnapshot & { data: Uint8Array; test: string | null }): number {
  const { call, title, page, frame, test, resources, data } = snapshot;
  let bytes = HELD_OVERHEAD + data.length + 2 * (call.length + title.length + page.length + frame.length);
  bytes += 2 * (test?.length ?? 0);
  for (const { url, sha1 } of resources) bytes += 64 + 2 * (url.length + sha1.length);
  return bytes;
}

/** A worker's snapshots: in the order they came, by moment, by frame's chain; and the moments it let go, with why. */
class WorkerSnapshots {
  readonly order = new Map<number, HeldSnapshot>();
  /** The latest snapshot of each call's moment. */
  readonly moments = new Map<string, HeldSnapshot>();
  /** The moments held of each frame. */
  readonly frameMoments = new Set<string>();
  /** Each frame's chains, in the order they began, and the latest, which the frame's next snapshot joins. */
  readonly chains = new Map<string, { all: Set<Chain>; latest: Chain }>();
  readonly letGo = new Map<string, LetGo>();
  bytes = 0;
  /** How many snapshots it let go: a page rendered before one went may no longer be what renders. */
  removals = 0;

  remember(moment: string, why: LetGo): void {
    this.letGo.delete(moment);
    this.letGo.set(moment, why);
    if (this.letGo.size > MAX_LET_GO) this.letGo.delete(this.letGo.keys().next().value!);
  }
}

/**
 * The snapshot's JSON as the renderer reads it, named and placed by its header, what its secrets show hidden again
 * (`hideFrameSnapshotSecrets`: its HTML, its frame's address and its stylesheets' changed in the page); null when it
 * is not an object, or cannot be read whole.
 */
function parsedSnapshot(held: HeldSnapshot): TraceFrameSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(held.data).toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const shown = hideFrameSnapshotSecrets(value as Record<string, unknown>, { secrets: [] });
  if (!shown) return null;
  const snapshot = shown as unknown as TraceFrameSnapshot;
  return {
    ...snapshot,
    callId: held.call,
    phase: held.phase,
    snapshotName: `${held.phase}@${held.call}`,
    pageId: held.page,
    frameId: held.frame,
    isMainFrame: true,
  };
}

/**
 * A snapshot of a chain as the renderer reads one a reference names: named and placed by its header, its JSON parsed,
 * and its secrets hidden again, only once a reference reaches its nodes.
 */
function lazySnapshot(held: HeldSnapshot): TraceFrameSnapshot {
  let html: unknown;
  let read = false;
  return {
    callId: held.call,
    phase: held.phase,
    snapshotName: `${held.phase}@${held.call}`,
    pageId: held.page,
    frameId: held.frame,
    isMainFrame: true,
    get html() {
      if (!read) html = parsedSnapshot(held)?.html;
      read = true;
      return html;
    },
  };
}

/** A viewport as a snapshot records it: whole positive pixels; null for anything else. */
function viewportOf(value: unknown): { width: number; height: number } | null {
  const { width, height } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;
}

/**
 * The viewport a snapshot's JSON records, read without parsing the rest of it: Playwright writes it, a flat object,
 * after the snapshot's HTML, so its key's last place names it.
 */
function viewportOfData(data: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.length);
  const at = bytes.lastIndexOf('"viewport":');
  if (at < 0) return null;
  const tail = bytes.subarray(at + '"viewport":'.length, at + '"viewport":'.length + 256).toString('utf8');
  const end = tail.indexOf('}');
  if (!tail.startsWith('{') || end < 0) return null;
  try {
    return viewportOf(JSON.parse(tail.slice(0, end + 1)));
  } catch {
    return null;
  }
}

/** A resource as the store keeps it, and what it counts. */
interface HeldResource {
  contentType: string;
  data: Uint8Array;
  bytes: number;
}

/** A page kept rendered: of which snapshot, as its worker's store and the resources stood then. */
interface CachedPage {
  target: HeldSnapshot;
  removals: number;
  resourcesGone: number;
  page: LiveSnapshotPage;
  bytes: number;
}

/** What one run's live view keeps for Inspect: its workers' snapshots and the resources they name. */
export class RunInspect {
  private readonly workers = new Map<string, WorkerSnapshots>();
  /** The run's snapshots, in the order they came. */
  private readonly order = new Map<number, HeldSnapshot>();
  private snapshotBytes = 0;
  private seq = 0;
  /** The resources, by name, the least recently used first. */
  private readonly resources = new Map<string, HeldResource>();
  private resourceBytes = 0;
  /** How many resources went: a page rendered before one went may no longer be what renders. */
  private resourcesGone = 0;
  /** The pages kept rendered, by worker, call and moment, the least recently read first. */
  private readonly pages = new Map<string, CachedPage>();
  private pageBytes = 0;

  constructor(private readonly budget: InspectBudget = new InspectBudget()) {}

  /**
   * Keep a worker's snapshot (`worker`, its `liveWorkerKey`), within the bounds: `kept` when it is one the store did
   * not hold, of a page's main frame, which its watches then hear of.
   */
  addSnapshot(worker: string, snapshot: LiveSnapshot & { data: Uint8Array; test: string | null }): InspectAdded {
    if (!snapshot.main) return 'ignored';
    const store = this.workers.get(worker) ?? new WorkerSnapshots();
    this.workers.set(worker, store);
    const moment = momentKey(snapshot.call, snapshot.phase);
    if (store.frameMoments.has(`${snapshot.frame}\n${moment}`)) return 'held';
    const bytes = heldBytes(snapshot);
    if (bytes > MAX_WORKER_SNAPSHOTS) return 'ignored';
    if (!this.budget.fits(bytes)) return 'full';
    const chain = this.chainFor(store, snapshot);
    const held: HeldSnapshot = {
      ...snapshot,
      resources: [...snapshot.resources],
      worker,
      seq: this.seq++,
      bytes,
      chain,
    };
    chain.snapshots.set(held.index, held);
    store.order.set(held.seq, held);
    store.moments.set(moment, held);
    store.frameMoments.add(`${held.frame}\n${moment}`);
    store.letGo.delete(moment);
    store.bytes += bytes;
    this.order.set(held.seq, held);
    this.snapshotBytes += bytes;
    this.budget.used += bytes;
    while (store.bytes > MAX_WORKER_SNAPSHOTS || store.order.size > MAX_WORKER_SNAPSHOT_COUNT) {
      this.remove(store.order.values().next().value!, 'bounds');
    }
    while (this.snapshotBytes > MAX_RUN_SNAPSHOTS || this.order.size > MAX_RUN_SNAPSHOT_COUNT) {
      this.remove(this.order.values().next().value!, 'bounds');
    }
    return store.order.has(held.seq) ? 'kept' : 'ignored';
  }

  /** Keep a resource, within the bounds; one the store holds already is used again. */
  addResource(resource: LiveResource & { data: Uint8Array }): InspectAdded {
    const known = this.resources.get(resource.sha1);
    if (known) {
      this.touch(resource.sha1, known);
      return 'held';
    }
    const bytes = HELD_OVERHEAD + resource.data.length + 2 * (resource.sha1.length + resource.contentType.length);
    if (bytes > MAX_RUN_RESOURCES) return 'ignored';
    if (!this.budget.fits(bytes)) return 'full';
    this.resources.set(resource.sha1, { contentType: resource.contentType, data: resource.data, bytes });
    this.resourceBytes += bytes;
    this.budget.used += bytes;
    while (this.resourceBytes > MAX_RUN_RESOURCES || this.resources.size > MAX_RUN_RESOURCE_COUNT) {
      const [oldest, entry] = this.resources.entries().next().value!;
      this.resources.delete(oldest);
      this.resourceBytes -= entry.bytes;
      this.budget.used -= entry.bytes;
      this.resourcesGone++;
    }
    return 'kept';
  }

  /** The snapshots kept of a worker, in the order they came, as its watches hear them. */
  heard(worker: string): HeardSnapshot[] {
    return [...(this.workers.get(worker)?.order.values() ?? [])].map((held) => ({
      call: held.call,
      title: held.title,
      phase: held.phase,
      page: held.page,
      frame: held.frame,
      main: held.main,
      full: held.full,
      index: held.index,
      at: held.at,
      test: held.test,
    }));
  }

  /** How many bytes of snapshots, of resources and of pages kept rendered the store holds, and how many of each. */
  size(): { snapshots: number; resources: number; pages: number; counts: { snapshots: number; resources: number } } {
    return {
      snapshots: this.snapshotBytes,
      resources: this.resourceBytes,
      pages: this.pageBytes,
      counts: { snapshots: this.order.size, resources: this.resources.size },
    };
  }

  /** A resource's bytes, used again, or null when the store does not hold it. */
  resource(sha1: string): { contentType: string; data: Uint8Array } | null {
    const entry = this.resources.get(sha1);
    if (!entry) return null;
    this.touch(sha1, entry);
    return entry;
  }

  /**
   * The viewport of the page at a call's moment of the worker, as its snapshot records it, read from that snapshot
   * alone; a refusal when the store does not hold it.
   */
  viewport(worker: string, call: string, phase: SnapshotPhase): LiveSnapshotPage['viewport'] | LiveSnapshotRefusal {
    const store = this.workers.get(worker);
    const target = store?.moments.get(momentKey(call, phase));
    if (!target) return this.missing(store, call, phase);
    if (target.viewport === undefined) target.viewport = viewportOfData(target.data);
    return target.viewport;
  }

  /**
   * The page at a call's moment of the worker, rendered as the stored trace's snapshot view renders one: sanitized, no
   * script, its stylesheets, fonts and images the store holds inlined as data, nothing that would fetch. Kept rendered
   * until its chain lets a snapshot go or a resource goes. A refusal when the store does not hold it, or not a snapshot
   * it refers to, or it costs more to render than a render may.
   */
  async render(worker: string, call: string, phase: SnapshotPhase): Promise<LiveSnapshotPage | LiveSnapshotRefusal> {
    const store = this.workers.get(worker);
    const target = store?.moments.get(momentKey(call, phase));
    if (!store || !target) return this.missing(store, call, phase);
    const key = `${worker}\n${momentKey(call, phase)}`;
    const cached = this.pages.get(key);
    if (
      cached?.target === target &&
      cached.removals === store.removals &&
      cached.resourcesGone === this.resourcesGone
    ) {
      this.pages.delete(key);
      this.pages.set(key, cached);
      return cached.page;
    }
    const removals = store.removals;
    const resourcesGone = this.resourcesGone;
    const page = await this.renderNow(target);
    if (!('status' in page)) this.keepPage(key, { target, removals, resourcesGone, page, bytes: 2 * page.html.length });
    return page;
  }

  /** The worker's test ended: its snapshots go, and a page of one says so. */
  endTest(worker: string): void {
    const store = this.workers.get(worker);
    if (!store) return;
    for (const held of [...store.order.values()]) this.remove(held, 'test-ended');
    store.chains.clear();
    this.dropPages(worker);
  }

  /** The project began masking elements: every snapshot and resource goes, and a page of one says so. */
  mask(): void {
    for (const held of [...this.order.values()]) this.remove(held, 'masked');
    for (const store of this.workers.values()) store.chains.clear();
    this.dropResources();
    this.dropPages(null);
  }

  /** The run's view ended: everything goes, its bytes given back to the instance's budget. */
  clear(): void {
    for (const held of [...this.order.values()]) this.remove(held, 'bounds');
    this.dropResources();
    this.dropPages(null);
    this.workers.clear();
  }

  /**
   * The chain a snapshot joins: a full one starts one, the frame's chains before it whose full one the store does not
   * hold going; another joins the frame's latest, or starts one whose full one never came.
   */
  private chainFor(store: WorkerSnapshots, snapshot: LiveSnapshot): Chain {
    const frame = store.chains.get(snapshot.frame);
    if (frame && snapshot.full) {
      for (const chain of frame.all) {
        if (chain.start === 'full') break;
        const why = chain.start === 'unsent' ? 'unsent' : 'bounds';
        for (const held of [...chain.snapshots.values()]) this.remove(held, why);
        frame.all.delete(chain);
      }
    } else if (frame && !frame.latest.snapshots.has(snapshot.index)) {
      frame.all.add(frame.latest);
      return frame.latest;
    }
    const chain: Chain = { frame: snapshot.frame, snapshots: new Map(), start: snapshot.full ? 'full' : 'unsent' };
    if (frame) {
      frame.all.add(chain);
      frame.latest = chain;
    } else {
      store.chains.set(snapshot.frame, { all: new Set([chain]), latest: chain });
    }
    return chain;
  }

  /** Let a snapshot go, its moment remembered with why. */
  private remove(held: HeldSnapshot, why: LetGo): void {
    const store = this.workers.get(held.worker);
    if (!store || store.order.get(held.seq) !== held) return;
    const moment = momentKey(held.call, held.phase);
    store.order.delete(held.seq);
    this.order.delete(held.seq);
    if (store.moments.get(moment) === held) store.moments.delete(moment);
    store.frameMoments.delete(`${held.frame}\n${moment}`);
    store.bytes -= held.bytes;
    store.removals++;
    this.snapshotBytes -= held.bytes;
    this.budget.used -= held.bytes;
    const chain = held.chain;
    if (chain.snapshots.get(held.index) === held) chain.snapshots.delete(held.index);
    if (held.full && chain.start === 'full') chain.start = 'let-go';
    if (!chain.snapshots.size) store.chains.get(held.frame)?.all.delete(chain);
    // A chain whose start never came says so of its snapshots, whatever let them go.
    store.remember(moment, why === 'bounds' && chain.start === 'unsent' ? 'unsent' : why);
  }

  private dropResources(): void {
    for (const entry of this.resources.values()) this.budget.used -= entry.bytes;
    this.resourcesGone += this.resources.size;
    this.resources.clear();
    this.resourceBytes = 0;
  }

  /** Let go the pages kept rendered of a worker, or of every worker (null). */
  private dropPages(worker: string | null): void {
    for (const [key, cached] of this.pages) {
      if (worker !== null && cached.target.worker !== worker) continue;
      this.pages.delete(key);
      this.pageBytes -= cached.bytes;
      this.budget.used -= cached.bytes;
    }
  }

  /** Keep a page rendered, within the run's bounds and the instance's budget; the least recently read go first. */
  private keepPage(key: string, cached: CachedPage): void {
    if (cached.bytes > 2 * MAX_CACHED_CHARS || !this.budget.fits(cached.bytes)) return;
    const before = this.pages.get(key);
    if (before) {
      this.pages.delete(key);
      this.pageBytes -= before.bytes;
      this.budget.used -= before.bytes;
    }
    this.pages.set(key, cached);
    this.pageBytes += cached.bytes;
    this.budget.used += cached.bytes;
    while (this.pages.size > MAX_CACHED_PAGES || this.pageBytes > 2 * MAX_CACHED_CHARS) {
      const [oldest, entry] = this.pages.entries().next().value!;
      this.pages.delete(oldest);
      this.pageBytes -= entry.bytes;
      this.budget.used -= entry.bytes;
    }
  }

  /** Render a snapshot from its chain, saying why not when it does not render. */
  private async renderNow(target: HeldSnapshot): Promise<LiveSnapshotPage | LiveSnapshotRefusal> {
    const chain = target.chain;
    let lowest = target.index;
    for (const index of chain.snapshots.keys()) lowest = Math.min(lowest, index);
    // The chain by place in its frame, from its first snapshot held to the one rendered: a place the store does not
    // hold stays empty, and a reference to it does not resolve.
    const first = Math.max(lowest, target.index - MAX_CHAIN_SPAN);
    const parsed: TraceFrameSnapshot[] = [];
    for (let index = first; index <= target.index; index++) {
      parsed.push({ frameId: target.frame, isMainFrame: true, html: undefined });
    }
    const rendered = parsedSnapshot(target);
    if (!rendered?.snapshotName) return { status: 410, message: SNAPSHOT_UNREADABLE };
    const named: HeldSnapshot[] = [];
    for (const held of chain.snapshots.values()) {
      if (held.index < first || held.index > target.index) continue;
      named.push(held);
      parsed[held.index - first] = held === target ? rendered : lazySnapshot(held);
    }
    const gap = { status: 410 as const, message: chain.start === 'let-go' ? SNAPSHOT_GONE : SNAPSHOT_UNSENT };
    let unresolved = false;
    let tooLarge = false;
    const sanitized = renderSanitizedSnapshot(
      parsed,
      rendered.snapshotName,
      DOM_SNAPSHOT_CAP_CHARS,
      { keepInlineImages: true },
      () => (unresolved = true),
      () => (tooLarge = true),
    );
    if (!sanitized && tooLarge) return { status: 410, message: SNAPSHOT_TOO_LARGE };
    if (!sanitized || unresolved) return gap;
    const viewport = viewportOf(rendered.viewport);
    target.viewport = viewport;
    const frameUrl = typeof rendered.frameUrl === 'string' ? rendered.frameUrl : undefined;
    const page = await inlineSnapshotAssets(
      { status: 'ok', html: sanitized.html, ...(viewport ? { viewport } : {}), ...(frameUrl ? { frameUrl } : {}) },
      this.assets(named),
    );
    return { html: stripNetworkReferences(page.html ?? sanitized.html), viewport };
  }

  /** Why the store holds no snapshot of a call's moment of a worker: it let it go, saying why, or never had it. */
  private missing(store: WorkerSnapshots | undefined, call: string, phase: SnapshotPhase): LiveSnapshotRefusal {
    const why = store?.letGo.get(momentKey(call, phase));
    return why ? { status: 410, message: LET_GO_SAYS[why] } : { status: 404, message: SNAPSHOT_MISSING };
  }

  /**
   * The resources the snapshots of a chain name, by address as a browser resolves it (`resolveResourceUrl`: no
   * fragment), the later snapshots' first, each the store holds; their bytes read from the store, used again.
   */
  private assets(chain: HeldSnapshot[]): SnapshotAssets {
    const byUrl = new Map<string, TraceResource>();
    for (const held of chain) {
      for (const { url, sha1 } of held.resources) {
        const entry = this.resources.get(sha1);
        if (entry) byUrl.set(resolveResourceUrl(url, null) ?? url, { sha1, mimeType: entry.contentType });
      }
    }
    return {
      byUrl,
      read: async (res) => {
        const entry = this.resource(res.sha1);
        return entry ? Buffer.from(entry.data) : null;
      },
    };
  }

  private touch(sha1: string, entry: HeldResource): void {
    this.resources.delete(sha1);
    this.resources.set(sha1, entry);
  }
}
