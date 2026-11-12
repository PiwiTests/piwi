import {
  hideSnapshotSecrets,
  type LiveResource,
  type LiveSnapshot,
  type SnapshotPhase,
} from '@piwitests/core/live-inspect';
import { DOM_SNAPSHOT_CAP_CHARS, renderSanitizedSnapshot } from './dom-snapshot-render';
import { inlineSnapshotAssets, type SnapshotAssets } from './dom-snapshot';
import type { TraceFrameSnapshot, TraceResource } from './trace-events';

/**
 * What the run page's live view keeps for **Inspect** (`@piwitests/core/live-inspect`), in memory alone, for one run:
 * each worker's snapshots of its pages' main frames as they came, `MAX_WORKER_SNAPSHOTS` bytes at most (the oldest go
 * first) and `MAX_RUN_SNAPSHOTS` for the run's workers together (the run's oldest go first), and the resources they
 * name, `MAX_RUN_RESOURCES` bytes at most (the least recently used go first). Nothing is written anywhere: the run's
 * live view drops it with the run. A snapshot of a frame other than a page's main one is not kept: the snapshot view
 * renders a page's main frame alone.
 *
 * A frame's snapshots read as one chain from its last full one (`full`), each that is not full referring to the
 * snapshots before it by how many back, which their place in the frame (`index`) names. The worker sends a frame's
 * snapshots in the trace's order, and those of its watched page again as Inspect opens, so a snapshot of a frame the
 * store holds already (the same call and moment) is not kept twice, and a full one it does not hold starts its frame's
 * chain again: what the store held of that frame before its first full snapshot (a chain whose start was let go) goes,
 * an earlier navigation's whole chain stays. A snapshot whose chain lacks a snapshot it refers to (let go, or never
 * sent) does not render (`SNAPSHOT_GONE`). Each snapshot rendered goes through `hideSnapshotSecrets` again, after the
 * worker's own pass.
 */

/** The most bytes of snapshots kept of one worker: the oldest go first. */
export const MAX_WORKER_SNAPSHOTS = 32 * 1024 * 1024;
/** The most bytes of snapshots kept of one run, its workers together: the run's oldest go first. */
export const MAX_RUN_SNAPSHOTS = 128 * 1024 * 1024;
/** The most bytes of resources kept of one run: the least recently used go first. */
export const MAX_RUN_RESOURCES = 64 * 1024 * 1024;
/** The most places of a frame a render reads back from the snapshot it renders: a reference further back is a gap. */
const MAX_CHAIN_SPAN = 65_536;
/** The most snapshots let go a worker's store remembers, to tell a page no longer kept from one never sent. */
const MAX_LET_GO = 4096;

/** What a snapshot view says of a page whose snapshot, or one it refers to, the live view no longer keeps. */
export const SNAPSHOT_GONE = `The page at this call is no longer kept: the instance keeps a worker’s latest ${MAX_WORKER_SNAPSHOTS / 1024 / 1024} MB of pages while the run runs.`;
/** What it says of a call and moment the worker sent no page of. */
export const SNAPSHOT_MISSING = 'The worker sent no page of this call at that moment.';

/** A snapshot as the store keeps it: its header, the test it is of, its JSON, and when it came among the run's. */
interface HeldSnapshot extends LiveSnapshot {
  test: string | null;
  data: Uint8Array;
  seq: number;
}

/** A snapshot of a worker as the store tells it: its header, less its resources, and the test it is of. */
export type HeardSnapshot = Omit<LiveSnapshot, 'resources'> & { test: string | null };

/** A page rendered from a snapshot: its sanitized HTML, its resources inlined, and the viewport it was taken at. */
export interface LiveSnapshotPage {
  html: string;
  viewport: { width: number; height: number } | null;
}

/** Why a page does not render: the worker sent none of that call and moment, or the store no longer keeps it. */
export type LiveSnapshotRefusal = { status: 404 | 410; message: string };

/** The key of a call's moment: the one snapshot of a page's main frame taken then. */
function momentKey(call: string, phase: SnapshotPhase): string {
  return `${call}\n${phase}`;
}

/** A worker's snapshots, in the order they came, and those it let go. */
class WorkerSnapshots {
  held: HeldSnapshot[] = [];
  bytes = 0;
  /** The moments of the snapshots let go, the latest `MAX_LET_GO`. */
  private readonly letGo = new Set<string>();

  has(frame: string, call: string, phase: SnapshotPhase): boolean {
    return this.held.some((s) => s.frame === frame && s.call === call && s.phase === phase);
  }

  wasLetGo(call: string, phase: SnapshotPhase): boolean {
    return this.letGo.has(momentKey(call, phase));
  }

  add(snapshot: HeldSnapshot): void {
    if (snapshot.full) {
      // The frame's chain starts again: what is held of it before its first full snapshot (a chain whose full one was
      // let go) can no longer be read, and the chain the worker sends again takes its place.
      const firstFull = this.held.findIndex((s) => s.frame === snapshot.frame && s.full);
      const cut = firstFull < 0 ? this.held.length : firstFull;
      this.remove((s, i) => i < cut && s.frame === snapshot.frame);
    }
    this.held.push(snapshot);
    this.bytes += snapshot.data.length;
  }

  /** Let the oldest go; null when none is held. */
  dropOldest(): HeldSnapshot | null {
    const oldest = this.held.shift() ?? null;
    if (oldest) this.forget(oldest);
    return oldest;
  }

  private remove(which: (s: HeldSnapshot, index: number) => boolean): void {
    const kept: HeldSnapshot[] = [];
    this.held.forEach((s, i) => (which(s, i) ? this.forget(s) : kept.push(s)));
    this.held = kept;
  }

  private forget(snapshot: HeldSnapshot): void {
    this.bytes -= snapshot.data.length;
    const key = momentKey(snapshot.call, snapshot.phase);
    this.letGo.delete(key);
    this.letGo.add(key);
    if (this.letGo.size > MAX_LET_GO) this.letGo.delete(this.letGo.values().next().value!);
  }

  /**
   * The latest snapshot of the call's moment, and its frame's chain up to it, from its last full one (or from the
   * first the store still holds); null for none.
   */
  chainTo(call: string, phase: SnapshotPhase): { target: HeldSnapshot; chain: HeldSnapshot[] } | null {
    let at = -1;
    for (let i = this.held.length - 1; i >= 0; i--) {
      const s = this.held[i]!;
      if (s.call === call && s.phase === phase) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const target = this.held[at]!;
    const frame = this.held.slice(0, at + 1).filter((s) => s.frame === target.frame);
    let start = 0;
    for (let i = frame.length - 1; i >= 0; i--) {
      if (frame[i]!.full) {
        start = i;
        break;
      }
    }
    return { target, chain: frame.slice(start) };
  }
}

/**
 * The snapshot's JSON as the renderer reads it, named and placed by its header, the values of the fields that hold a
 * secret hidden again; null when it is not an object.
 */
function parsedSnapshot(held: HeldSnapshot): TraceFrameSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(held.data).toString('utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as TraceFrameSnapshot;
  return {
    ...snapshot,
    html: hideSnapshotSecrets(snapshot.html, { secrets: [] }),
    callId: held.call,
    phase: held.phase,
    snapshotName: `${held.phase}@${held.call}`,
    pageId: held.page,
    frameId: held.frame,
    isMainFrame: true,
  };
}

/** A viewport as a snapshot records it: whole positive pixels; null for anything else. */
function viewportOf(snapshot: TraceFrameSnapshot): { width: number; height: number } | null {
  const viewport = snapshot.viewport as unknown as Record<string, unknown> | undefined;
  const { width, height } = viewport ?? {};
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width: Math.round(width), height: Math.round(height) }
    : null;
}

/** What one run's live view keeps for Inspect: its workers' snapshots and the resources they name. */
export class RunInspect {
  private readonly workers = new Map<string, WorkerSnapshots>();
  private snapshotBytes = 0;
  private seq = 0;
  /** The resources, by name, the least recently used first. */
  private readonly resources = new Map<string, { contentType: string; data: Uint8Array }>();
  private resourceBytes = 0;

  /**
   * Keep a worker's snapshot (`worker`, its `liveWorkerKey`), within the bounds: true when it is one the store did not
   * hold, of a page's main frame, which its watches then hear of; false for another frame's, or one held already.
   */
  addSnapshot(worker: string, snapshot: LiveSnapshot & { data: Uint8Array; test: string | null }): boolean {
    if (!snapshot.main) return false;
    let store = this.workers.get(worker);
    if (!store) {
      store = new WorkerSnapshots();
      this.workers.set(worker, store);
    }
    if (store.has(snapshot.frame, snapshot.call, snapshot.phase)) return false;
    if (snapshot.data.length > MAX_WORKER_SNAPSHOTS) return false;
    const held: HeldSnapshot = { ...snapshot, resources: [...snapshot.resources], seq: this.seq++ };
    const before = store.bytes;
    store.add(held);
    this.snapshotBytes += store.bytes - before;
    while (store.bytes > MAX_WORKER_SNAPSHOTS) this.snapshotBytes -= store.dropOldest()?.data.length ?? 0;
    while (this.snapshotBytes > MAX_RUN_SNAPSHOTS) {
      let oldest: WorkerSnapshots | null = null;
      for (const kept of this.workers.values()) {
        if (kept.held.length && (!oldest || kept.held[0]!.seq < oldest.held[0]!.seq)) oldest = kept;
      }
      if (!oldest) break;
      this.snapshotBytes -= oldest.dropOldest()?.data.length ?? 0;
    }
    return store.held.includes(held);
  }

  /** Keep a resource, within the bounds; one the store holds already is used again. */
  addResource(resource: LiveResource & { data: Uint8Array }): void {
    const known = this.resources.get(resource.sha1);
    if (known) {
      this.touch(resource.sha1, known);
      return;
    }
    if (resource.data.length > MAX_RUN_RESOURCES) return;
    this.resources.set(resource.sha1, { contentType: resource.contentType, data: resource.data });
    this.resourceBytes += resource.data.length;
    while (this.resourceBytes > MAX_RUN_RESOURCES) {
      const [oldest, entry] = this.resources.entries().next().value!;
      this.resources.delete(oldest);
      this.resourceBytes -= entry.data.length;
    }
  }

  /** The snapshots kept of a worker, in the order they came, as its watches hear them. */
  heard(worker: string): HeardSnapshot[] {
    return (this.workers.get(worker)?.held ?? []).map((held) => ({
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

  /** How many bytes of snapshots and of resources the store holds. */
  size(): { snapshots: number; resources: number } {
    return { snapshots: this.snapshotBytes, resources: this.resourceBytes };
  }

  /** A resource's bytes, used again, or null when the store does not hold it. */
  resource(sha1: string): { contentType: string; data: Uint8Array } | null {
    const entry = this.resources.get(sha1);
    if (!entry) return null;
    this.touch(sha1, entry);
    return entry;
  }

  /**
   * The viewport of the page at a call's moment of the worker, read from its snapshot; a refusal when the store does
   * not hold it.
   */
  viewport(worker: string, call: string, phase: SnapshotPhase): LiveSnapshotPage['viewport'] | LiveSnapshotRefusal {
    const found = this.find(worker, call, phase);
    if ('status' in found) return found;
    const parsed = parsedSnapshot(found.target);
    return parsed ? viewportOf(parsed) : null;
  }

  /**
   * The page at a call's moment of the worker, rendered as the stored trace's snapshot view renders one: sanitized, no
   * script, its stylesheets, fonts and images the store holds inlined as data. A refusal when the store does not hold
   * it, or no longer holds a snapshot it refers to.
   */
  async render(worker: string, call: string, phase: SnapshotPhase): Promise<LiveSnapshotPage | LiveSnapshotRefusal> {
    const found = this.find(worker, call, phase);
    if ('status' in found) return found;
    // The chain by place in its frame, from its first snapshot held to the one rendered: a place the store does not hold
    // stays empty, and a reference to it does not resolve.
    const first = Math.max(found.chain[0]!.index, found.target.index - MAX_CHAIN_SPAN);
    const parsed: TraceFrameSnapshot[] = [];
    for (let index = first; index <= found.target.index; index++) {
      parsed.push({ frameId: found.target.frame, isMainFrame: true, html: undefined });
    }
    for (const held of found.chain) {
      const snapshot = held.index >= first && held.index <= found.target.index ? parsedSnapshot(held) : null;
      if (snapshot) parsed[held.index - first] = snapshot;
    }
    const target = parsed.at(-1);
    if (!target?.snapshotName) return { status: 410, message: SNAPSHOT_GONE };
    let unresolved = false;
    const rendered = renderSanitizedSnapshot(
      parsed,
      target.snapshotName,
      DOM_SNAPSHOT_CAP_CHARS,
      { keepInlineImages: true },
      () => (unresolved = true),
    );
    if (!rendered || unresolved) return { status: 410, message: SNAPSHOT_GONE };
    const viewport = viewportOf(target);
    const frameUrl = typeof target.frameUrl === 'string' ? target.frameUrl : undefined;
    const page = await inlineSnapshotAssets(
      { status: 'ok', html: rendered.html, ...(viewport ? { viewport } : {}), ...(frameUrl ? { frameUrl } : {}) },
      this.assets(found.chain),
    );
    return { html: page.html ?? rendered.html, viewport };
  }

  /** The snapshot of a call's moment of a worker, and its chain; why not, when the store does not hold it. */
  private find(
    worker: string,
    call: string,
    phase: SnapshotPhase,
  ): { target: HeldSnapshot; chain: HeldSnapshot[] } | LiveSnapshotRefusal {
    const store = this.workers.get(worker);
    const found = store?.chainTo(call, phase) ?? null;
    if (found) return found;
    return store?.wasLetGo(call, phase)
      ? { status: 410, message: SNAPSHOT_GONE }
      : { status: 404, message: SNAPSHOT_MISSING };
  }

  /**
   * The resources a chain names, by address, the later snapshots' first, each the store holds; their bytes read from
   * the store, used again.
   */
  private assets(chain: HeldSnapshot[]): SnapshotAssets {
    const byUrl = new Map<string, TraceResource>();
    for (const held of chain) {
      for (const { url, sha1 } of held.resources) {
        const entry = this.resources.get(sha1);
        if (entry) byUrl.set(url, { sha1, mimeType: entry.contentType });
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

  private touch(sha1: string, entry: { contentType: string; data: Uint8Array }): void {
    this.resources.delete(sha1);
    this.resources.set(sha1, entry);
  }
}
