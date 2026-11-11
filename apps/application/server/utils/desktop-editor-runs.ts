/**
 * Desktop build: the runs of the editors of this machine, read for the app's own surfaces (the taskbar or Dock, the
 * window's title and the tray dot say a test of an editor's run waits at a stop), steered by none of them. The server
 * lists the editors' discovery files (`readLiveHubs`), connects to each live hub as a process of this machine, with no
 * `Origin`, its `hello` holding the hub's token from the file, and subscribes to observe (`subscribe` with `observe`):
 * a stop no pause bar shows never waits for it. A hub that refuses (an editor service that predates it) is not asked
 * again while it runs; one that closes or leaves the folder is let go, with its runs. The folder is read again every
 * `EDITOR_RUNS_READ_MS`.
 */
import { WebSocket } from 'ws';
import { parseHubMessage, type HubSession, type LiveHub } from '@piwitests/core/run-hub';

/** How often the editors' discovery files are read again. */
export const EDITOR_RUNS_READ_MS = 5_000;

/** A live run of an editor: the editor as it names itself, and the run as its hub tells it. */
export interface EditorRun {
  client: string | null;
  session: HubSession;
}

interface Followed {
  socket: WebSocket;
  client: string | null;
  sessions: Map<string, HubSession>;
}

export interface EditorRunsOptions {
  /** The live hubs of the editors' discovery files. */
  live(): LiveHub[];
  /** The editors' live runs changed. */
  changed(): void;
  readMs?: number;
}

export class EditorRuns {
  private readonly followed = new Map<string, Followed>();
  /** The hubs that refused a connection with no `Origin`, by address: an editor service that predates it. */
  private readonly refused = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: EditorRunsOptions) {}

  start(): void {
    this.read();
    this.timer = setInterval(() => this.read(), this.options.readMs ?? EDITOR_RUNS_READ_MS);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const followed of this.followed.values()) followed.socket.close();
    this.followed.clear();
  }

  /** The editors' runs that have not ended. */
  runs(): EditorRun[] {
    return [...this.followed.values()].flatMap((followed) =>
      [...followed.sessions.values()]
        .filter((session) => !session.ended)
        .map((session) => ({ client: followed.client, session })),
    );
  }

  private read(): void {
    if (this.closed) return;
    let live: LiveHub[];
    try {
      live = this.options.live();
    } catch {
      return;
    }
    const urls = new Set(live.map((hub) => hub.url));
    for (const url of this.refused) if (!urls.has(url)) this.refused.delete(url);
    for (const [url, followed] of this.followed) {
      if (urls.has(url)) continue;
      this.followed.delete(url);
      followed.socket.close();
      if (followed.sessions.size > 0) this.options.changed();
    }
    for (const hub of live) if (!this.followed.has(hub.url) && !this.refused.has(hub.url)) this.follow(hub);
  }

  private follow(hub: LiveHub): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(hub.url);
    } catch {
      return;
    }
    const followed: Followed = { socket, client: hub.client, sessions: new Map() };
    this.followed.set(hub.url, followed);
    const send = (message: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.on('unexpected-response', () => {
      this.refused.add(hub.url);
      socket.terminate();
    });
    socket.on('open', () => send({ type: 'hello', token: hub.token }));
    socket.on('message', (data) => {
      const message = parseHubMessage(String(data));
      if (!message) return;
      if (message.type === 'welcome') {
        followed.client = message.client ?? followed.client;
        send({ type: 'subscribe', id: 1, observe: true });
      } else if (message.type === 'session') {
        if (message.session.ended) followed.sessions.delete(message.session.ref);
        else followed.sessions.set(message.session.ref, message.session);
        this.options.changed();
      }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      if (this.followed.get(hub.url) !== followed) return;
      this.followed.delete(hub.url);
      if (followed.sessions.size > 0) this.options.changed();
    });
  }
}
