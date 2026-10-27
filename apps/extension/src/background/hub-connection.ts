/**
 * One connection to an editor service's hub (`@piwitests/core/run-hub`), from the background worker alone: the
 * WebSocket the editor's live endpoint named, `hello` with its token, `subscribe` once welcomed, then each run as the
 * hub pushes it. Every message is read with `parseHubMessage`, field by field; one it cannot read is left aside, as a
 * newer hub's would be. A command waits for the answer of its `id`, and is answered by the worker itself when the
 * connection closes or the hub stays silent. The hub sends `keepalive` every `keepaliveMs`: a connection that hears
 * nothing for two of them and a bit is closed as silent.
 */
import {
  HUB_CLOSE,
  parseHubMessage,
  type HubAnswer,
  type HubCommand,
  type HubSession,
  type HubWelcome,
  type LiveHub,
} from '@piwitests/core/run-hub';
import type { RunsAnswer } from '../shared/runs.js';

/** What a connection uses of the browser's WebSocket; a unit test hands over its own. */
export interface HubSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type OpenSocket = (url: string) => HubSocket;

/** The browser's own WebSocket, as a {@link HubSocket}. The browser sends the extension's origin with it. */
export function browserSocket(url: string): HubSocket {
  const ws = new WebSocket(url);
  const socket: HubSocket = {
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (event) => socket.onopen?.(event);
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = (event) => socket.onclose?.({ code: event.code });
  ws.onerror = (event) => socket.onerror?.(event);
  return socket;
}

/**
 * Why a connection ended: the hub refused the token (`refused`), its service stopped (`stopped`), it stayed silent
 * (`silent`), or the socket closed or never opened (`closed`).
 */
export type HubLoss = 'refused' | 'stopped' | 'silent' | 'closed';

/** A command without its `id`, which the connection gives it. */
export type HubRequest = HubCommand extends infer C ? (C extends HubCommand ? Omit<C, 'id'> : never) : never;

export interface HubConnectionEvents {
  /** Its state or a run changed. */
  changed(): void;
  /** A run ended, as the hub said last; `sessions` still holds it as it was before. */
  ended(session: HubSession): void;
  /** The connection closed by itself. */
  lost(why: HubLoss): void;
}

export interface HubTimings {
  /** How long a command waits for its answer; the hub takes up to 10 s for an image. */
  answerMs: number;
  /** How long the socket may take to open and the hub to welcome it. */
  welcomeMs: number;
  /** Past the hub's own keepalive interval, how long silence is taken as a hub still there. */
  silenceSlackMs: number;
}

const TIMINGS: HubTimings = { answerMs: 15_000, welcomeMs: 10_000, silenceSlackMs: 10_000 };

const MAX_ID = 2_147_483_647;

export class HubConnection {
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  welcome: HubWelcome | null = null;
  /** The live runs, by ref. */
  readonly sessions = new Map<string, HubSession>();
  /** Resolves once the runs live at `subscribe` were heard, or the connection closed. */
  readonly ready: Promise<void>;

  private readonly socket: HubSocket;
  private readonly pending = new Map<
    number,
    { resolve(answer: RunsAnswer): void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private subscribeId = 0;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private silenceMs = 0;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private loss: HubLoss | null = null;
  private markReady: () => void = () => {};

  constructor(
    readonly hub: LiveHub,
    open: OpenSocket,
    private readonly events: HubConnectionEvents,
    private readonly timings: HubTimings = TIMINGS,
  ) {
    this.ready = new Promise((resolve) => (this.markReady = resolve));
    this.welcomeTimer = setTimeout(() => this.drop('closed'), timings.welcomeMs);
    let socket: HubSocket;
    try {
      socket = open(hub.url);
    } catch {
      // An address the browser refuses to open: as a socket that closed.
      this.socket = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
      queueMicrotask(() => this.closed());
      return;
    }
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: hub.token }));
    socket.onmessage = (event) => this.heard(event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => this.closed(event.code);
  }

  /** Sends a command; answered once, by the hub or, when it cannot be, by the connection. */
  command(request: HubRequest): Promise<RunsAnswer> {
    if (this.state !== 'open') return Promise.resolve({ ok: false, message: '', failure: 'offline' });
    const id = this.nextId;
    this.nextId = id >= MAX_ID ? 1 : id + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, message: '', failure: 'timeout' });
      }, this.timings.answerMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.socket.send(JSON.stringify({ ...request, id }));
      } catch {
        // A socket closing under the command: its close answers it.
      }
    });
  }

  /** Closes the connection; it reports no loss. */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.close(1000, 'Piwi Picker closed the connection.');
    this.closed();
  }

  private heard(data: unknown): void {
    if (typeof data !== 'string' || this.state === 'closed') return;
    const message = parseHubMessage(data);
    if (!message) return;
    this.listen();
    if (!this.welcome) {
      if (message.type !== 'welcome') return;
      this.welcome = message;
      this.state = 'open';
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      this.silenceMs = message.keepaliveMs * 2 + this.timings.silenceSlackMs;
      this.listen();
      this.subscribeId = this.nextId;
      void this.command({ type: 'subscribe' }).then(() => this.markReady());
      this.events.changed();
      return;
    }
    switch (message.type) {
      case 'answer':
        return this.answered(message);
      case 'session': {
        const { session } = message;
        if (session.ended) {
          this.events.ended(session);
          this.sessions.delete(session.ref);
        } else {
          this.sessions.set(session.ref, session);
        }
        this.events.changed();
        return;
      }
      default:
        // keepalive, or a second welcome: nothing to do but the silence timer, set again above.
        return;
    }
  }

  private answered(answer: HubAnswer): void {
    const waiting = this.pending.get(answer.id);
    if (!waiting) return;
    this.pending.delete(answer.id);
    clearTimeout(waiting.timer);
    if (answer.id === this.subscribeId) {
      // The hub sends the runs live now right after this answer, each in its own message.
      setTimeout(() => waiting.resolve(answer), 50);
      return;
    }
    const { ok, message, image } = answer;
    waiting.resolve(image === undefined ? { ok, message } : { ok, message, image });
  }

  /** Hears the hub: the silence timer starts again. */
  private listen(): void {
    if (!this.silenceMs) return;
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => this.drop('silent'), this.silenceMs);
  }

  /** Closes the socket for `why`, which `lost` reports. */
  private drop(why: HubLoss): void {
    if (this.state === 'closed') return;
    this.loss = why;
    this.socket.close(1000, 'Piwi Picker heard nothing.');
    this.closed();
  }

  private closed(code?: number): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of [this.silence, this.welcomeTimer]) if (timer) clearTimeout(timer);
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve({ ok: false, message: '', failure: 'offline' });
    }
    this.pending.clear();
    this.sessions.clear();
    this.markReady();
    if (this.disposed) return;
    const why: HubLoss =
      this.loss ?? (code === HUB_CLOSE.unauthorized ? 'refused' : code === HUB_CLOSE.goingAway ? 'stopped' : 'closed');
    this.events.lost(why);
    this.events.changed();
  }
}
