/**
 * The client's watch of a CI run's lane on the team instance (`piwi/ciWatch`, `piwi/ciFrame`), read-only: one per
 * service, the instance's watch of the run (`PiwiClient.liveWatch`), opened with the editor's key on the lane's worker in
 * full at `CI_WATCH_SIZE`, its live messages read with `@piwitests/core/live-view`'s reader. Another lane of the same
 * run is shown on the same watch (`PiwiClient.changeLiveWatch`); a lane of another run, or of another instance or key,
 * is a new watch in its place. Each image goes to the client as it comes, one at a time, the newest alone waiting
 * (`FrameSender`), and nothing is kept. An instance that has not answered the watch within `OPEN_MS` is refused, its
 * request let go. The watch ends as the client asks, as the run's session ends, as the instance ends it, once it brings
 * nothing for `IDLE_MS`, or on an error: the client hears why (`ended`) unless it asked. The layers the client asks
 * (`CiWatchParams.layers`) are the watch's (`layers`, changed in place), the call log being the full view's own: each
 * goes to the client as it comes (`piwi/ciLayer`), the lane's alone, none it did not ask for. Nothing here reaches the
 * run's workers: no control, input or pick.
 */
import {
  LIVE_STREAM_TYPE,
  MAX_LIVE_FRAME,
  createLiveMessageReader,
  readLiveViewerMessage,
  type LiveMessage,
  type LiveViewEnd,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { LANE_TEXTS_PER_SECOND, readLaneLayers, type LaneLayer } from '@piwitests/core/live-layers';
import type { LaneLayerData } from '@piwitests/core/run-channel';
import { FrameSender } from './client-page-view.js';
import type { PiwiClient } from './piwi-client.js';
import type { CiFrame, CiLayer, CiSession, CiWatchParams, RunControlResult } from './protocol.js';

/** The size the editors' panels show a CI lane at, in device pixels; the instance holds it within its bounds. */
export const CI_WATCH_SIZE = { width: 960, height: 600 };
/** A watch that brings nothing for this long has lost the instance, which sends a heartbeat every 15 s. */
const IDLE_MS = 45_000;
/** How long the instance may take to answer a new watch: within the 20 s the JetBrains plugin waits for an answer. */
const OPEN_MS = 15_000;
/** The longest refusal of the instance passed on in its own words. */
const MAX_REFUSAL = 300;
/** The statuses of a run whose session the service still follows. */
const ACTIVE = new Set(['running', 'initializing', 'finalizing']);

/** Why the instance ended a watch, in the words the client shows. */
const ENDS: Record<LiveViewEnd, string> = {
  'run-ended': 'The CI run ended.',
  off: 'The project’s live view was turned off.',
  replaced:
    'The instance closed this watch: you opened more watches of this run elsewhere than it keeps for one person.',
  'test-ended': 'The test ended.',
  'worker-left': 'No worker runs in this lane any more.',
  unshared: 'The run is no longer shared.',
};

/** The run a client asks to watch a lane of, as the CI sessions follow it (`CiSessions.watchTarget`). */
export interface CiWatchTarget {
  root: string;
  client: PiwiClient;
  watchable: boolean;
  worker: number | null;
}

export interface CiWatchOptions {
  target: (root: string | undefined, runId: number, shard: number | null, lane: number) => CiWatchTarget | null;
  /** Tell the client: an image, why none shows, or why the watch ended. */
  send: (frame: CiFrame) => Promise<void>;
  /** Tell the client a layer of the lane it asked for. */
  sendLayer?: (layer: CiLayer) => Promise<void>;
  /** How long a watch may bring nothing, the instance's heartbeat included, before it ends. */
  idleMs?: number;
  /** How long the instance may take to answer a new watch before it is refused. */
  openMs?: number;
  /** How long after the page's text was asked another ask of it is merged with that one. */
  textMs?: number;
}

/** A lane of a CI run, as the client names it (`lane` from 1, as `CiTest.lane`), and the worker that ran there last. */
interface Lane {
  root: string;
  runId: number;
  shard: number | null;
  lane: number;
  worker: number;
}

interface Watch extends Lane {
  client: PiwiClient;
  abort: AbortController;
  /** The id the instance's stream opened with, which a change names; null until its `hello`. */
  id: string | null;
  /** The lanes asked of it, counted: an answer to an earlier one changes nothing. */
  asked: number;
  /** The layers the client shows, in `LANE_LAYERS`' order. */
  layers: LaneLayer[];
  /**
   * The page's text as last asked of the instance: when, its answer, and whether that answer is still to come. Another
   * ask meanwhile, or within `textMs` of it, shares its answer.
   */
  textAsk: { at: number; answer: Promise<RunControlResult>; pending: boolean } | null;
}

/** A client's params, checked field by field; why not, as a sentence. */
function readParams(
  params: CiWatchParams | null | undefined,
): (Omit<CiWatchParams, 'root' | 'layers'> & { root?: string; layers: LaneLayer[] }) | string {
  if (!params || typeof params.on !== 'boolean') return 'Watching needs on or off.';
  const shard = params.shard ?? null;
  const root = params.root ?? undefined;
  if (
    !Number.isInteger(params.runId) ||
    params.runId < 1 ||
    !Number.isInteger(params.lane) ||
    params.lane < 1 ||
    (shard !== null && (!Number.isInteger(shard) || shard < 1)) ||
    (root !== undefined && typeof root !== 'string')
  ) {
    return 'The command needs the CI run and the worker’s lane it watches.';
  }
  const layers = params.layers == null ? [] : readLaneLayers(params.layers);
  if (!layers) return 'The layers are a list: calls, events, text, filmstrip.';
  return { root, runId: params.runId, shard, lane: params.lane, on: params.on, layers, text: params.text === true };
}

/** The layers the instance's watch takes, comma-separated: the call log comes with the full view itself. */
function watchLayers(layers: readonly LaneLayer[]): LaneLayer[] {
  return layers.filter((layer) => layer !== 'calls');
}

/** `worker 2`, or `shard 1, worker 2`: a CI lane as the clients name it. */
function laneName(lane: Pick<Lane, 'shard' | 'lane'>): string {
  return lane.shard !== null ? `shard ${lane.shard}, worker ${lane.lane}` : `worker ${lane.lane}`;
}

/** Whether a message of the instance is of the lane watched: by its lane, else, from an older reporter, its worker. */
function ofLane(lane: Lane, id: Partial<LiveWorkerId>): boolean {
  if ((id.shard ?? null) !== lane.shard) return false;
  return id.slot !== undefined ? id.slot === lane.lane - 1 : id.worker === lane.worker;
}

/** Whether two clients reach one instance with one key. */
function sameConnection(a: PiwiClient, b: PiwiClient): boolean {
  return a.connection.serverUrl === b.connection.serverUrl && a.connection.apiKey === b.connection.apiKey;
}

/** Why the instance refused, in its own words when it gave some, else by its status. */
async function refusal(response: Response): Promise<string> {
  let said: unknown = null;
  try {
    said = ((await response.json()) as { message?: unknown } | null)?.message;
  } catch {
    // No JSON: the status says it.
  }
  if (typeof said === 'string' && said.trim()) {
    const text = said.trim().slice(0, MAX_REFUSAL);
    return /[.!?…]$/.test(text) ? text : `${text}.`;
  }
  switch (response.status) {
    case 401:
    case 403:
      return 'The instance refused the editor’s key.';
    case 404:
      return 'The instance shows no live view of this worker: the project’s live view is off, or the worker left.';
    case 410:
      return 'The CI run is no longer live.';
    case 429:
      return 'Too many people watch this run now: try again in a moment.';
    default:
      return `The instance answered ${response.status}.`;
  }
}

const SUPERSEDED: RunControlResult = { ok: false, message: 'Another CI watch took the place of this one.' };
const LATE = 'The instance did not open the watch in time: try again in a moment.';

/** How long after the page's text was asked another ask shares that one's answer. */
const TEXT_MS = 1000 / LANE_TEXTS_PER_SECOND;
const TEXT_ON_ITS_WAY: RunControlResult = { ok: true, message: 'The page’s text is on its way.' };

/** One per service: the client's one watch of a CI lane. */
export class CiWatch {
  private current: Watch | null = null;
  private readonly sender: FrameSender<CiFrame>;

  constructor(private readonly options: CiWatchOptions) {
    // The lane may have changed since the image came, before it goes.
    this.sender = new FrameSender(
      options.send,
      (frame) => this.isCurrent(frame),
      () => this.stop(),
    );
  }

  async watch(params: CiWatchParams): Promise<RunControlResult> {
    const asked = readParams(params);
    if (typeof asked === 'string') return { ok: false, message: asked };
    const own = this.current;
    if (!asked.on) {
      if (own?.runId === asked.runId && own.shard === asked.shard && own.lane === asked.lane) this.stop();
      return { ok: true, message: 'You no longer watch the CI run’s worker.' };
    }
    const target = this.options.target(asked.root, asked.runId, asked.shard, asked.lane);
    if (!target || !target.watchable || target.worker === null) {
      this.stop();
      return {
        ok: false,
        message: !target
          ? `The editor follows no CI run #${asked.runId} now: it ended, or the editor reads another branch.`
          : !target.watchable
            ? 'This CI run cannot be watched: its project’s live view is off, or the run holds no key.'
            : 'No test ran in this worker’s lane yet.',
      };
    }
    const lane: Lane = {
      root: target.root,
      runId: asked.runId,
      shard: asked.shard,
      lane: asked.lane,
      worker: target.worker,
    };
    // A watch the instance opened shows another lane of its run without a new one.
    if (own?.id && own.root === lane.root && own.runId === lane.runId && sameConnection(own.client, target.client)) {
      if (own.shard === lane.shard && own.lane === lane.lane) {
        return this.relayer(own, asked.layers, asked.text === true);
      }
      return this.change(own, lane, asked.layers);
    }
    this.stop();
    return this.open(target.client, lane, asked.layers);
  }

  /** A session changed: one that ended ends the watch of its run, saying whether the run ended. */
  sessionChanged(session: CiSession): void {
    const own = this.current;
    if (!session.ended || !own || own.runId !== session.runId || own.root !== session.root) return;
    this.end(
      own,
      ACTIVE.has(session.progress.status)
        ? 'The editor follows this CI run no more: it reads another branch, project or instance, or a newer run of the branch took its place.'
        : ENDS['run-ended'],
    );
  }

  dispose(): void {
    this.stop();
  }

  /** The watch ends as the client asked, or as another takes its place: the client hears nothing of it. */
  private stop(): void {
    const own = this.current;
    this.current = null;
    this.sender.clear();
    own?.abort.abort();
  }

  /** The watch ends of itself: the client hears why, last. */
  private end(watch: Watch, why: string): void {
    if (this.current !== watch) return;
    this.stop();
    void this.options.send({ ...where(watch), ended: why }).catch(() => {});
  }

  private isCurrent(frame: CiFrame): boolean {
    const own = this.current;
    return (
      !!own &&
      frame.root === own.root &&
      frame.runId === own.runId &&
      frame.shard === own.shard &&
      frame.lane === own.lane
    );
  }

  /** Open the instance's watch of the run on the lane's worker, and read it until it ends. */
  private async open(client: PiwiClient, lane: Lane, layers: LaneLayer[]): Promise<RunControlResult> {
    const watch: Watch = { ...lane, client, abort: new AbortController(), id: null, asked: 0, layers, textAsk: null };
    this.current = watch;
    const query = new URLSearchParams({
      worker: String(lane.worker),
      slot: String(lane.lane - 1),
      width: String(CI_WATCH_SIZE.width),
      height: String(CI_WATCH_SIZE.height),
    });
    if (lane.shard !== null) query.set('shard', String(lane.shard));
    if (watchLayers(layers).length) query.set('layers', watchLayers(layers).join(','));
    let late = false;
    const wait = setTimeout(() => {
      late = true;
      watch.abort.abort();
    }, this.options.openMs ?? OPEN_MS);
    wait.unref?.();
    try {
      let response: Response;
      try {
        response = await client.liveWatch(lane.runId, query, watch.abort.signal);
      } catch {
        if (this.current !== watch) return SUPERSEDED;
        this.stop();
        return { ok: false, message: late ? LATE : 'The instance did not answer.' };
      }
      if (this.current !== watch) {
        await response.body?.cancel().catch(() => {});
        return SUPERSEDED;
      }
      if (!response.ok || !response.body) {
        // Read before the watch's signal aborts the body.
        const message = await refusal(response);
        if (this.current !== watch) return SUPERSEDED;
        this.stop();
        return { ok: false, message };
      }
      if (!response.headers.get('content-type')?.startsWith(LIVE_STREAM_TYPE)) {
        this.stop();
        return {
          ok: false,
          message: 'This instance’s live view is not one the editor reads: watch the test on the dashboard.',
        };
      }
      void this.read(watch, response.body);
      return { ok: true, message: `You watch ${laneName(lane)} of CI run #${lane.runId}.` };
    } finally {
      clearTimeout(wait);
    }
  }

  /**
   * Change the layers of the lane the watch shows (`layers`), or ask its worker for its page's text now (`text`, and as
   * the layers list it anew): the instance sends the filmstrip again to a watch that takes it anew. An ask of the text
   * while the last one is answered, or within `textMs` of it, is that one: the instance hears none.
   */
  private async relayer(watch: Watch, layers: LaneLayer[], text: boolean): Promise<RunControlResult> {
    const said = { ok: true, message: `You watch ${laneName(watch)} of CI run #${watch.runId}.` };
    if (text && !layers.includes('text')) return { ok: false, message: 'Show the page’s text first.' };
    // The call log comes with the full view: the instance hears of the other layers alone.
    const changed = watchLayers(layers).join() !== watchLayers(watch.layers).join();
    const before = watch.layers;
    const last = watch.textAsk;
    const now = Date.now();
    const recent = !!last && (last.pending || now - last.at < (this.options.textMs ?? TEXT_MS));
    const asks = (text || (layers.includes('text') && !before.includes('text'))) && !recent;
    watch.layers = layers;
    if (!changed && !asks) return text ? last!.answer : said;
    const body: Record<string, unknown> = { watch: watch.id };
    if (changed) body.layers = watchLayers(layers);
    if (asks) body.text = true;
    const posted = this.post(watch, body, watch.asked, false).then((answer) => {
      // Refused, the watch takes the layers it took before, which the client may ask to change again.
      if (!answer.ok && watch.layers === layers) watch.layers = before;
      return answer;
    });
    const ask = asks ? { at: now, pending: true, answer: posted } : null;
    if (ask) {
      watch.textAsk = ask;
      ask.answer = posted.then((answer) => {
        ask.pending = false;
        return answer.ok ? TEXT_ON_ITS_WAY : answer;
      });
    }
    const answer = await posted;
    if (!answer.ok || !text) return answer.ok ? said : answer;
    return (ask ?? last)!.answer;
  }

  /** Show another lane of the run on the watch open: its images go from now on, the lane before's no more. */
  private async change(watch: Watch, lane: Lane, layers: LaneLayer[]): Promise<RunControlResult> {
    Object.assign(watch, lane);
    // An instance that predates the layers hears of none while none were asked.
    const named = watchLayers(layers).length || watchLayers(watch.layers).length;
    watch.layers = layers;
    const asked = ++watch.asked;
    this.sender.clear();
    const answer = await this.post(
      watch,
      {
        watch: watch.id,
        focus: { worker: lane.worker, shard: lane.shard, slot: lane.lane - 1 },
        ...CI_WATCH_SIZE,
        ...(named ? { layers: watchLayers(layers) } : {}),
      },
      asked,
    );
    return answer.ok ? { ok: true, message: `You watch ${laneName(lane)} of CI run #${lane.runId}.` } : answer;
  }

  /**
   * Change what the watch shows (`POST …/live-view/watch`), as the client asked it the `asked`th time: a later ask, or
   * another watch, takes its place, and a refusal ends the watch when `ends`, else leaves it as it was.
   */
  private async post(
    watch: Watch,
    body: Record<string, unknown>,
    asked: number,
    ends = true,
  ): Promise<RunControlResult> {
    let response: Response;
    try {
      response = await watch.client.changeLiveWatch(watch.runId, body);
    } catch {
      if (this.current !== watch || watch.asked !== asked) return SUPERSEDED;
      if (ends) this.stop();
      return { ok: false, message: 'The instance did not answer.' };
    }
    if (this.current !== watch || watch.asked !== asked) {
      await response.body?.cancel().catch(() => {});
      return SUPERSEDED;
    }
    if (!response.ok) {
      const message = await refusal(response);
      if (ends && this.current === watch && watch.asked === asked) this.stop();
      return { ok: false, message };
    }
    await response.body?.cancel().catch(() => {});
    return { ok: true, message: 'The watch changed.' };
  }

  /** Read the watch's live messages until it ends, the lane's images and refusals to the client. */
  private async read(watch: Watch, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const parse = createLiveMessageReader({ maxData: MAX_LIVE_FRAME });
    const cancel = () => void reader.cancel().catch(() => {});
    watch.abort.signal.addEventListener('abort', cancel, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => this.end(watch, 'The instance stopped answering.'), this.options.idleMs ?? IDLE_MS);
      idle.unref?.();
    };
    let why = 'The instance closed the watch.';
    try {
      alive();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.current !== watch) break;
        alive();
        let messages: LiveMessage[];
        try {
          messages = parse(value);
        } catch (e) {
          why = `The watch’s stream broke: ${(e as Error).message}`;
          break;
        }
        for (const raw of messages) {
          const message = readLiveViewerMessage(raw);
          if (message && this.current === watch) this.heard(watch, message);
        }
      }
    } catch {
      why = 'The connection to the instance dropped.';
    } finally {
      clearTimeout(idle);
      watch.abort.signal.removeEventListener('abort', cancel);
      cancel();
    }
    this.end(watch, why);
  }

  private heard(watch: Watch, message: LiveViewerMessage): void {
    switch (message.type) {
      case 'hello':
        watch.id = message.watch;
        return;
      case 'end':
        // An end naming no worker is the whole watch's; one naming the lane's is its view's, which is all it shows.
        if (message.worker === undefined || ofLane(watch, message)) this.end(watch, ENDS[message.reason]);
        return;
      case 'frame':
        if (!ofLane(watch, message)) return;
        return this.sender.send({
          ...where(watch),
          data: Buffer.from(message.image).toString('base64'),
          test: message.test,
          call: message.call?.title ?? null,
        });
      case 'refused':
        if (ofLane(watch, message)) this.sender.send({ ...where(watch), refused: message.message });
        return;
      case 'call-log':
        return this.layer(watch, message, { layer: 'calls', log: message.log });
      case 'page-event':
        return this.layer(watch, message, { layer: 'events', event: message.event, at: message.at });
      case 'text':
        return this.layer(
          watch,
          message,
          'refused' in message ? { layer: 'text', refused: message.refused } : { layer: 'text', text: message.text },
        );
      case 'thumb':
        return this.layer(watch, message, {
          layer: 'filmstrip',
          thumb: message.thumb,
          data: Buffer.from(message.image).toString('base64'),
        });
      default:
        // A test's outcome: the CI sessions say how each test ended.
        return;
    }
  }

  /**
   * A layer of the lane watched, to the client when it asked for it, with the worker that sent it: each as it comes,
   * none of another lane.
   */
  private layer(watch: Watch, message: LiveWorkerId & { test: string | null }, data: LaneLayerData): void {
    if (!ofLane(watch, message) || !watch.layers.includes(data.layer) || !this.options.sendLayer) return;
    this.options.sendLayer({ ...where(watch), worker: message.worker, test: message.test, ...data }).catch(() => {});
  }
}

/** The lane a frame is of, as the client named it. */
function where(lane: Lane): Pick<CiFrame, 'root' | 'runId' | 'shard' | 'lane'> {
  return { root: lane.root, runId: lane.runId, shard: lane.shard, lane: lane.lane };
}
