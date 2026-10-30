import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EDITORS_DIR_ENV,
  EDITORS_DIR_PARTS,
  editorForRun,
  readLiveEditors,
  type DiscoveryFolder,
  type EditorDiscovery,
} from '@piwitests/core/editor-discovery';
import { formatRecordChannel } from '@piwitests/core/ide-recorder';
import { RUN_CHANNEL_ENV, RUN_REF_ENV, TERMINAL_REF_PREFIX } from '@piwitests/core/run-channel';
import { detectCi } from '../support/ci.js';
import { PIWI_ORIGIN_ENV } from './env.js';

/**
 * A run started in a terminal, or by an editor's own test runner (`startedByTestRunner`), follows the editor whose
 * workspace holds it: each editor service writes its discovery file (`@piwitests/core/editor-discovery`:
 * `~/.piwi/editors/<pid>.json`, or the folder `PIWI_EDITORS_DIR` names), which names its run channel, and the reporter
 * hands that channel to the run's workers (`PIWI_RUN_CHANNEL`) under a ref of the run's own (`PIWI_RUN_REF`,
 * `terminal-<pid>-<time>`): they connect to it as the workers of a run the editor started do. Only a run whose output
 * goes to a terminal or that a test runner started (else `PIWI_EDITOR=on`), never under CI nor Playwright's own
 * debugger or UI mode, never one that names its run channel itself or that a launcher started (`PIWI_ORIGIN`);
 * `PIWI_EDITOR=off` runs it alone. The files are read only from a folder this user owns, not a link, that no other user
 * can enter, and only those this user owns in it; none is deleted here.
 */

/** `PIWI_EDITOR`: `off` never follows an editor; `on` follows one when the run's output goes to no terminal too. */
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

/** Why a run looks for no editor to follow, in a few words; null when it does. */
export function terminalRunSkip(gate: TerminalRunGate): string | null {
  const { env, argv } = gate;
  const editor = env[PIWI_EDITOR_ENV]?.trim().toLowerCase();
  if (editor === 'off') return `${PIWI_EDITOR_ENV}=off`;
  if (env[RUN_CHANNEL_ENV] !== undefined) return `the run names its ${RUN_CHANNEL_ENV}`;
  if (env[PIWI_ORIGIN_ENV.kind]) return 'a launcher started the run';
  if (detectCi(env)) return 'running under CI';
  if (env.PWDEBUG && !['0', 'false', 'console'].includes(env.PWDEBUG)) return "Playwright's Inspector runs it";
  const flag = (name: string) => argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
  // Playwright opens UI mode for `--ui-host` or `--ui-port` too.
  if (flag('--debug') || flag('--ui') || flag('--ui-host') || flag('--ui-port')) {
    return "Playwright's debugger or UI mode runs it";
  }
  if (argv.slice(2).includes('merge-reports')) return 'it merges reports, running no test';
  if (!gate.terminal && editor !== 'on' && !startedByTestRunner(env)) return 'its output goes to no terminal';
  return null;
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
 * Whether a process of this user runs with this id. A file this user owns was written by a service of this user, so a
 * process of another user's that took its id since (`EPERM`) is not that service.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The longest a clock may have moved between a service writing its file and this run reading it. */
const CLOCK_SLACK_MS = 60_000;

/**
 * Whether a service's file may still be its own, by what the platform tells: written since this machine started (a
 * file of before, its process gone with the restart, names an id another process may have taken since), and, but on
 * Windows, naming a run channel in a folder this user owns and no other user can enter, which a socket of another
 * user's cannot be in. A named pipe tells no owner, and a file with no time passes as far as the time goes.
 */
function stillServing(editor: EditorDiscovery, now = Date.now()): boolean {
  const written = Date.parse(editor.startedAt);
  if (Number.isFinite(written) && written < now - os.uptime() * 1000 - CLOCK_SLACK_MS) return false;
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
function folderOnDisk(dir: string): DiscoveryFolder {
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
    alive: processAlive,
    remove: () => {},
  };
}

/** A folder's real path, its links followed, in the case the file system gives it; null for one that is gone. */
function realFolder(folder: string): string | null {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return null;
  }
}

/** The editor a run follows, and the ref its workers name the run by. */
export interface FollowedEditor {
  editor: EditorDiscovery;
  ref: string;
}

/**
 * Follow the editor whose workspace holds the run (`dirs`: its Playwright config's folder, then its working
 * directory), when the gate lets the run look for one: its run channel and the run's own ref go into `gate.env`, which
 * the workers inherit. Null when the run runs alone. Never throws.
 */
export function followEditor(
  dirs: readonly string[],
  gate: TerminalRunGate,
  folder: string = editorsFolder(gate.env),
): FollowedEditor | null {
  try {
    if (terminalRunSkip(gate)) return null;
    const live = readLiveEditors(folderOnDisk(folder)).filter((editor) => stillServing(editor));
    const editor = editorForRun(live, dirs, realFolder, process.platform === 'win32');
    if (!editor?.runChannel) return null;
    const ref = `${TERMINAL_REF_PREFIX}${process.pid}-${Date.now()}`;
    gate.env[RUN_CHANNEL_ENV] = formatRecordChannel(editor.runChannel);
    gate.env[RUN_REF_ENV] = ref;
    return { editor, ref };
  } catch {
    return null;
  }
}
