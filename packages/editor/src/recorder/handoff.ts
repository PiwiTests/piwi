/**
 * The record channel: the local socket the service listens on (a Unix socket in a folder only this user reads, a named
 * pipe on Windows), which every test run the service builds names in its environment (`PIWI_RECORD_CHANNEL`,
 * `@piwitests/core/ide-recorder`). A test paused in such a run (Piwi's pause bar at a breakpoint or at `page.pause()`)
 * asks it to record from there; the service asks the editor to take the recording (`onAttach`), whose `piwi/record`
 * names the hand-off, and the session then drives the test's page as it drives a launcher's browser: `handoffLauncher`
 * answers the recorder's calls the test relays as the launcher does (`RecorderHost`), and hands the test what the
 * session says. A hand-off the editor does not take in time is refused, with why.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IDE_PAUSED_MESSAGE,
  formatRecordChannel,
  lineReader,
  parseHandoffToEditor,
  type HandoffReason,
  type HandoffToTest,
  type IdeRecorderPaused,
} from '@piwitests/core/ide-recorder';
import { RecorderHost } from './host-state.js';
import type { LauncherEvents, LauncherFactory } from './sessions.js';

/** How long the editor may take to start a recording a test asked for before the test hears it will not. */
export const HANDOFF_WAIT_MS = 30_000;

/** A test that asked to record from where it is paused, until the editor takes it or it is refused. */
export interface Handoff {
  id: string;
  /** The file the test is paused in (absolute) and the 1-based line, the statement about to run. */
  file: string;
  line: number;
  reason: HandoffReason;
  /** The test's project's `testIdAttribute` and `baseURL`. */
  testIdAttribute: string | null;
  baseURL: string | null;
  socket: net.Socket;
  /** The lines the test sent before a session's launcher read them: none but `closed` is expected. */
  kept: string[];
  /** Where the test's next lines go: into `kept` until a session's launcher reads them. */
  deliver(line: string): void;
}

export interface RecordChannelOptions {
  /** A test asked to record: the editor is asked to take it, with `take`. */
  onAttach(handoff: Handoff): void;
  /** How long a hand-off waits for the editor; {@link HANDOFF_WAIT_MS} by default. */
  waitMs?: number;
}

/** The test's half of a refused or ended hand-off. */
function write(socket: net.Socket, message: HandoffToTest): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** Whether a token is the channel's, compared in constant time. */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RecordChannel {
  private readonly pending = new Map<string, { handoff: Handoff; timer: ReturnType<typeof setTimeout> }>();
  private folder: string | null = null;

  private constructor(
    private readonly server: net.Server,
    readonly path: string,
    readonly token: string,
    private readonly options: RecordChannelOptions,
  ) {}

  /** The value of `PIWI_RECORD_CHANNEL` for a run's environment. */
  get value(): string {
    return formatRecordChannel({ path: this.path, token: this.token });
  }

  /** Listens on a new socket; null when the machine refuses one, and no run can then record from a pause. */
  static async open(options: RecordChannelOptions): Promise<RecordChannel | null> {
    const token = randomBytes(24).toString('base64url');
    let folder: string | null = null;
    let socketPath: string;
    if (process.platform === 'win32') {
      socketPath = `\\\\.\\pipe\\piwi-record-${randomBytes(12).toString('hex')}`;
    } else {
      // A folder only this user can read: no other user reaches the socket.
      folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piwi-record-')).catch(() => null);
      if (!folder) return null;
      socketPath = path.join(folder, 'channel.sock');
    }
    const server = net.createServer();
    const channel = new RecordChannel(server, socketPath, token, options);
    channel.folder = folder;
    server.on('connection', (socket) => channel.accept(socket));
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(socketPath, () => resolve(true));
    });
    if (!listening) {
      channel.close();
      return null;
    }
    server.unref();
    return channel;
  }

  /** The hand-off a `piwi/record` names, taken out of the waiting ones; null when there is none or it timed out. */
  take(id: string): Handoff | null {
    const waiting = this.pending.get(id);
    if (!waiting) return null;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    return waiting.handoff;
  }

  /** Refuses a waiting hand-off, with why. */
  refuse(id: string, message: string): void {
    const handoff = this.take(id);
    if (!handoff) return;
    write(handoff.socket, { type: 'refused', message });
    handoff.socket.end();
  }

  close(): void {
    for (const id of this.pending.keys()) this.refuse(id, 'The editor service stopped.');
    this.server.close();
    if (this.folder) fs.rmSync(this.folder, { recursive: true, force: true });
  }

  /** A test connected: its first line must be an attach with the token; anything else closes it. */
  private accept(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let handoff: Handoff | null = null;
    const read = lineReader(
      (line) => {
        if (handoff) {
          handoff.deliver(line);
          return;
        }
        const message = parseHandoffToEditor(line);
        if (message?.type !== 'attach' || !sameToken(message.token, this.token)) {
          socket.destroy();
          return;
        }
        handoff = {
          id: randomBytes(12).toString('hex'),
          file: message.file,
          line: message.line,
          reason: message.reason,
          testIdAttribute: message.testIdAttribute,
          baseURL: message.baseURL,
          socket,
          kept: [],
          deliver: (early) => handoff?.kept.push(early),
        };
        const id = handoff.id;
        const timer = setTimeout(
          () => this.refuse(id, 'the editor did not start the recording in time.'),
          this.options.waitMs ?? HANDOFF_WAIT_MS,
        );
        timer.unref?.();
        this.pending.set(id, { handoff, timer });
        this.options.onAttach(handoff);
      },
      () => socket.destroy(),
    );
    socket.on('data', read);
    socket.on('close', () => {
      if (handoff) this.take(handoff.id);
    });
    socket.on('error', () => socket.destroy());
  }
}

/**
 * The launcher of a session recording a test's page: the session's messages and the test's lines, translated. `start`
 * makes the recorder's host and has the test load the bundle; each call of the binding the test relays is answered by
 * the host, from the recording's page or as outside it; a pause and the stop reach the recorder in the page. The test
 * closing the channel is the launcher's exit.
 */
export function handoffLauncher(handoff: Handoff): LauncherFactory {
  return (_cwd: string, events: LauncherEvents) => {
    const { socket } = handoff;
    let host: RecorderHost | null = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      events.exit(0, null);
    };
    const dispatch = (message: unknown) => write(socket, { type: 'dispatch', message });
    const onLine = (line: string) => {
      const message = parseHandoffToEditor(line);
      if (!message) return;
      switch (message.type) {
        case 'loaded':
          return events.message({ type: 'started' });
        case 'binding': {
          const value = !host
            ? null
            : message.outside
              ? host.handleOutside(message.payload)
              : host.handle(message.payload);
          return write(socket, { type: 'answer', call: message.call, value });
        }
        case 'notice':
          return events.message({ type: 'notice', message: message.message });
        case 'closed':
          return events.message({ type: 'closed' });
      }
    };
    handoff.deliver = onLine;
    socket.on('close', end);
    for (const line of handoff.kept.splice(0)) onLine(line);
    if (socket.destroyed) queueMicrotask(end);
    return {
      send: (message) => {
        if (message.type === 'start') {
          host = new RecorderHost({
            language: message.request.language,
            settings: message.request.settings,
            startedAt: message.request.startedAt,
            onEvent: (event) => events.message({ type: 'event', event }),
            onStopped: () => events.message({ type: 'stopped-in-browser' }),
            onPaused: (paused) => events.message({ type: 'paused', paused }),
          });
          write(socket, { type: 'load', bundle: message.request.bundle });
        } else if (message.type === 'pause') {
          host?.setPaused(message.paused);
          dispatch({ type: IDE_PAUSED_MESSAGE, paused: message.paused } satisfies IdeRecorderPaused);
        } else if (message.type === 'stop') {
          // The recorder in the page stops, and answers as outside a recording once the test hears the stop.
          dispatch({ type: 'piwi-recording-stopped' });
          write(socket, { type: 'stop' });
          socket.end();
        }
      },
      kill: () => socket.destroy(),
    };
  };
}
