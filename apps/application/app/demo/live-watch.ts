/**
 * The demo's watch of a run, the counterpart of `LiveWatch` (`app/utils/live-watch.ts`) for the run page in the demo,
 * whose simulated workers run no browser. They publish what they say to a view of them over the demo's event channel
 * (`publishDemoLiveMessage`, `app/demo/live-calls.ts`): the call each test is in, the pages Inspect shows, how each test
 * ended. This page keeps what each worker said last, as the instance keeps it for a view that opens later
 * (`hearDemoEvent`, from the moment `listenToDemoWorkers` is called): its latest call log, and the pages of its running
 * test and why none comes, each read as a watch reads its stream (`readLiveViewerMessage`) and let go as its test ends.
 * A watch opens at once, as soon as something is wanted: the worker it shows in full is told it sends no image (its
 * `refused`), then hears its worker's latest call log, and, with Inspect open, its pages, then each message of that
 * worker as it comes; its page's text is refused. The run's end ends the watch (`run-ended`), and a watch of a run that
 * ended closes as it opens. Nothing reaches the workers: what a view asks changes only what it hears.
 */
import {
  liveLaneKey,
  liveWorkerKey,
  readLiveViewerMessage,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import type { Lane } from '#shared/live-lanes';
import type { LiveWorkerState } from '#shared/live-view';
import { MAX_HEARD_SNAPSHOTS } from '~/utils/live-inspect';
import { sameWorker, type LiveWatchAsk, type LiveWatchConnection, type LiveWatchEvents } from '~/utils/live-watch';
import { DEMO_NO_IMAGE, DEMO_NO_TEXT } from './live-calls';
import { subscribeDemoEvents, type DemoEventMessage, type DemoGlobalEvent } from './run-events';

type CallLogMessage = Extract<LiveViewerMessage, { type: 'call-log' }>;
type SnapshotMessage = Extract<LiveViewerMessage, { type: 'snapshot' }>;

/** What a worker said last, kept for a view that opens later. */
interface KeptWorker {
  /** The test it runs, as its last message named it. */
  test: string | null;
  /** The call its test is in, as it last logged it. */
  log: CallLogMessage | null;
  /** The pages of its test for Inspect, and why none comes, in the order they came. */
  inspect: SnapshotMessage[];
}

/** The most runs whose workers this page keeps: past them, the oldest go. */
const MAX_KEPT_RUNS = 8;
/** Each run's workers, by lane (`liveLaneKey`), or by worker for one that names none. */
const kept = new Map<number, Map<string, KeptWorker>>();
/** The runs this page heard end, the latest last: a run that ended takes no watch, nor keeps what it hears. */
const endedRuns = new Set<number>();
/** The open watches, each hearing every message the page reads, of every run. */
const watches = new Set<(runId: number, message: LiveViewerMessage) => void>();
let listening = false;
/** What ends a run's live view, as the instance's relay reads the run's events (`RUN_ENDS`, `server/utils/live-view.ts`). */
const DEMO_RUN_ENDS: ReadonlySet<DemoGlobalEvent['type']> = new Set([
  'run-finalizing',
  'run-finished',
  'run-cancelled',
  'run-submitted',
]);

/** Where a worker's messages are kept: its lane, which a worker started again in it takes over, else the worker. */
function keptKey(id: LiveWorkerId): string {
  return id.slot === undefined ? liveWorkerKey(id) : liveLaneKey({ shard: id.shard, slot: id.slot });
}

function idOf(message: LiveWorkerId): LiveWorkerId {
  return {
    shard: message.shard,
    worker: message.worker,
    ...(message.slot === undefined ? {} : { slot: message.slot }),
  };
}

/** What the page keeps of `runId`'s workers, made as it first hears of the run. */
function keptRun(runId: number): Map<string, KeptWorker> {
  let run = kept.get(runId);
  if (!run) {
    run = new Map();
    kept.set(runId, run);
    for (const old of kept.keys()) {
      if (kept.size <= MAX_KEPT_RUNS) break;
      kept.delete(old);
    }
  }
  return run;
}

/** Keep what a worker said: a message of another test starts its record afresh, and its test's end lets it go. */
function keep(runId: number, message: LiveViewerMessage): void {
  if (message.type !== 'call-log' && message.type !== 'snapshot' && message.type !== 'test-ended') return;
  const run = keptRun(runId);
  const key = keptKey(message);
  const test = message.type === 'test-ended' ? (message.outcome?.test ?? null) : message.test;
  let worker = run.get(key);
  if (!worker || (test !== null && test !== worker.test)) {
    worker = { test, log: null, inspect: [] };
    run.set(key, worker);
  }
  if (message.type === 'call-log') worker.log = message;
  else if (message.type === 'snapshot') worker.inspect = [...worker.inspect, message].slice(-MAX_HEARD_SNAPSHOTS);
  else run.delete(key);
}

/**
 * Hear a message of the demo's event channel: what a simulated worker said, read as a watch reads it and kept, then
 * told to each watch; a run's end, told as the end of each watch of it.
 */
export function hearDemoEvent(event: DemoEventMessage): void {
  if (event.scope === 'live') {
    if (endedRuns.has(event.runId)) return;
    const message = readLiveViewerMessage({ header: event.message as unknown as Record<string, unknown>, data: null });
    if (!message || message.type === 'hello' || message.type === 'end') return;
    keep(event.runId, message);
    for (const tell of watches) tell(event.runId, message);
  } else {
    const runId = endedRunOf(event);
    if (runId === null || endedRuns.has(runId)) return;
    kept.delete(runId);
    endedRuns.add(runId);
    for (const old of endedRuns) {
      if (endedRuns.size <= MAX_KEPT_RUNS) break;
      endedRuns.delete(old);
    }
    for (const tell of watches) tell(runId, { type: 'end', reason: 'run-ended' });
  }
}

/** The run an event of the demo's channel ends the live view of, or null. */
function endedRunOf(event: DemoEventMessage): number | null {
  if (event.scope === 'global') return DEMO_RUN_ENDS.has(event.event.type) ? event.event.runId : null;
  if (event.scope !== 'run') return null;
  return DEMO_RUN_ENDS.has(event.event.type as DemoGlobalEvent['type']) ? event.runId : null;
}

/** Hear the demo's workers from now on, in this page: once, for as long as the page lives. */
export function listenToDemoWorkers(): void {
  if (listening) return;
  listening = true;
  subscribeDemoEvents(hearDemoEvent);
}

/** Forget what the page kept of every run, and the runs it heard end. */
export function forgetDemoWorkers(): void {
  kept.clear();
  endedRuns.clear();
}

/** What the page kept of a worker of a run: of its lane, when it names one. */
function keptWorker(runId: number, id: LiveWorkerId): KeptWorker | null {
  return kept.get(runId)?.get(keptKey(id)) ?? null;
}

let watchCount = 0;

/** The page's watches that are open. */
const openWatches = new Set<DemoLiveWatch>();

/**
 * Whether a watch of this page shows `worker` of run `runId` in full: the demo's simulated CI worker holds a failing
 * test only then, as a worker holds one only while a controller watches it in full.
 */
export function demoWatchShows(runId: number, worker: LiveWorkerId): boolean {
  for (const watch of openWatches) if (watch.shows(runId, worker)) return true;
  return false;
}

export class DemoLiveWatch implements LiveWatchConnection {
  private ask: LiveWatchAsk = { focus: null, tiles: false, size: null, layers: [], inspect: false };
  private open = false;
  /** The run ended, and the watch with it. */
  private halted = false;
  /** The full view and Inspect its view heard what was kept for: another view, or Inspect opened, hears it again. */
  private told: { focus: LiveWorkerId | null; inspect: boolean } = { focus: null, inspect: false };
  private readonly watchId = `demo-watch-${Date.now().toString(36)}-${++watchCount}`;
  private readonly tell = (runId: number, message: LiveViewerMessage) => this.hear(runId, message);

  constructor(
    private readonly runId: number,
    private readonly events: LiveWatchEvents,
  ) {}

  get id(): string | null {
    return this.open ? this.watchId : null;
  }

  /** Whether this watch is open on run `runId` and shows `worker` in full. */
  shows(runId: number, worker: LiveWorkerId): boolean {
    const focus = this.ask.focus;
    return this.open && this.runId === runId && !!focus && sameWorker(focus, worker);
  }

  want(ask: LiveWatchAsk): void {
    this.ask = { ...ask, focus: ask.focus ? { ...ask.focus } : null, inspect: ask.inspect === true };
    if (!ask.tiles && !ask.focus) return this.close();
    if (this.halted) return;
    if (endedRuns.has(this.runId)) {
      this.halted = true;
      this.events.state({ kind: 'closed', status: null, reason: 'run-ended' });
      return;
    }
    if (!this.open) {
      this.open = true;
      watches.add(this.tell);
      openWatches.add(this);
      this.events.state({ kind: 'open' });
    }
    this.tellKept();
  }

  /** The demo's workers have no page to read: the view shown in full hears so. */
  askText(): void {
    const focus = this.ask.focus;
    if (!this.open || !focus || !this.ask.layers.includes('text')) return;
    this.events.message({ type: 'text', ...idOf(focus), refused: DEMO_NO_TEXT, test: null });
  }

  /**
   * Open the watch again, as the page asks when a view attaches (`useLiveWatch`'s `show`): the view shown in full hears
   * again what its worker said, even of the worker shown before, as a view that starts afresh needs it.
   */
  resume(): void {
    this.halted = false;
    this.told = { focus: null, inspect: false };
    this.want(this.ask);
  }

  close(): void {
    this.open = false;
    watches.delete(this.tell);
    openWatches.delete(this);
    this.told = { focus: null, inspect: false };
    this.events.state({ kind: 'idle' });
  }

  /**
   * Tell the view shown in full what its worker said before it opened: that it sends no image, its latest call log,
   * and with Inspect open, the pages of its test. Each once per view, and the pages again as Inspect opens.
   */
  private tellKept(): void {
    const focus = this.ask.focus;
    const inspect = !!focus && !!this.ask.inspect;
    const before = this.told;
    this.told = { focus, inspect };
    if (!focus) return;
    const another = !before.focus || !sameWorker(before.focus, focus) || before.focus.worker !== focus.worker;
    const worker = keptWorker(this.runId, focus);
    if (another) {
      this.events.message({ type: 'refused', ...idOf(focus), message: DEMO_NO_IMAGE });
      if (worker?.log) this.events.message(worker.log);
    }
    if (inspect && (another || !before.inspect)) for (const page of worker?.inspect ?? []) this.events.message(page);
  }

  /** A message the page read: the view shown in full hears its worker's, the pages only with Inspect open. */
  private hear(runId: number, message: LiveViewerMessage): void {
    if (runId !== this.runId || !this.open) return;
    if (message.type === 'end') {
      this.events.message(message);
      this.open = false;
      this.halted = true;
      watches.delete(this.tell);
      openWatches.delete(this);
      this.told = { focus: null, inspect: false };
      this.events.state({ kind: 'closed', status: null, reason: message.reason });
      return;
    }
    if (message.type === 'hello') return;
    const focus = this.ask.focus;
    if (!focus || !sameWorker(focus, message)) return;
    if (message.type === 'snapshot' && !this.ask.inspect) return;
    this.events.message(message);
  }
}

/**
 * The run's workers in its live view, in the demo: a stand-in for the worker of each lane that runs a test, which the
 * simulator plays, keyed as the run page keys its workers (`liveWorkerKey`), each keeping the held failure its
 * simulated CI worker told (`before`, the run page's `live-worker`s).
 */
export function demoLaneWorkers(
  lanes: Iterable<Lane>,
  before: Readonly<Record<string, LiveWorkerState>> = {},
): Record<string, LiveWorkerState> {
  const workers: Record<string, LiveWorkerState> = {};
  for (const lane of lanes) {
    if (!lane.test || lane.state === 'done') continue;
    const worker = { shard: lane.id.shard, worker: lane.worker ?? lane.id.lane, slot: lane.id.lane };
    const key = liveWorkerKey(worker);
    workers[key] = before[key] ?? { ...worker, connected: true, paused: null };
  }
  return workers;
}
