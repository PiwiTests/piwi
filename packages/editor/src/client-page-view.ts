import {
  MAX_VIEW_EVENT_RATE,
  RateWindow,
  readViewInput,
  type ViewInput,
  type ViewButton,
} from '@piwitests/core/run-view';
import type { PageFrame, PageInputParams, PageViewParams, RunControlResult } from './protocol.js';
import type { RunSessions, Viewer } from './run-sessions.js';

/** One editor panel's viewer, sharing the run channel with the other local viewers. */
export class ClientPageView {
  private current: PageViewParams | null = null;
  private pending: PageFrame | null = null;
  private sending = false;
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<ViewButton>();
  private point = { x: 0, y: 0 };
  private readonly rate = new RateWindow(MAX_VIEW_EVENT_RATE);
  readonly viewer: Viewer = { frame: (frame) => this.frame(frame) };

  constructor(
    private readonly sessions: RunSessions,
    private readonly notify: (frame: PageFrame) => Promise<void>,
  ) {}

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

  async input(params: PageInputParams): Promise<RunControlResult> {
    if (!this.matches(params)) return { ok: false, message: 'Input needs the page you are watching.' };
    const events = params?.release === true ? this.releaseEvents() : readViewInput(params?.events);
    if (typeof events === 'string') return { ok: false, message: events };
    if (!events.length) return { ok: true, message: 'The input is released.' };
    if (!params.release && !this.rate.take(events.length))
      return { ok: false, message: 'Too many input events; try again.' };
    for (const event of events) {
      if (event.type === 'key' && event.action === 'down') this.keys.add(event.key);
      if (event.type === 'key' && event.action === 'up') this.keys.delete(event.key);
      if (event.type === 'mouse') {
        this.point = { x: event.x, y: event.y };
        if (event.action === 'down') this.buttons.add(event.button);
        if (event.action === 'up') this.buttons.delete(event.button);
      }
    }
    return this.sessions.input(params, this.viewer, events);
  }

  /** A session changed: discard anything left of a stop that ended. */
  changed(): void {
    const own = this.current;
    if (own && !this.sessions.viewing(this.viewer, own.ref, own.worker, own.since)) this.dispose();
  }

  dispose(): void {
    const own = this.current;
    const events = this.releaseEvents();
    if (own && events.length && this.sessions.viewing(this.viewer, own.ref, own.worker, own.since)) {
      void this.sessions.input(own, this.viewer, events);
    }
    this.current = null;
    this.pending = null;
    this.sessions.unwatchAll(this.viewer);
  }

  private releaseEvents(): ViewInput[] {
    const events: ViewInput[] = [
      ...[...this.buttons].map((button): ViewInput => ({ type: 'mouse', action: 'up', ...this.point, button })),
      ...[...this.keys].reverse().map((key): ViewInput => ({ type: 'key', action: 'up', key })),
    ];
    this.buttons.clear();
    this.keys.clear();
    return events;
  }

  private matches(at: { ref: string; worker: number; since: string } | null | undefined): boolean {
    const own = this.current;
    return !!own && !!at && own.ref === at.ref && own.worker === at.worker && own.since === at.since;
  }

  private frame(frame: PageFrame): void {
    if (!this.matches(frame)) return;
    this.pending = frame;
    if (!this.sending) void this.flush();
  }

  private async flush(): Promise<void> {
    this.sending = true;
    try {
      while (this.pending) {
        const frame = this.pending;
        this.pending = null;
        if (this.matches(frame)) await this.notify(frame);
      }
    } catch {
      this.dispose();
    } finally {
      this.sending = false;
    }
  }
}
