import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EDITORS_DIR_ENV,
  EDITORS_DIR_PARTS,
  editorForRun,
  readLiveEditors,
  writtenSinceBoot,
  type DiscoveryFolder,
  type EditorDiscovery,
} from '@piwitests/core/editor-discovery';
import { formatPairing } from '@piwitests/core/editor-send';
import { RECORD_CHANNEL_ENV, formatRecordChannel, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { RUN_CHANNEL_ENV, RUN_REF_ENV, TERMINAL_REF_PREFIX, UNATTENDED_REF_SUFFIX } from '@piwitests/core/run-channel';
import { isRunOriginKind, type RunInteractive } from '@piwitests/core/wire';
import { detectCi } from '../support/ci.js';
import { isMergeReports } from '../support/run-mode.js';
import { defaultDesktopConfigPath, ownProcessAlive, readDesktopHub, type DesktopHub } from './desktop.js';
import { PIWI_DESKTOP_CONFIG_ENV, PIWI_LOCAL_DEBUG_ENV, PIWI_ORIGIN_ENV } from './env.js';

/**
 * The hub of a run started in a terminal, or by an editor's own test runner (`startedByTestRunner`): one owner per run,
 * picked in order. A run that names its run channel (`PIWI_RUN_CHANNEL`, its launcher's) keeps it; else the editor whose
 * workspace holds the run, each editor service writing its discovery file (`@piwitests/core/editor-discovery`:
 * `~/.piwi/editors/<pid>.json`, or the folder `PIWI_EDITORS_DIR` names), which names its run channel; else the desktop
 * app whose linked folder holds it, its discovery file (`~/.piwi/desktop.json`, `PIWI_DESKTOP_CONFIG`) naming its
 * bundled server's run channel (`readDesktopHub`); else none. The reporter hands the hub's channel to the run's workers
 * (`PIWI_RUN_CHANNEL`) under a ref of the run's own (`PIWI_RUN_REF`, `terminal-<pid>-<time>`): they connect to it as the
 * workers of a run the hub's tool started do. An editor's channel is its record channel too (`PIWI_RECORD_CHANNEL`),
 * and a hub that names where its runs' picks go gets them (`PIWI_EDITOR_SEND`), unless the run names its own. A run
 * whose output goes to no terminal and that no test runner started attaches unattended (its ref ends in
 * `-unattended`): it is listed and can be paused, but no failure of it waits and a stop nobody asked for goes on;
 * `PIWI_EDITOR=on` attends it. Never under CI nor Playwright's own debugger or UI mode, never one that a launcher started
 * (`PIWI_ORIGIN`); `PIWI_EDITOR=off` runs it alone. The editors' files are read only from a folder this user owns, not a
 * link, that no other user can enter, and only those this user owns in it; none is deleted here.
 */

/** `PIWI_EDITOR`: `off` never attaches the run to a hub; `on` attends it when its output goes to no terminal too. */
export const PIWI_EDITOR_ENV = 'PIWI_EDITOR';

/**
 * The variable through which an editor's own test runner adds its reporter to a run, Playwright loading it beside the
 * config's: a file of the runner's own (JetBrains IDEs' Playwright run configurations name theirs there).
 */
export const TEST_RUNNER_REPORTER_ENV = 'PW_TEST_REPORTER';

/**
 * Whether an editor's own test runner started the run, its output going to the runner's view rather than a terminal:
 * `PW_TEST_REPORTER` names a reporter file. The name of one of Playwright's own reporters (`dot`) says nothing.
 */
export function startedByTestRunner(env: NodeJS.ProcessEnv): boolean {
  const reporter = env[TEST_RUNNER_REPORTER_ENV]?.trim();
  return !!reporter && /[\\/]/.test(reporter);
}

/** What decides whether a run looks for an editor to follow. */
export interface TerminalRunGate {
  env: NodeJS.ProcessEnv;
  /** The runner's command line. */
  argv: readonly string[];
  /** Whether the runner's output goes to a terminal. */
  terminal: boolean;
}

/** Why a run looks for no hub to attach to, in a few words; null when it does. */
export function terminalRunSkip(gate: TerminalRunGate): string | null {
  const { env, argv } = gate;
  const editor = env[PIWI_EDITOR_ENV]?.trim().toLowerCase();
  if (editor && ['off', 'false', '0', 'no'].includes(editor)) return `${PIWI_EDITOR_ENV}=${editor}`;
  if (env[RUN_CHANNEL_ENV] !== undefined) return `the run names its ${RUN_CHANNEL_ENV}`;
  if (env[PIWI_ORIGIN_ENV.kind]) return 'a launcher started the run';
  if (detectCi(env)) return 'running under CI';
  if (env.PWDEBUG && !['0', 'false', 'console'].includes(env.PWDEBUG)) return "Playwright's Inspector runs it";
  const flag = (name: string) => argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
  // Playwright opens UI mode for `--ui-host` or `--ui-port` too.
  if (flag('--debug') || flag('--ui') || flag('--ui-host') || flag('--ui-port')) {
    return "Playwright's debugger or UI mode runs it";
  }
  if (isMergeReports(argv)) return 'it merges reports, running no test';
  return null;
}

/**
 * Whether a person attends the run, so a failure of it may wait at its line and a breakpoint stops it: its output goes
 * to a terminal, an editor's test runner started it, or `PIWI_EDITOR=on` says so. A run piped to a file or another
 * program, as an agent's, is not attended.
 */
export function terminalRunAttended(gate: TerminalRunGate): boolean {
  const editor = gate.env[PIWI_EDITOR_ENV]?.trim().toLowerCase();
  const forced = !!editor && ['on', 'true', '1', 'yes'].includes(editor);
  return gate.terminal || forced || startedByTestRunner(gate.env);
}

/** The folder of the editors' discovery files: `PIWI_EDITORS_DIR`, else `~/.piwi/editors`. */
export function editorsFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env[EDITORS_DIR_ENV] || path.join(os.homedir(), ...EDITORS_DIR_PARTS);
}

/** Whether `dir` is a folder, not a link, that this user owns and no other user can enter, where the platform tells. */
function privateFolder(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return false;
    if (typeof process.getuid !== 'function') return true;
    return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a service's file may still be its own, by what the platform tells: written since this machine started (a
 * file of before, its process gone with the restart, names an id another process may have taken since), and, but on
 * Windows, naming a run channel in a folder this user owns and no other user can enter, which a socket of another
 * user's cannot be in. A named pipe tells no owner, and a file with no time passes as far as the time goes.
 */
export function stillServing(editor: EditorDiscovery, now = Date.now()): boolean {
  if (!writtenSinceBoot(editor, now, os.uptime() * 1000)) return false;
  if (!editor.runChannel || process.platform === 'win32') return true;
  return privateFolder(path.dirname(editor.runChannel.path)) && ownSocket(editor.runChannel.path);
}

/** Whether `file` is a socket, not a link, that this user owns. */
function ownSocket(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isSocket() && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

/** The folder's files as `readLiveEditors` reads them, never deleting one: none when it is not this user's alone. */
export function folderOnDisk(dir: string): DiscoveryFolder {
  return {
    host: os.hostname(),
    names: () => {
      try {
        return privateFolder(dir) ? fs.readdirSync(dir) : [];
      } catch {
        return [];
      }
    },
    owned: (name) => {
      try {
        const stat = fs.lstatSync(path.join(dir, name));
        return stat.isFile() && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
      } catch {
        return false;
      }
    },
    read: (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        return null;
      }
    },
    alive: ownProcessAlive,
    remove: () => {},
  };
}

/** A folder's real path, its links followed, in the case the file system gives it; null for one that is gone. */
export function realFolder(folder: string): string | null {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return null;
  }
}

/** The hub a run attaches to: an editor's service or the desktop app's server, the ref its workers name the run by. */
export interface FollowedHub {
  kind: 'editor' | 'desktop';
  /** The hub's process, as its discovery file names it; null when the desktop app's names none. */
  pid: number | null;
  /** The tool the hub is, as a person reads it: the editor's own name, `the editor`, or `the desktop app`. */
  name: string;
  /** The hub's client as the run's `piwiInteractive` names it: the editor's own name, else `editor`, or `desktop`. */
  client: string;
  ref: string;
  /** Whether a person attends the run (`terminalRunAttended`); its ref ends in `-unattended` when not. */
  attended: boolean;
}

/**
 * The desktop app's server as the hub of a run its linked folder holds, compared as an editor's workspace is
 * (`editorForRun`): a file of an app that still runs naming its run channel, whose socket, but on Windows, is this
 * user's in a folder no other user can enter.
 */
function desktopForRun(hub: DesktopHub | null, dirs: readonly string[]): DesktopHub | null {
  if (!hub) return null;
  const channel = hub.runChannel;
  if (process.platform !== 'win32' && !(privateFolder(path.dirname(channel.path)) && ownSocket(channel.path))) {
    return null;
  }
  const asEditor: EditorDiscovery = {
    pid: hub.pid,
    host: os.hostname(),
    version: '',
    client: null,
    startedAt: '',
    roots: hub.folders,
    hub: hub.hub,
    runChannel: channel,
    recorderBundle: null,
    unattended: true,
  };
  return editorForRun([asEditor], dirs, realFolder, process.platform === 'win32') ? hub : null;
}

/**
 * Attach the run to its hub (`dirs`: its Playwright config's folder, then its working directory), when the gate lets
 * it look for one: the editor whose workspace holds it, else the desktop app whose linked folder does. The hub's run
 * channel, the run's own ref, an editor's record channel and where the hub takes the run's picks (the app's, or the
 * pairing the editor's file names) go into `gate.env`, which the workers inherit. Null when the run runs alone. Never
 * throws.
 */
export function followHub(
  dirs: readonly string[],
  gate: TerminalRunGate,
  folder: string = editorsFolder(gate.env),
  desktopFile: string = gate.env[PIWI_DESKTOP_CONFIG_ENV] || defaultDesktopConfigPath(),
): FollowedHub | null {
  try {
    if (terminalRunSkip(gate)) return null;
    const attended = terminalRunAttended(gate);
    const ref = `${TERMINAL_REF_PREFIX}${process.pid}-${Date.now()}${attended ? '' : UNATTENDED_REF_SUFFIX}`;
    const live = readLiveEditors(folderOnDisk(folder)).filter((editor) => stillServing(editor));
    const editor = editorForRun(live, dirs, realFolder, process.platform === 'win32');
    // An editor service that does not know a run nobody attends would hold it at its breakpoints: the run runs alone.
    if (editor?.runChannel && !attended && !editor.unattended) return null;
    if (editor?.runChannel) {
      const channel = formatRecordChannel(editor.runChannel);
      gate.env[RUN_CHANNEL_ENV] = channel;
      gate.env[RUN_REF_ENV] = ref;
      gate.env[RECORD_CHANNEL_ENV] ??= channel;
      if (editor.send) gate.env[PIWI_LOCAL_DEBUG_ENV.editorSend] ??= formatPairing(editor.send);
      const name = editor.client ?? 'the editor';
      return { kind: 'editor', pid: editor.pid, name, client: editor.client ?? 'editor', ref, attended };
    }
    const desktop = desktopForRun(readDesktopHub(desktopFile), dirs);
    if (!desktop) return null;
    gate.env[RUN_CHANNEL_ENV] = formatRecordChannel(desktop.runChannel);
    gate.env[RUN_REF_ENV] = ref;
    if (desktop.send) gate.env[PIWI_LOCAL_DEBUG_ENV.editorSend] ??= formatPairing(desktop.send);
    return { kind: 'desktop', pid: desktop.pid, name: 'the desktop app', client: 'desktop', ref, attended };
  } catch {
    return null;
  }
}

/**
 * The name a run's workers give the hub of its run channel (`PIWI_RUN_REF`, else `PIWI_ORIGIN_REF`) when the run names
 * a channel (`PIWI_RUN_CHANNEL`) and the name is one a hub takes; null when its workers connect to no hub.
 */
export function runChannelRef(env: NodeJS.ProcessEnv): string | null {
  if (!parseRecordChannel(env[RUN_CHANNEL_ENV])) return null;
  const ref = env[RUN_REF_ENV] ?? env[PIWI_ORIGIN_ENV.ref];
  return ref && /^[\w-]{1,64}$/.test(ref) ? ref : null;
}

/**
 * The hub that steers the run, as the run's `piwiInteractive` metadata names it: a run whose workers connect to a hub
 * (`runChannelRef`) is interactive. Its client is the hub the run attached to (`FollowedHub.client`), else the launcher
 * `PIWI_ORIGIN` names, null when nothing names one. Null for a run that attaches to no hub.
 */
export function runInteractive(env: NodeJS.ProcessEnv, followed: FollowedHub | null): RunInteractive | null {
  const ref = runChannelRef(env);
  if (!ref) return null;
  const origin = env[PIWI_ORIGIN_ENV.kind]?.trim();
  const client = followed ? followed.client : isRunOriginKind(origin) ? origin : null;
  return { client, ref };
}
