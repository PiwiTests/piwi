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
  type LiveWorkerId,
  type LiveWorkerPost,
  type WorkerToInstance,
} from '@piwitests/core/live-view';
import { MAX_RESOURCE_BYTES, MAX_SNAPSHOT_BYTES, SNAPSHOTS_PER_SECOND } from '@piwitests/core/live-inspect';
import {
  LANE_LAYERS,
  LANE_TEXTS_PER_SECOND,
  LANE_THUMBS_PER_SECOND,
  MAX_FILMSTRIP,
  MAX_FILMSTRIP_BYTES,
  MAX_PAGE_EVENTS_PER_SECOND,
  type LaneLayer,
} from '@piwitests/core/live-layers';
import { LatestPacer, RateWindow } from '@piwitests/core/run-view';
import type { LiveWorkerState } from '#shared/live-view';
import type { DbClient } from '../database';
import { projects, testRuns } from '../database/schema';
import { apiError } from './api-error';
import type { EventStreamSink } from './event-stream';
import { InspectBudget, MAX_INSPECT_BYTES, RunInspect, SNAPSHOT_MASKED, type HeardSnapshot } from './live-inspect';
import { runEventBus, type GlobalRunEvent } from './run-events';
import { timingSafeEqualStr } from './timing-safe';

/**
 * The run page's live view on this instance: a relay, in memory alone, between the workers of a live run whose project
 * turned it on (a CI run's, or one a developer shares from their machine) and the people watching them. Each worker
 * holds one event stream, opened with a key minted for its run (`mintKey`, handed to the run's global setup), on which
 * it hears how many people watch it, what they ask of its images (`view`: the largest size one of them shows it at,
 * the pace, and whether one shows it in full, `full`, `TELL_MS` apart at most, what changed in between told
 * together; `resend` when a watch that showed it as a tile shows it in full), and which elements its project masks
 * beside the secret fields (`setMasks` tells the open workers each change). A viewer's page holds one watch of the run
 * (`openWatch`), a stream of live messages: the frames of the worker it shows in full (its focus: one worker's test, or
 * the worker of a lane, `liveLaneKey`, which it follows through the lane's next tests and the worker started in it
 * again, waiting `LANE_WAIT_MS` for it, a watch that asks for a lane while it waits included, each test's end told
 * with how it ended, `test-ended`), and while it shows tiles (**Watch all**) each other worker's latest frame,
 * `LIVE_TILE_FPS` a second at most, `MAX_LIVE_TILE_FRAME` bytes at most (a larger one says why in its place). The
 * page changes what its watch shows without opening another (`changeWatch`), by the id the watch's stream said as it
 * opened, `MAX_WATCH_CHANGES_PER_SECOND` times a second at most, and hears what the watch shows then (`LiveWatchShown`),
 * a full view refused included. The frames a worker posts go to its viewers and nowhere else: none is kept, written to
 * the database, logged or exported. A viewer whose stream is backed up, or that was sent `MAX_WATCH_BYTES_PER_SECOND`
 * of images in the last second, gets the latest frame alone once it may, and one whose stream stays backed up
 * `WATCH_STALL_MS` ends. A frame of a worker no watch shows in full, past a tile's pace or size, or that nobody
 * watches, goes nowhere and is not charged to the run. A CI run's worker posts the call its test is in as Playwright
 * logs it (`call-log`), which goes to the watches that show it in full the same way, the latest kept apart from the
 * frame. A watch with **Inspect** open on its full view (`inspect`) has the worker told so (`view`'s `inspect`); the
 * worker then posts the DOM snapshots of its page and the resources they name (`@piwitests/core/live-inspect`), which the
 * run keeps in memory alone, bounded (`RunInspect`, every run's within the instance's `InspectBudget`), each watch with
 * Inspect open hearing of each snapshot of its worker's pages' main frames as it comes, and of those kept as it opens
 * Inspect or follows its lane to another worker, without their JSON: the page is served rendered (`inspectOf`). A
 * worker no watch inspects has its snapshots and resources refused; a worker's go as its test ends, and every one of a
 * run as its project starts masking elements, its watches with Inspect open hearing why, its posts refused while the
 * project masks any. A run that ended takes no watch any more. The worker's stops go to everyone
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
 * person (the oldest replaced), frames, call logs and snapshots a second and bytes of resources a second per worker,
 * bytes of images a second per run and, apart, bytes of snapshots and resources, what Inspect keeps of a run and of
 * every run together, and each message's bytes (the route's).
 */

const MB = 1024 * 1024;

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
/** The most page events relayed of one worker a second: twice what a worker sends. */
export const MAX_RELAYED_PAGE_EVENTS = MAX_PAGE_EVENTS_PER_SECOND * 2;
/** The most texts of the page relayed of one worker a second: as the trace writes them, and as watches ask. */
export const MAX_RELAYED_TEXTS = LANE_TEXTS_PER_SECOND * 4;
/** The most images of a filmstrip relayed of one worker a second: twice what a worker sends. */
export const MAX_RELAYED_THUMBS = LANE_THUMBS_PER_SECOND * 2;
/**
 * The most snapshots of its page, or refusals in their place, a worker posts a second while Inspect is open: twice its
 * pace, as a second the instance counts may straddle two of the worker's.
 */
export const MAX_RELAYED_SNAPSHOTS = SNAPSHOTS_PER_SECOND * 2;
/**
 * The most bytes of resources a worker posts a second while Inspect is open: it posts them back to back as a page names
 * them, a second's wait at most each past its live view's budget, so a few of the largest at most.
 */
export const MAX_RELAYED_RESOURCE_BYTES = 4 * MAX_RESOURCE_BYTES;
/**
 * The most bytes of snapshots and resources the workers of one run post in a second, together, counted apart from
 * their images: a few of the largest snapshots, whatever the frames took.
 */
export const MAX_INSPECT_BYTES_PER_RUN = 4 * MAX_SNAPSHOT_BYTES;
/** The most notices of snapshots a watch's backed up stream holds back: past them, the oldest go. */
const MAX_WAITING_NOTICES = 256;
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
/** The runs that ended remembered, the latest, so a watch opened as one ends is refused. */
const MAX_ENDED_RUNS = 512;
/** The most changes of one watch a second: a further one is refused. */
export const MAX_WATCH_CHANGES_PER_SECOND = 5;
/** The least time between two tellings of what a worker's viewers ask: the changes in between go as one. */
export const TELL_MS = 250;
/** The largest image a tile carries, in bytes: a tile-sized frame is a fraction of it. */
export const MAX_LIVE_TILE_FRAME = 48 * 1024;
/** What a tile says in place of an image larger than a tile carries: someone shows its worker in full, large. */
export const TILE_TOO_LARGE = 'Shown in full elsewhere, at a size too large for a tile: open it to watch.';
/** The most frames a second relayed of a worker no watch shows in full: twice a tile's pace, for the jitter. */
export const MAX_RELAYED_TILE_FPS = LIVE_TILE_FPS * 2;
/** The most bytes of images one watch is sent a second, its full view and its tiles together: the rest waits. */
export const MAX_WATCH_BYTES_PER_SECOND = 1024 * 1024;
/** How long a watch's stream may stay backed up before the watch ends: its page reads no more. */
export const WATCH_STALL_MS = 5000;
/** How soon a watch past its bytes a second tries again to send what waits. */
const BYTES_RETRY_MS = 250;
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
  /** The layers its full view takes beside the images (`calls` aside, which goes with every full view). */
  layers?: LaneLayer[];
  /** Ask the worker shown in full for its page's text now. */
  text?: true;
  /** Whether its full view has Inspect open: the worker shown in full sends its page's snapshots. */
  inspect?: boolean;
}

/** A page's watch of the run: one stream, whatever it shows. */
interface Viewer {
  /** The id its page changes what it shows by: random, said on its own stream alone. */
  id: string;
  sink: EventStreamSink;
  /**
   * The latest message of each kind of its focused worker waiting while its stream is backed up or its bytes a second
   * are spent, so the one never pushes the other out: an image or why none shows (`frame`, `refused`), and a call log.
   */
  pending: Map<PendingKind, LiveViewerMessage>;
  /**
   * The images of its focused worker's filmstrip waiting while its stream is backed up or its bytes a second are spent,
   * oldest first: a strip's worth at most (`MAX_FILMSTRIP` images, `MAX_FILMSTRIP_BYTES`), the oldest going past it.
   */
  thumbs: Array<Extract<LiveViewerMessage, { type: 'thumb' }>>;
  /**
   * The page events of its focused worker's test its backed up stream could not take: how many, of which test, and
   * when the latest happened, said (`dropped`) before the next event that goes, or as the stream drains.
   */
  dropped: { count: number; test: string | null; at: number } | null;
  /** The signed-in person watching, null when the instance knows nobody (authentication off). */
  person: number | null;
  /** When it came, in the order of all viewers. */
  since: number;
  /** What it shows in full, as its page asked it: a worker, or a lane's (with its `slot`); null for none. */
  focus: LiveWorkerId | null;
  /** The lane its full view follows (`liveLaneKey`); null for one worker's test, or no full view. */
  lane: string | null;
  /** The worker it shows in full now: null with no full view, or while it waits for its lane's next worker. */
  link: WorkerLink | null;
  tiles: boolean;
  size: { width: number; height: number };
  /** The layers its full view takes beside the images. */
  layers: ReadonlySet<LaneLayer>;
  /** Whether its full view has Inspect open. */
  inspect: boolean;
  /** The notices of snapshots its backed up stream holds back, oldest first. */
  notices: LiveViewerMessage[];
  /** Each other worker's tile, at its pace, by `liveWorkerKey`: the latest alone waits. */
  tilePacers: Map<string, LatestPacer<LiveViewerMessage>>;
  /** Its page's changes of what it shows in the last second. */
  changes: RateWindow;
  /** The bytes of images it was sent in the last second. */
  bytes: RateWindow;
  /** Ends it once its stream stayed backed up `WATCH_STALL_MS`. */
  stall: ReturnType<typeof setTimeout> | null;
  /** Sends what waits once its bytes a second allow. */
  retry: ReturnType<typeof setTimeout> | null;
}

interface WorkerLink {
  id: LiveWorkerId;
  sink: EventStreamSink;
  /** The watches that show it in full. */
  viewers: Set<Viewer>;
  paused: LiveStop | null;
  rate: RateWindow;
  /** Its frames relayed in the last second while no watch showed it in full. */
  tileRate: RateWindow;
  /** The call logs it posted in the last second. */
  logRate: RateWindow;
  /** Its page events, texts and filmstrip images posted in the last second. */
  eventRate: RateWindow;
  textRate: RateWindow;
  thumbRate: RateWindow;
  /** Its snapshots posted in the last second, and the bytes of its resources. */
  snapshotRate: RateWindow;
  resourceBytes: RateWindow;
  /** How many watch it, and what they ask, as it last heard: each is said again when it changes alone. */
  told: { count: number; view: string } | null;
  /** Tells it how many watch and what they ask, `TELL_MS` apart at most. */
  teller: LatestPacer<true>;
  /** A watch began to show it in full since it was last told. */
  attached: boolean;
}

/** What a full view asked shows: a worker, or the lane's (`lane`), or a lane that waits for its next worker. */
type FocusTarget = { link: WorkerLink; lane: string | null } | { waiting: string };

interface RunLive {
  id: number;
  projectId: number;
  workers: Map<string, WorkerLink>;
  /** The worker that holds each lane now, by `liveLaneKey`. */
  lanes: Map<string, WorkerLink>;
  /**
   * The lanes whose worker left, `LANE_WAIT_MS` each, for one to start in it again: that worker, and the watches that
   * wait for the lane's next.
   */
  waiting: Map<string, { id: LiveWorkerId; viewers: Set<Viewer>; timer: ReturnType<typeof setTimeout> }>;
  /** Every watch of the run, by its id. */
  viewers: Map<string, Viewer>;
  /** The bytes of images its workers posted in the last second. */
  bytes: RateWindow;
  /** The bytes of snapshots and resources its workers posted in the last second. */
  inspectBytes: RateWindow;
  /** What Inspect keeps of the run: made as its first snapshot or resource comes. */
  inspect: RunInspect | null;
  /** The elements its project masks, as the route read them as a worker connected: null for a list it cannot read. */
  masks: readonly string[] | null;
}

/**
 * What a run's workers sent, the posts refused included, and the frames taken whether or not anyone received them:
 * the run page's and the tests' check that nothing went.
 */
export interface LiveViewCounts {
  requests: number;
  frames: number;
  bytes: number;
}

/** The messages of a focused worker a watch keeps the latest of while its stream is backed up. */
type PendingKind = 'image' | 'call-log' | 'text';

/** Why a relay refused. */
export type LiveViewRefusal = { status: 404 | 409 | 410 | 429 | 503; message: string };

/**
 * What a watch shows, as its page hears it after a change: the full view as the page asked it (null for none, or once
 * it ended), its tiles, and the size of its full view, in device pixels.
 */
export interface LiveWatchShown {
  focus: LiveWorkerId | null;
  tiles: boolean;
  width: number;
  height: number;
  layers: LaneLayer[];
  inspect: boolean;
}

/**
 * How a change of a watch went: refused or not, and what the watch shows then. A full view refused leaves the watch
 * showing none, the change's other fields applied, and says what it shows; any other refusal changes nothing and says
 * nothing of it.
 */
export interface LiveWatchChange {
  refused: LiveViewRefusal | null;
  shown: LiveWatchShown | null;
}

/**
 * What a worker posts, as the relay takes it: a frame with its image as bytes, from either form it came in, and what
 * comes as a live message alone: an image of its filmstrip, a snapshot of its page or why none goes, and a resource.
 */
export type LiveRelayMessage = Exclude<WorkerToInstance, { type: 'frame'; data: string }> | LiveWorkerPost;

/** The layers a watch asks, as it keeps them: those a worker posts beside the call log, in `LANE_LAYERS`' order. */
function watchLayers(layers: readonly LaneLayer[] | undefined): ReadonlySet<LaneLayer> {
  return new Set(LANE_LAYERS.filter((layer) => layer !== 'calls' && layers?.includes(layer)));
}

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
  /** The runs that ended, oldest first: none of them takes a watch. */
  private readonly endedRuns = new Set<number>();
  /** How many viewers came so far, which orders them. */
  private viewersCame = 0;
  /** The elements each project masks, as a project admin last set them on this server: null for a list it cannot read. */
  private readonly projectMasks = new Map<number, string[] | null>();

  constructor(
    private readonly publish: (runId: number, state: LiveWorkerState) => void = (runId, state) =>
      runEventBus.publish(runId, { type: 'live-worker', data: state }),
    private readonly now: () => number = Date.now,
    private readonly inspectBudget: InspectBudget = new InspectBudget(),
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
      id: runId,
      projectId,
      workers: new Map(),
      lanes: new Map(),
      waiting: new Map(),
      viewers: new Map(),
      bytes: new RateWindow(MAX_LIVE_BYTES_PER_RUN, this.now),
      inspectBytes: new RateWindow(MAX_INSPECT_BYTES_PER_RUN, this.now),
      inspect: null,
      masks: [],
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
    masks: readonly string[] | null = [],
  ): LiveViewRefusal | null {
    const key = liveWorkerKey(id);
    const known = this.runs.get(entry.runId);
    const before = known?.workers.get(key);
    if (!before && (known?.workers.size ?? 0) >= MAX_LIVE_WORKERS_PER_RUN) {
      return { status: 429, message: `A run has ${MAX_LIVE_WORKERS_PER_RUN} workers in its live view at most.` };
    }
    const run = this.runOf(entry.runId, entry.projectId);
    run.masks = masks === null ? null : [...masks];
    entry.streamed = true;
    const sink = open();
    const link: WorkerLink = {
      id,
      sink,
      viewers: new Set(),
      paused: before?.paused ?? null,
      rate: new RateWindow(MAX_RELAYED_FPS, this.now),
      tileRate: new RateWindow(MAX_RELAYED_TILE_FPS, this.now),
      logRate: new RateWindow(MAX_RELAYED_CALL_LOGS, this.now),
      eventRate: new RateWindow(MAX_RELAYED_PAGE_EVENTS, this.now),
      textRate: new RateWindow(MAX_RELAYED_TEXTS, this.now),
      thumbRate: new RateWindow(MAX_RELAYED_THUMBS, this.now),
      snapshotRate: new RateWindow(MAX_RELAYED_SNAPSHOTS, this.now),
      resourceBytes: new RateWindow(MAX_RELAYED_RESOURCE_BYTES, this.now),
      told: null,
      teller: new LatestPacer<true>({ intervalMs: TELL_MS, send: () => this.tellNow(run, link) }),
      attached: false,
    };
    run.workers.set(key, link);
    if (before) {
      // The worker opened its stream again: its viewers stay with it.
      for (const viewer of before.viewers) this.attach(run, viewer, link);
      before.viewers.clear();
      before.teller.close();
      before.sink.close();
    }
    // A new worker in a lane takes it; a worker that opens its stream again keeps the lane only if it still held it.
    const lane = laneOf(id);
    if (lane !== null && (!before || run.lanes.get(lane) === before)) this.takeLane(run, link, lane);
    sink.onClose(() => this.disconnectWorker(entry.runId, key, link));
    // The elements to mask go before anyone watches: the latest a project admin set here, else the route's read.
    const locators = this.projectMasks.has(entry.projectId) ? this.projectMasks.get(entry.projectId)! : masks;
    sink.send({ type: 'masks', locators: locators === null ? null : [...locators] } satisfies InstanceToWorker);
    this.tell(link);
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
        const counts = this.countsOf(runId);
        // A frame no watch shows in full goes to the tiles alone, at their pace and within their size, or nowhere:
        // either way, what nobody receives is not charged to the run.
        if (!link.viewers.size) {
          const tiled = [...run.viewers.values()].some((viewer) => viewer.tiles);
          const fits = message.image.length <= MAX_LIVE_TILE_FRAME;
          if (!tiled || !fits || !link.tileRate.take(1)) {
            counts.frames++;
            counts.bytes += message.image.length;
            if (tiled && !fits) this.offerTiles(run, link, this.tooLarge(link));
            return null;
          }
        }
        if (!run.bytes.take(message.image.length)) {
          const most = MAX_LIVE_BYTES_PER_RUN / (1024 * 1024);
          return { status: 429, message: `The workers of a run send ${most} MB of images a second at most.` };
        }
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
      case 'page-event':
        if (!link.eventRate.take(1)) {
          return { status: 429, message: `${MAX_RELAYED_PAGE_EVENTS} page events a second at most.` };
        }
        this.deliverLayer(link, 'events', { ...message, ...idOf(link.id) });
        return null;
      case 'text':
        if (!link.textRate.take(1)) return { status: 429, message: `${MAX_RELAYED_TEXTS} texts a second at most.` };
        this.deliverLayer(link, 'text', { ...message, ...idOf(link.id) });
        return null;
      case 'thumb': {
        if (!link.thumbRate.take(1)) {
          return { status: 429, message: `${MAX_RELAYED_THUMBS} images of a filmstrip a second at most.` };
        }
        const asked = [...link.viewers].some((viewer) => viewer.layers.has('filmstrip'));
        if (!asked) return null;
        if (!run.bytes.take(message.image.length)) {
          const most = MAX_LIVE_BYTES_PER_RUN / (1024 * 1024);
          return { status: 429, message: `The workers of a run send ${most} MB of images a second at most.` };
        }
        this.deliverLayer(link, 'filmstrip', { ...message, ...idOf(link.id) });
        return null;
      }
      case 'snapshot':
      case 'resource': {
        if (![...link.viewers].some((viewer) => viewer.inspect)) {
          return { status: 409, message: 'No watch has Inspect open on this worker: it sends no page.' };
        }
        if (message.type === 'snapshot' && !link.snapshotRate.take(1)) {
          return { status: 429, message: `${MAX_RELAYED_SNAPSHOTS} snapshots a second at most.` };
        }
        if ('refused' in message) {
          this.deliverNotice(link, {
            type: 'snapshot',
            ...idOf(link.id),
            refused: message.refused,
            test: message.test,
          });
          return null;
        }
        if (this.masked(run)) return { status: 409, message: SNAPSHOT_MASKED };
        if (message.type === 'resource' && !link.resourceBytes.take(message.data.length)) {
          return { status: 429, message: `${MAX_RELAYED_RESOURCE_BYTES / MB} MB of resources a second at most.` };
        }
        if (!run.inspectBytes.take(message.data.length)) {
          const most = MAX_INSPECT_BYTES_PER_RUN / MB;
          return { status: 429, message: `The workers of a run send ${most} MB of pages a second at most.` };
        }
        run.inspect ??= new RunInspect(this.inspectBudget);
        const added =
          message.type === 'resource'
            ? run.inspect.addResource({ ...message.resource, data: message.data })
            : run.inspect.addSnapshot(liveWorkerKey(link.id), {
                ...message.snapshot,
                data: message.data,
                test: message.test,
              });
        if (added === 'full') {
          const most = MAX_INSPECT_BYTES / MB;
          return {
            status: 503,
            message: `This instance keeps ${most} MB of live runs’ pages at most: more as runs end.`,
          };
        }
        if (added === 'kept' && message.type === 'snapshot') {
          this.deliverNotice(link, this.notice(link, { ...message.snapshot, test: message.test }));
        }
        return null;
      }
    }
  }

  /**
   * What Inspect keeps of the run, for the page of a watch (`watchId`) of `person` with Inspect open to read; refused
   * (404) for a watch of another run or another person, one without Inspect open (409), or a run that ended (410).
   */
  inspectOf(runId: number, watchId: string, person: number | null): RunInspect | LiveViewRefusal {
    if (this.endedRuns.has(runId)) return { status: 410, message: 'The run is no longer live.' };
    const run = this.runs.get(runId);
    const viewer = run?.viewers.get(watchId);
    if (!run || !viewer || viewer.person !== person) return { status: 404, message: 'No such watch of this run.' };
    if (!viewer.inspect) return { status: 409, message: 'This watch has no Inspect open: open it first.' };
    if (this.masked(run)) return { status: 410, message: SNAPSHOT_MASKED };
    run.inspect ??= new RunInspect(this.inspectBudget);
    return run.inspect;
  }

  /**
   * Whether the run's project masks elements, as a project admin last set them here, else as the route read them: a
   * list that cannot be read masks everything.
   */
  private masked(run: RunLive): boolean {
    const masks = this.projectMasks.has(run.projectId) ? this.projectMasks.get(run.projectId)! : run.masks;
    return masks === null || masks.length > 0;
  }

  /** What a watch hears of a snapshot of `link`'s page: its header, but the resources it names. */
  private notice(link: WorkerLink, snapshot: HeardSnapshot): LiveViewerMessage {
    const { call, title, phase, page, frame, main, full, index, at, test } = snapshot;
    return { type: 'snapshot', ...idOf(link.id), call, title, phase, page, frame, main, full, index, at, test };
  }

  /** Tell each watch with Inspect open of `link` in full of a snapshot of its page, or why none goes. */
  private deliverNotice(link: WorkerLink, message: LiveViewerMessage): void {
    for (const viewer of link.viewers) if (viewer.inspect) this.sendNotice(viewer, message);
  }

  /**
   * Tell a watch that opens Inspect on `link`, or comes to it with Inspect open, of the snapshots the run keeps of
   * `link`'s pages, in the order they came.
   */
  private tellKept(run: RunLive, viewer: Viewer, link: WorkerLink): void {
    if (!viewer.inspect || !run.inspect) return;
    for (const snapshot of run.inspect.heard(liveWorkerKey(link.id)))
      this.sendNotice(viewer, this.notice(link, snapshot));
  }

  /**
   * Send a notice of a snapshot at once, or, while the watch's stream is backed up or others wait, after them:
   * `MAX_WAITING_NOTICES` wait at most, the oldest going past them.
   */
  private sendNotice(viewer: Viewer, message: LiveViewerMessage): void {
    if (!viewer.notices.length && !this.backedUp(viewer)) return this.send(viewer, message);
    viewer.notices.push(message);
    if (viewer.notices.length > MAX_WAITING_NOTICES) viewer.notices.shift();
    this.flushSoon(viewer);
  }

  /**
   * Someone's page watches the run on the stream `open` opens, as `ask` says, until it closes; refused, the stream is
   * left unopened. The stream opens with the watch's id (`hello`), which `changeWatch` takes. A full view names a
   * connected worker, or a lane a connected worker holds or that waits for its next one; tiles need none. `person`,
   * the signed-in user, holds `MAX_LIVE_VIEWERS_PER_PERSON` watches of the run at most: one more replaces their oldest,
   * which hears why it ended. A run that ended takes none (410), as it ends while its route opened the watch.
   */
  openWatch(
    runId: number,
    projectId: number,
    ask: LiveWatchAsk,
    open: () => EventStreamSink,
    person: number | null = null,
  ): LiveViewRefusal | null {
    if (this.endedRuns.has(runId)) return { status: 410, message: 'The run is no longer live.' };
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
      thumbs: [],
      dropped: null,
      person,
      since: this.viewersCame++,
      focus: null,
      lane: null,
      link: null,
      tiles: ask.tiles === true,
      size: ask.size ?? DEFAULT_SIZE,
      layers: watchLayers(ask.layers),
      inspect: ask.inspect === true,
      notices: [],
      tilePacers: new Map(),
      changes: new RateWindow(MAX_WATCH_CHANGES_PER_SECOND, this.now),
      bytes: new RateWindow(MAX_WATCH_BYTES_PER_SECOND, this.now),
      stall: null,
      retry: null,
    };
    run.viewers.set(viewer.id, viewer);
    this.send(viewer, { type: 'hello', watch: viewer.id });
    if (ask.focus && target) this.focusOn(run, viewer, ask.focus, target);
    sink.onDrain(() => {
      if (!sink.backedUp() && viewer.stall) {
        clearTimeout(viewer.stall);
        viewer.stall = null;
      }
      this.flush(viewer);
    });
    // A page that left while the route awaited its checks closes its watch at once, which tells its workers.
    sink.onClose(() => this.closeWatch(runId, viewer));
    if (run.viewers.get(viewer.id) !== viewer) return null;
    if (viewer.tiles) for (const link of run.workers.values()) this.tell(link);
    else if (viewer.link) this.tell(viewer.link);
    return null;
  }

  /**
   * The page changes what its watch `watchId` of the run shows, as `ask` says: a full view of another worker or lane,
   * or none (`focus: null`), tiles on or off, the full view's size; and hears what the watch shows then. Refused (404)
   * for a watch of another run or another person, and past `MAX_WATCH_CHANGES_PER_SECOND` (429), the watch then left
   * as it was; a full view of a worker that is not in the live view, nor of a lane that waits for its next worker, is
   * refused (404) with the change's other fields applied and no full view shown.
   */
  changeWatch(runId: number, watchId: string, person: number | null, ask: LiveWatchAsk): LiveWatchChange {
    const run = this.runs.get(runId);
    const viewer = run?.viewers.get(watchId);
    if (!run || !viewer || viewer.person !== person) {
      return { refused: { status: 404, message: 'No such watch of this run.' }, shown: null };
    }
    if (!viewer.changes.take(1)) {
      const message = `A watch changes what it shows ${MAX_WATCH_CHANGES_PER_SECOND} times a second at most.`;
      return { refused: { status: 429, message }, shown: null };
    }
    let refused: LiveViewRefusal | null = null;
    const told = new Set<WorkerLink>();
    if (ask.focus !== undefined) {
      const target = ask.focus ? this.focusOf(run, ask.focus) : null;
      const before = viewer.link;
      this.leaveFocus(run, viewer);
      if (before) told.add(before);
      if (ask.focus && target) {
        this.focusOn(run, viewer, ask.focus, target);
        if ('link' in target) told.add(target.link);
      } else if (ask.focus) {
        refused = { status: 404, message: 'This worker is not in the live view of the run.' };
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
    if (ask.layers) {
      const before = viewer.layers;
      viewer.layers = watchLayers(ask.layers);
      // What waits of a layer the watch no longer takes goes nowhere.
      if (!viewer.layers.has('text')) viewer.pending.delete('text');
      if (!viewer.layers.has('filmstrip')) viewer.thumbs = [];
      if (!viewer.layers.has('events')) viewer.dropped = null;
      if (viewer.link) {
        told.add(viewer.link);
        // The filmstrip this watch did not take: the worker sends the strip it kept again.
        if (viewer.layers.has('filmstrip') && !before.has('filmstrip')) viewer.link.attached = true;
      }
    }
    if (ask.inspect !== undefined && ask.inspect !== viewer.inspect) {
      viewer.inspect = ask.inspect;
      if (!viewer.inspect) viewer.notices = [];
      if (viewer.link) {
        told.add(viewer.link);
        this.tellKept(run, viewer, viewer.link);
      }
    }
    for (const link of told) if (run.workers.get(liveWorkerKey(link.id)) === link) this.tell(link);
    // The text asked now: the worker shown in full takes its page's text, the full views that take text hear it.
    if (ask.text && viewer.link && viewer.layers.has('text')) {
      viewer.link.sink.send({ type: 'text' } satisfies InstanceToWorker);
    }
    const { width, height } = viewer.size;
    const layers = [...viewer.layers];
    return {
      refused,
      shown: { focus: viewer.focus, tiles: viewer.tiles, width, height, layers, inspect: viewer.inspect },
    };
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
   * The project now masks `locators` beside the secret fields (null for a stored list this server cannot read, which
   * masks everything: the workers send no image then): the workers of its live runs hear so, and a worker
   * that connects later gets them, whatever its route read before. With any, or null, what Inspect kept of its runs,
   * taken without them, goes, and the watches with Inspect open hear why in its place.
   */
  setMasks(projectId: number, locators: readonly string[] | null): void {
    this.projectMasks.set(projectId, locators === null ? null : [...locators]);
    const message: InstanceToWorker = { type: 'masks', locators: locators === null ? null : [...locators] };
    for (const run of this.runs.values()) {
      if (run.projectId !== projectId) continue;
      for (const worker of run.workers.values()) worker.sink.send(message);
      if (locators !== null && !locators.length) continue;
      run.inspect?.mask();
      for (const viewer of run.viewers.values()) viewer.notices = [];
      for (const link of run.workers.values()) {
        this.deliverNotice(link, { type: 'snapshot', ...idOf(link.id), refused: SNAPSHOT_MASKED, test: null });
      }
    }
  }

  /**
   * The run's live view ends: its keys open nothing more, its workers' and watches' streams close. A run that ended
   * (not one whose project turned its live view off, which may turn it on again) takes no watch any more.
   */
  endRun(runId: number, reason: LiveViewEnd = 'run-ended'): void {
    const why: LiveKeyEnd = reason === 'off' ? 'off' : 'run-ended';
    for (const [id, entry] of this.keys) if (entry.runId === runId) this.endKey(id, entry, why);
    if (why === 'run-ended') {
      this.endedRuns.delete(runId);
      while (this.endedRuns.size >= MAX_ENDED_RUNS) this.endedRuns.delete(this.endedRuns.values().next().value!);
      this.endedRuns.add(runId);
    }
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
    run.inspect?.clear();
    for (const { timer } of run.waiting.values()) clearTimeout(timer);
    run.waiting.clear();
    for (const viewer of [...run.viewers.values()]) this.endWatch(run, viewer, reason);
    for (const link of run.workers.values()) {
      link.teller.close();
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
   * What a full view of `focus` shows, and the lane it follows: the lane's worker when it names its lane, or the lane
   * itself while it waits for its next worker, else that worker; null when none is in the run's live view.
   */
  private focusOf(run: RunLive | undefined, focus: LiveWorkerId): FocusTarget | null {
    const lane = laneOf(focus);
    const link = lane !== null ? run?.lanes.get(lane) : run?.workers.get(liveWorkerKey(focus));
    if (link) return { link, lane };
    return lane !== null && run?.waiting.has(lane) ? { waiting: lane } : null;
  }

  /**
   * The watch shows `focus` in full from now on (`target`): its worker, or the lane's next worker, which it waits for
   * as the lane's followers do, hearing why no image shows meanwhile.
   */
  private focusOn(run: RunLive, viewer: Viewer, focus: LiveWorkerId, target: FocusTarget): void {
    viewer.focus = idOf(focus);
    if ('link' in target) {
      viewer.lane = target.lane;
      this.attach(run, viewer, target.link);
      return;
    }
    const waiting = run.waiting.get(target.waiting)!;
    viewer.lane = target.waiting;
    waiting.viewers.add(viewer);
    this.send(viewer, { type: 'refused', ...waiting.id, message: LANE_RESTARTING });
  }

  /**
   * The watch shows `link` in full from now on: its tile of that worker gives way to the full view, and with Inspect
   * open it hears of the snapshots the run keeps of the worker's pages.
   */
  private attach(run: RunLive, viewer: Viewer, link: WorkerLink): void {
    viewer.link = link;
    link.viewers.add(viewer);
    link.attached = true;
    viewer.tilePacers.get(liveWorkerKey(link.id))?.close();
    viewer.tilePacers.delete(liveWorkerKey(link.id));
    this.tellKept(run, viewer, link);
  }

  /** The watch shows no worker in full any more, nor waits for a lane's; what it had waiting of it goes nowhere. */
  private leaveFocus(run: RunLive, viewer: Viewer): void {
    viewer.link?.viewers.delete(viewer);
    viewer.link = null;
    viewer.lane = null;
    viewer.focus = null;
    this.dropWaiting(viewer);
    viewer.dropped = null;
    for (const { viewers } of run.waiting.values()) viewers.delete(viewer);
  }

  /**
   * What waits for the watch of its focused worker goes nowhere: its latest image, call log and text, and its
   * filmstrip's images.
   */
  private dropWaiting(viewer: Viewer): void {
    viewer.pending.clear();
    viewer.thumbs = [];
    viewer.notices = [];
  }

  /** The watch shows no tile any more: the tiles waiting go nowhere. */
  private closeTiles(viewer: Viewer): void {
    for (const pacer of viewer.tilePacers.values()) pacer.close();
    viewer.tilePacers.clear();
  }

  /** Tell a worker how many watches take its images and what they ask, at once or `TELL_MS` after it was last told. */
  private tell(link: WorkerLink): void {
    link.teller.offer(true);
  }

  /**
   * Tell a worker how many watches take its images, as it changes, and before it what they ask of them, as it
   * changes: the largest full view's size, `LIVE_FRAME_FPS` and `full`, else a tile's size and pace; what an older
   * reporter ignores. A worker a further watch shows in full, the count the same, is asked for its latest image and
   * call log again (`resend`). Nothing for a worker that left, or of a run that ended.
   */
  private tellNow(run: RunLive, link: WorkerLink): void {
    if (this.runs.get(run.id) !== run || run.workers.get(liveWorkerKey(link.id)) !== link) return;
    let count = link.viewers.size;
    let tiles = false;
    for (const viewer of run.viewers.values()) {
      if (viewer.tiles && !link.viewers.has(viewer)) {
        count++;
        tiles = true;
      }
    }
    const view = { width: 0, height: 0, fps: 0 };
    const layers = new Set<LaneLayer>();
    let inspect = false;
    for (const viewer of link.viewers) {
      view.width = Math.max(view.width, viewer.size.width);
      view.height = Math.max(view.height, viewer.size.height);
      view.fps = LIVE_FRAME_FPS;
      for (const layer of viewer.layers) layers.add(layer);
      if (viewer.inspect) inspect = true;
    }
    if (tiles) {
      view.width = Math.max(view.width, LIVE_TILE_WIDTH);
      view.height = Math.max(view.height, LIVE_TILE_HEIGHT);
      view.fps = Math.max(view.fps, LIVE_TILE_FPS);
    }
    const full = link.viewers.size > 0;
    const listed = LANE_LAYERS.filter((layer) => layers.has(layer));
    const asked = view.fps
      ? { ...view, full, layers: listed, inspect }
      : { ...DEFAULT_SIZE, fps: LIVE_FRAME_FPS, full, layers: listed, inspect };
    const key = `${asked.width}x${asked.height}@${asked.fps}${full ? ' full' : ''} ${listed.join(',')}${inspect ? ' inspect' : ''}`;
    const resend = link.attached && full && link.told !== null && count <= link.told.count;
    link.attached = false;
    if (link.told?.view !== key) link.sink.send({ type: 'view', ...asked } satisfies InstanceToWorker);
    if (link.told?.count !== count) link.sink.send({ type: 'viewers', count } satisfies InstanceToWorker);
    if (resend) link.sink.send({ type: 'resend' } satisfies InstanceToWorker);
    link.told = { count, view: key };
  }

  /**
   * Send a layer of a worker to the watches that show it in full and asked for that layer: the page's text as the
   * latest of its kind while a stream is backed up; a page event at once, whatever waits, or, while the stream is
   * backed up, counted and said (`sendEvent`); a filmstrip image at once, or in its turn once the stream and the
   * watch's bytes a second allow (`offerThumb`).
   */
  private deliverLayer(link: WorkerLink, layer: LaneLayer, message: LiveViewerMessage): void {
    for (const viewer of link.viewers) {
      if (!viewer.layers.has(layer)) continue;
      if (message.type === 'page-event') this.sendEvent(viewer, message);
      else if (message.type === 'thumb') this.offerThumb(viewer, message);
      else this.offer(viewer, 'text', message);
    }
  }

  /**
   * Send a page event at once, whatever waits; while the stream is backed up it goes nowhere, counted, and the count
   * of its test goes before the next event that goes.
   */
  private sendEvent(viewer: Viewer, message: Extract<LiveViewerMessage, { type: 'page-event' }>): void {
    if (this.backedUp(viewer)) {
      const same = viewer.dropped?.test === message.test;
      viewer.dropped = { count: (same ? viewer.dropped!.count : 0) + 1, test: message.test, at: message.at };
      return;
    }
    this.sayDropped(viewer);
    this.send(viewer, message);
  }

  /** Tell the watch how many page events it could not take, once its stream takes it. */
  private sayDropped(viewer: Viewer): void {
    const dropped = viewer.dropped;
    if (!dropped || !viewer.link || this.backedUp(viewer)) return;
    viewer.dropped = null;
    const event = { kind: 'dropped' as const, count: dropped.count };
    this.send(viewer, { type: 'page-event', ...idOf(viewer.link.id), event, at: dropped.at, test: dropped.test });
  }

  /** Send an image of the filmstrip at once, or after those waiting, as the stream and the bytes a second allow. */
  private offerThumb(viewer: Viewer, message: Extract<LiveViewerMessage, { type: 'thumb' }>): void {
    if (!viewer.thumbs.length && !this.backedUp(viewer) && this.affords(viewer, message)) {
      return this.send(viewer, message);
    }
    viewer.thumbs.push(message);
    let bytes = viewer.thumbs.reduce((sum, thumb) => sum + thumb.image.length, 0);
    while (viewer.thumbs.length > MAX_FILMSTRIP || bytes > MAX_FILMSTRIP_BYTES) {
      bytes -= viewer.thumbs.shift()!.image.length;
    }
    this.flushSoon(viewer);
  }

  /**
   * Send a message of a worker to the watches that show it: in full, at once (`offer`); as a tile, an image within
   * `MAX_LIVE_TILE_FRAME` bytes, else why none shows, at a tile's pace.
   */
  private deliver(run: RunLive, link: WorkerLink, message: LiveViewerMessage, kind: 'image' | 'call-log'): void {
    for (const viewer of link.viewers) this.offer(viewer, kind, message);
    if (kind !== 'image') return;
    const fits = message.type !== 'frame' || message.image.length <= MAX_LIVE_TILE_FRAME;
    this.offerTiles(run, link, fits ? message : this.tooLarge(link));
  }

  /** What a tile of `link` shows in place of an image larger than a tile carries. */
  private tooLarge(link: WorkerLink): LiveViewerMessage {
    return { type: 'refused', ...idOf(link.id), message: TILE_TOO_LARGE };
  }

  /** Offer `tile` to every watch that shows `link` as a tile, each at a tile's pace, the latest alone waiting. */
  private offerTiles(run: RunLive, link: WorkerLink, tile: LiveViewerMessage): void {
    const key = liveWorkerKey(link.id);
    for (const viewer of run.viewers.values()) {
      if (!viewer.tiles || link.viewers.has(viewer)) continue;
      let pacer = viewer.tilePacers.get(key);
      if (!pacer) {
        const paced: LatestPacer<LiveViewerMessage> = new LatestPacer<LiveViewerMessage>({
          intervalMs: 1000 / LIVE_TILE_FPS,
          busy: () => this.backedUp(viewer),
          send: (next) => {
            // Past the watch's bytes a second, the tile waits its next turn, unless a newer one takes its place.
            if (this.affords(viewer, next)) this.send(viewer, next);
            else paced.offer(next);
          },
        });
        pacer = paced;
        viewer.tilePacers.set(key, pacer);
      }
      pacer.offer(tile);
    }
  }

  /**
   * Send a message of the worker the watch shows in full: at once, or, while its stream is backed up, its bytes a
   * second are spent or older messages still wait, the latest of each kind alone once it may, so a newer message
   * never goes before an older one.
   */
  private offer(viewer: Viewer, kind: PendingKind, message: LiveViewerMessage): void {
    if (!viewer.pending.size && !this.backedUp(viewer) && this.affords(viewer, message)) {
      return this.send(viewer, message);
    }
    viewer.pending.set(kind, message);
    this.flushSoon(viewer);
  }

  /**
   * Send what waits for the watch while its stream takes it and its bytes a second allow: the latest of each kind,
   * oldest first, then the filmstrip's images in their order, then the notices of snapshots in theirs, then how many
   * page events it could not take.
   */
  private flush(viewer: Viewer): void {
    for (const [kind, waiting] of viewer.pending) {
      if (this.backedUp(viewer)) return;
      if (!this.affords(viewer, waiting)) return this.flushSoon(viewer);
      viewer.pending.delete(kind);
      this.send(viewer, waiting);
    }
    while (viewer.thumbs.length) {
      if (this.backedUp(viewer)) return;
      if (!this.affords(viewer, viewer.thumbs[0]!)) return this.flushSoon(viewer);
      this.send(viewer, viewer.thumbs.shift()!);
    }
    while (viewer.notices.length) {
      if (this.backedUp(viewer)) return;
      this.send(viewer, viewer.notices.shift()!);
    }
    this.sayDropped(viewer);
  }

  /** Try again soon to send what waits for the watch past its bytes a second; a backed up stream's drain does it. */
  private flushSoon(viewer: Viewer): void {
    if (viewer.retry || viewer.sink.backedUp()) return;
    viewer.retry = setTimeout(() => {
      viewer.retry = null;
      this.flush(viewer);
    }, BYTES_RETRY_MS);
    viewer.retry.unref?.();
  }

  /** Whether the watch may be sent `message` within its bytes a second, which it then spends: an image's bytes. */
  private affords(viewer: Viewer, message: LiveViewerMessage): boolean {
    return (message.type !== 'frame' && message.type !== 'thumb') || viewer.bytes.take(message.image.length);
  }

  /** Send the watch a message, the stream then watched for staying backed up. */
  private send(viewer: Viewer, message: LiveViewerMessage): void {
    viewer.sink.send(message);
    this.backedUp(viewer);
  }

  /**
   * Whether the watch's stream is backed up: while it stays so `WATCH_STALL_MS`, its page reads nothing, and its stream
   * closes, which ends the watch; the page opens another.
   */
  private backedUp(viewer: Viewer): boolean {
    if (!viewer.sink.backedUp()) return false;
    if (!viewer.stall) {
      viewer.stall = setTimeout(() => {
        viewer.stall = null;
        if (viewer.sink.backedUp()) viewer.sink.close();
      }, WATCH_STALL_MS);
      viewer.stall.unref?.();
    }
    return true;
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
    if (viewer.stall) clearTimeout(viewer.stall);
    if (viewer.retry) clearTimeout(viewer.retry);
    viewer.stall = null;
    viewer.retry = null;
    const link = viewer.link;
    this.leaveFocus(run, viewer);
    this.closeTiles(viewer);
    if (viewer.tiles) for (const worker of run.workers.values()) this.tell(worker);
    else if (link && run.workers.get(liveWorkerKey(link.id)) === link) this.tell(link);
    if (runId !== null) this.forgetIfIdle(runId, run);
  }

  /** A run with no worker, no watch and no lane waited for is forgotten. */
  private forgetIfIdle(runId: number, run: RunLive): void {
    if (!run.workers.size && !run.waiting.size && !run.viewers.size && this.runs.get(runId) === run) {
      this.runs.delete(runId);
      run.inspect?.clear();
    }
  }

  /**
   * The worker's test ended (`outcome`, when it says how): the full views of its test alone end, saying so, and those
   * that follow its lane hear how the test ended and stay for the next one.
   */
  private testEnded(run: RunLive, link: WorkerLink, outcome: LiveTestOutcome | null): void {
    // The test's pages go with it: the worker's next test's alone are kept, and told a watch that opens Inspect.
    run.inspect?.endTest(liveWorkerKey(link.id));
    if (!link.viewers.size) return;
    const id = idOf(link.id);
    for (const viewer of [...link.viewers]) {
      // What the viewer has waiting is of the test that ended: it goes no later than its end. How many page events it
      // could not take is said before it, or once its stream takes it.
      this.dropWaiting(viewer);
      this.sayDropped(viewer);
      if (viewer.lane !== null) {
        this.send(viewer, { type: 'test-ended', ...id, outcome } satisfies LiveViewerMessage);
        continue;
      }
      this.leaveFocus(run, viewer);
      this.send(viewer, { type: 'end', ...id, reason: 'test-ended', ...(outcome ? { outcome } : {}) });
    }
    this.tell(link);
  }

  /** The worker's full views end, each hearing `reason`; the watches stay, and the worker hears how many are left. */
  private endFocus(run: RunLive, link: WorkerLink, reason: LiveViewEnd): void {
    if (!link.viewers.size) return;
    for (const viewer of [...link.viewers]) {
      this.leaveFocus(run, viewer);
      this.send(viewer, { type: 'end', ...idOf(link.id), reason } satisfies LiveViewerMessage);
    }
    this.tell(link);
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
        this.attach(run, viewer, link);
      }
      if (run.workers.get(liveWorkerKey(before.id)) === before) this.tell(before);
    }
    const waiting = run.waiting.get(lane);
    if (waiting) {
      clearTimeout(waiting.timer);
      run.waiting.delete(lane);
      for (const viewer of waiting.viewers) this.attach(run, viewer, link);
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
      viewer.focus = null;
      this.send(viewer, { type: 'end', ...idOf(waiting.id), reason } satisfies LiveViewerMessage);
    }
    this.forgetIfIdle(runId, run);
  }

  private disconnectWorker(runId: number, key: string, link: WorkerLink): void {
    const run = this.runs.get(runId);
    if (run?.workers.get(key) !== link) return;
    run.workers.delete(key);
    link.teller.close();
    const id = idOf(link.id);
    // Its tiles waiting go nowhere: the run page hears the worker left.
    for (const viewer of run.viewers.values()) {
      viewer.tilePacers.get(key)?.close();
      viewer.tilePacers.delete(key);
    }
    const lane = laneOf(link.id);
    if (lane !== null && run.lanes.get(lane) === link) {
      run.lanes.delete(lane);
      // The full views that follow the lane, and those that ask for it meanwhile, wait for the worker Playwright
      // starts in it again.
      const followers = [...link.viewers].filter((viewer) => viewer.lane === lane);
      for (const viewer of followers) {
        link.viewers.delete(viewer);
        viewer.link = null;
        // What the viewer has waiting is of the worker that left: it goes no later than the wait.
        this.dropWaiting(viewer);
        viewer.dropped = null;
        this.send(viewer, { type: 'refused', ...id, message: LANE_RESTARTING } satisfies LiveViewerMessage);
      }
      const timer = setTimeout(() => this.stopWaiting(runId, run, lane, 'worker-left'), LANE_WAIT_MS);
      timer.unref?.();
      run.waiting.set(lane, { id, viewers: new Set(followers), timer });
    }
    for (const viewer of [...link.viewers]) {
      this.leaveFocus(run, viewer);
      this.send(viewer, { type: 'end', ...id, reason: 'worker-left' } satisfies LiveViewerMessage);
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
