/**
 * The hub of the Playwright runs a desktop shell starts, which its Node host runs: the dashboard's desktop build
 * (`apps/application/server/utils/desktop-runs.ts`) for a run in a project's linked folder or a worktree of it, Piwi
 * Runner (`apps/runner/server`) for a run a team instance requested, in the folder the shell links to its project. The
 * shell names the host's run channel in each run's environment (`PIWI_RUN_CHANNEL`, read from
 * `DESKTOP_RUN_CHANNEL_PATH`) and the run's name on it (`PIWI_RUN_REF`, `desktop-<the shell's run id>`): each worker
 * keeps a run connection there. Every piece is this service's own run control (`./run-host.ts`), wired to the shell's
 * surfaces:
 *  - the channel is the service's socket (a Unix socket in a new folder only this user reads, `<folderPrefix>*` in the
 *    temporary directory, a named pipe on Windows), which takes a run connection only with its token, compared in
 *    constant time; a recording's hand-off is refused, as no editor here takes one. The folders a host the shell killed
 *    left behind are removed as the next one starts (`clearStaleRunChannels`);
 *  - the hub is the service's WebSocket for Piwi Picker, on `127.0.0.1` alone, with its `Host` and extension `Origin`
 *    checks, its limits, its keepalive and its closed set of commands; `hello` carries the host's access token;
 *  - the shell's window is a peer of that hub (`RunHub.join`) through routes behind the access token
 *    (`./shell-runs-routes.ts`): it hears what Piwi Picker hears, sends the same commands, and alone receives the code
 *    made at a stop, to copy (`stop-code`);
 *  - a failure no pause bar shows is held in a run whose **Hold failures** is on: the window turns it on or off
 *    (`show`), as Piwi Picker (`hold`) and an agent may, and it goes off as the last window showing the run closes;
 *    otherwise it goes on at once, and always in a run nobody attends (its ref ends in `-unattended`), whose workers
 *    hear that they hold no failure;
 *  - the code from a stop is rendered by the service's generator from the file as it is on disk, for a file of one of
 *    the host's folders alone, and refused once the file was written since the run's first connection opened
 *    (`RunLines`).
 * Pick and Record in the test's window, and Assert, end in an editor, which the host has none of: they are refused
 * (`declined`), and a pick on an image of the stop (`pick-at`) answers with the locator it found. The runs name the
 * host as where their picks go (`PIWI_EDITOR_SEND`, `DESKTOP_PICKS_PATH`, with a token for that route alone): a locator
 * the pause bar's **Pick a locator** or a pick on the image picked comes to the window, to copy (`pick`).
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TERMINAL_REF_PREFIX, isUnattendedRef, type RunIntent } from '@piwitests/core/run-channel';
import {
  HUB_FEATURES,
  canStopRun,
  parseHubCommand,
  type HubAnswer,
  type HubMessage,
  type LiveHub,
} from '@piwitests/core/run-hub';
import { sameToken } from './recorder/handoff.js';
import {
  MAX_HUB_BUFFERED,
  RecordChannel,
  RunAgent,
  RunHub,
  RunLines,
  RunSessions,
  StopActions,
  expectModuleOf,
  siblingSpecs,
  startTraceViewer,
  type AgentWords,
  type DiskFile,
  type HubPeer,
  type RunControlResult,
  type RunHoldFailures,
  type StopTarget,
  type TraceViewerLauncher,
  type Viewer,
} from './run-host.js';
import { runTargetConnection } from './run-target.js';
import {
  DESKTOP_PICKS_PATH,
  MAX_KEPT_STOP_CODES,
  isDesktopRunViewer,
  type DesktopRunEvent,
  type DesktopRunPick,
} from './shell-run-events.js';

/** The window streams open at once; one more is refused. */
const MAX_WINDOWS = 16;

/** A run's name on the channel, as the hub's commands name it. */
const REF = /^[\w-]{1,64}$/;

/**
 * A folder the host's runs run in: a project's linked folder, keyed by the project's id (the dashboard's, or the team
 * instance's for Piwi Runner).
 */
export interface ShellFolder {
  id: number;
  path: string;
}

/** What the hub says of the host, in its own name. Each sentence is shown as it is. */
export interface ShellRunsWords {
  /** The host as a sentence names it: "the desktop app". */
  host: string;
  /** The window, as a sentence names it: "the desktop app's window". */
  surfaces: string;
  /** What the hub's `welcome` and its live entry call the host: "Piwi desktop app". */
  client: string;
  /** The window as presence names it to the hub's other tools. */
  presence: NonNullable<Viewer['who']>;
  /** The editor's intents the host refuses at every stop, and why. */
  declined: Partial<Record<RunIntent, string>>;
  /** What a pick on the image of a stop answers: where its locator went. */
  picked(locator: string): string;
  /** What a code made at a stop answers: where it waits. */
  codeSent(what: string, at: string): string;
  /** Why no code is made for a file outside the host's folders (`file`, its name). */
  outside(file: string): string;
  /** Why a run is not stopped while no window is open to stop it. */
  noWindowToStop: string;
  /** What a stop asked through the hub answers once the windows heard it. */
  stopping: string;
  /** What the hub's peers hear as it closes. */
  closing: string;
  /** What the host's log lines start with: "[desktop-runs]". */
  log: string;
}

/** The agents' tools for the host's runs, for a host that serves them from an MCP server of its own. */
export interface ShellAgentWords {
  words: AgentWords;
  /** Why an agent is not given a run nobody attends. */
  unattended: string;
  /** Why an agent's pause, step or run to a line would not hold: no window answers a stop. */
  noWindow: string;
}

/** What a window's stream takes: the events, what it holds unsent in bytes, and its end. */
export interface DesktopRunSink {
  send(event: DesktopRunEvent): void;
  buffered(): number;
  close(): void;
}

export interface ShellRunsOptions {
  /** The host's access token: the hub's `hello` carries it. */
  token: string;
  /** The host's version, as the hub's `welcome` names it. */
  version: string;
  /** The folders the host's runs run in, now. */
  folders(): readonly ShellFolder[];
  words: ShellRunsWords;
  /** The agents' tools, in the host's words; none without. */
  agent?: ShellAgentWords;
  /** What the run channel's socket folder is named from, in the temporary directory: the host's alone. */
  folderPrefix: string;
  /** The token of the picks route (`DESKTOP_PICKS_PATH`) alone; a new one per host by default. */
  picksToken?: () => string;
  /** The name of a project, for what Piwi Picker shows of a run. */
  projectName?(id: number): Promise<string | null>;
  /** The other hubs of this machine the hub names to its peers; none by default. */
  peers?(): readonly LiveHub[];
  /** A sentence for the host's log. */
  log?(message: string): void;
  keepaliveMs?: number;
  helloMs?: number;
  peersMs?: number;
  lingerMs?: number;
  requestMs?: number;
  /** How long an agent follows a run after its last call on it (`RunAgent`'s `followIdleMs`). */
  agentIdleMs?: number;
  /**
   * Starts Playwright's trace viewer on a lane's running test's trace (the hub's `openTrace`), from the Playwright of
   * the folder the run runs in: `startTraceViewer` by default.
   */
  traceViewer?: TraceViewerLauncher;
  /**
   * Whether this machine shows the trace viewer's window (`hasDisplay` by default): without one, the hub offers no
   * trace and refuses `openTrace`.
   */
  traceDisplay?: () => boolean;
}

/**
 * Whether the hub's message to a window goes on to its stream: the runs, what each code came to, the frames of the
 * stops (`frame`) and the lanes (`lane-frame`) it watches, and the layers of those lanes it asked for (`lane-layer`). A
 * joined peer hears no `welcome`, and its answers come back to the command that asked.
 */
function relayed(message: HubMessage): message is Extract<HubMessage, DesktopRunEvent> {
  return ['session', 'code', 'frame', 'lane-frame', 'lane-layer'].includes(message.type);
}

/** Whether a process listens on the Unix socket `file`: false only when the connection is refused. */
function listening(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    const done = (answers: boolean) => {
      probe.destroy();
      resolve(answers);
    };
    probe.setTimeout(1000, () => done(true));
    probe.once('connect', () => done(true));
    probe.once('error', (error: NodeJS.ErrnoException) => done(error.code !== 'ECONNREFUSED'));
  });
}

/**
 * Removes the run channel folders a host left behind as it was killed or crashed (the shell stops the host at once, so
 * its own cleanup never runs): this user's `<prefix>*` folders in `dir`, never a link, whose socket refuses a
 * connection. A folder whose socket answers, or that holds none, stays. Returns how many went.
 */
export async function clearStaleRunChannels(prefix: string, dir = os.tmpdir()): Promise<number> {
  if (process.platform === 'win32') return 0;
  const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const folder = path.join(dir, name);
    const stat = await fs.promises.lstat(folder).catch(() => null);
    if (!stat?.isDirectory() || stat.uid !== process.getuid?.()) continue;
    const socket = await fs.promises.lstat(path.join(folder, 'channel.sock')).catch(() => null);
    if (!socket?.isSocket() || (await listening(path.join(folder, 'channel.sock')))) continue;
    await fs.promises.rm(folder, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

interface RunWindow {
  peer: HubPeer;
  sink: DesktopRunSink;
  /**
   * The runs whose Hold failures it turned on, each with the Hold failures it set: the last window showing a run turns
   * it off as it stops showing it, unless someone set it since.
   */
  shows: Map<string, RunHoldFailures>;
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

/** The folder, of `folders`, that is `cwd` or holds it, the most specific when several do; null for none. */
export function linkHolding(folders: readonly ShellFolder[], cwd: string): string | null {
  const at = real(cwd);
  const holding = folders.filter((link) => samePath(real(link.path), at) || insideFolder(link.path, cwd));
  holding.sort((a, b) => real(b.path).length - real(a.path).length);
  return holding[0]?.path ?? null;
}

/**
 * `cwd` as the folder holding it spells it: the folder's path, then the rest of `cwd` below it; null outside every
 * folder. A session's root names its run's working directory, in the spelling the window opens files under.
 */
export function linkedSpelling(folders: readonly ShellFolder[], cwd: string): string | null {
  const link = linkHolding(folders, cwd);
  if (link === null) return null;
  const rest = path.relative(real(link), real(cwd));
  return rest ? path.join(link, rest) : link;
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
    return { text: fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** What the window keeps of a stop's code or a pick, to send again to a window that opens later. */
type Kept = Extract<DesktopRunEvent, { type: 'stop-code' | 'pick' }>;

/** The service's sessions, with the sentence a pick on the image answers with: its locator goes to the window. */
class ShellRunSessions extends RunSessions {
  constructor(
    options: ConstructorParameters<typeof RunSessions>[0],
    private readonly pickedWords: (locator: string) => string,
  ) {
    super(options);
  }

  override async pickAt(params: Parameters<RunSessions['pickAt']>[0]): ReturnType<RunSessions['pickAt']> {
    const picked = await super.pickAt(params);
    return picked.ok && picked.locator
      ? { ...picked, taken: false, message: this.pickedWords(picked.locator) }
      : picked;
  }
}

/** A new token for the picks route alone. */
function newPicksToken(): string {
  return `pdp_${randomBytes(32).toString('hex')}`;
}

export class ShellRuns {
  private readonly windows = new Map<string, RunWindow>();
  private readonly kept: Kept[] = [];
  /** The project of each folder a run ran in, by folder: null until its name is read. */
  private readonly projects = new Map<string, string | null>();
  private readonly lines = new RunLines();
  readonly sessions: RunSessions;
  private readonly actions: StopActions;
  /** The agents' tools for these runs, for a host that serves them; null without `agent`. */
  readonly agent: RunAgent | null;
  private channel: RecordChannel | null = null;
  private hub: RunHub | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly liveCountListeners = new Set<(live: number) => void>();
  private liveCount = 0;
  private readonly picks: () => string;

  protected constructor(protected readonly options: ShellRunsOptions) {
    const words = options.words;
    let minted: string | null = null;
    this.picks = options.picksToken ?? (() => (minted ??= newPicksToken()));
    this.sessions = new ShellRunSessions(
      {
        // A run's page is linked on this machine, or on the team instance whose requests it runs.
        instances: () => [runTargetConnection().instance],
        notify: (session) => {
          this.hub?.push(session);
          this.liveCountChanged();
        },
        presenceChanged: (session) => this.hub?.push(session),
        // The window's stream and Piwi Picker's subscribed connections are the hub's peers alike.
        answersStops: () => !!this.hub?.answersStops(),
        notice: (root, severity, message) => this.notice(root, severity, message),
        // A teammate asks to watch a run the host follows: each window asks the person.
        askedToWatch: (ask) => {
          for (const window of this.windows.values()) window.sink.send({ type: 'ask-to-watch', ...ask });
        },
        // The run's folder as the host's folder spells it: a run the shell starts runs in it, one started in a
        // terminal there or below.
        rootOf: (cwd) => linkedSpelling(options.folders(), cwd),
        writesCode: () => true,
        onRegion: (stop, region) =>
          'refused' in region
            ? this.actions.regionRefused(stop, region.refused)
            : this.actions.region(stop, region.locator, region.snapshot),
        holdsFailures: (ref) => !isUnattendedRef(ref),
        // A run started in a terminal in a linked folder attaches under a ref of its own (the reporter's `hub.ts`).
        terminal: (ref) => ref.startsWith(TERMINAL_REF_PREFIX),
        // A run's code is its files as they stood when its first connection opened.
        sessionStarted: (ref, again) => this.lines.started(ref, () => [], !again),
        declines: (what) => words.declined[what] ?? null,
        host: words.host,
        surfaces: words.surfaces,
        // An agent following the runs hears what each worker says.
        heard: (ref, worker, what, root) => this.agent?.heard(ref, worker, what, root),
        // A breakpoint and Run to cursor are read against the file as the run runs it: as it stood on disk when the
        // run started, none written since.
        runText: (ref, file) => {
          const disk = diskFile(file);
          const started = this.lines.startedAt(ref);
          return disk && (started === null || disk.mtime <= started) ? disk.text : null;
        },
        lingerMs: options.lingerMs,
        requestMs: options.requestMs,
        // **Open the trace so far**: the viewer runs from the run's folder with none of the host's environment but
        // what a window and Playwright need, the trace's path staying in the host.
        traceViewer: options.traceViewer ?? startTraceViewer,
        ...(options.traceDisplay ? { traceDisplay: options.traceDisplay } : {}),
      },
      words.picked,
    );
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
        wrote: (what, at) => `Piwi made ${what} to write ${at}.`,
        sent: words.codeSent,
        outside: (uri) => words.outside(path.basename(uriToPath(uri) ?? uri)),
      },
    });
    const agent = options.agent;
    this.agent = agent
      ? new RunAgent({
          sessions: this.sessions,
          // The code goes to the window to copy, and back to the agent, which has no file to read it in.
          writeCode: (stop, input) => this.actions.agentCode(stop, input),
          notice: (root, message) => this.notice(root, 'information', message),
          command: () => null,
          preferLocators: () => new Set(),
          words: agent.words,
          refuses: (ref) => (isUnattendedRef(ref) ? agent.unattended : null),
          followIdleMs: options.agentIdleMs,
          stopsGoOn: () => (this.hub?.answersStops() ? null : agent.noWindow),
          // The window may hide in the tray while it holds a stop: one the agent asked for goes on once it calls no
          // more.
          letsGoOnIdle: true,
        })
      : null;
  }

  /** Opens the hub of `options`' host: the run channel and the hub, either one null when the machine refuses it. */
  static async start(options: ShellRunsOptions): Promise<ShellRuns> {
    const runs = new ShellRuns(options);
    await runs.open();
    return runs;
  }

  /** Opens the run channel and the hub; either one is null when the machine refuses it. */
  protected async open(): Promise<void> {
    const options = this.options;
    const words = options.words;
    void clearStaleRunChannels(options.folderPrefix)
      .then((removed) => {
        const folders = removed === 1 ? 'folder' : 'folders';
        if (removed) options.log?.(`${words.log} Removed ${removed} run channel ${folders} a stopped host left.`);
      })
      .catch(() => {});
    const [channel, hub] = await Promise.all([
      RecordChannel.open({
        onAttach: (handoff) =>
          this.channel?.refuse(handoff.id, words.declined.record ?? 'Record here records into an editor.'),
        onRun: (socket, attach) => this.sessions.attach(socket, attach),
        onRunMain: (socket, begin) => this.sessions.attachMain(socket, begin),
        folderPrefix: options.folderPrefix,
      }),
      RunHub.open({
        sessions: this.sessions,
        actions: this.actions,
        runInfo: (_ref, root) => {
          const link = root ? linkHolding(options.folders(), root) : null;
          return { command: null, label: link ? path.basename(link) : null, project: link ? this.project(link) : null };
        },
        welcome: () => ({
          pid: process.pid,
          version: options.version,
          client: words.client,
          roots: options.folders().map((link) => link.path),
        }),
        surfacesChanged: () => this.sessions.surfacesChanged(),
        stopRun: async (ref) => this.stopRun(ref),
        ...(options.peers ? { peers: options.peers } : {}),
        peersMs: options.peersMs,
        token: options.token,
        closing: words.closing,
        keepaliveMs: options.keepaliveMs,
        helloMs: options.helloMs,
      }),
    ]);
    this.channel = channel;
    this.hub = hub;
    if (!channel) options.log?.(`${words.log} The run channel could not listen: runs start without a hub.`);
    if (!hub) options.log?.(`${words.log} The hub could not listen: Piwi Picker and the window see no run.`);
  }

  /** `PIWI_RUN_CHANNEL` for the runs the shell starts (`<socket>#<token>`); null when the channel does not listen. */
  get runChannel(): string | null {
    return this.channel?.value ?? null;
  }

  /** The token that opens the picks route (`DESKTOP_PICKS_PATH`) alone. */
  picksToken(): string {
    return this.picks();
  }

  /** Whether `presented` is the picks route's token, compared in constant time. */
  isPicksToken(presented: string): boolean {
    return sameToken(presented, this.picks());
  }

  /**
   * Where the runs the shell starts send the locators their tests pick (`PIWI_EDITOR_SEND`), as an editor's pairing
   * address names its Send to editor endpoint: the host's route on `port`, with the token that opens that route alone,
   * never the access token. Null while the run channel does not listen.
   */
  picksAddress(port: number | string): string | null {
    if (!this.channel) return null;
    return `http://127.0.0.1:${port}${DESKTOP_PICKS_PATH}#${this.picks()}`;
  }

  /** A locator a test of a run picked (`POST DESKTOP_PICKS_PATH`): every window hears it, to copy, and it is kept. */
  picked(pick: DesktopRunPick): void {
    this.keep({ type: 'pick', pick });
  }

  /** How many runs the hub has live. */
  liveRunCount(): number {
    return this.sessions.current().length;
  }

  /** Hears the number of live runs each time it changes; returns the unsubscribe. */
  onLiveRunCount(listener: (live: number) => void): () => void {
    this.liveCountListeners.add(listener);
    return () => this.liveCountListeners.delete(listener);
  }

  /** The hub as a live entry names it, in the shape an editor's `GET …/live` gives (`LiveAnswer`). */
  live(): LiveHub[] {
    if (!this.hub) return [];
    return [
      {
        url: this.hub.url,
        token: this.options.token,
        pid: process.pid,
        version: this.options.version,
        client: this.options.words.client,
        roots: this.options.folders().map((link) => link.path),
        startedAt: this.startedAt,
        features: [...HUB_FEATURES],
      },
    ];
  }

  /**
   * Stops the run `ref` as another tool asks through the hub (`stop`): every window's stream hears it (`stop-run`), and
   * the window that holds the run stops it as its own Stop does, the shell's process with it. Refused for a run that
   * ended, one started in a terminal, whose process is the terminal's, and while no window is open to stop it.
   */
  stopRun(ref: string): RunControlResult {
    const session = this.sessions.current().find((s) => s.ref === ref);
    if (session?.terminal && !session.ended) {
      return { ok: false, message: 'The run was started in a terminal: stop it there.' };
    }
    if (!session || !canStopRun(session)) return { ok: false, message: 'The run has ended.' };
    if (this.windows.size === 0) return { ok: false, message: this.options.words.noWindowToStop };
    for (const window of this.windows.values()) window.sink.send({ type: 'stop-run', ref });
    return { ok: true, message: this.options.words.stopping };
  }

  /**
   * A window's stream opens: it is a peer of the hub, subscribed at once, and hears first the id its commands name
   * it by, then the codes and the picks kept, then each run, then that every run live was listed (`listed`). Null while
   * the hub does not listen, or past `MAX_WINDOWS`.
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
      shows: new Map(),
      peer: this.hub.join(
        {
          send: (message) => {
            // A stream that left as much unread as a WebSocket may is let go, as the hub lets that one go.
            if (sink.buffered() > MAX_HUB_BUFFERED) return close();
            if (relayed(message)) sink.send(message);
          },
          buffered: () => sink.buffered(),
          close,
        },
        this.options.words.presence,
      ),
    };
    this.windows.set(viewer, window);
    sink.send({ type: 'hello', viewer });
    for (const kept of this.kept) sink.send(kept);
    await window.peer.command({ type: 'subscribe', id: 1 });
    if (this.windows.get(viewer) === window) sink.send({ type: 'listed' });
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
      if (isUnattendedRef(value.ref)) {
        return answer(true, 'Nobody attends a run of this kind: its failures go on at once, whoever watches it.');
      }
      // The window's Hold failures is the run's own: another window, Piwi Picker or an agent may change it after.
      if (value.on) {
        this.sessions.hold({ ref: value.ref, on: true }, 'person');
        window.shows.set(value.ref, this.sessions.holdOf(value.ref));
      } else {
        this.stopShowing(window, value.ref);
      }
      return answer(
        true,
        value.on
          ? 'A failure no pause bar shows waits for an answer in this run while the window shows it.'
          : 'A failure of this run no pause bar shows goes on at once.',
      );
    }
    if (value.type === 'answer-ask') {
      if (!id || typeof value.ref !== 'string' || !REF.test(value.ref) || typeof value.ask !== 'string') {
        return answer(false, 'The command needs the ref of a run and the ask it answers.');
      }
      const said = this.sessions.answerAsk({ ref: value.ref, id: value.ask, answer: 'not-now' });
      return answer(said.ok, said.message);
    }
    const parsed = parseHubCommand(JSON.stringify(value));
    if (!parsed) return answer(false, 'Not a command.');
    return window.peer.command(parsed);
  }

  /** The host stops: the hub and the channel close, every worker's connection with them, and every window stream. */
  close(): void {
    this.agent?.dispose();
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
    for (const ref of [...window.shows.keys()]) this.stopShowing(window, ref);
  }

  /**
   * The window shows the run no more: the last window showing it turns its Hold failures off, unless someone set it
   * since the window did.
   */
  private stopShowing(window: RunWindow, ref: string): void {
    const set = window.shows.get(ref);
    if (!set) return;
    window.shows.delete(ref);
    if ([...this.windows.values()].some((other) => other.shows.has(ref))) return;
    if (this.sessions.holdOf(ref) === set) this.sessions.hold({ ref, on: false }, 'person');
  }

  private liveCountChanged(): void {
    const live = this.liveRunCount();
    if (live === this.liveCount) return;
    this.liveCount = live;
    for (const listener of this.liveCountListeners) listener(live);
  }

  /** The name of the project a folder belongs to, read once: null until then. */
  private project(root: string): string | null {
    if (this.projects.has(root)) return this.projects.get(root) ?? null;
    this.projects.set(root, null);
    const link = this.options.folders().find((l) => l.path === root);
    if (link && this.options.projectName) {
      void this.options
        .projectName(link.id)
        .then((name) => this.projects.set(root, name))
        .catch(() => {});
    }
    return null;
  }

  /** What a file's code is written from: its text on disk, for a file of the host's folders alone. */
  private target(file: string): StopTarget | null {
    if (!this.options.folders().some((link) => insideFolder(link.path, file))) return null;
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
    this.options.log?.(`${this.options.words.log} ${message}`);
    for (const window of this.windows.values()) window.sink.send({ type: 'notice', root, severity, message });
  }
}
