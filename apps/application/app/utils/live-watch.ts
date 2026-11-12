import {
  LIVE_STREAM_TYPE,
  MAX_LIVE_FRAME,
  createLiveMessageReader,
  readLiveViewSize,
  readLiveViewerMessage,
  readLiveWorkerId,
  type LiveViewEnd,
  type LiveViewerMessage,
  type LiveWorkerId,
} from '@piwitests/core/live-view';
import { LANE_LAYERS, readLaneLayers, type LaneLayer } from '@piwitests/core/live-layers';

/**
 * The run page's one watch of a live run (`/api/test-runs/:id/live-view/watch`): a streamed GET of live messages read
 * through `fetch` with `@piwitests/core/live-view`'s reader, which carries every image the page shows. What it shows
 * (`LiveWatchAsk`: one worker in full, at the size the page shows it, and each worker's tile) changes on the same
 * stream, by a POST that names the watch by the id it opened with (`hello`); a watch that shows tiles opens without
 * its full view and asks for it once open, so a worker that left refuses the full view alone. What the watch shows is
 * what the instance last said it shows (the stream's query as it opened, then each change's answer), never what was
 * asked and not answered: a change that fails is asked again a little later, `CHANGE_RETRY_MS.length` times in a row,
 * then the stream is dropped and opened again, its query asking for the whole of it. The full view also names the
 * layers it takes beside its images (`@piwitests/core/live-layers`: the page's events, its text, the test's filmstrip),
 * those the lane panel shows, and asks the worker shown in full for its page's text now (`text: true`) as the page asks
 * (`askText`) and as each stream that takes the text opens. It opens as soon as something is wanted, and closes once
 * nothing is. A stream that drops, breaks its framing or brings nothing for `STALL_MS` (the instance sends a heartbeat
 * every 15 s) is let go, its request aborted, and opens again, waiting longer each time, `RETRY_MS.length` times in a
 * row at most: a stream open `STEADY_MS` counts the tries afresh. One the instance refuses, or that ends saying why, or
 * that gave up, stays closed until the page asks again (`resume`).
 * Nothing is kept: each message goes to the page as it comes.
 */

/** What the page wants the watch to show. */
export interface LiveWatchAsk {
  /** The worker shown in full: with its lane (`slot`), the worker of that lane, followed through its next tests. */
  focus: LiveWorkerId | null;
  tiles: boolean;
  /** The size the page shows the full view at, in device pixels. */
  size: { width: number; height: number } | null;
  /** The layers the full view takes beside its images: those the lane panel shows, in `LANE_LAYERS`' order. */
  layers: LaneLayer[];
}

/** What the instance says a watch shows: `layers` null from an answer that does not say them. */
export type LiveWatchShown = Omit<LiveWatchAsk, 'layers'> & { layers: LaneLayer[] | null };

/** How the watch stands: nothing wanted, opening (again), open, or closed with why. */
export type LiveWatchState =
  | { kind: 'idle' }
  | { kind: 'connecting'; again: boolean }
  | { kind: 'open' }
  | { kind: 'closed'; status: number | null; reason: LiveViewEnd | null };

/** What the watch tells the page. */
export interface LiveWatchEvents {
  /** A message of the stream: a worker's, or the end of the full view or of the whole watch. */
  message(message: LiveViewerMessage): void;
  state(state: LiveWatchState): void;
  /** The full view asked for could not be shown (`status`, the instance's answer; null for none): the watch stays. */
  focusRefused(focus: LiveWorkerId, status: number | null): void;
}

/** How long the watch waits before it opens again after a drop, each try in a row; then it gives up. */
const RETRY_MS = [1000, 2000, 4000, 8000, 16000];
/** How long the watch waits before it asks again for a change that failed, each try in a row; then it opens again. */
const CHANGE_RETRY_MS = [500, 1000, 2000];
/** How long a stream may bring nothing, its heartbeats included, before it counts as dropped. */
export const STALL_MS = 45_000;
/** How long a stream stays open before it counts as one that held: the next drop starts the tries again. */
export const STEADY_MS = 30_000;

/** Whether two workers are the same one to a full view: the same lane when it names one, else the same worker. */
export function sameWorker(a: LiveWorkerId, b: LiveWorkerId): boolean {
  if (a.shard !== b.shard) return false;
  return a.slot !== undefined && b.slot !== undefined ? a.slot === b.slot : a.worker === b.worker;
}

function sameAsk(a: LiveWatchAsk['focus'], b: LiveWatchAsk['focus']): boolean {
  if (a === null || b === null) return a === b;
  return a.shard === b.shard && a.worker === b.worker && a.slot === b.slot;
}

function sameSize(a: LiveWatchAsk['size'], b: LiveWatchAsk['size']): boolean {
  return a?.width === b?.width && a?.height === b?.height;
}

function sameLayers(a: readonly LaneLayer[], b: readonly LaneLayer[]): boolean {
  return a.length === b.length && a.every((layer, i) => layer === b[i]);
}

/** The layers a full view takes as the instance holds them: those a worker posts beside its call log, in order. */
export function heldLayers(layers: readonly LaneLayer[]): LaneLayer[] {
  return LANE_LAYERS.filter((layer) => layer !== 'calls' && layers.includes(layer));
}

/** A size as the instance holds it: whole device pixels within a tile's and the largest view's; null for none. */
function heldSize(size: LiveWatchAsk['size']): LiveWatchAsk['size'] {
  return size ? readLiveViewSize(Math.round(size.width), Math.round(size.height)) : null;
}

/** What the watch shows, as a change's answer says it (`watch`, or `data.watch` of a refusal); null for none. */
export function readLiveWatchShown(answer: unknown): LiveWatchShown | null {
  const body = answer as { watch?: unknown; data?: { watch?: unknown } } | null;
  const value = (body?.watch ?? body?.data?.watch) as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== 'object' || typeof value.tiles !== 'boolean') return null;
  const size = readLiveViewSize(value.width, value.height);
  const raw = value.focus as Record<string, unknown> | null | undefined;
  const focus = raw ? readLiveWorkerId(raw.shard, raw.worker, raw.slot) : null;
  if (!size || (raw && !focus)) return null;
  const layers = readLaneLayers(value.layers);
  return { focus, tiles: value.tiles, size, layers: layers ? heldLayers(layers) : null };
}

/** Whether a watch shows anything. */
function wanted(ask: LiveWatchAsk): boolean {
  return ask.tiles || ask.focus !== null;
}

/** The query of a watch's stream: its full view (unless it shows tiles), its tiles, the full view's size and layers. */
export function liveWatchQuery(ask: LiveWatchAsk): URLSearchParams {
  const query = new URLSearchParams();
  if (ask.focus && !ask.tiles) {
    query.set('worker', String(ask.focus.worker));
    if (ask.focus.shard !== null) query.set('shard', String(ask.focus.shard));
    if (ask.focus.slot !== undefined) query.set('slot', String(ask.focus.slot));
  }
  if (ask.tiles) query.set('tiles', '1');
  if (ask.size) {
    query.set('width', String(ask.size.width));
    query.set('height', String(ask.size.height));
  }
  if (ask.layers.length) query.set('layers', ask.layers.join(','));
  return query;
}

export class LiveWatch {
  private ask: LiveWatchAsk = { focus: null, tiles: false, size: null, layers: [] };
  /** What the instance shows now, as the watch's stream opened or the last change said. */
  private shown: LiveWatchAsk | null = null;
  private controller: AbortController | null = null;
  private watchId: string | null = null;
  private changing = false;
  /** How many times the page's text was asked for, and how many of those asks the instance took. */
  private textAsks = 0;
  private textTaken = 0;
  /** The changes that failed in a row, and the wait before the next try. */
  private changeFailures = 0;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the tries afresh once the stream open stayed so `STEADY_MS`. */
  private steady: ReturnType<typeof setTimeout> | null = null;
  /** The watch closed saying why (refused, ended, given up): it opens again only as the page asks (`resume`). */
  private halted = false;

  constructor(
    private readonly url: string,
    private readonly events: LiveWatchEvents,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  /**
   * Show `ask` from now on: open the watch, change what it shows, or close it once nothing is wanted. A watch that
   * closed saying why stays closed until `resume`.
   */
  want(ask: LiveWatchAsk): void {
    this.ask = {
      ...ask,
      focus: ask.focus ? { ...ask.focus } : null,
      size: heldSize(ask.size),
      layers: heldLayers(ask.layers),
    };
    if (!wanted(this.ask)) return this.close();
    if (this.halted) return;
    if (!this.controller && !this.timer) {
      this.retries = 0;
      return void this.open(false);
    }
    void this.change();
  }

  /**
   * Ask the worker shown in full for its page's text now, for a full view that takes the text: once the watch is open,
   * with the change that asks for the text when one waits.
   */
  askText(): void {
    this.textAsks++;
    void this.change();
  }

  /** Open a watch that closed saying why again, as the page asks: what it wants shown now. */
  resume(): void {
    this.halted = false;
    this.want(this.ask);
  }

  /** Close the watch: nothing more comes. */
  close(): void {
    this.halted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.forgetWatch();
    this.events.state({ kind: 'idle' });
  }

  /** The stream open is done with: its id, what it showed, and the changes asked of it go. */
  private forgetWatch(): void {
    this.watchId = null;
    this.shown = null;
    this.changeFailures = 0;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    if (this.steady) clearTimeout(this.steady);
    this.steady = null;
  }

  private async open(again: boolean): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.forgetWatch();
    const ask = this.ask;
    this.events.state({ kind: 'connecting', again });
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}?${liveWatchQuery(ask)}`, {
        headers: { Accept: LIVE_STREAM_TYPE },
        signal: controller.signal,
      });
    } catch {
      return this.dropped(controller);
    }
    if (this.controller !== controller) return;
    if (!response.ok || !response.body) {
      this.controller = null;
      this.halted = true;
      const status = response.status || null;
      // A full view the instance would not open, beside no tiles: the full view alone is refused.
      if (ask.focus && !ask.tiles) this.events.focusRefused(ask.focus, status);
      this.events.state({ kind: 'closed', status, reason: null });
      return;
    }
    this.shown = { ...ask, focus: ask.tiles ? null : ask.focus };
    const read = createLiveMessageReader({ maxData: MAX_LIVE_FRAME });
    const reader = response.body.getReader();
    let ended: LiveViewEnd | null = null;
    /** Let the stream go: what it still brings is read no more, and its request ends. */
    const letGo = (): void => {
      void reader.cancel().catch(() => {});
      controller.abort();
    };
    // A stream that brings nothing, not even its heartbeat, is half open: it is dropped.
    let stall: ReturnType<typeof setTimeout> | null = null;
    const alive = (): void => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(letGo, STALL_MS);
    };
    try {
      alive();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.controller !== controller) break;
        alive();
        for (const raw of read(value)) {
          const message = readLiveViewerMessage(raw);
          if (!message) continue;
          if (message.type === 'hello') {
            this.watchId = message.watch;
            if (this.steady) clearTimeout(this.steady);
            this.steady = setTimeout(() => {
              this.steady = null;
              this.retries = 0;
            }, STEADY_MS);
            this.events.state({ kind: 'open' });
            // A worker reads its page's text as the first of its full views takes it: each stream asks for it now.
            if (this.ask.layers.includes('text')) this.textAsks++;
            void this.change();
            continue;
          }
          if (message.type === 'end' && message.worker === undefined) ended = message.reason;
          else if (message.type === 'end' && this.shown) {
            // The instance shows no full view any more: one asked again is asked anew.
            this.shown = { ...this.shown, focus: null };
            if (this.ask.focus && sameWorker(this.ask.focus, message as LiveWorkerId)) {
              this.ask = { ...this.ask, focus: null };
            }
          }
          this.events.message(message);
        }
      }
    } catch {
      // A stream cut short, or one that broke its framing: it is let go, and opens again.
      letGo();
    } finally {
      if (stall) clearTimeout(stall);
    }
    if (this.controller !== controller) return;
    if (ended) {
      this.controller = null;
      this.forgetWatch();
      this.halted = true;
      this.events.state({ kind: 'closed', status: null, reason: ended });
      return;
    }
    this.dropped(controller);
  }

  /** The stream dropped: it opens again a little later, `RETRY_MS.length` times in a row at most. */
  private dropped(controller: AbortController): void {
    if (this.controller !== controller) return;
    this.controller = null;
    this.forgetWatch();
    if (this.retries >= RETRY_MS.length) {
      this.halted = true;
      this.events.state({ kind: 'closed', status: null, reason: null });
      return;
    }
    this.events.state({ kind: 'connecting', again: true });
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (wanted(this.ask)) void this.open(true);
      },
      RETRY_MS[this.retries++],
    );
  }

  /**
   * Tell the instance what changed of what the watch shows, one change at a time, the latest after the one before;
   * what the watch shows is what its answer says, the layers as asked from an answer that does not say them. The page's
   * text asked for goes with it, while the full view takes the text. A full view the instance refuses is no longer
   * asked, and the page hears why. A change it did not answer (no answer, an error, too many changes) is asked again a
   * little later, then, after `CHANGE_RETRY_MS.length` failures in a row, or at once for a watch it no longer holds, the
   * stream is opened again with the whole ask.
   */
  private async change(): Promise<void> {
    if (this.changing || this.changeTimer || !this.watchId || !this.shown || !this.controller) return;
    const ask = this.ask;
    const body: Record<string, unknown> = { watch: this.watchId };
    if (!sameAsk(ask.focus, this.shown.focus)) body.focus = ask.focus;
    if (ask.tiles !== this.shown.tiles) body.tiles = ask.tiles;
    if (ask.size && !sameSize(ask.size, this.shown.size)) {
      body.width = ask.size.width;
      body.height = ask.size.height;
    }
    if (!sameLayers(ask.layers, this.shown.layers)) body.layers = ask.layers;
    // A text asked while the full view takes none is not asked any more.
    if (!ask.layers.includes('text')) this.textTaken = this.textAsks;
    const textAsks = this.textAsks;
    if (textAsks > this.textTaken) body.text = true;
    if (Object.keys(body).length === 1) {
      this.changeFailures = 0;
      return;
    }
    this.changing = true;
    const controller = this.controller;
    let status: number | null = null;
    let shown: LiveWatchShown | null = null;
    try {
      const response = await this.fetcher(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      status = response.status;
      shown = readLiveWatchShown(await response.json().catch(() => null));
    } catch {
      status = null;
    }
    this.changing = false;
    if (this.controller !== controller || !this.shown) return;
    const ok = status !== null && status >= 200 && status < 300;
    if (shown || ok) {
      this.changeFailures = 0;
      if (body.text) this.textTaken = Math.max(this.textTaken, textAsks);
      const layers = 'layers' in body ? ask.layers : this.shown.layers;
      this.shown = shown
        ? { ...shown, layers: shown.layers ?? layers }
        : {
            focus: 'focus' in body ? (ask.focus ? { ...ask.focus } : null) : this.shown.focus,
            tiles: 'tiles' in body ? ask.tiles : this.shown.tiles,
            size: 'width' in body ? ask.size : this.shown.size,
            layers,
          };
      // The full view asked is not shown: refused, it is no longer asked, and the page hears why.
      if (!ok && ask.focus && 'focus' in body && !sameAsk(this.shown.focus, ask.focus)) {
        if (sameAsk(this.ask.focus, ask.focus)) this.ask = { ...this.ask, focus: null };
        this.events.focusRefused(ask.focus, status);
      }
      return void this.change();
    }
    this.changeFailures++;
    // A watch the instance no longer holds, or a change that keeps failing: the stream opens again with the whole ask.
    if (status === 404 || this.changeFailures > CHANGE_RETRY_MS.length) {
      controller.abort();
      return this.dropped(controller);
    }
    this.changeTimer = setTimeout(
      () => {
        this.changeTimer = null;
        void this.change();
      },
      CHANGE_RETRY_MS[this.changeFailures - 1],
    );
  }
}
