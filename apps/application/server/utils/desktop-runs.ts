/**
 * Desktop build: the hub of the Playwright runs the desktop shell starts, in a project's linked folder or a worktree
 * of it (a plain run, a reproduction, a bisect step, a Flake Lab run, a bug report's run). The shell names this
 * server's run channel in each run's environment (`PIWI_RUN_CHANNEL`, read from `GET /api/desktop/run-channel`) and
 * the run's name on it (`PIWI_RUN_REF`, `desktop-<the shell's run id>`): each worker keeps a run connection there.
 * Every piece is the editor service's own run control (`@piwitests/editor/run-host`), wired to the desktop's surfaces:
 *  - the channel is the editor's socket (a Unix socket in a new folder only this user reads, a named pipe on Windows),
 *    which takes a run connection only with its token, compared in constant time; a recording's hand-off is refused,
 *    as no editor here takes one;
 *  - the hub is the editor's WebSocket for Piwi Picker, on `127.0.0.1` alone, with its `Host` and extension `Origin`
 *    checks, its limits, its keepalive and its closed set of commands; `hello` carries the desktop token, which the
 *    paired Piwi Picker holds since **Allow**, and `GET /api/desktop/live` names the hub to a request carrying it;
 *  - the app's window is a peer of that hub (`RunHub.join`) through routes behind the desktop guard: it hears what
 *    Piwi Picker hears, sends the same commands, and alone receives the code made at a stop, to copy (`stop-code`);
 *  - a failure no pause bar shows is held in a run the person opened in the window (`show`), or while a Runs window of
 *    Piwi Picker follows the runs (`follow`); otherwise it goes on at once, and always in a run nobody attends (a Flake
 *    Lab, a bisect, a lab job, a run repeating its tests or in UI mode: its ref ends in `-unattended`), whose workers
 *    hear that they hold no failure;
 *  - the code from a stop is rendered by the editor's generator from the file as it is on disk, for a file of a
 *    linked folder alone, and refused once the file was written since the run's first worker connected (`RunLines`).
 * Pick and Record in the test's window, and Assert, end in an editor (its Send to editor pairing, its recorder), which
 * this server has none of: they are refused here, and a pick on an image of the stop (`pick-at`) answers with the
 * locator it found. The runs name this server as where their picks go (`PIWI_EDITOR_SEND`, `DESKTOP_PICKS_PATH`): a
 * locator the pause bar's **Pick a locator** or a pick on the image picked comes to the window, to copy (`pick`).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHubCommand, type HubAnswer, type LiveHub } from '@piwitests/core/run-hub';
import type { RunIntent } from '@piwitests/core/run-channel';
import {
  MAX_HUB_BUFFERED,
  RecordChannel,
  RunHub,
  RunLines,
  RunSessions,
  StopActions,
  expectModuleOf,
  siblingSpecs,
  type DiskFile,
  type HubPeer,
  type StopTarget,
} from '@piwitests/editor/run-host';
import {
  DESKTOP_PICKS_PATH,
  MAX_KEPT_STOP_CODES,
  isDesktopRunViewer,
  isUnattendedDesktopRun,
  type DesktopRunEvent,
  type DesktopRunPick,
} from '#shared/desktop-runs';
import { desktopLinkedFolders, type DesktopLink } from './desktop-links';

/** What the hub's `welcome` and `GET /api/desktop/live` call this server. */
export const DESKTOP_HUB_CLIENT = 'Piwi desktop app';

/** The window streams open at once; one more is refused. */
const MAX_WINDOWS = 16;

/** A run's name on the channel, as the hub's commands name it. */
const REF = /^[\w-]{1,64}$/;

/** The intents of the editor's that this server refuses at every stop, and why. */
const DECLINED: Partial<Record<RunIntent, string>> = {
  pick:
    "Pick a locator in the test's window sends the locator to an editor, and the desktop app has none: pick on the " +
    'image of the stop instead, which answers with the locator.',
  record:
    'Record here records into an editor, and the desktop app has none: run the test from VS Code or a JetBrains IDE ' +
    'to record from its stop.',
  assert:
    "Assert makes its check with an editor's recorder, and the desktop app has none: assert a region instead, or run " +
    'the test from VS Code or a JetBrains IDE.',
};

/** What a window's stream takes: the events, what it holds unsent in bytes, and its end. */
export interface DesktopRunSink {
  send(event: DesktopRunEvent): void;
  buffered(): number;
  close(): void;
}

export interface DesktopRunsOptions {
  /** The desktop token: the hub's `hello` carries it. */
  token: string;
  /** The app's version, as the hub's `welcome` names it. */
  version: string;
  /** The folders linked to projects now; the discovery file's by default. */
  links?(): DesktopLink[];
  /** The name of a Piwi project, for what Piwi Picker shows of a run. */
  projectName?(id: number): Promise<string | null>;
  /** A sentence for the server's log. */
  log?(message: string): void;
  keepaliveMs?: number;
  helloMs?: number;
  lingerMs?: number;
  requestMs?: number;
}

interface RunWindow {
  peer: HubPeer;
  sink: DesktopRunSink;
  /** The runs the person opened in it: a failure no pause bar shows is held in them. */
  shows: Set<string>;
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** A path as the file system names it, links resolved; the path itself when it does not exist. */
function real(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/** Two paths compared as the file system does: without regard to case on Windows and macOS. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Whether `file` is inside `folder`, both resolved through their links. */
export function insideFolder(folder: string, file: string): boolean {
  const relative = path.relative(real(folder), real(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** A file as `RunLines` keys it: its absolute path, in lower case where the file system ignores case. */
function lineKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** A file's text, without the byte order mark it may start with, and its modification time; null when unreadable. */
function diskFile(file: string): DiskFile {
  try {
    return { text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** What the window keeps of a stop's code or a pick, to send again to a window that opens later. */
type Kept = Extract<DesktopRunEvent, { type: 'stop-code' | 'pick' }>;

/**
 * The editor's sessions, with the sentence a pick on the image answers with: its locator goes where the run's picks
 * go, this server's window, never to an editor.
 */
class DesktopRunSessions extends RunSessions {
  override async pickAt(params: Parameters<RunSessions['pickAt']>[0]): ReturnType<RunSessions['pickAt']> {
    const picked = await super.pickAt(params);
    return picked.ok && picked.locator
      ? { ...picked, message: `${picked.locator}: copy it in the desktop app's window.` }
      : picked;
  }
}

export class DesktopRuns {
  private readonly windows = new Map<string, RunWindow>();
  private readonly kept: Kept[] = [];
  /** The Piwi project of each linked folder a run ran in, by folder: null until its name is read. */
  private readonly projects = new Map<string, string | null>();
  private readonly lines = new RunLines();
  readonly sessions: RunSessions;
  private readonly actions: StopActions;
  private channel: RecordChannel | null = null;
  private hub: RunHub | null = null;
  private readonly startedAt = new Date().toISOString();

  private constructor(private readonly options: DesktopRunsOptions) {
    this.sessions = new DesktopRunSessions({
      notify: (session) => this.hub?.push(session),
      // The window's stream and Piwi Picker's subscribed connections are the hub's peers alike.
      answersStops: () => !!this.hub?.answersStops(),
      notice: (root, severity, message) => this.notice(root, severity, message),
      rootOf: (cwd) => this.links().find((link) => samePath(real(link.path), real(cwd)))?.path ?? null,
      writesCode: () => true,
      onRegion: (stop, region) =>
        'refused' in region
          ? this.actions.regionRefused(stop, region.refused)
          : this.actions.region(stop, region.locator, region.snapshot),
      watched: (ref) => [...this.windows.values()].some((window) => window.shows.has(ref)),
      followed: () => !!this.hub?.follows(),
      holdsFailures: (ref) => !isUnattendedDesktopRun(ref),
      // A run's code is its files as they stood when its first worker connected.
      sessionStarted: (ref, again) => this.lines.started(ref, () => [], !again),
      declines: (what) => DECLINED[what] ?? null,
      host: 'the desktop app',
      surfaces: "the desktop app's window",
      lingerMs: options.lingerMs,
      requestMs: options.requestMs,
    });
    this.actions = new StopActions({
      sessions: this.sessions,
      writesCode: () => true,
      notify: (code) => this.keep({ type: 'stop-code', code }),
      notice: (root, message) => this.notice(root, 'warning', message),
      outcome: (outcome) => this.hub?.code(outcome),
      target: (file) => this.target(file),
      lineNow: (stop, target) => {
        const file = uriToPath(target.uri);
        if (!file) return { refusal: `${target.uri} is not a file.` };
        return this.lines.lineNow(stop.ref, lineKey(file), stop.line, false, diskFile(file));
      },
      language: () => null,
      words: {
        wrote: (what, where) => `Piwi made ${what} to write above ${where}.`,
        sent: (what, where) => `Piwi made ${what} to write above ${where}: copy it in the desktop app's window.`,
        outside: (uri) =>
          `${path.basename(uriToPath(uri) ?? uri)} is not in a folder linked to a project: Piwi makes code for the ` +
          "linked folders' files alone.",
      },
    });
  }

  /** Opens the run channel and the hub; either one is null when the machine refuses it. */
  static async start(options: DesktopRunsOptions): Promise<DesktopRuns> {
    const runs = new DesktopRuns(options);
    const [channel, hub] = await Promise.all([
      RecordChannel.open({
        onAttach: (handoff) => runs.channel?.refuse(handoff.id, DECLINED.record!),
        onRun: (socket, attach) => runs.sessions.attach(socket, attach),
      }),
      RunHub.open({
        sessions: runs.sessions,
        actions: runs.actions,
        runInfo: (_ref, root) => ({
          command: null,
          label: root ? path.basename(root) : null,
          project: root ? runs.project(root) : null,
        }),
        welcome: () => ({
          pid: process.pid,
          version: options.version,
          client: DESKTOP_HUB_CLIENT,
          roots: runs.links().map((link) => link.path),
        }),
        surfacesChanged: () => runs.sessions.surfacesChanged(),
        token: options.token,
        closing: 'The desktop app stopped.',
        keepaliveMs: options.keepaliveMs,
        helloMs: options.helloMs,
      }),
    ]);
    runs.channel = channel;
    runs.hub = hub;
    if (!channel) options.log?.('[desktop-runs] The run channel could not listen: runs start without a hub.');
    if (!hub) options.log?.('[desktop-runs] The hub could not listen: Piwi Picker and the window see no run.');
    return runs;
  }

  /** `PIWI_RUN_CHANNEL` for the runs the shell starts (`<socket>#<token>`); null when the channel does not listen. */
  get runChannel(): string | null {
    return this.channel?.value ?? null;
  }

  /**
   * Where the runs the shell starts send the locators their tests pick (`PIWI_EDITOR_SEND`), as an editor's pairing
   * address names its Send to editor endpoint: this server's route on `port`, with the desktop token, which its guard
   * asks of every request. Null while the run channel does not listen.
   */
  picksAddress(port: number | string): string | null {
    if (!this.channel) return null;
    return `http://127.0.0.1:${port}${DESKTOP_PICKS_PATH}#${this.options.token}`;
  }

  /** A locator a test of a run picked (`POST DESKTOP_PICKS_PATH`): every window hears it, to copy, and it is kept. */
  picked(pick: DesktopRunPick): void {
    this.keep({ type: 'pick', pick });
  }

  /** The hub as `GET /api/desktop/live` names it, in the shape an editor's `GET …/live` gives (`LiveAnswer`). */
  live(): LiveHub[] {
    if (!this.hub) return [];
    return [
      {
        url: this.hub.url,
        token: this.options.token,
        pid: process.pid,
        version: this.options.version,
        client: DESKTOP_HUB_CLIENT,
        roots: this.links().map((link) => link.path),
        startedAt: this.startedAt,
      },
    ];
  }

  /**
   * A window's stream opens: it is a peer of the hub, subscribed at once, and hears first the id its commands name
   * it by, then the codes and the picks kept, then each run. Null while the hub does not listen, or past `MAX_WINDOWS`.
   */
  async openWindow(sink: DesktopRunSink): Promise<{ viewer: string; close(): void } | null> {
    if (!this.hub || this.windows.size >= MAX_WINDOWS) return null;
    const viewer = randomBytes(16).toString('hex');
    const close = () => {
      this.closeWindow(viewer);
      sink.close();
    };
    const window: RunWindow = {
      sink,
      shows: new Set(),
      peer: this.hub.join({
        send: (message) => {
          // A stream that left as much unread as a WebSocket may is let go, as the hub lets that one go.
          if (sink.buffered() > MAX_HUB_BUFFERED) return close();
          // A joined peer hears no `welcome`, and its answers come back to the command that asked.
          if (message.type === 'session' || message.type === 'code' || message.type === 'frame') sink.send(message);
        },
        buffered: () => sink.buffered(),
        close,
      }),
    };
    this.windows.set(viewer, window);
    sink.send({ type: 'hello', viewer });
    for (const kept of this.kept) sink.send(kept);
    await window.peer.command({ type: 'subscribe', id: 1 });
    return { viewer, close: () => this.closeWindow(viewer) };
  }

  /**
   * A command of a window's, as the hub answers it, or `show`; null for a stream that is not open. Each field is
   * checked as the hub checks a WebSocket's (`parseHubCommand`).
   */
  async command(body: unknown): Promise<HubAnswer | null> {
    const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const window = isDesktopRunViewer(value.viewer) ? this.windows.get(value.viewer) : undefined;
    if (!window) return null;
    const id = Number.isInteger(value.id) && (value.id as number) >= 1 ? (value.id as number) : 0;
    const answer = (ok: boolean, message: string): HubAnswer => ({ type: 'answer', id, ok, message });
    if (value.type === 'show') {
      if (!id) return answer(false, 'Not a command.');
      if (typeof value.ref !== 'string' || !REF.test(value.ref))
        return answer(false, 'The command needs the ref of a run.');
      if (typeof value.on !== 'boolean') return answer(false, 'on must be true or false.');
      const had = window.shows.has(value.ref);
      if (value.on) window.shows.add(value.ref);
      else window.shows.delete(value.ref);
      if (had !== value.on) this.sessions.surfacesChanged();
      if (isUnattendedDesktopRun(value.ref)) {
        return answer(true, 'Nobody attends a run of this kind: its failures go on at once, whoever watches it.');
      }
      return answer(
        true,
        value.on
          ? 'A failure no pause bar shows waits for an answer in this run while the window shows it.'
          : 'A failure of this run no pause bar shows goes on unless Piwi Picker follows the runs.',
      );
    }
    const parsed = parseHubCommand(JSON.stringify(value));
    if (!parsed) return answer(false, 'Not a command.');
    return window.peer.command(parsed);
  }

  /** The server stops: the hub and the channel close, every worker's connection with them, and every window stream. */
  close(): void {
    this.hub?.close();
    this.hub = null;
    this.channel?.close();
    this.channel = null;
    this.sessions.dispose();
    for (const window of this.windows.values()) window.sink.close();
    this.windows.clear();
  }

  private closeWindow(viewer: string): void {
    const window = this.windows.get(viewer);
    if (!window) return;
    this.windows.delete(viewer);
    window.peer.leave();
    if (window.shows.size) this.sessions.surfacesChanged();
  }

  private links(): DesktopLink[] {
    return this.options.links?.() ?? desktopLinkedFolders();
  }

  /** The name of the project a linked folder belongs to, read once: null until then. */
  private project(root: string): string | null {
    if (this.projects.has(root)) return this.projects.get(root) ?? null;
    this.projects.set(root, null);
    const link = this.links().find((l) => l.path === root);
    if (link && this.options.projectName) {
      void this.options
        .projectName(link.id)
        .then((name) => this.projects.set(root, name))
        .catch(() => {});
    }
    return null;
  }

  /** What a file's code is written from: its text on disk, for a file of a linked folder alone. */
  private target(file: string): StopTarget | null {
    if (!this.links().some((link) => insideFolder(link.path, file))) return null;
    const disk = diskFile(file);
    if (!disk) return null;
    return {
      uri: pathToFileURL(file).href,
      text: disk.text,
      version: null,
      preferLocators: new Set(),
      expectModule: expectModuleOf(disk.text, { siblings: () => siblingSpecs(file) }),
    };
  }

  /**
   * A code made at a stop, or a locator picked: every window hears it, to copy, and the latest are kept for a window
   * that opens later.
   */
  private keep(kept: Kept): void {
    this.kept.push(kept);
    if (this.kept.length > MAX_KEPT_STOP_CODES) this.kept.shift();
    for (const window of this.windows.values()) window.sink.send(kept);
  }

  private notice(root: string | null, severity: 'information' | 'warning', message: string): void {
    this.options.log?.(`[desktop-runs] ${message}`);
    for (const window of this.windows.values()) window.sink.send({ type: 'notice', root, severity, message });
  }
}

let running: Promise<DesktopRuns> | null = null;

/** Starts the desktop runs' hub once; the server's plugin does so in the desktop build alone. */
export function startDesktopRuns(options: DesktopRunsOptions): Promise<DesktopRuns> {
  running ??= DesktopRuns.start(options);
  return running;
}

/** The desktop runs' hub, once started; null outside the desktop build. */
export function desktopRuns(): Promise<DesktopRuns> | null {
  return running;
}
