/**
 * The hub's WebSocket, for Piwi Picker (`@piwitests/core/run-hub`): the runs the editor started, as the run sessions
 * hold them (`run-sessions.ts`), followed and steered from the developer's own browser. It listens on `127.0.0.1`
 * alone, on a free port; a handshake is taken only on `HUB_PATH`, with the hub's own `Host` and a browser extension's
 * `Origin`, and refused with a status before any WebSocket opens. The first message must be `hello` with the token,
 * compared in constant time, within `HUB_HELLO_MS`. The token is in the service's discovery file, which only this
 * user reads, and the editor's Send to editor endpoint lists it to a request carrying the pairing's token: the paired
 * Piwi Picker, and any process of this user that holds that token (the runs the editor starts name it in
 * `PIWI_EDITOR_SEND`). Another user's processes and web pages are kept out; this user's own processes are not a
 * boundary. A command is one of a closed set, checked field by field and answered once; nothing it asks evaluates
 * code, reads a file or reaches an instance. A subscribed connection hears every run as the editor does, and counts as
 * a surface that answers stops: while one is, a stop no pause bar shows waits for it. The code actions it starts at a
 * stop (Assert, Assert a region, Mock a request, `stop-actions.ts`) write their code in the editor, through its
 * client: the answer says whether they started, never the code, and each subscribed connection hears what each one came
 * to, whichever surface started it (`code`: the sentence the client shows and the code's warnings, or why it was
 * refused once it started). A connection watches a stopped page's live view (`view`): its frames come to it alone, at
 * most `MAX_VIEW_FPS` a second, the latest one once its socket is no longer backed up, none of a stop that ended or it
 * stopped watching; it plays its input on the page it watches (`input`, at most `MAX_VIEW_EVENT_RATE` events a
 * second), and starts there, at a stop no pause bar shows, the intents the bar's buttons start (`stop.intents` in each
 * session it hears says which a stop takes from it). The hub keeps no frame. Any connection picks the element under a
 * point of an image of a stopped page (`pick-at`). A connection the hub closes is cut a second later when the other
 * side does not answer the close, and only the open connections count toward its limits.
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  HUB_CLOSE,
  HUB_HELLO_MS,
  HUB_KEEPALIVE_MS,
  HUB_PATH,
  MAX_HUB_CLIENT,
  MAX_HUB_COMMAND,
  MAX_HUB_FRAME,
  MAX_HUB_MESSAGE,
  MAX_HUB_PENDING,
  MAX_HUB_PROJECT,
  MAX_HUB_ROOTS,
  MAX_HUB_WARNINGS,
  isExtensionOrigin,
  isHubHost,
  parseHubCommand,
  parseHubHello,
  type HubCodeIntent,
  type HubIntent,
  type HubMessage,
  type HubSession,
  type ParsedHubCommand,
} from '@piwitests/core/run-hub';
import { LatestPacer, MAX_VIEW_EVENT_RATE, MAX_VIEW_FPS, RateWindow } from '@piwitests/core/run-view';
import type { RunControlResult, RunSession } from './protocol.js';
import { sameToken } from './recorder/handoff.js';
import type { RunSessions, ViewFrame, Viewer } from './run-sessions.js';
import type { StopActions, StopOutcome } from './stop-actions.js';

/** The connections a hub holds at once, and those among them that did not say `hello` yet. */
const MAX_CONNECTIONS = 16;
const MAX_UNAUTHENTICATED = 8;
/** What a connection may leave unread before it is dropped, in bytes. */
const MAX_BUFFERED = 32 * 1024 * 1024;
/** How long a connection the hub closes has to answer the close before it is cut. */
const CLOSE_GRACE_MS = 1_000;
/** What a connection may leave unread before a frame waits for it, in bytes: the latest frame alone waits. */
const MAX_VIEW_BUFFERED = 1024 * 1024;
/** The workers a connection keeps the pace of frames for: the oldest is forgotten past it. */
const MAX_VIEW_PACERS = 32;

/** What a run session's view lacks for the Runs page: the command, the folder's label and the project. */
export interface HubRunInfo {
  command: string | null;
  label: string | null;
  project: string | null;
}

export interface RunHubOptions {
  sessions: RunSessions;
  /** The actions a stop takes: the intents, the responses the test kept and the one to mock. */
  actions: Pick<StopActions, 'action' | 'requests'>;
  /** What the Runs page shows of a run beside its workers. */
  runInfo(ref: string, root: string | null): HubRunInfo;
  /** What `welcome` says of the service. */
  welcome(): { pid: number; version: string; client: string | null; roots: string[] };
  /** A subscribed connection came or went: whether a stop no pause bar shows can be answered changed. */
  surfacesChanged(): void;
  keepaliveMs?: number;
  helloMs?: number;
}

interface Connection {
  socket: WebSocket;
  authenticated: boolean;
  subscribed: boolean;
  pending: number;
  /** It answered the last ping. */
  alive: boolean;
  /** It is cut once `CLOSE_GRACE_MS` passed, unless it closed by then. */
  cutting: boolean;
  /** It, as a viewer of the live views it watches. */
  viewer: Viewer;
  /** The pace of the frames it is sent, by run and worker: the latest one waits, no other. */
  frames: Map<string, LatestPacer<ViewFrame>>;
  /** The input it sends, in events a second. */
  input: RateWindow;
}

/** Cut a connection being closed once `CLOSE_GRACE_MS` passed, unless the other side closed it by then. */
function cutSoon(connection: Connection): void {
  if (connection.cutting) return;
  connection.cutting = true;
  setTimeout(() => connection.socket.terminate(), CLOSE_GRACE_MS).unref();
}

/** Close a connection saying why, cut if the other side does not answer the close. */
function closeWith(connection: Connection, code: number, reason: string): void {
  connection.socket.close(code, reason);
  cutSoon(connection);
}

/** A handshake refused before any WebSocket opens: the status alone, and the socket closed once it is sent. */
function refuse(socket: Duplex, status: number, reason: string): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** `text`, cut to `max` characters with the cut marked; null stays null. */
function cut(text: string | null, max: number): string | null {
  return text !== null && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A text frame's text. */
function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class RunHub {
  private readonly connections = new Set<Connection>();
  private readonly keepalive: ReturnType<typeof setInterval>;

  private constructor(
    private readonly server: http.Server,
    private readonly sockets: WebSocketServer,
    readonly port: number,
    readonly token: string,
    private readonly options: RunHubOptions,
  ) {
    this.keepalive = setInterval(() => this.beat(), options.keepaliveMs ?? HUB_KEEPALIVE_MS);
    this.keepalive.unref();
  }

  /** The address Piwi Picker connects to: `ws://127.0.0.1:<port>/piwi/hub`. */
  get url(): string {
    return `ws://127.0.0.1:${this.port}${HUB_PATH}`;
  }

  /** Listens on a free port of `127.0.0.1`; null when the machine refuses one. */
  static async open(options: RunHubOptions): Promise<RunHub | null> {
    // Headers that take longer than 5 s, checked each second, or hold more than 8 KiB close the connection.
    const server = http.createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, (_req, res) => {
      res.writeHead(426, { Connection: 'close', 'Content-Length': '0' });
      res.end();
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 64;
    const sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_HUB_FRAME,
      perMessageDeflate: false,
      clientTracking: false,
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, '127.0.0.1', () => resolve(true));
    });
    if (!listening) {
      server.close();
      return null;
    }
    server.on('error', () => {});
    server.on('clientError', (_error, socket) => socket.destroy());
    server.unref();
    const port = (server.address() as AddressInfo).port;
    const hub = new RunHub(server, sockets, port, randomBytes(24).toString('base64url'), options);
    server.on('upgrade', (req, socket, head) => hub.upgrade(req, socket, head));
    return hub;
  }

  /** Whether a connection follows the runs, and so can answer a stop. */
  answersStops(): boolean {
    for (const connection of this.connections) if (connection.subscribed) return true;
    return false;
  }

  /** A run changed: every subscribed connection hears it, with what each stop takes from it. */
  push(session: RunSession): void {
    let view: HubSession | null = null;
    for (const connection of this.connections) {
      if (!connection.subscribed) continue;
      view ??= this.view(session);
      this.send(connection, { type: 'session', session: this.forViewer(view, connection) });
    }
  }

  /** A session as one connection hears it: each stop with what it takes from that connection now. */
  private forViewer(session: HubSession, connection: Connection): HubSession {
    const { sessions } = this.options;
    return {
      ...session,
      workers: session.workers.map((worker) =>
        worker.stop
          ? {
              ...worker,
              stop: { ...worker.stop, intents: sessions.stopIntentsOf(session.ref, worker.worker, connection.viewer) },
            }
          : worker,
      ),
    };
  }

  /** A connection started or stopped watching a stop of a run: it hears the run again, with what its stops take now. */
  private resend(connection: Connection, ref: string): void {
    if (!connection.subscribed) return;
    const session = this.options.sessions.current().find((s) => s.ref === ref);
    if (session) this.send(connection, { type: 'session', session: this.forViewer(this.view(session), connection) });
  }

  /**
   * A frame of a live view a connection watches: sent at most `MAX_VIEW_FPS` a second for each worker, the latest one
   * once the connection's socket left less than `MAX_VIEW_BUFFERED` unread, and only while the connection watches the
   * stop it shows.
   */
  private frame(connection: Connection, frame: ViewFrame): void {
    const key = `${frame.ref} ${frame.worker}`;
    let pacer = connection.frames.get(key);
    if (!pacer) {
      pacer = new LatestPacer<ViewFrame>({
        intervalMs: 1000 / MAX_VIEW_FPS,
        busy: () => connection.socket.bufferedAmount > MAX_VIEW_BUFFERED,
        send: (latest) => {
          // A frame of a stop that ended, or that the connection stopped watching, waits no more.
          if (this.options.sessions.viewing(connection.viewer, latest.ref, latest.worker, latest.since)) {
            this.send(connection, { type: 'frame', ...latest });
          }
        },
      });
      connection.frames.set(key, pacer);
      for (const [oldest, old] of connection.frames) {
        if (connection.frames.size <= MAX_VIEW_PACERS) break;
        old.close();
        connection.frames.delete(oldest);
      }
    }
    pacer.offer(frame);
  }

  /** What an action that writes code came to: every subscribed connection hears its sentence, never its code. */
  code(outcome: StopOutcome): void {
    const warnings = outcome.warnings.slice(0, MAX_HUB_WARNINGS).map((w) => cut(w, MAX_HUB_MESSAGE)!);
    const message: HubMessage = {
      type: 'code',
      ref: outcome.ref,
      worker: outcome.worker,
      since: outcome.since,
      action: outcome.action,
      ok: outcome.ok,
      message: cut(outcome.message, MAX_HUB_MESSAGE)!,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    for (const connection of this.connections) if (connection.subscribed) this.send(connection, message);
  }

  /** The service stops: every connection is closed, saying so. */
  close(): void {
    clearInterval(this.keepalive);
    for (const connection of this.connections)
      closeWith(connection, HUB_CLOSE.goingAway, 'The editor service stopped.');
    this.connections.clear();
    this.server.close();
    this.server.closeAllConnections();
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    if (req.url !== HUB_PATH) return refuse(socket, 404, 'Not Found');
    // Another name for this machine (a page's DNS rebinding) or a page's origin never opens a WebSocket.
    if (!isHubHost(req.headers.host, this.port) || !isExtensionOrigin(req.headers.origin)) {
      return refuse(socket, 403, 'Forbidden');
    }
    // A connection being closed, however its close began (the other side's, a frame the library refused), holds no
    // place: it is cut within `CLOSE_GRACE_MS`.
    const open = [...this.connections].filter((c) => {
      if (c.socket.readyState === c.socket.OPEN) return true;
      cutSoon(c);
      return false;
    });
    const unauthenticated = open.filter((c) => !c.authenticated).length;
    if (open.length >= MAX_CONNECTIONS || unauthenticated >= MAX_UNAUTHENTICATED) {
      return refuse(socket, 503, 'Service Unavailable');
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      authenticated: false,
      subscribed: false,
      pending: 0,
      alive: true,
      cutting: false,
      viewer: { frame: (frame) => this.frame(connection, frame) },
      frames: new Map(),
      input: new RateWindow(MAX_VIEW_EVENT_RATE),
    };
    this.connections.add(connection);
    const hello = setTimeout(
      () => closeWith(connection, HUB_CLOSE.helloTimeout, 'No hello in time.'),
      this.options.helloMs ?? HUB_HELLO_MS,
    );
    hello.unref();
    socket.on('message', (data: RawData, binary: boolean) => {
      // A connection being closed reads nothing more, the frames it sent with the one that closed it included.
      if (socket.readyState !== socket.OPEN) return;
      if (binary) return closeWith(connection, HUB_CLOSE.unsupported, 'Text frames only.');
      const text = textOf(data);
      if (!connection.authenticated) {
        const token = parseHubHello(text);
        if (token === null || !sameToken(token, this.token)) {
          return closeWith(connection, HUB_CLOSE.unauthorized, 'Not paired.');
        }
        clearTimeout(hello);
        connection.authenticated = true;
        const { client, roots, ...service } = this.options.welcome();
        this.send(connection, {
          type: 'welcome',
          ...service,
          client: cut(client, MAX_HUB_CLIENT),
          roots: roots.slice(0, MAX_HUB_ROOTS),
          keepaliveMs: this.options.keepaliveMs ?? HUB_KEEPALIVE_MS,
        });
        return;
      }
      const command = parseHubCommand(text);
      if (!command) return closeWith(connection, HUB_CLOSE.malformed, 'Not a command.');
      void this.answer(connection, command);
    });
    socket.on('pong', () => {
      connection.alive = true;
    });
    // A frame too long, or text that is not UTF-8: the library closes the connection with its code (1009, 1007).
    socket.on('error', () => cutSoon(connection));
    socket.on('close', () => {
      clearTimeout(hello);
      this.connections.delete(connection);
      // It watches nothing any more: the last viewer of a stop has its view stop.
      this.options.sessions.unwatchAll(connection.viewer);
      for (const pacer of connection.frames.values()) pacer.close();
      connection.frames.clear();
      if (connection.subscribed) this.options.surfacesChanged();
    });
  }

  private async answer(connection: Connection, command: ParsedHubCommand): Promise<void> {
    const reply = (result: RunControlResult, extra: Record<string, unknown> = {}) =>
      this.send(connection, {
        type: 'answer',
        id: command.id,
        ok: result.ok,
        message: cut(result.message, MAX_HUB_MESSAGE)!,
        ...extra,
      });
    if (command.type === 'unknown') {
      return reply({ ok: false, message: `Piwi does not know the command ${JSON.stringify(command.what)}.` });
    }
    if (command.type === 'invalid') return reply({ ok: false, message: command.message });
    if (connection.pending >= MAX_HUB_PENDING) {
      return reply({ ok: false, message: 'Too many commands at once: wait for their answers.' });
    }
    connection.pending++;
    try {
      const { sessions } = this.options;
      switch (command.type) {
        case 'subscribe': {
          const live = sessions.current();
          const first = !connection.subscribed;
          connection.subscribed = true;
          reply({ ok: true, message: live.length === 1 ? 'Following 1 run.' : `Following ${live.length} runs.` });
          for (const session of live) {
            this.send(connection, { type: 'session', session: this.forViewer(this.view(session), connection) });
          }
          if (first) this.options.surfacesChanged();
          return;
        }
        case 'runControl':
          if (command.action !== 'pause' && command.since === null) {
            return reply({ ok: false, message: 'The command needs the stop it answers.' });
          }
          return reply(
            sessions.control({
              ref: command.ref,
              worker: command.worker,
              action: command.action,
              since: command.since,
            }),
          );
        case 'pausedPage': {
          const { image } = await sessions.pausedPage({ ref: command.ref, worker: command.worker, what: 'image' });
          return reply(
            image
              ? { ok: true, message: 'The stopped page.' }
              : {
                  ok: false,
                  message:
                    'No image: the worker is not stopped, cannot tell which page it stopped in, or did not answer in time.',
                },
            { image },
          );
        }
        case 'requests': {
          const listed = await this.options.actions.requests({
            ref: command.ref,
            worker: command.worker,
            since: command.since,
          });
          return reply(listed, { requests: listed.requests });
        }
        case 'mock':
          return reply(
            await this.options.actions.action({
              ref: command.ref,
              worker: command.worker,
              since: command.since,
              action: 'mock',
              request: command.request,
            }),
          );
        case 'view': {
          const { ref, worker, since, on } = command;
          const watched = await sessions.watch({ ref, worker, since, on }, connection.viewer);
          reply(watched);
          return this.resend(connection, ref);
        }
        case 'input': {
          if (!connection.input.take(command.events.length)) {
            return reply({ ok: false, message: `Too much input: ${MAX_VIEW_EVENT_RATE} events a second at most.` });
          }
          const { ref, worker, since } = command;
          return reply(await sessions.input({ ref, worker, since }, connection.viewer, command.events));
        }
        case 'pick-at': {
          const { ref, worker, since, x, y } = command;
          const picked = await sessions.pickAt({ ref, worker, since, x, y });
          return reply(picked, { locator: picked.locator });
        }
        default:
          return reply(
            await this.options.actions.action(
              {
                ref: command.ref,
                worker: command.worker,
                since: command.since,
                action: command.type as HubIntent | HubCodeIntent,
              },
              connection.viewer,
            ),
          );
      }
    } finally {
      connection.pending--;
    }
  }

  /** A session as the Runs page reads it. */
  private view(session: RunSession): HubSession {
    const info = this.options.runInfo(session.ref, session.root);
    return {
      ref: session.ref,
      root: session.root,
      label: info.label,
      command: cut(info.command, MAX_HUB_COMMAND),
      project: cut(info.project, MAX_HUB_PROJECT),
      workers: session.workers.map(({ takes: _takes, ...worker }) => ({
        ...worker,
        intents: this.options.sessions.intentsOf(session.ref, worker.worker),
      })),
      ended: session.ended,
    };
  }

  /** Send a message; a connection that left more than `MAX_BUFFERED` unread is dropped. */
  private send(connection: Connection, message: HubMessage): void {
    const { socket } = connection;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message));
  }

  /** Each authenticated connection hears a keepalive; one that did not answer the last ping is dropped. */
  private beat(): void {
    for (const connection of this.connections) {
      if (!connection.authenticated) continue;
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
      this.send(connection, { type: 'keepalive' });
    }
  }
}
