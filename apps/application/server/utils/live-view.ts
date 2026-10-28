import { createHash, randomBytes } from 'node:crypto';
import { getRequestHeader, type H3Event } from 'h3';
import {
  LIVE_FRAME_FPS,
  LIVE_VIEW_KEY_PREFIX,
  isLiveViewKey,
  liveWorkerKey,
  type LiveStop,
  type LiveWorkerId,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { RateWindow } from '@piwitests/core/run-view';
import type { LiveViewEnd, LiveViewerMessage, LiveWorkerState } from '#shared/live-view';
import type { EventStreamSink } from './event-stream';
import { runEventBus, type GlobalRunEvent } from './run-events';

/**
 * The run page's live view on this instance: a relay, in memory alone, between the workers of a live run whose
 * project turned it on and the people watching them. Each worker holds one event stream, opened with a key minted
 * for its run (`mintKey`, handed to the run's global setup), on which it hears how many people watch it; a viewer
 * holds one stream per worker it watches. The frames a worker posts go to that worker's viewers and nowhere else: none
 * is kept, written to the database, logged or exported, and a viewer whose stream is backed up gets the latest frame
 * alone once it drains. The worker's stops go to everyone with the run page open, through the run's event stream
 * (`live-worker`), and so does each worker's leaving, whatever ends it. A run's keys, workers and viewers end with the
 * run (its finish or cancel), with the project's setting turned off (`endProject`), and a key after `LIVE_KEY_TTL_MS`
 * at most; an interrupted run's workers and viewers end, its keys stay for the run to go on (`interruptRun`). Bounded
 * throughout: keys per project and in all (the expired ones go first), workers and viewers per run, viewers per person
 * (the oldest replaced), frames a second per worker, and each frame's bytes (the route's).
 */

/** The most workers of one run that hold a stream. */
export const MAX_LIVE_WORKERS_PER_RUN = 64;
/** The most viewers of one run, over all its workers. */
export const MAX_LIVE_VIEWERS_PER_RUN = 16;
/** The most frames a second relayed of one worker: twice what a worker sends, for the jitter of the way. */
export const MAX_RELAYED_FPS = LIVE_FRAME_FPS * 2;
/** How long a key opens a stream at most, whatever its run does. */
export const LIVE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** The most viewers one person holds in one run: a further one replaces their oldest. */
export const MAX_LIVE_VIEWERS_PER_PERSON = 4;
/** The most keys held, of every run: the expired go first, then the oldest of the project that holds the most. */
export const MAX_LIVE_KEYS = 5000;
/** The most keys of one project: its expired go first, then its oldest. */
export const MAX_LIVE_KEYS_PER_PROJECT = 500;
/** The most keys of one run: one per shard that set it up. */
const MAX_KEYS_PER_RUN = 64;
/** The runs whose counts are kept after they ended, the latest. */
const MAX_COUNTED_RUNS = 512;

/** What ends a run's live view on the instance: its tests are done, or it will never run them (an interruption aside). */
const RUN_ENDS: ReadonlySet<GlobalRunEvent['type']> = new Set([
  'run-finalizing',
  'run-finished',
  'run-cancelled',
  'run-submitted',
]);

interface KeyEntry {
  runId: number;
  projectId: number;
  expiresAt: number;
}

interface Viewer {
  sink: EventStreamSink;
  /** The latest message waiting while the viewer's stream is backed up. */
  pending: LiveViewerMessage | null;
  /** The signed-in person watching, null when the instance knows nobody (authentication off). */
  person: number | null;
  /** When it came, in the order of all viewers. */
  since: number;
}

interface WorkerLink {
  id: LiveWorkerId;
  sink: EventStreamSink;
  viewers: Set<Viewer>;
  paused: LiveStop | null;
  rate: RateWindow;
}

interface RunLive {
  projectId: number;
  workers: Map<string, WorkerLink>;
}

/** What a run's workers sent, the posts refused included: the run page's and the tests' check that nothing went. */
export interface LiveViewCounts {
  requests: number;
  frames: number;
  bytes: number;
}

/** Why a relay refused. */
export type LiveViewRefusal = { status: 404 | 409 | 429; message: string };

/** The SHA-256 of a key, as it is held. */
function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class LiveViewRelay {
  private readonly keys = new Map<string, KeyEntry>();
  private readonly runs = new Map<number, RunLive>();
  private readonly counts = new Map<number, LiveViewCounts>();
  /** How many viewers came so far, which orders them. */
  private viewersCame = 0;

  constructor(
    private readonly publish: (runId: number, state: LiveWorkerState) => void = (runId, state) =>
      runEventBus.publish(runId, { type: 'live-worker', data: state }),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A key that opens the live view of `runId` alone; null when the run holds as many as it may. A project at its
   * bound gives up its expired keys, then its oldest; the instance at its bound gives up every expired key, then the
   * oldest of the project that holds the most, so no project takes another's place.
   */
  mintKey(runId: number, projectId: number): string | null {
    const ofRun = [...this.keys.values()].filter((entry) => entry.runId === runId).length;
    if (ofRun >= MAX_KEYS_PER_RUN) return null;
    if (this.keysOf(projectId).length >= MAX_LIVE_KEYS_PER_PROJECT) this.dropExpired(projectId);
    const ofProject = this.keysOf(projectId);
    if (ofProject.length >= MAX_LIVE_KEYS_PER_PROJECT) this.keys.delete(ofProject[0]!);
    if (this.keys.size >= MAX_LIVE_KEYS) this.dropExpired(null);
    while (this.keys.size >= MAX_LIVE_KEYS) this.keys.delete(this.keysOf(this.largestProject())[0]!);
    const key = `${LIVE_VIEW_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.keys.set(digest(key), { runId, projectId, expiresAt: this.now() + LIVE_KEY_TTL_MS });
    return key;
  }

  /** The run's key entry the presented key opens: null for another run's, an expired one, or none. */
  authorize(runId: number, presented: string | null | undefined): KeyEntry | null {
    if (!isLiveViewKey(presented)) return null;
    const id = digest(presented);
    const entry = this.keys.get(id);
    if (!entry || entry.runId !== runId) return null;
    if (entry.expiresAt <= this.now()) {
      this.keys.delete(id);
      return null;
    }
    return entry;
  }

  /** Count a request to the run's live view endpoint, refused or not. */
  noteRequest(runId: number): void {
    this.countsOf(runId).requests++;
  }

  /** What the run's workers sent so far. */
  countsFor(runId: number): LiveViewCounts {
    return { ...(this.counts.get(runId) ?? { requests: 0, frames: 0, bytes: 0 }) };
  }

  /**
   * A worker of the run holds the stream `open` opens from now on, in place of a stream it held before, whose viewers
   * and stop it keeps; the run page hears it is connected. Refused past `MAX_LIVE_WORKERS_PER_RUN`, the stream then
   * left unopened.
   */
  connectWorker(entry: KeyEntry, id: LiveWorkerId, open: () => EventStreamSink): LiveViewRefusal | null {
    const key = liveWorkerKey(id);
    const known = this.runs.get(entry.runId);
    const before = known?.workers.get(key);
    if (!before && (known?.workers.size ?? 0) >= MAX_LIVE_WORKERS_PER_RUN) {
      return { status: 429, message: `A run has ${MAX_LIVE_WORKERS_PER_RUN} workers in its live view at most.` };
    }
    const run = known ?? { projectId: entry.projectId, workers: new Map<string, WorkerLink>() };
    this.runs.set(entry.runId, run);
    const sink = open();
    const link: WorkerLink = {
      id,
      sink,
      viewers: new Set(),
      paused: before?.paused ?? null,
      rate: new RateWindow(MAX_RELAYED_FPS, this.now),
    };
    run.workers.set(key, link);
    if (before) {
      // The worker opened its stream again: its viewers stay with it.
      for (const viewer of before.viewers) link.viewers.add(viewer);
      before.viewers.clear();
      before.sink.close();
    }
    sink.onClose(() => this.disconnectWorker(entry.runId, key, link));
    sink.send({ type: 'viewers', count: link.viewers.size });
    this.publish(entry.runId, { ...id, connected: true, paused: link.paused });
    return null;
  }

  /** A message a worker of the run posted. */
  receive(runId: number, message: WorkerToInstance): LiveViewRefusal | null {
    const link = this.runs.get(runId)?.workers.get(liveWorkerKey(message));
    if (!link) return { status: 409, message: 'This worker holds no stream of the run: open it first.' };
    switch (message.type) {
      case 'frame': {
        if (!link.rate.take(1)) return { status: 429, message: `${MAX_RELAYED_FPS} frames a second at most.` };
        if ('refused' in message) {
          this.deliver(link, { type: 'refused', message: message.refused });
          return null;
        }
        const counts = this.countsOf(runId);
        counts.frames++;
        counts.bytes += Math.floor((message.data.length * 3) / 4);
        this.deliver(link, { type: 'frame', data: message.data, call: message.call, test: message.test });
        return null;
      }
      case 'stop':
        link.paused = message.stop;
        this.publish(runId, { ...link.id, connected: true, paused: message.stop });
        return null;
      case 'ended':
        this.endViewers(link, 'test-ended');
        return null;
    }
  }

  /**
   * Someone watches a connected worker of the run on the stream `open` opens, until it closes; refused, the stream is
   * left unopened. `person`, the signed-in user, holds `MAX_LIVE_VIEWERS_PER_PERSON` viewers of the run at most: one
   * more replaces their oldest, which hears why it ended.
   */
  addViewer(
    runId: number,
    id: LiveWorkerId,
    open: () => EventStreamSink,
    person: number | null = null,
  ): LiveViewRefusal | null {
    const run = this.runs.get(runId);
    const link = run?.workers.get(liveWorkerKey(id));
    if (!run || !link) return { status: 404, message: 'This worker is not in the live view of the run.' };
    const all: Array<{ worker: WorkerLink; viewer: Viewer }> = [];
    for (const worker of run.workers.values()) for (const viewer of worker.viewers) all.push({ worker, viewer });
    const own = person === null ? [] : all.filter(({ viewer }) => viewer.person === person);
    own.sort((a, b) => a.viewer.since - b.viewer.since);
    const replaced = own.length >= MAX_LIVE_VIEWERS_PER_PERSON ? own[0]! : null;
    if (!replaced && all.length >= MAX_LIVE_VIEWERS_PER_RUN) {
      return { status: 429, message: `${MAX_LIVE_VIEWERS_PER_RUN} people at most watch one run at a time.` };
    }
    if (replaced) this.endViewer(replaced.worker, replaced.viewer, 'replaced');
    const sink = open();
    const viewer: Viewer = { sink, pending: null, person, since: this.viewersCame++ };
    link.viewers.add(viewer);
    sink.onDrain(() => {
      const waiting = viewer.pending;
      if (!waiting || sink.backedUp()) return;
      viewer.pending = null;
      sink.send(waiting);
    });
    sink.onClose(() => {
      // The link the viewer watches now, should its worker have opened its stream again.
      const current = this.runs.get(runId)?.workers.get(liveWorkerKey(id));
      if (current?.viewers.delete(viewer)) current.sink.send({ type: 'viewers', count: current.viewers.size });
    });
    link.sink.send({ type: 'viewers', count: link.viewers.size });
    return null;
  }

  /** The run's connected workers, for a run page that opens its stream. */
  workersOf(runId: number): LiveWorkerState[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return [...run.workers.values()].map((link) => ({ ...link.id, connected: true, paused: link.paused }));
  }

  /** The run's live view ends: its keys open nothing more, its workers' and viewers' streams close. */
  endRun(runId: number, reason: LiveViewEnd = 'run-ended'): void {
    for (const [id, entry] of this.keys) if (entry.runId === runId) this.keys.delete(id);
    this.closeRun(runId, reason);
  }

  /**
   * The run was interrupted: its workers' and viewers' streams close, and the run page hears each worker left. Its
   * keys stay, until the run ends or they expire, so its workers open their streams again if it goes on.
   */
  interruptRun(runId: number): void {
    this.closeRun(runId, 'run-ended');
  }

  /** The project turned its live view off: every run of it ends its view. */
  endProject(projectId: number): void {
    const runIds = new Set<number>();
    for (const entry of this.keys.values()) if (entry.projectId === projectId) runIds.add(entry.runId);
    for (const [runId, run] of this.runs) if (run.projectId === projectId) runIds.add(runId);
    for (const runId of runIds) this.endRun(runId, 'off');
  }

  /** End the relay's part in each run that ends, as the run's lifecycle says; an interrupted run's keys stay. */
  followRuns(): () => void {
    return runEventBus.subscribeGlobal((event) => {
      if (!RUN_ENDS.has(event.type)) return;
      if (event.type === 'run-finished' && event.status === 'interrupted') this.interruptRun(event.runId);
      else this.endRun(event.runId);
    });
  }

  /** Close the run's workers' and viewers' streams, the viewers hearing `reason` and the run page each worker leave. */
  private closeRun(runId: number, reason: LiveViewEnd): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    for (const link of run.workers.values()) {
      this.endViewers(link, reason);
      link.sink.close();
      this.publish(runId, { ...link.id, connected: false, paused: null });
    }
  }

  /** The keys of a project, oldest first. */
  private keysOf(projectId: number): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.keys) if (entry.projectId === projectId) ids.push(id);
    return ids;
  }

  /** Give up the expired keys, of one project or of all (null). */
  private dropExpired(projectId: number | null): void {
    const now = this.now();
    for (const [id, entry] of this.keys) {
      if (entry.expiresAt <= now && (projectId === null || entry.projectId === projectId)) this.keys.delete(id);
    }
  }

  /** The project that holds the most keys. */
  private largestProject(): number {
    const counts = new Map<number, number>();
    for (const entry of this.keys.values()) counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
    let largest = -1;
    let most = -1;
    for (const [projectId, count] of counts) {
      if (count > most) [largest, most] = [projectId, count];
    }
    return largest;
  }

  /** Send a message to a worker's viewers: one whose stream is backed up gets the latest alone, once it drains. */
  private deliver(link: WorkerLink, message: LiveViewerMessage): void {
    for (const viewer of link.viewers) {
      if (viewer.sink.backedUp()) viewer.pending = message;
      else viewer.sink.send(message);
    }
  }

  /** One viewer of the worker hears why its view ended, and its stream closes; the worker hears how many are left. */
  private endViewer(link: WorkerLink, viewer: Viewer, reason: LiveViewEnd): void {
    link.viewers.delete(viewer);
    viewer.sink.send({ type: 'end', reason } satisfies LiveViewerMessage);
    viewer.sink.close();
    link.sink.send({ type: 'viewers', count: link.viewers.size });
  }

  /** The worker's viewers hear why their view ended, and their streams close; the worker hears nobody watches. */
  private endViewers(link: WorkerLink, reason: LiveViewEnd): void {
    if (!link.viewers.size) return;
    const viewers = [...link.viewers];
    link.viewers.clear();
    for (const viewer of viewers) {
      viewer.sink.send({ type: 'end', reason } satisfies LiveViewerMessage);
      viewer.sink.close();
    }
    link.sink.send({ type: 'viewers', count: 0 });
  }

  private disconnectWorker(runId: number, key: string, link: WorkerLink): void {
    const run = this.runs.get(runId);
    if (run?.workers.get(key) !== link) return;
    run.workers.delete(key);
    this.endViewers(link, 'worker-left');
    this.publish(runId, { ...link.id, connected: false, paused: null });
    if (!run.workers.size) this.runs.delete(runId);
  }

  private countsOf(runId: number): LiveViewCounts {
    let counts = this.counts.get(runId);
    if (!counts) {
      while (this.counts.size >= MAX_COUNTED_RUNS) this.counts.delete(this.counts.keys().next().value!);
      counts = { requests: 0, frames: 0, bytes: 0 };
      this.counts.set(runId, counts);
    }
    return counts;
  }
}

/** The live view key a request presents: its `Authorization: Bearer` token, when it is one. */
export function liveViewKeyOf(event: H3Event): string | null {
  const header = getRequestHeader(event, 'authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match && isLiveViewKey(match[1]) ? match[1] : null;
}

export const liveViewRelay = new LiveViewRelay();
liveViewRelay.followRuns();
