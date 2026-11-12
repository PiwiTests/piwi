/**
 * **Open the trace so far**: Playwright's trace viewer on a running test's trace, on this machine. The lane's worker
 * names the attempt's own trace file to the hub alone (`trace` on the run channel); `checkTraceFile` takes it only as a
 * regular file, no link, named `<attempt>[-recording<N>].trace`, in the runner's trace folder of that worker
 * (`.playwright-artifacts-<worker>/traces`) inside the run's folder as its host knows it (`session.root`, never the
 * folder the worker names), as the file system spells each of them. The
 * viewer opens every file of the attempt there as Playwright's live trace (`<traces>/<attempt>.json`, which its server
 * lists from the folder), as it stands when the viewer loads it: Playwright's viewer reads it once.
 *
 * `startTraceViewer` runs `show-trace` from the project's own Playwright (`recorder/playwright.ts`), with the project's
 * Node (`recorder/node.ts`) and the variables of the host's environment a window and Playwright need alone
 * (`viewerEnv`), in the run's folder as its host knows it: an argument array and no shell, detached from the service so the viewer's window
 * outlives it, and let go once it started. A viewer that stops within `TRACE_VIEWER_START_MS` did not
 * start, and says why. No path goes into what a surface hears: the run sessions answer with a sentence alone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectNode, projectNodeEnv } from './recorder/node.js';
import { resolvePlaywrightCli } from './recorder/playwright.js';

/** How long a viewer that has not stopped is waited for before it counts as started. */
export const TRACE_VIEWER_START_MS = 2_000;

/** The most of the viewer's error output read for why it did not start, in bytes. */
const MAX_START_OUTPUT = 4_000;

/**
 * The variables of the host's environment the viewer runs with, by their name in capitals: what a window and
 * Playwright need (the user's home, folders and temp, the locale, the display and its session bus, Playwright's
 * browsers, the network's proxy, and Windows' own). Never the host's own settings and secrets (`PIWI_*`, its database
 * and storage, `NODE_OPTIONS`, `NODE_ENV`, `NODE_COMPILE_CACHE`).
 */
const VIEWER_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'PLAYWRIGHT_BROWSERS_PATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

/** The prefixes of the variables the viewer runs with too: the locale's and the desktop's folders and session. */
const VIEWER_ENV_PREFIXES = ['LC_', 'XDG_'];

/** The environment the viewer runs with: the variables of `source` it needs (`VIEWER_ENV`), and no colors. */
function viewerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value === undefined) continue;
    if (VIEWER_ENV.has(upper) || VIEWER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) env[name] = value;
  }
  env.FORCE_COLOR = '0';
  return env;
}

/** What a viewer opens, and where it runs. */
export interface TraceViewerLaunch {
  /** The run's folder, as its host knows it: the viewer is the Playwright installed there, and runs in it. */
  folder: string;
  /** What the viewer opens: the attempt's files in the runner's trace folder, as a live trace (`<traces>/<attempt>.json`). */
  trace: string;
}

/**
 * A viewer that started, and settles `closed` once it stops; or why it did not start, as a clause, which may name the
 * trace's path: the run sessions take it out before a surface hears it.
 */
export type TraceViewerStarted = { ok: true; closed: Promise<void> } | { ok: false; reason: string };

/** Starts Playwright's trace viewer on a trace: `startTraceViewer`, or a stand-in in tests. */
export type TraceViewerLauncher = (launch: TraceViewerLaunch) => Promise<TraceViewerStarted>;

/** The attempt whose trace a worker named, as its run sessions know it. */
export interface TraceAttempt {
  /**
   * The run's folder, as its host knows it (`RunSessionsOptions.rootOf`: the editor's config folder, the desktop app's
   * linked folder), never one the worker names: the trace is inside it.
   */
  folder: string;
  /** The worker's index, which names the runner's folder of its artifacts (`.playwright-artifacts-<worker>`). */
  worker: number;
  /** Playwright's id of the running test. */
  testId: string;
  /** Its retry, 0 for the first attempt: a retry's files are named `<testId>-retry<k>`. */
  retry: number;
}

/** A trace file that passed the checks: what the viewer opens. Else why it is not opened, in a sentence. */
export type CheckedTrace = { ok: true; trace: string } | { ok: false; message: string };

/** The name an attempt's trace files start with, as the runner writes them. */
export function attemptName(attempt: Pick<TraceAttempt, 'testId' | 'retry'>): string {
  return attempt.retry ? `${attempt.testId}-retry${attempt.retry}` : attempt.testId;
}

function realPath(file: string): string | null {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

/** Whether `inner` is inside `outer`, below it. */
function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The checks a trace file a worker named passes before a viewer opens it: an absolute path, a `.trace` file of the
 * attempt that runs, a regular file and no link, in the runner's trace folder of that worker, inside the run's folder
 * as its host knows it, each folder as the file system spells it.
 */
export function checkTraceFile(file: string, attempt: TraceAttempt): CheckedTrace {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    return { ok: false, message: "The worker named no absolute path for its test's trace." };
  }
  const name = path.basename(file);
  if (!name.endsWith('.trace')) return { ok: false, message: 'The worker named a file that is no Playwright trace.' };
  const base = attemptName(attempt);
  if (!new RegExp(`^${escape(base)}(?:-recording\\d+)?\\.trace$`).test(name)) {
    return { ok: false, message: 'The worker named the trace of another test.' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { ok: false, message: "This test's trace is no longer there: its attempt ended." };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, message: "The worker named a link or a folder, not its test's trace file." };
  }
  const traces = realPath(path.dirname(file));
  const artifacts = traces ? path.dirname(traces) : null;
  if (!traces || !artifacts || path.basename(traces) !== 'traces') {
    return { ok: false, message: "The worker named a file outside the runner's trace folder." };
  }
  if (path.basename(artifacts) !== `.playwright-artifacts-${attempt.worker}`) {
    return { ok: false, message: "The worker named a file outside the runner's trace folder." };
  }
  const folder = realPath(attempt.folder);
  if (!folder || !isInside(folder, traces)) {
    return { ok: false, message: 'The worker named a trace outside the folder the run runs in.' };
  }
  return { ok: true, trace: path.join(traces, `${base}.json`) };
}

/**
 * A viewer's error output as a clause: its first line that says something, past a box's border, whole. The run
 * sessions take the trace's path out of it before they cut it.
 */
function reasonOf(output: string, code: number | null, signal: NodeJS.Signals | null): string {
  const line = output
    .split(/\r?\n/)
    .map((text) => text.replace(/^Error:\s*/, '').trim())
    .find((text) => text && !/^[╔║╚═\s]+$/.test(text));
  if (line) return line;
  return code === null ? `it was stopped (${signal ?? 'no signal'})` : `it stopped with exit code ${code}`;
}

/** How `startTraceViewer` starts a viewer. */
export interface TraceViewerStart {
  /** How long a viewer that has not stopped is waited for before it counts as started: `TRACE_VIEWER_START_MS`. */
  startMs?: number;
  /** Where the folder of the viewer's error output is made: the system's temporary folder. */
  tempDir?: string;
}

/**
 * The start of the viewer's error output: at most `MAX_START_OUTPUT` bytes of `file`, without a last line that read
 * cut short (part of a path is no path to take out); empty when it cannot be read.
 */
async function startOutput(file: string): Promise<string> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(MAX_START_OUTPUT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    return bytesRead < buffer.length ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  } catch {
    return '';
  } finally {
    await handle?.close().catch(() => {});
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs `show-trace` on `launch.trace` from the Playwright installed in `launch.folder`, with the project's Node, and
 * waits `startMs` for it to stop: one that does stops at once without a window (Playwright missing there, its browser
 * not installed), and says why. Detached and let go after that: its window outlives the service.
 *
 * The viewer's error output goes to a file, `stderr.log` in a new folder only this user reads (`piwi-trace-viewer-*` in
 * `tempDir`, the system's temporary folder), never to a pipe of the host's, which ends with the host. The file is read
 * for why a viewer that stops at once did not start, and removed with its folder once the viewer stops while the host
 * runs; a viewer still open when the host exits leaves its folder in the temporary folder.
 */
export async function startTraceViewer(
  launch: TraceViewerLaunch,
  options: TraceViewerStart = {},
): Promise<TraceViewerStarted> {
  const cli = resolvePlaywrightCli(launch.folder);
  if (!cli) return { ok: false, reason: 'Playwright is not installed in the folder the run runs in' };
  const node = projectNode();
  let folder: string;
  try {
    // `mkdtemp` makes a new folder that only this user reads.
    folder = await fs.promises.mkdtemp(path.join(options.tempDir ?? os.tmpdir(), 'piwi-trace-viewer-'));
  } catch (error) {
    return { ok: false, reason: reasonOf(messageOf(error), null, null) };
  }
  const remove = () => fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  const log = path.join(folder, 'stderr.log');
  let output: fs.promises.FileHandle | undefined;
  let child: ChildProcess;
  try {
    output = await fs.promises.open(log, 'wx', 0o600);
    child = spawn(node.execPath, [cli, 'show-trace', launch.trace], {
      cwd: launch.folder,
      env: projectNodeEnv(node, viewerEnv()),
      detached: true,
      stdio: ['ignore', 'ignore', output.fd],
      windowsHide: true,
    });
  } catch (error) {
    await output?.close().catch(() => {});
    await remove();
    return { ok: false, reason: reasonOf(messageOf(error), null, null) };
  }
  // The viewer holds the file open itself.
  await output.close().catch(() => {});
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = await Promise.race([
    stopped,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.startMs ?? TRACE_VIEWER_START_MS);
    }),
  ]);
  clearTimeout(timer);
  if (started && (started.error || started.code !== 0)) {
    const reason = started.error
      ? reasonOf(started.error.message, null, null)
      : reasonOf(await startOutput(log), started.code, started.signal);
    await remove();
    return { ok: false, reason };
  }
  // Running: nothing of it holds the service open.
  child.unref();
  return { ok: true, closed: stopped.then(remove) };
}
