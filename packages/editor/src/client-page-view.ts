import {
  MAX_VIEW_EVENT_RATE,
  RateWindow,
  readViewInput,
  type ViewInput,
  type ViewButton,
} from '@piwitests/core/run-view';
import type {
  LaneFrame,
  LaneViewParams,
  PageFrame,
  PageInputParams,
  PageViewParams,
  RunControlResult,
} from './protocol.js';
import type { LaneViewFrame, RunSessions, Viewer } from './run-sessions.js';

/** The keys and buttons a viewer's input holds down on a page, released as it leaves it. */
class HeldInput {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<ViewButton>();
  private point = { x: 0, y: 0 };
  private readonly rate = new RateWindow(MAX_VIEW_EVENT_RATE);

  /** The events a client sent, checked and counted, or why they are refused; a release lets go of what is held. */
  read(params: PageInputParams): ViewInput[] | string {
    const events = params?.release === true ? this.release() : readViewInput(params?.events);
    if (typeof events === 'string') return events;
    if (events.length && !params.release && !this.rate.take(events.length)) return 'Too many input events; try again.';
    for (const event of events) {
      if (event.type === 'key' && event.action === 'down') this.keys.add(event.key);
      if (event.type === 'key' && event.action === 'up') this.keys.delete(event.key);
      if (event.type === 'mouse') {
        this.point = { x: event.x, y: event.y };
        if (event.action === 'down') this.buttons.add(event.button);
        if (event.action === 'up') this.buttons.delete(event.button);
      }
    }
    return events;
  }

  /** The events that let go of every button and key held, forgotten. */
  release(): ViewInput[] {
    const events: ViewInput[] = [
      ...[...this.buttons].map((button): ViewInput => ({ type: 'mouse', action: 'up', ...this.point, button })),
      ...[...this.keys].reverse().map((key): ViewInput => ({ type: 'key', action: 'up', key })),
    ];
    this.buttons.clear();
    this.keys.clear();
    return events;
  }
}

/**
 * Sends a viewer's frames to the client one at a time, the latest alone while one is on its way, each only while
 * `goes` says it still does.
 */
class FrameSender<F> {
  private pending: F | null = null;
  private sending = false;

  constructor(
    private readonly notify: (frame: F) => Promise<void>,
    private readonly goes: (frame: F) => boolean,
    private readonly failed: () => void,
  ) {}

  send(frame: F): void {
    this.pending = frame;
    if (!this.sending) void this.flush();
  }

  clear(): void {
    this.pending = null;
  }

  private async flush(): Promise<void> {
    this.sending = true;
    try {
      while (this.pending) {
        const frame = this.pending;
        this.pending = null;
        if (this.goes(frame)) await this.notify(frame);
      }
    } catch {
      this.failed();
    } finally {
      this.sending = false;
    }
  }
}

/** A viewer of the editor's client, which presence names by the editor's name as it gave it (`editor`). */
function editorViewer(editor: () => string | null, viewer: Viewer): Viewer {
  return Object.defineProperty(viewer, 'who', {
    get: () => ({ kind: 'editor' as const, name: editor() ?? 'the editor' }),
    enumerable: true,
  });
}

/** One editor panel's viewer of a stop, sharing the run channel with the other local viewers. */
export class ClientPageView {
  private current: PageViewParams | null = null;
  private readonly held = new HeldInput();
  private readonly sender: FrameSender<PageFrame>;
  readonly viewer: Viewer;

  constructor(
    private readonly sessions: RunSessions,
    notify: (frame: PageFrame) => Promise<void>,
    editor: () => string | null = () => null,
  ) {
    this.viewer = editorViewer(editor, { frame: (frame) => this.frame(frame) });
    // The stop may have ended since the frame came, before the paced session change says so.
    this.sender = new FrameSender(
      notify,
      (frame) => this.matches(frame) && this.sessions.viewing(this.viewer, frame.ref, frame.worker, frame.since),
      () => this.dispose(),
    );
  }

  async watch(params: PageViewParams): Promise<RunControlResult> {
    if (!params || typeof params.on !== 'boolean') return { ok: false, message: 'Watching needs on or off.' };
    if (!params.on) {
      if (this.matches(params)) this.dispose();
      return { ok: true, message: 'You no longer watch the page.' };
    }
    this.dispose();
    this.current = { ...params };
    const own = this.current;
    const answer = await this.sessions.watch(params, this.viewer);
    if (this.current !== own) return { ok: false, message: 'The page view changed.' };
    if (!answer.ok) this.dispose();
    return answer;
  }

  /** Whether input naming this stop is this viewer's: the stop it watches. */
  takes(params: PageInputParams): boolean {
    return this.matches(params);
  }

  async input(params: PageInputParams): Promise<RunControlResult> {
    if (!this.matches(params)) return { ok: false, message: 'Input needs the page you are watching.' };
    const events = this.held.read(params);
    if (typeof events === 'string') return { ok: false, message: events };
    if (!events.length) return { ok: true, message: 'The input is released.' };
    return this.sessions.input(params, this.viewer, events);
  }

  /** A session changed: discard anything left of a stop that ended. */
  changed(): void {
    const own = this.current;
    if (own && !this.sessions.viewing(this.viewer, own.ref, own.worker, own.since)) this.dispose();
  }

  dispose(): void {
    const own = this.current;
    const events = this.held.release();
    if (own && events.length && this.sessions.viewing(this.viewer, own.ref, own.worker, own.since)) {
      void this.sessions.input(own, this.viewer, events);
    }
    this.current = null;
    this.sender.clear();
    this.sessions.unwatchAll(this.viewer);
  }

  private matches(at: { ref: string; worker: number; since: string } | null | undefined): boolean {
    const own = this.current;
    return !!own && !!at && own.ref === at.ref && own.worker === at.worker && own.since === at.since;
  }

  private frame(frame: PageFrame): void {
    if (this.matches(frame)) this.sender.send(frame);
  }
}

/**
 * One editor panel's viewer of a worker's lane (`piwi/laneView`): its frames, running or stopped, through its tests and
 * the workers Playwright starts in it, and its input at a stop of the lane's running test, which watching the lane
 * makes it a viewer of.
 */
export class ClientLaneView {
  private current: Omit<LaneViewParams, 'on'> | null = null;
  private readonly held = new HeldInput();
  /** The stop the input held down was sent to, which a release goes to. */
  private heldAt: PageInputParams | null = null;
  private readonly sender: FrameSender<LaneFrame>;
  readonly viewer: Viewer;

  constructor(
    private readonly sessions: RunSessions,
    notify: (frame: LaneFrame) => Promise<void>,
    editor: () => string | null = () => null,
  ) {
    this.viewer = editorViewer(editor, { frame: () => {}, laneFrame: (frame) => this.frame(frame) });
    // The lane's worker may have gone on or left since the frame came, before the paced session change says so.
    this.sender = new FrameSender(
      notify,
      (frame) => this.matches(frame) && this.sessions.laneFrameGoes(this.viewer, frame),
      () => this.dispose(),
    );
  }

  async watch(params: LaneViewParams): Promise<RunControlResult> {
    if (!params || typeof params.on !== 'boolean') return { ok: false, message: 'Watching needs on or off.' };
    if (typeof params.ref !== 'string' || !Number.isInteger(params.lane) || params.lane < 0) {
      return { ok: false, message: 'The command needs the run and the worker it watches.' };
    }
    if (!params.on) {
      if (this.matches(params)) this.dispose();
      return { ok: true, message: 'You no longer watch the worker.' };
    }
    this.dispose();
    this.current = { ref: params.ref, lane: params.lane };
    const own = this.current;
    const answer = await this.sessions.watchLane(params, this.viewer);
    if (this.current !== own) return { ok: false, message: 'The worker view changed.' };
    if (!answer.ok) this.dispose();
    return answer;
  }

  /** Whether input naming a stop is this viewer's: a stop of its lane's running test, which it watches. */
  takes(params: PageInputParams): boolean {
    const own = this.current;
    return (
      !!own &&
      params?.ref === own.ref &&
      typeof params.worker === 'number' &&
      typeof params.since === 'string' &&
      this.sessions.viewing(this.viewer, params.ref, params.worker, params.since)
    );
  }

  async input(params: PageInputParams): Promise<RunControlResult> {
    if (!this.takes(params)) return { ok: false, message: 'Input needs the page you are watching.' };
    if (this.heldAt && (this.heldAt.worker !== params.worker || this.heldAt.since !== params.since)) {
      this.releaseHeld();
    }
    const events = this.held.read(params);
    if (typeof events === 'string') return { ok: false, message: events };
    if (!events.length) return { ok: true, message: 'The input is released.' };
    this.heldAt = { ref: params.ref, worker: params.worker, since: params.since, events: [] };
    return this.sessions.input(params, this.viewer, events);
  }

  /** A session changed: a run that ended ends the watch. */
  changed(): void {
    const own = this.current;
    if (own && !this.sessions.watchesLane(this.viewer, own.ref, own.lane)) this.dispose();
  }

  dispose(): void {
    const own = this.current;
    this.releaseHeld();
    this.current = null;
    this.sender.clear();
    if (own) void this.sessions.watchLane({ ...own, on: false }, this.viewer);
  }

  /** What the input holds down is let go of, at the stop it was sent to while the viewer still watches it. */
  private releaseHeld(): void {
    const at = this.heldAt;
    const events = this.held.release();
    this.heldAt = null;
    if (at && events.length && this.sessions.viewing(this.viewer, at.ref, at.worker, at.since)) {
      void this.sessions.input(at, this.viewer, events);
    }
  }

  private matches(at: { ref: string; lane: number } | null | undefined): boolean {
    const own = this.current;
    return !!own && !!at && own.ref === at.ref && own.lane === at.lane;
  }

  private frame(frame: LaneViewFrame): void {
    if (!this.matches(frame)) return;
    const { ref, lane, worker, since } = frame;
    this.sender.send(
      'refused' in frame
        ? { ref, lane, worker, test: frame.test, since, refused: frame.refused }
        : { ref, lane, worker, test: frame.test, since, data: frame.data, width: frame.width, height: frame.height },
    );
  }
}
