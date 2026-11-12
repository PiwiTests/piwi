/**
 * The worker's one watch of a CI run's lane on the connected instance, read-only, for the Runs windows that ask it
 * (`ci-watch`): the instance's watch of the run (`GET /api/test-runs/:id/live-view/watch`), opened with the extension's
 * API key on the lane's worker in full at `CI_WATCH_SIZE`, its live messages read with `@piwitests/core/live-view`'s
 * reader. Another lane of the same run is shown on the same watch (`POST` naming it); a lane of another run, or of
 * another instance, is a new watch in its place. The windows that watch the lane get each image, base64, at most
 * `MAX_VIEW_FPS` a second, the latest one waiting, and nothing is kept. A window that asks another lane takes the watch
 * there, the others hearing it moved (`moved`): one watch of the instance's bounds (16 a run, 4 a person) at a time.
 * The watch ends as its last window leaves, as the run leaves the list or the instance ends it, once it brings nothing
 * for `IDLE_MS`, or on an error: its windows hear why (`ci-ended`) unless they asked. Nothing here reaches the run's
 * workers: no control, input or pick.
 */
import {
  LIVE_STREAM_TYPE,
  MAX_LIVE_FRAME,
  createLiveMessageReader,
  readLiveViewerMessage,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { LatestPacer, MAX_VIEW_FPS } from '@piwitests/core/run-view';
import type { ConnectionSettings } from '../shared/connection-settings.js';
import type { CiWatchEnd, RunsAnswer, RunsCiFrame, RunsCiLane } from '../shared/runs.js';

/** The size the Runs window shows a CI lane at, in device pixels: its width at twice the pixels. */
export const CI_WATCH_SIZE = { width: 880, height: 550 };
/** A watch that brings nothing for this long has lost the instance, which sends a heartbeat every 15 s. */
const IDLE_MS = 45_000;
/** How long the instance may take to answer a new watch. */
const OPEN_MS = 15_000;
/** The longest refusal of the instance passed on in its own words. */
const MAX_REFUSAL = 300;

/** A Runs window, as a viewer of the CI lane it watches. */
export interface CiViewer {
  frame(frame: RunsCiFrame): void;
  ended(lane: RunsCiLane, why: CiWatchEnd): void;
}

export interface CiWatchOptions {
  settings: () => Promise<ConnectionSettings>;
  /** A lane of a listed run: whether its lanes can be watched and its worker; null for a run not followed now. */
  target: (runId: number, shard: number | null, lane: number) => { watchable: boolean; worker: number | null } | null;
  open: (settings: ConnectionSettings, runId: number, query: URLSearchParams, signal: AbortSignal) => Promise<Response>;
  change: (settings: ConnectionSettings, runId: number, body: Record<string, unknown>) => Promise<Response>;
  idleMs?: number;
  openMs?: number;
}

interface Watch extends RunsCiLane {
  instance: string;
  settings: ConnectionSettings;
  worker: number;
  abort: AbortController;
  /** The id the instance's stream opened with, which a change names; null until its `hello`. */
  id: string | null;
  /** The lanes asked of it, counted: an answer to an earlier one changes nothing. */
  asked: number;
  /** The windows that watch it, each with the pace of its images. */
  viewers: Map<CiViewer, LatestPacer<RunsCiFrame>>;
}

/** Bytes as base64. */
export function base64Of(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Why the instance refused, in its own words when it gave some, else its status. */
async function refusal(response: Response): Promise<RunsAnswer> {
  let said: unknown = null;
  try {
    said = ((await response.json()) as { message?: unknown } | null)?.message;
  } catch {
    // No JSON: the status says it.
  }
  if (typeof said === 'string' && said.trim()) {
    const text = said.trim().slice(0, MAX_REFUSAL);
    return { ok: false, message: /[.!?…]$/.test(text) ? text : `${text}.`, ci: 'refused' };
  }
  return { ok: false, message: '', ci: 'refused', status: response.status };
}

const refused = (ci: NonNullable<RunsAnswer['ci']>): RunsAnswer => ({ ok: false, message: '', ci });
const OK: RunsAnswer = { ok: true, message: '' };

export class CiLaneWatch {
  private current: Watch | null = null;

  constructor(private readonly options: CiWatchOptions) {}

  /** A window asks to watch a lane of a CI run (`on`), or stops. */
  async watch(viewer: CiViewer, lane: RunsCiLane, on: boolean): Promise<RunsAnswer> {
    const own = this.current;
    if (!on) {
      if (own && sameLane(own, lane)) this.leave(viewer);
      return OK;
    }
    const target = this.options.target(lane.runId, lane.shard, lane.lane);
    if (!target) return refused('unlisted');
    if (!target.watchable) return refused('unwatchable');
    if (target.worker === null) return refused('no-test');
    const settings = await this.options.settings();
    if (this.current !== own) return this.watch(viewer, lane, on);
    if (own && own.instance === settings.instanceUrl && own.runId === lane.runId) {
      if (sameLane(own, lane)) {
        this.join(own, viewer);
        return OK;
      }
      if (own.id) return this.change(own, viewer, lane, target.worker);
    }
    this.stop('moved');
    return this.open(settings, viewer, lane, target.worker);
  }

  /** A window left, or no longer watches: the watch ends with its last window. */
  leave(viewer: CiViewer): void {
    const own = this.current;
    const pacer = own?.viewers.get(viewer);
    if (!own || !pacer) return;
    pacer.close();
    own.viewers.delete(viewer);
    if (!own.viewers.size) this.stop(null);
  }

  /** A run left the list: a watch of it ends, saying the run ended. */
  runLeft(runId: number): void {
    if (this.current?.runId === runId) this.stop('run-ended');
  }

  /** Whether a lane is watched now, for tests and the worker's state. */
  watching(): RunsCiLane | null {
    const own = this.current;
    return own ? { runId: own.runId, shard: own.shard, lane: own.lane } : null;
  }

  private join(watch: Watch, viewer: CiViewer): void {
    if (watch.viewers.has(viewer)) return;
    watch.viewers.set(
      viewer,
      new LatestPacer<RunsCiFrame>({ intervalMs: 1000 / MAX_VIEW_FPS, send: (frame) => viewer.frame(frame) }),
    );
  }

  /** The watch ends: its windows hear why (`why`), unless they asked (null). */
  private stop(why: CiWatchEnd | null, only?: Iterable<CiViewer>): void {
    const own = this.current;
    if (!own) return;
    this.current = null;
    own.abort.abort();
    for (const pacer of own.viewers.values()) pacer.close();
    if (why === null) return;
    const lane = { runId: own.runId, shard: own.shard, lane: own.lane };
    for (const viewer of only ?? own.viewers.keys()) viewer.ended(lane, why);
  }

  private async open(
    settings: ConnectionSettings,
    viewer: CiViewer,
    lane: RunsCiLane,
    worker: number,
  ): Promise<RunsAnswer> {
    const watch: Watch = {
      ...lane,
      instance: settings.instanceUrl,
      settings,
      worker,
      abort: new AbortController(),
      id: null,
      asked: 0,
      viewers: new Map(),
    };
    this.current = watch;
    this.join(watch, viewer);
    const query = new URLSearchParams({
      worker: String(worker),
      slot: String(lane.lane),
      width: String(CI_WATCH_SIZE.width),
      height: String(CI_WATCH_SIZE.height),
    });
    if (lane.shard !== null) query.set('shard', String(lane.shard));
    let late = false;
    const wait = setTimeout(() => {
      late = true;
      watch.abort.abort();
    }, this.options.openMs ?? OPEN_MS);
    try {
      let response: Response;
      try {
        response = await this.options.open(settings, lane.runId, query, watch.abort.signal);
      } catch {
        if (this.current !== watch) return OK;
        this.stop(null);
        return refused(late ? 'late' : 'offline');
      }
      if (this.current !== watch) {
        await response.body?.cancel().catch(() => {});
        return OK;
      }
      if (!response.ok || !response.body) {
        const answer = await refusal(response);
        if (this.current === watch) this.stop(null);
        return answer;
      }
      if (!response.headers.get('content-type')?.startsWith(LIVE_STREAM_TYPE)) {
        await response.body.cancel().catch(() => {});
        this.stop(null);
        return refused('older');
      }
      void this.read(watch, response.body);
      return OK;
    } finally {
      clearTimeout(wait);
    }
  }

  /** Show another lane of the run on the watch open: the windows of the lane before hear it moved. */
  private async change(watch: Watch, viewer: CiViewer, lane: RunsCiLane, worker: number): Promise<RunsAnswer> {
    const before = { runId: watch.runId, shard: watch.shard, lane: watch.lane };
    for (const [other, pacer] of watch.viewers) {
      if (other === viewer) continue;
      pacer.close();
      watch.viewers.delete(other);
      other.ended(before, 'moved');
    }
    Object.assign(watch, { shard: lane.shard, lane: lane.lane, worker });
    this.join(watch, viewer);
    const asked = ++watch.asked;
    let response: Response;
    try {
      response = await this.options.change(watch.settings, watch.runId, {
        watch: watch.id,
        focus: { worker, shard: lane.shard, slot: lane.lane },
        ...CI_WATCH_SIZE,
      });
    } catch {
      if (this.current !== watch || watch.asked !== asked) return OK;
      this.stop(null);
      return refused('offline');
    }
    if (this.current !== watch || watch.asked !== asked) {
      await response.body?.cancel().catch(() => {});
      return OK;
    }
    if (!response.ok) {
      const answer = await refusal(response);
      if (this.current === watch && watch.asked === asked) this.stop(null);
      return answer;
    }
    await response.body?.cancel().catch(() => {});
    return OK;
  }

  /** Read the watch's live messages until it ends, the lane's images and refusals to its windows. */
  private async read(watch: Watch, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const parse = createLiveMessageReader({ maxData: MAX_LIVE_FRAME });
    const cancel = () => void reader.cancel().catch(() => {});
    watch.abort.signal.addEventListener('abort', cancel, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    let why: CiWatchEnd = 'closed';
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        why = 'silent';
        cancel();
      }, this.options.idleMs ?? IDLE_MS);
    };
    try {
      alive();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.current !== watch) break;
        alive();
        for (const raw of parse(value)) {
          const message = readLiveViewerMessage(raw);
          if (!message || this.current !== watch) continue;
          const ended = this.heard(watch, message);
          if (ended) {
            why = ended;
            cancel();
            break;
          }
        }
      }
    } catch {
      if (why === 'closed') why = 'broken';
    } finally {
      clearTimeout(idle);
      watch.abort.signal.removeEventListener('abort', cancel);
      cancel();
    }
    if (this.current === watch) this.stop(why);
  }

  /** A message of the watch: the lane's images and refusals to its windows; why it ended, when it did. */
  private heard(watch: Watch, message: LiveViewerMessage): CiWatchEnd | null {
    switch (message.type) {
      case 'hello':
        watch.id = message.watch;
        return null;
      case 'end':
        // An end naming no worker is the whole watch's; one naming the lane's is its view's, which is all it shows.
        return message.worker === undefined || ofLane(watch, message) ? message.reason : null;
      case 'frame':
        if (ofLane(watch, message)) {
          this.send(watch, {
            ...laneOf(watch),
            data: base64Of(message.image),
            test: message.test,
            call: message.call?.title ?? null,
          });
        }
        return null;
      case 'refused':
        if (ofLane(watch, message)) this.send(watch, { ...laneOf(watch), refused: message.message });
        return null;
      default:
        return null;
    }
  }

  private send(watch: Watch, frame: RunsCiFrame): void {
    for (const pacer of watch.viewers.values()) pacer.offer(frame);
  }
}

function sameLane(a: RunsCiLane, b: RunsCiLane): boolean {
  return a.runId === b.runId && a.shard === b.shard && a.lane === b.lane;
}

function laneOf(watch: Watch): RunsCiLane {
  return { runId: watch.runId, shard: watch.shard, lane: watch.lane };
}

/** Whether a message of the instance is of the lane watched: by its lane, else, from an older reporter, its worker. */
function ofLane(watch: Watch, id: Partial<LiveWorkerId>): boolean {
  if ((id.shard ?? null) !== watch.shard) return false;
  return id.slot !== undefined ? id.slot === watch.lane : id.worker === watch.worker;
}
