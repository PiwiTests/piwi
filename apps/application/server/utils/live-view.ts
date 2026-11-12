import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getRequestHeader, type H3Event } from 'h3';
import {
  LIVE_CALL_LOGS_PER_SECOND,
  LIVE_FRAME_FPS,
  LIVE_FRAME_HEIGHT,
  LIVE_FRAME_WIDTH,
  LIVE_TILE_FPS,
  LIVE_TILE_HEIGHT,
  LIVE_TILE_WIDTH,
  LIVE_VIEW_KEY_PREFIX,
  isLiveViewKey,
  liveLaneKey,
  liveWorkerKey,
  type InstanceToWorker,
  type LiveStop,
  type LiveTestOutcome,
  type LiveViewEnd,
  type LiveViewerMessage,
  type LiveWorkerFrame,
  type LiveWorkerId,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { LatestPacer, RateWindow } from '@piwitests/core/run-view';
import type { LiveWorkerState } from '#shared/live-view';
import type { DbClient } from '../database';
import { projects, testRuns } from '../database/schema';
import { apiError } from './api-error';
import type { EventStreamSink } from './event-stream';
import { runEventBus, type GlobalRunEvent } from './run-events';
import { timingSafeEqualStr } from './timing-safe';

/**
 * The run page's live view on this instance: a relay, in memory alone, between the workers of a live run whose project
 * turned it on (a CI run's, or one a developer shares from their machine) and the people watching them. Each worker
 * holds one event stream, opened with a key minted for its run (`mintKey`, handed to the run's global setup), on which
 * it hears how many people watch it, what they ask of its images (`view`: the largest size one of them shows it at, and
 * the pace), and which elements its project masks beside the secret fields (`setMasks` tells the open workers each
 * change). A viewer's page holds one watch of the run (`openWatch`), a stream of live messages: the frames of the
 * worker it shows in full (its focus: one worker's test, or the worker of a lane, `liveLaneKey`, which it follows
 * through the lane's next tests and the worker started in it again, waiting `LANE_WAIT_MS` for it, each test's end told
 * with how it ended, `test-ended`), and while it shows tiles (**Watch all**) each other worker's latest frame,
 * `LIVE_TILE_FPS` a second at most. The page changes what its watch shows without opening another (`changeWatch`), by
 * the id the watch's stream said as it opened. The frames a worker posts go to its viewers and nowhere else: none is
 * kept, written to the database, logged or exported, and a viewer whose stream is backed up gets the latest frame alone
 * once it drains. A CI run's worker posts the call its test is in as Playwright logs it (`call-log`), which goes to the
 * watches that show it in full the same way, the latest kept apart from the frame. The worker's stops go to everyone
 * with the run page open, through the run's event stream (`live-worker`), and so does each worker's leaving, whatever
 * ends it; a developer who stops sharing their run has each worker's full views hear so (`unshared`) before its stream
 * closes. A run's keys, workers and watches end with the run (its finish or cancel), with the project's setting turned
 * off (`endProject`), and a key after `LIVE_KEY_TTL_MS` at most; an interrupted run's workers and watches end, the keys
 * that opened a stream stay for the run to go on (`interruptRun`). A key that ended with its run or with the setting
 * is remembered, as long as it would have lived, for the routes to tell its worker why (`endedWhy`). The run keeps
 * each key's digest (`storeLiveViewKey`), never the key: a key this relay does not hold (the instance started again,
 * the setting turned off and on, the key given up at a bound) is taken back as its worker presents it while the run
 * still runs, or may go on, in a project with the live view on, within `LIVE_KEY_TTL_MS` of the run's creation
 * (`authorizeLiveViewKey`). Bounded throughout: keys per project and in all (the expired ones go first, then those
 * that never opened a stream: a run on a developer's machine nobody shares), workers and watches per run, watches per
 * person (the oldest replaced), frames and call logs a second per worker, bytes of images a second per run, and each
 * message's bytes (the route's).
 */

/** The most workers of one run that hold a stream. */
export const MAX_LIVE_WORKERS_PER_RUN = 64;
/** The most watches of one run: a page's one connection, whatever it shows. */
export const MAX_LIVE_VIEWERS_PER_RUN = 16;
/** The most frames a second relayed of one worker: twice what a worker sends, for the jitter of the way. */
export const MAX_RELAYED_FPS = LIVE_FRAME_FPS * 2;
/** The most bytes of images the workers of one run post in a second, together: a frame past it is refused. */
export const MAX_LIVE_BYTES_PER_RUN = 4 * 1024 * 1024;
/** The most call logs a worker's view relays a second: twice what a worker posts, for posts the network brings together. */
export const MAX_RELAYED_CALL_LOGS = LIVE_CALL_LOGS_PER_SECOND * 2;
/** How long a key opens a stream at most, whatever its run does. */
export const LIVE_KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** The most watches one person holds of one run: a further one replaces their oldest. */
export const MAX_LIVE_VIEWERS_PER_PERSON = 4;
/** How long a viewer who follows a lane waits for its worker to start again, as Playwright does after a failure. */
export const LANE_WAIT_MS = 30_000;
/** What a viewer who follows a lane sees while it waits for the lane's next worker. */
export const LANE_RESTARTING = 'Waiting for the next test of this worker’s lane.';
/** The most keys held, of every run: the expired go first, then the oldest of the project that holds the most. */
export const MAX_LIVE_KEYS = 5000;
/** The most keys of one project: its expired go first, then its oldest. */
export const MAX_LIVE_KEYS_PER_PROJECT = 500;
/** The most keys of one run, held and stored: one per shard that set it up. */
const MAX_KEYS_PER_RUN = 64;
/** The runs whose counts are kept after they ended, the latest. */
const MAX_COUNTED_RUNS = 512;
/** The size a watch shows its focused worker at, in device pixels, until it says another. */
const DEFAULT_SIZE = { width: LIVE_FRAME_WIDTH, height: LIVE_FRAME_HEIGHT };

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
  /** A worker opened a stream with it. */
  streamed: boolean;
}

/** Why a key that was one opens nothing any more: the project turned its live view off, or the run ended. */
export type LiveKeyEnd = 'off' | 'run-ended';

/**
 * What a watch shows, each field kept as it was when a change leaves it out: one worker in full (`focus`, null for
 * none; with its lane, `slot`, the worker of that lane, followed through its next tests), every other worker's tile
 * (`tiles`), and the size the page shows the full view at, in device pixels (`readLiveViewSize`).
 */
export interface LiveWatchAsk {
  focus?: LiveWorkerId | null;
  tiles?: boolean;
  size?: { width: number; height: number };
}

/** A page's watch of the run: one stream, whatever it shows. */
interface Viewer {
  /** The id its page changes what it shows by: random, said on its own stream alone. */
  id: string;
  sink: EventStreamSink;
  /**
   * The latest message of each kind of its focused worker waiting while its stream is backed up, so the one never
   * pushes the other out: an image or why none shows (`frame`, `refused`), and a call log.
   */
  pending: Map<'image' | 'call-log', LiveViewerMessage>;
  /** The signed-in person watching, null when the instance knows nobody (authentication off). */
  person: number | null;
  /** When it came, in the order of all viewers. */
  since: number;
  /** The lane its full view follows (`liveLaneKey`); null for one worker's test, or no full view. */
  lane: string | null;
  /** The worker it shows in full now: null with no full view, or while it waits for its lane's next worker. */
  link: WorkerLink | null;
  tiles: boolean;
  size: { width: number; height: number };
  /** Each other worker's tile, at its pace, by `liveWorkerKey`: the latest alone waits. */
  tilePacers: Map<string, LatestPacer<LiveViewerMessage>>;
}

interface WorkerLink {
  id: LiveWorkerId;
  sink: EventStreamSink;
  /** The watches that show it in full. */
  viewers: Set<Viewer>;
  paused: LiveStop | null;
  rate: RateWindow;
  /** The call logs it posted in the last second. */
  logRate: RateWindow;
  /** How many watch it, and what they ask, as it last heard: each is said again when it changes alone. */
  told: { count: number; view: string } | null;
}

interface RunLive {
  projectId: number;
  workers: Map<string, WorkerLink>;
  /** The worker that holds each lane now, by `liveLaneKey`. */
  lanes: Map<string, WorkerLink>;
  /** The watches whose lane's worker left, waiting `LANE_WAIT_MS` for one to start in it again, and that worker. */
  waiting: Map<string, { id: LiveWorkerId; viewers: Set<Viewer>; timer: ReturnType<typeof setTimeout> }>;
  /** Every watch of the run, by its id. */
  viewers: Map<string, Viewer>;
  /** The bytes of images its workers posted in the last second. */
  bytes: RateWindow;
}

/** What a run's workers sent, the posts refused included: the run page's and the tests' check that nothing went. */
export interface LiveViewCounts {
  requests: number;
  frames: number;
  bytes: number;
}

/** Why a relay refused. */
export type LiveViewRefusal = { status: 404 | 409 | 429; message: string };

/** What a worker posts, as the relay takes it: a frame with its image as bytes, from either form it came in. */
export type LiveRelayMessage = Exclude<WorkerToInstance, { type: 'frame'; data: string }> | LiveWorkerFrame;

/** The SHA-256 of a key, as it is held, and stored with its run. */
function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** The key digests a run stores (`test_runs.live_view_key_digests`), as they are read: none for anything else. */
function storedDigests(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Whether `presented` is a key whose digest the run stores (`stored`), each digest compared in constant time. */
function storesKey(stored: unknown, presented: string): boolean {
  const presentedDigest = digest(presented);
  let found = false;
  for (const kept of storedDigests(stored)) if (timingSafeEqualStr(kept, presentedDigest)) found = true;
  return found;
}

/** The digests a run stores of its keys, and when it was created, which bounds how long they open its view. */
export interface StoredLiveViewKeys {
  digests: unknown;
  createdAt: Date;
}

/** The lane a worker id names (`liveLaneKey`); null for a worker of a reporter that does not say its lane. */
function laneOf(id: LiveWorkerId): string | null {
  return id.slot === undefined ? null : liveLaneKey({ shard: id.shard, slot: id.slot });
}

/** A worker's own fields, as each message about it names it. */
function idOf(id: LiveWorkerId): LiveWorkerId {
  return id.slot === undefined
    ? { shard: id.shard, worker: id.worker }
    : { shard: id.shard, worker: id.worker, slot: id.slot };
}

export class LiveViewRelay {
  private readonly keys = new Map<string, KeyEntry>();
  /** The keys that ended, oldest first, as many at most as are held. */
  private readonly ended = new Map<string, { runId: number; why: LiveKeyEnd; expiresAt: number }>();
  private readonly runs = new Map<number, RunLive>();
  private readonly counts = new Map<number, LiveViewCounts>();
  /** How many viewers came so far, which orders them. */
  private viewersCame = 0;
  /** The elements each project masks, as a project admin last set them on this server. */
  private readonly projectMasks = new Map<number, string[]>();

  constructor(
    private readonly publish: (runId: number, state: LiveWorkerState) => void = (runId, state) =>
      runEventBus.publish(runId, { type: 'live-worker', data: state }),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A key that opens the live view of `runId` alone; null when the run holds as many as it may. Held within the
   * bounds `hold` keeps, so no project takes another's place and a run that streams keeps its key.
   */
  mintKey(runId: number, projectId: number): string | null {
    const key = `${LIVE_VIEW_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const entry = { runId, projectId, expiresAt: this.now() + LIVE_KEY_TTL_MS, streamed: false };
    return this.hold(digest(key), entry) ? key : null;
  }

  /**
   * Take back the key `presented` of the run `runId`, which this relay does not hold, when the run stores its digest
   * (`stored`): it opens the run's view again until `LIVE_KEY_TTL_MS` after the run was created, held within the same
   * bounds as a key minted. Null for a key the run does not store, past that time, or past the run's bound. The caller
   * checks first that the run still runs, or may go on, and that its project's live view is on.
   */
  restoreKey(runId: number, projectId: number, presented: string, stored: StoredLiveViewKeys): KeyEntry | null {
    const expiresAt = stored.createdAt.getTime() + LIVE_KEY_TTL_MS;
    if (!isLiveViewKey(presented) || expiresAt <= this.now() || !storesKey(stored.digests, presented)) return null;
    const id = digest(presented);
    const entry = { runId, projectId, expiresAt, streamed: false };
    if (!this.hold(id, entry)) return null;
    this.ended.delete(id);
    return entry;
  }

  /**
   * Hold a key's entry by its digest (`id`); false when its run holds as many as it may. A project at its bound gives
   * up its expired keys, then its oldest that never opened a stream, then its oldest; the instance at its bound gives
   * up every expired key, then the oldest that never opened a stream of the project that holds the most of them, then
   * the oldest of the project that holds the most.
   */
  private hold(id: string, entry: KeyEntry): boolean {
    const { runId, projectId } = entry;
    const ofRun = [...this.keys.values()].filter((held) => held.runId === runId).length;
    if (ofRun >= MAX_KEYS_PER_RUN) return false;
    if (this.keysOf(projectId).length >= MAX_LIVE_KEYS_PER_PROJECT) this.dropExpired(projectId);
    if (this.keysOf(projectId).length >= MAX_LIVE_KEYS_PER_PROJECT) {
      this.keys.delete(this.keysOf(projectId, false)[0] ?? this.keysOf(projectId)[0]!);
    }
    if (this.keys.size >= MAX_LIVE_KEYS) this.dropExpired(null);
    while (this.keys.size >= MAX_LIVE_KEYS) {
      const idle = this.largestProject(false);
      this.keys.delete(idle === null ? this.keysOf(this.largestProject(null)!)[0]! : this.keysOf(idle, false)[0]!);
    }
    this.keys.set(id, entry);
    return true;
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

  /**
   * Why a key of the run that `authorize` refuses opens nothing any more, for the worker that presents it to say:
   * the setting turned off, or the run ended; null for a key that never was one, expired, or was given up.
   */
  endedWhy(runId: number, presented: string | null | undefined): LiveKeyEnd | null {
    if (!isLiveViewKey(presented)) return null;
    const ended = this.ended.get(digest(presented));
    if (!ended || ended.runId !== runId || ended.expiresAt <= this.now()) return null;
    return ended.why;
  }

  /** Count a request to the run's live view endpoint, refused or not. */
  noteRequest(runId: number): void {
    this.countsOf(runId).requests++;
  }

  /** What the run's workers sent so far. */
  countsFor(runId: number): LiveViewCounts {
    return { ...(this.counts.get(runId) ?? { requests: 0, frames: 0, bytes: 0 }) };
  }

  /** The run's live state, made as its first worker or watch comes. */
  private runOf(runId: number, projectId: number): RunLive {
    const known = this.runs.get(runId);
    if (known) return known;
    const run: RunLive = {
      projectId,
      workers: new Map(),
      lanes: new Map(),
      waiting: new Map(),
      viewers: new Map(),
      bytes: new RateWindow(MAX_LIVE_BYTES_PER_RUN, this.now),
    };
    this.runs.set(runId, run);
    return run;
  }

  /**
   * A worker of the run holds the stream `open` opens from now on, in place of a stream it held before, whose viewers
   * and stop it keeps; the run page hears it is connected. Refused past `MAX_LIVE_WORKERS_PER_RUN`, the stream then
   * left unopened.
   */
  connectWorker(
    entry: KeyEntry,
    id: LiveWorkerId,
    open: () => EventStreamSink,
    masks: readonly string[] = [],
  ): LiveViewRefusal | null {
    const key = liveWorkerKey(id);
    const known = this.runs.get(entry.runId);
    const before = known?.workers.get(key);
    if (!before && (known?.workers.size ?? 0) >= MAX_LIVE_WORKERS_PER_RUN) {
      return { status: 429, message: `A run has ${MAX_LIVE_WORKERS_PER_RUN} workers in its live view at most.` };
    }
    const run = this.runOf(entry.runId, entry.projectId);
    entry.streamed = true;
    const sink = open();
    const link: WorkerLink = {
      id,
      sink,
      viewers: new Set(),
      paused: before?.paused ?? null,
      rate: new RateWindow(MAX_RELAYED_FPS, this.now),
      logRate: new RateWindow(MAX_RELAYED_CALL_LOGS, this.now),
      told: null,
    };
    run.workers.set(key, link);
    if (before) {
      // The worker opened its stream again: its viewers stay with it.
      for (const viewer of before.viewers) this.attach(viewer, link);
      before.viewers.clear();
      before.sink.close();
    }
    // A new worker in a lane takes it; a worker that opens its stream again keeps the lane only if it still held it.
    const lane = laneOf(id);
    if (lane !== null && (!before || run.lanes.get(lane) === before)) this.takeLane(run, link, lane);
    sink.onClose(() => this.disconnectWorker(entry.runId, key, link));
    // The elements to mask go before anyone watches: the latest a project admin set here, else the route's read.
    const locators = this.projectMasks.get(entry.projectId) ?? masks;
    sink.send({ type: 'masks', locators: [...locators] } satisfies InstanceToWorker);
    this.tell(run, link);
    this.publish(entry.runId, { ...id, connected: true, paused: link.paused });
    return null;
  }

  /** A message a worker of the run posted. */
  receive(runId: number, message: LiveRelayMessage): LiveViewRefusal | null {
    const run = this.runs.get(runId);
    const link = run?.workers.get(liveWorkerKey(message));
    if (!run || !link) return { status: 409, message: 'This worker holds no stream of the run: open it first.' };
    switch (message.type) {
      case 'frame': {
        if (!link.rate.take(1)) return { status: 429, message: `${MAX_RELAYED_FPS} frames a second at most.` };
        if ('refused' in message) {
          this.deliver(run, link, { type: 'refused', ...idOf(link.id), message: message.refused }, 'image');
          return null;
        }
        if (!run.bytes.take(message.image.length)) {
          const most = MAX_LIVE_BYTES_PER_RUN / (1024 * 1024);
          return { status: 429, message: `The workers of a run send ${most} MB of images a second at most.` };
        }
        const counts = this.countsOf(runId);
        counts.frames++;
        counts.bytes += message.image.length;
        const frame: LiveViewerMessage = {
          type: 'frame',
          ...idOf(link.id),
          image: message.image,
          call: message.call,
          test: message.test,
          ...(message.at === undefined ? {} : { at: message.at }),
        };
        this.deliver(run, link, frame, 'image');
        return null;
      }
      case 'call-log':
        if (!link.logRate.take(1)) {
          return { status: 429, message: `${MAX_RELAYED_CALL_LOGS} call logs a second at most.` };
        }
        this.deliver(
          run,
          link,
          { type: 'call-log', ...idOf(link.id), log: message.log, test: message.test },
          'call-log',
        );
        return null;
      case 'stop':
        link.paused = message.stop;
        this.publish(runId, { ...link.id, connected: true, paused: message.stop });
        return null;
      case 'ended':
        this.testEnded(run, link, message.outcome ?? null);
        return null;
      case 'unshared':
        this.endFocus(run, link, 'unshared');
        return null;
    }
  }

  /**
   * Someone's page watches the run on the stream `open` opens, as `ask` says, until it closes; refused, the stream is
   * left unopened. The stream opens with the watch's id (`hello`), which `changeWatch` takes. A full view names a
   * connected worker, or a lane a connected worker holds; tiles need none. `person`, the signed-in user, holds
   * `MAX_LIVE_VIEWERS_PER_PERSON` watches of the run at most: one more replaces their oldest, which hears why it
   * ended.
   */
  openWatch(
    runId: number,
    projectId: number,
    ask: LiveWatchAsk,
    open: () => EventStreamSink,
    person: number | null = null,
  ): LiveViewRefusal | null {
    const known = this.runs.get(runId);
    const target = ask.focus ? this.focusOf(known, ask.focus) : null;
    if (ask.focus && !target) return { status: 404, message: 'This worker is not in the live view of the run.' };
    const all = known ? [...known.viewers.values()] : [];
    const own = person === null ? [] : all.filter((viewer) => viewer.person === person);
    own.sort((a, b) => a.since - b.since);
    const replaced = own.length >= MAX_LIVE_VIEWERS_PER_PERSON ? own[0]! : null;
    if (!replaced && all.length >= MAX_LIVE_VIEWERS_PER_RUN) {
      return { status: 429, message: `${MAX_LIVE_VIEWERS_PER_RUN} pages at most watch one run at a time.` };
    }
    const run = this.runOf(runId, projectId);
    if (replaced) this.endWatch(run, replaced, 'replaced');
    const sink = open();
    const viewer: Viewer = {
      id: randomBytes(16).toString('base64url'),
      sink,
      pending: new Map(),
      person,
      since: this.viewersCame++,
      lane: null,
      link: null,
      tiles: ask.tiles === true,
      size: ask.size ?? DEFAULT_SIZE,
      tilePacers: new Map(),
    };
    run.viewers.set(viewer.id, viewer);
    if (target) {
      viewer.lane = target.lane;
      this.attach(viewer, target.link);
    }
    sink.send({ type: 'hello', watch: viewer.id } satisfies LiveViewerMessage);
    sink.onDrain(() => {
      for (const [type, waiting] of viewer.pending) {
        if (sink.backedUp()) return;
        viewer.pending.delete(type);
        sink.send(waiting);
      }
    });
    // A page that left while the route awaited its checks closes its watch at once, which tells its workers.
    sink.onClose(() => this.closeWatch(runId, viewer));
    if (run.viewers.get(viewer.id) !== viewer) return null;
    if (viewer.tiles) for (const link of run.workers.values()) this.tell(run, link);
    else if (viewer.link) this.tell(run, viewer.link);
    return null;
  }

  /**
   * The page changes what its watch `watchId` of the run shows, as `ask` says: a full view of another worker or lane,
   * or none (`focus: null`), tiles on or off, the full view's size. Refused (404) for a watch of another run or another
   * person, and for a full view of a worker that is not in the live view, the watch then left as it was.
   */
  changeWatch(runId: number, watchId: string, person: number | null, ask: LiveWatchAsk): LiveViewRefusal | null {
    const run = this.runs.get(runId);
    const viewer = run?.viewers.get(watchId);
    if (!run || !viewer || viewer.person !== person) return { status: 404, message: 'No such watch of this run.' };
    const target = ask.focus ? this.focusOf(run, ask.focus) : null;
    if (ask.focus && !target) return { status: 404, message: 'This worker is not in the live view of the run.' };
    const told = new Set<WorkerLink>();
    if (ask.focus !== undefined) {
      const before = viewer.link;
      this.leaveFocus(run, viewer);
      if (before) told.add(before);
      if (target) {
        viewer.lane = target.lane;
        this.attach(viewer, target.link);
        told.add(target.link);
      }
    }
    if (ask.size) {
      viewer.size = ask.size;
      if (viewer.link) told.add(viewer.link);
    }
    if (ask.tiles !== undefined && ask.tiles !== viewer.tiles) {
      viewer.tiles = ask.tiles;
      if (!viewer.tiles) this.closeTiles(viewer);
      for (const link of run.workers.values()) told.add(link);
    }
    for (const link of told) if (run.workers.get(liveWorkerKey(link.id)) === link) this.tell(run, link);
    return null;
  }

  /**
   * Whether the run holds a key that opens its live view, for a run page that opens its stream: one this relay holds,
   * or one the run stores (`stored`) that `restoreKey` would take back as its worker presents it.
   */
  holdsKey(runId: number, stored: StoredLiveViewKeys | null = null): boolean {
    const now = this.now();
    for (const entry of this.keys.values()) if (entry.runId === runId && entry.expiresAt > now) return true;
    return !!stored && storedDigests(stored.digests).length > 0 && stored.createdAt.getTime() + LIVE_KEY_TTL_MS > now;
  }

  /** How many watches of the run are open, whatever they show. */
  viewersOf(runId: number): number {
    return this.runs.get(runId)?.viewers.size ?? 0;
  }

  /** The run's connected workers, for a run page that opens its stream. */
  workersOf(runId: number): LiveWorkerState[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return [...run.workers.values()].map((link) => ({ ...link.id, connected: true, paused: link.paused }));
  }

  /**
   * The project now masks `locators` beside the secret fields: the workers of its live runs hear so, and a worker that
   * connects later gets them, whatever its route read before.
   */
  setMasks(projectId: number, locators: readonly string[]): void {
    this.projectMasks.set(projectId, [...locators]);
    const message: InstanceToWorker = { type: 'masks', locators: [...locators] };
    for (const run of this.runs.values()) {
      if (run.projectId !== projectId) continue;
      for (const worker of run.workers.values()) worker.sink.send(message);
    }
  }

  /** The run's live view ends: its keys open nothing more, its workers' and watches' streams close. */
  endRun(runId: number, reason: LiveViewEnd = 'run-ended'): void {
    const why: LiveKeyEnd = reason === 'off' ? 'off' : 'run-ended';
    for (const [id, entry] of this.keys) if (entry.runId === runId) this.endKey(id, entry, why);
    this.closeRun(runId, reason);
  }

  /**
   * The run was interrupted: its workers' and watches' streams close, and the run page hears each worker left. The
   * keys that opened a stream stay, until the run ends or they expire, so its workers open their streams again if it
   * goes on; the others end.
   */
  interruptRun(runId: number): void {
    for (const [id, entry] of this.keys) {
      if (entry.runId === runId && !entry.streamed) this.endKey(id, entry, 'run-ended');
    }
    this.closeRun(runId, 'run-ended');
  }

  /** The project turned its live view off: every run of it ends its view. Returns those runs. */
  endProject(projectId: number): number[] {
    const runIds = new Set<number>();
    for (const entry of this.keys.values()) if (entry.projectId === projectId) runIds.add(entry.runId);
    for (const [runId, run] of this.runs) if (run.projectId === projectId) runIds.add(runId);
    for (const runId of runIds) this.endRun(runId, 'off');
    return [...runIds];
  }

  /** End the relay's part in each run that ends, as the run's lifecycle says; an interrupted run's keys stay. */
  followRuns(): () => void {
    return runEventBus.subscribeGlobal((event) => {
      if (!RUN_ENDS.has(event.type)) return;
      if (event.type === 'run-finished' && event.status === 'interrupted') this.interruptRun(event.runId);
      else this.endRun(event.runId);
    });
  }

  /** Close the run's workers' and watches' streams, the watches hearing `reason` and the run page each worker leave. */
  private closeRun(runId: number, reason: LiveViewEnd): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    for (const { timer } of run.waiting.values()) clearTimeout(timer);
    run.waiting.clear();
    for (const viewer of [...run.viewers.values()]) this.endWatch(run, viewer, reason);
    for (const link of run.workers.values()) {
      link.sink.close();
      this.publish(runId, { ...link.id, connected: false, paused: null });
    }
  }

  /** A key opens nothing more, remembered with why until it would have expired. */
  private endKey(id: string, entry: KeyEntry, why: LiveKeyEnd): void {
    this.keys.delete(id);
    this.ended.delete(id);
    while (this.ended.size >= MAX_LIVE_KEYS) this.ended.delete(this.ended.keys().next().value!);
    this.ended.set(id, { runId: entry.runId, why, expiresAt: entry.expiresAt });
  }

  /** The keys of a project, oldest first: those that opened a stream or not (`streamed`), or all. */
  private keysOf(projectId: number, streamed: boolean | null = null): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.keys) {
      if (entry.projectId === projectId && (streamed === null || entry.streamed === streamed)) ids.push(id);
    }
    return ids;
  }

  /** Give up the expired keys, of one project or of all (null). */
  private dropExpired(projectId: number | null): void {
    const now = this.now();
    for (const [id, entry] of this.keys) {
      if (entry.expiresAt <= now && (projectId === null || entry.projectId === projectId)) this.keys.delete(id);
    }
  }

  /** The project that holds the most keys that opened a stream or not (`streamed`), or the most keys; null for none. */
  private largestProject(streamed: boolean | null): number | null {
    const counts = new Map<number, number>();
    for (const entry of this.keys.values()) {
      if (streamed === null || entry.streamed === streamed) {
        counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
      }
    }
    let largest: number | null = null;
    let most = 0;
    for (const [projectId, count] of counts) {
      if (count > most) [largest, most] = [projectId, count];
    }
    return largest;
  }

  /**
   * The worker a full view of `focus` shows, and the lane it follows: the lane's worker when it names its lane, else
   * that worker; null when none is in the run's live view.
   */
  private focusOf(run: RunLive | undefined, focus: LiveWorkerId): { link: WorkerLink; lane: string | null } | null {
    const lane = laneOf(focus);
    const link = lane !== null ? run?.lanes.get(lane) : run?.workers.get(liveWorkerKey(focus));
    return link ? { link, lane } : null;
  }

  /** The watch shows `link` in full from now on: its tile of that worker gives way to the full view. */
  private attach(viewer: Viewer, link: WorkerLink): void {
    viewer.link = link;
    link.viewers.add(viewer);
    viewer.tilePacers.get(liveWorkerKey(link.id))?.close();
    viewer.tilePacers.delete(liveWorkerKey(link.id));
  }

  /** The watch shows no worker in full any more, nor waits for a lane's; what it had waiting of it goes nowhere. */
  private leaveFocus(run: RunLive, viewer: Viewer): void {
    viewer.link?.viewers.delete(viewer);
    viewer.link = null;
    viewer.lane = null;
    viewer.pending.clear();
    for (const { viewers } of run.waiting.values()) viewers.delete(viewer);
  }

  /** The watch shows no tile any more: the tiles waiting go nowhere. */
  private closeTiles(viewer: Viewer): void {
    for (const pacer of viewer.tilePacers.values()) pacer.close();
    viewer.tilePacers.clear();
  }

  /**
   * Tell a worker how many watches take its images, as it changes, and before it what they ask of them, as it
   * changes: the largest full view's size and `LIVE_FRAME_FPS`, else a tile's size and pace; what an older reporter
   * ignores.
   */
  private tell(run: RunLive, link: WorkerLink): void {
    let count = link.viewers.size;
    let tiles = false;
    for (const viewer of run.viewers.values()) {
      if (viewer.tiles && !link.viewers.has(viewer)) {
        count++;
        tiles = true;
      }
    }
    const view = { width: 0, height: 0, fps: 0 };
    for (const viewer of link.viewers) {
      view.width = Math.max(view.width, viewer.size.width);
      view.height = Math.max(view.height, viewer.size.height);
      view.fps = LIVE_FRAME_FPS;
    }
    if (tiles) {
      view.width = Math.max(view.width, LIVE_TILE_WIDTH);
      view.height = Math.max(view.height, LIVE_TILE_HEIGHT);
      view.fps = Math.max(view.fps, LIVE_TILE_FPS);
    }
    const asked = view.fps ? view : { ...DEFAULT_SIZE, fps: LIVE_FRAME_FPS };
    const key = `${asked.width}x${asked.height}@${asked.fps}`;
    if (link.told?.view !== key) link.sink.send({ type: 'view', ...asked } satisfies InstanceToWorker);
    if (link.told?.count !== count) link.sink.send({ type: 'viewers', count } satisfies InstanceToWorker);
    link.told = { count, view: key };
  }

  /**
   * Send a message of a worker to the watches that show it: in full, at once (one whose stream is backed up, or still
   * has messages waiting, gets the latest of each kind alone, once it drains, so a newer message never goes before an
   * older one); as a tile, an image or why none shows alone, at a tile's pace.
   */
  private deliver(run: RunLive, link: WorkerLink, message: LiveViewerMessage, kind: 'image' | 'call-log'): void {
    for (const viewer of link.viewers) {
      if (viewer.sink.backedUp() || viewer.pending.size) viewer.pending.set(kind, message);
      else viewer.sink.send(message);
    }
    if (kind !== 'image') return;
    const key = liveWorkerKey(link.id);
    for (const viewer of run.viewers.values()) {
      if (!viewer.tiles || link.viewers.has(viewer)) continue;
      let pacer = viewer.tilePacers.get(key);
      if (!pacer) {
        pacer = new LatestPacer<LiveViewerMessage>({
          intervalMs: 1000 / LIVE_TILE_FPS,
          busy: () => viewer.sink.backedUp(),
          send: (tile) => viewer.sink.send(tile),
        });
        viewer.tilePacers.set(key, pacer);
      }
      pacer.offer(message);
    }
  }

  /** The watch ends, hearing why, and its stream closes; the workers it took images of hear how many are left. */
  private endWatch(run: RunLive, viewer: Viewer, reason: LiveViewEnd): void {
    viewer.sink.send({ type: 'end', reason } satisfies LiveViewerMessage);
    viewer.sink.close();
    this.closeWatch(null, viewer, run);
  }

  /** The watch's stream closed: it leaves the run, and the workers it took images of hear how many are left. */
  private closeWatch(runId: number | null, viewer: Viewer, known?: RunLive): void {
    const run = known ?? (runId === null ? undefined : this.runs.get(runId));
    if (!run || run.viewers.get(viewer.id) !== viewer) return;
    run.viewers.delete(viewer.id);
    const link = viewer.link;
    this.leaveFocus(run, viewer);
    this.closeTiles(viewer);
    if (viewer.tiles) for (const worker of run.workers.values()) this.tell(run, worker);
    else if (link && run.workers.get(liveWorkerKey(link.id)) === link) this.tell(run, link);
    if (runId !== null) this.forgetIfIdle(runId, run);
  }

  /** A run with no worker, no watch and no lane waited for is forgotten. */
  private forgetIfIdle(runId: number, run: RunLive): void {
    if (!run.workers.size && !run.waiting.size && !run.viewers.size && this.runs.get(runId) === run) {
      this.runs.delete(runId);
    }
  }

  /**
   * The worker's test ended (`outcome`, when it says how): the full views of its test alone end, saying so, and those
   * that follow its lane hear how the test ended and stay for the next one.
   */
  private testEnded(run: RunLive, link: WorkerLink, outcome: LiveTestOutcome | null): void {
    if (!link.viewers.size) return;
    const id = idOf(link.id);
    for (const viewer of [...link.viewers]) {
      // What the viewer has waiting is of the test that ended: it goes no later than its end.
      viewer.pending.clear();
      if (viewer.lane !== null) {
        viewer.sink.send({ type: 'test-ended', ...id, outcome } satisfies LiveViewerMessage);
        continue;
      }
      this.leaveFocus(run, viewer);
      viewer.sink.send({ type: 'end', ...id, reason: 'test-ended', ...(outcome ? { outcome } : {}) });
    }
    this.tell(run, link);
  }

  /** The worker's full views end, each hearing `reason`; the watches stay, and the worker hears how many are left. */
  private endFocus(run: RunLive, link: WorkerLink, reason: LiveViewEnd): void {
    if (!link.viewers.size) return;
    for (const viewer of [...link.viewers]) {
      this.leaveFocus(run, viewer);
      viewer.sink.send({ type: 'end', ...idOf(link.id), reason } satisfies LiveViewerMessage);
    }
    this.tell(run, link);
  }

  /**
   * `link` holds the lane `lane` from now on: the watches that follow the lane leave the worker that held it before,
   * and those that waited for it come, the workers hearing how many watch.
   */
  private takeLane(run: RunLive, link: WorkerLink, lane: string): void {
    const before = run.lanes.get(lane);
    run.lanes.set(lane, link);
    if (before && before !== link) {
      for (const viewer of [...before.viewers]) {
        if (viewer.lane !== lane) continue;
        before.viewers.delete(viewer);
        this.attach(viewer, link);
      }
      if (run.workers.get(liveWorkerKey(before.id)) === before) this.tell(run, before);
    }
    const waiting = run.waiting.get(lane);
    if (waiting) {
      clearTimeout(waiting.timer);
      run.waiting.delete(lane);
      for (const viewer of waiting.viewers) this.attach(viewer, link);
    }
  }

  /** The watches waiting for the lane's worker stop waiting: their full view ends with `reason`, the watch stays. */
  private stopWaiting(runId: number, run: RunLive, lane: string, reason: LiveViewEnd): void {
    const waiting = run.waiting.get(lane);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    run.waiting.delete(lane);
    for (const viewer of waiting.viewers) {
      viewer.lane = null;
      viewer.sink.send({ type: 'end', ...idOf(waiting.id), reason } satisfies LiveViewerMessage);
    }
    this.forgetIfIdle(runId, run);
  }

  private disconnectWorker(runId: number, key: string, link: WorkerLink): void {
    const run = this.runs.get(runId);
    if (run?.workers.get(key) !== link) return;
    run.workers.delete(key);
    const id = idOf(link.id);
    // Its tiles waiting go nowhere: the run page hears the worker left.
    for (const viewer of run.viewers.values()) {
      viewer.tilePacers.get(key)?.close();
      viewer.tilePacers.delete(key);
    }
    const lane = laneOf(link.id);
    if (lane !== null && run.lanes.get(lane) === link) {
      run.lanes.delete(lane);
      // The full views that follow the lane wait for the worker Playwright starts in it again.
      const followers = [...link.viewers].filter((viewer) => viewer.lane === lane);
      if (followers.length) {
        for (const viewer of followers) {
          link.viewers.delete(viewer);
          viewer.link = null;
          // What the viewer has waiting is of the worker that left: it goes no later than the wait.
          viewer.pending.clear();
          viewer.sink.send({ type: 'refused', ...id, message: LANE_RESTARTING } satisfies LiveViewerMessage);
        }
        const timer = setTimeout(() => this.stopWaiting(runId, run, lane, 'worker-left'), LANE_WAIT_MS);
        timer.unref?.();
        run.waiting.set(lane, { id, viewers: new Set(followers), timer });
      }
    }
    for (const viewer of [...link.viewers]) {
      this.leaveFocus(run, viewer);
      viewer.sink.send({ type: 'end', ...id, reason: 'worker-left' } satisfies LiveViewerMessage);
    }
    this.publish(runId, { ...link.id, connected: false, paused: null });
    this.forgetIfIdle(runId, run);
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

/** The statuses of a run whose stored key a worker presents again: its workers run tests, or it may go on. */
const KEYED_STATUSES: readonly string[] = ['initializing', 'running', 'interrupted'];

/**
 * Keep the digest of `key`, which `setup` just minted for the run, with the run, beside those of its other shards and
 * `MAX_KEYS_PER_RUN` at most, the latest: never the key itself. The setup of a shard runs under its instance's lock.
 */
export async function storeLiveViewKey(db: DbClient, runId: number, key: string): Promise<void> {
  const [run] = await db.select({ digests: testRuns.liveViewKeyDigests }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return;
  const digests = [...storedDigests(run.digests), digest(key)].slice(-MAX_KEYS_PER_RUN);
  await db.update(testRuns).set({ liveViewKeyDigests: digests }).where(eq(testRuns.id, runId));
}

/**
 * The run's key entry a worker's request opens (`presented`): one the relay holds, else one the run stores, taken
 * back (`restoreKey`) while the run still runs or may go on and its project's live view is on. A key the run stores
 * answers 404 while that setting is off and 410 once the run ended; any other key is refused as `refuseLiveViewKey`
 * says.
 */
export async function authorizeLiveViewKey(db: DbClient, runId: number, presented: string | null): Promise<KeyEntry> {
  const held = liveViewRelay.authorize(runId, presented);
  if (held) return held;
  if (isLiveViewKey(presented)) {
    const [run] = await db
      .select({
        projectId: testRuns.projectId,
        status: testRuns.status,
        createdAt: testRuns.createdAt,
        digests: testRuns.liveViewKeyDigests,
        liveView: projects.liveView,
      })
      .from(testRuns)
      .innerJoin(projects, eq(projects.id, testRuns.projectId))
      .where(eq(testRuns.id, runId));
    if (run && storesKey(run.digests, presented)) {
      if (!run.liveView) throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
      if (!KEYED_STATUSES.includes(run.status))
        throw apiError({ statusCode: 410, message: 'The run is no longer live' });
      const restored = liveViewRelay.restoreKey(runId, run.projectId, presented, run);
      if (restored) return restored;
    }
  }
  return refuseLiveViewKey(runId, presented);
}

/**
 * Refuse a worker's request whose key `authorize` refused: 404 for a key that ended as the project turned its live view
 * off, 410 for one that ended with its run, else 401; so the worker says why its sharing stopped.
 */
export function refuseLiveViewKey(runId: number, presented: string | null): never {
  const why = liveViewRelay.endedWhy(runId, presented);
  if (why === 'off') throw apiError({ statusCode: 404, message: 'The live view is off for this project' });
  if (why === 'run-ended') throw apiError({ statusCode: 410, message: 'The run is no longer live' });
  throw apiError({ statusCode: 401, message: 'A live view key of this run is required' });
}

/** The live view key a request presents: its `Authorization: Bearer` token, when it is one. */
export function liveViewKeyOf(event: H3Event): string | null {
  const header = getRequestHeader(event, 'authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match && isLiveViewKey(match[1]) ? match[1] : null;
}

export const liveViewRelay = new LiveViewRelay();
liveViewRelay.followRuns();
