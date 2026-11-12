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
 * A host that does more for its windows extends the class: it hears each run that changed (`sessionChanged`), each hub
 * message on its way to a window (`relaying`), each window command of a type the hub does not know (`windowCommand`)
 * and each window that left (`windowLeft`), sends a window events of its own (`HostEvent`, `sendToWindow`), and closes
 * what it opened as it overrides `close`.
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
import { testCalls } from './analysis.js';
import type { RunSession } from './protocol.js';
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
import type { AgentRunStart } from './run-agent.js';
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

/** The name the shell gives a run it starts (`PIWI_RUN_REF`): `desktop-<its id>`, marked when nobody attends it. */
const SHELL_REF = /^desktop-\d{1,10}(?:-unattended)?$/;

/** The command lines of the runs the shell started that the hub keeps, the latest. */
const MAX_RUN_COMMANDS = 50;

/** The most Playwright arguments, and characters of them, the shell names for a run. */
const MAX_RUN_ARGS = 1000;
const MAX_RUN_ARGS_CHARS = 24_000;

/** An argument as a command line shows it: as it is when it holds no space nor quote, else in double quotes. */
function shownArg(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

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

/** A spec file, as the editor tells one: `*.spec.ts`, `*.test.js` and their kin. */
const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

/**
 * A run an agent asks the host to start (`run_start`), as its window starts a person's: the project whose linked folder
 * holds the spec, the spec relative to that folder (`/` between its parts), the line of the test to run in it (from 1;
 * the whole spec when null), whether the browser shows, whether a failure waits at its line (**Hold failures**), and
 * what the run is called where the person sees it ("Started by Claude Code").
 */
export interface ShellRunStart {
  projectId: number;
  file: string;
  line: number | null;
  headed: boolean;
  hold: boolean;
  title: string;
}

/** The agents' tools for the host's runs, for a host that serves them from an MCP server of its own. */
export interface ShellAgentWords {
  words: AgentWords;
  /** Why an agent is not given a run nobody attends. */
  unattended: string;
  /** Why an agent's pause, step or run to a line would not hold: no window answers a stop. */
  noWindow: string;
}

/**
 * What a window's stream takes: the events (the hub's, and those of a host that extends `ShellRuns`), what it holds
 * unsent in bytes, and its end.
 */
export interface DesktopRunSink<Event extends { type: string } = DesktopRunEvent> {
  send(event: Event): void;
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
  /**
   * Has the host's window start a run an agent asked for, as it starts a person's (`run_start`): the run's ref once the
   * shell started it, or why not, in a sentence (no window is open). Absent, agents start no run here.
   */
  startRun?(start: ShellRunStart): Promise<{ ref: string } | { refused: string }>;
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

interface RunWindow<HostEvent extends { type: string }> {
  peer: HubPeer;
  sink: DesktopRunSink<DesktopRunEvent | HostEvent>;
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

/** The folder, of `folders`, that holds `file`, the most specific when several do; null for none. */
function folderHolding(folders: readonly ShellFolder[], file: string): ShellFolder | null {
  const holding = folders.filter((link) => insideFolder(link.path, file));
  holding.sort((a, b) => real(b.path).length - real(a.path).length);
  return holding[0] ?? null;
}

/**
 * The line, from 1, of the test of `file` whose lines hold `line`; `line` itself when no test the spec's text shows
 * holds it, for Playwright to read.
 */
function testLineAt(file: string, line: number): number {
  const text = diskFile(file)?.text;
  const call =
    text === undefined ? null : testCalls(text.split(/\r?\n/)).find((c) => c.line <= line - 1 && c.endLine >= line - 1);
  return call ? call.line + 1 : line;
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

/** The hub; `HostEvent`, the events a host that extends it sends its windows besides the hub's (`sendToWindow`). */
export class ShellRuns<HostEvent extends { type: string } = never> {
  private readonly windows = new Map<string, RunWindow<HostEvent>>();
  private readonly kept: Kept[] = [];
  /** The command line of each run the shell started, by ref, as it said it (`started`), the latest `MAX_RUN_COMMANDS`. */
  private readonly commands = new Map<string, string>();
  /** The project of each folder a run ran in, by project id and folder: null while its name is being read. */
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
          this.sessionChanged(session);
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
          command: (ref) => this.commandOf(ref),
          ...(options.startRun
            ? { startRun: (start: AgentRunStart) => this.startAgentRun(start, options.startRun!, agent) }
            : {}),
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
        runInfo: (ref, root) => {
          const link = root ? linkHolding(options.folders(), root) : null;
          return {
            command: this.commandOf(ref),
            label: link ? path.basename(link) : null,
            project: link ? this.project(link) : null,
          };
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

  /**
   * The shell started its run `ref` with Playwright's `args` (`POST DESKTOP_RUN_STARTED_PATH`): the hub names the run's
   * command (`npx playwright test …`) to Piwi Picker and to agents, at once when the run is live. Null once kept, else
   * why not: a ref the shell does not give, or arguments that are no list of words.
   */
  started(ref: unknown, args: unknown): string | null {
    if (typeof ref !== 'string' || !SHELL_REF.test(ref)) return 'The ref names no run the shell starts.';
    if (
      !Array.isArray(args) ||
      args.length > MAX_RUN_ARGS ||
      args.some((arg) => typeof arg !== 'string' || /\p{Cc}/u.test(arg)) ||
      (args as string[]).reduce((chars, arg) => chars + arg.length + 1, 0) > MAX_RUN_ARGS_CHARS
    ) {
      return "args must be Playwright's arguments, as a list of words on one line.";
    }
    this.commands.delete(ref);
    this.commands.set(ref, ['npx', 'playwright', 'test', ...(args as string[]).map(shownArg)].join(' '));
    for (const oldest of this.commands.keys()) {
      if (this.commands.size <= MAX_RUN_COMMANDS) break;
      this.commands.delete(oldest);
    }
    const session = this.sessions.current().find((s) => s.ref === ref);
    if (session) this.hub?.push(session);
    return null;
  }

  /**
   * An agent's run (`run_start`): a spec of a linked folder, relative to one of them or absolute, or the test at a line
   * of it, which the host's window starts as a person's run, labeled with the agent's name; its Hold failures the
   * agent's. Refused for a file outside every linked folder and one that is no spec, as the host refuses it (no window
   * open), and for a run nobody attends, which agents are not given.
   */
  private async startAgentRun(
    start: AgentRunStart,
    startRun: NonNullable<ShellRunsOptions['startRun']>,
    agent: ShellAgentWords,
  ): Promise<{ ok: boolean; message: string; run?: string; root?: string | null }> {
    const words = this.options.words;
    const folders = this.options.folders();
    const candidates = path.isAbsolute(start.file)
      ? [path.resolve(start.file)]
      : folders.map((link) => path.resolve(link.path, start.file));
    const file = candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
    const link = file ? folderHolding(folders, file) : null;
    if (!file || !link) {
      return {
        ok: false,
        message: `${start.file} is in no folder linked to a project: ${words.host} runs the specs of its linked folders alone.`,
      };
    }
    const relative = path.relative(real(link.path), real(file)).split(path.sep).join('/');
    if (!SPEC_FILE.test(relative)) {
      return { ok: false, message: `${relative} is no spec file (\`*.spec.ts\`, \`*.test.ts\`).` };
    }
    const line = start.line === null ? null : testLineAt(file, start.line);
    const shown = line === null ? relative : `${relative}:${line}`;
    const title = `Started by ${start.agent}`;
    const answer = await startRun({
      projectId: link.id,
      file: relative,
      line,
      headed: start.headed,
      hold: start.hold,
      title,
    });
    if ('refused' in answer) return { ok: false, message: answer.refused };
    if (isUnattendedRef(answer.ref)) {
      return {
        ok: false,
        message: `${shown} started in ${words.surfaces}, but it is not served to agents: ${agent.unattended}`,
      };
    }
    this.sessions.hold({ ref: answer.ref, on: start.hold }, 'agent');
    return {
      ok: true,
      message: `${shown} started in ${words.surfaces}, as "${title}". Follow it with run_follow.`,
      run: answer.ref,
      root: link.path,
    };
  }

  /** The command line the shell said it started the run `ref` with; null for another run. */
  private commandOf(ref: string): string | null {
    return this.commands.get(ref) ?? null;
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
  async openWindow(
    sink: DesktopRunSink<DesktopRunEvent | HostEvent>,
  ): Promise<{ viewer: string; close(): void } | null> {
    if (!this.hub || this.windows.size >= MAX_WINDOWS) return null;
    const viewer = randomBytes(16).toString('hex');
    const close = () => {
      this.closeWindow(viewer);
      sink.close();
    };
    const window: RunWindow<HostEvent> = {
      sink,
      shows: new Map(),
      peer: this.hub.join(
        {
          send: (message) => {
            // A stream that left as much unread as a WebSocket may is let go, as the hub lets that one go.
            if (sink.buffered() > MAX_HUB_BUFFERED) return close();
            if (!relayed(message)) return;
            this.relaying(viewer, message);
            sink.send(message);
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
   * A command of a window's, as the hub answers it, or `show`, or one the host that extends the hub answers
   * (`windowCommand`); null for a stream that is not open. Each field is checked as the hub checks a WebSocket's
   * (`parseHubCommand`).
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
    const own = this.windowCommand(value.viewer as string, id, value);
    if (own) return own;
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
    this.windowLeft(viewer);
    window.peer.leave();
    for (const ref of [...window.shows.keys()]) this.stopShowing(window, ref);
  }

  /** A run changed, or ended, as the hub tells its peers: for a host that follows the runs further. */
  protected sessionChanged(_session: RunSession): void {}

  /** A message of the hub's on its way to the window `viewer`'s stream. */
  protected relaying(_viewer: string, _message: Extract<HubMessage, DesktopRunEvent>): void {}

  /**
   * A command of the window `viewer` (`value`, its `id` 0 when it names none) of a type the hub does not know: the
   * answer of a host that takes it, or null, and the hub reads it as one of its own.
   */
  protected windowCommand(_viewer: string, _id: number, _value: Record<string, unknown>): HubAnswer | null {
    return null;
  }

  /** The window `viewer`'s stream closed. */
  protected windowLeft(_viewer: string): void {}

  /** Sends the window `viewer` an event of the host's own; nothing once its stream closed. */
  protected sendToWindow(viewer: string, event: HostEvent): void {
    this.windows.get(viewer)?.sink.send(event);
  }

  /**
   * The window shows the run no more: the last window showing it turns its Hold failures off, unless someone set it
   * since the window did.
   */
  private stopShowing(window: RunWindow<HostEvent>, ref: string): void {
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

  /**
   * The name of the project a folder belongs to, read once it is known: null until then, and asked again while the
   * host has none, keyed by the project the folder is linked to now.
   */
  private project(root: string): string | null {
    const link = this.options.folders().find((l) => l.path === root);
    if (!link) return null;
    const key = `${link.id}\n${root}`;
    if (this.projects.has(key)) return this.projects.get(key) ?? null;
    if (!this.options.projectName) return null;
    this.projects.set(key, null);
    void this.options
      .projectName(link.id)
      .then((name) => {
        if (name) this.projects.set(key, name);
        else this.projects.delete(key);
      })
      .catch(() => this.projects.delete(key));
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
