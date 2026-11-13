import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sinceBoot as sinceMachineBoot, type ChannelAddress, type HubAddress } from '@piwitests/core/editor-discovery';
import { formatPairing, parsePairing, type EditorPairing } from '@piwitests/core/editor-send';
import { parseRecordChannel } from '@piwitests/core/ide-recorder';

/** Connection details the desktop app publishes while it is running. */
export interface DesktopConfig {
  /** Loopback base URL of the app's bundled server, e.g. `http://127.0.0.1:3000`. */
  url: string;
  /** The `pd_`-prefixed access token its local API guard requires. */
  token: string;
}

/**
 * Where the Piwi Dashboard desktop app publishes its connection details:
 * `~/.piwi/desktop.json` (`%USERPROFILE%\.piwi\desktop.json` on Windows).
 *
 * A home-relative well-known path rather than the OS app-data directory, so the
 * reporter never has to track the desktop shell's bundle identifier or Tauri's
 * per-platform path rules — the two ship on separate release cycles.
 */
export function defaultDesktopConfigPath(): string {
  return path.join(os.homedir(), '.piwi', 'desktop.json');
}

/** Whether a process with this id is running; one owned by another user counts. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a process of this user runs with this id. A file this user owns was written by a process of this user, so a
 * process of another user's that took its id since (`EPERM`) is not that one.
 */
export function ownProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a time a file names, in milliseconds since the epoch, is since this machine started (`sinceBoot` of
 * `@piwitests/core/editor-discovery`): a file of before names a process its restart ended, whose id another may have
 * taken since.
 */
export function sinceBoot(time: number, now: number = Date.now()): boolean {
  return sinceMachineBoot(time, now, os.uptime() * 1000);
}

/**
 * Read the desktop app's published connection details, or `null` when the app
 * is not running and the file is absent, unreadable or malformed.
 *
 * The app rewrites this file on every launch (its loopback port is a setting,
 * and changes when that port is taken) and deletes it on quit, so a readable
 * file means "there is a local app to talk to right now". A file that names the
 * app's `pid` and whose process is gone was left by a crash, and reads as no
 * app. Never throws — discovery is a convenience, and a truncated or
 * hand-edited file must not take a test run down.
 */
export function readDesktopConfig(filePath: string): DesktopConfig | null {
  const file = readDesktopFile(filePath);
  if (!file) return null;
  if (file.pid !== null && !processAlive(file.pid)) return null;
  return { url: file.url, token: file.token };
}

/**
 * The token in the discovery file, whether or not the app that wrote it still runs: `null` only when the file is
 * absent, unreadable or malformed. A key equal to it is the app's, so it is held to the proof of the server it goes
 * to, and the app that wrote it may be gone while something else holds the port. The app deletes the file on a clean
 * quit, so this reaches a key as long as the file exists.
 */
export function readDesktopToken(filePath: string): string | null {
  return readDesktopFile(filePath)?.token ?? null;
}

/**
 * What the discovery file names of the app's bundled server as a hub, for a run started in a terminal in a folder the
 * app links (`hub.ts`): its run channel (`PIWI_RUN_CHANNEL`), where a run's picks go (`PIWI_EDITOR_SEND`), its hub for
 * Piwi Picker, and the folders linked to a project.
 */
export interface DesktopHub {
  pid: number;
  runChannel: ChannelAddress;
  /** Where the runs' picks go, as `PIWI_EDITOR_SEND` names it; null when the file names none. */
  send: EditorPairing | null;
  hub: HubAddress | null;
  /** The linked folders, absolute. */
  folders: string[];
}

/**
 * The app's bundled server as a hub (`DesktopHub`), from the discovery file of an app of this user that still runs and
 * named the hub since this machine started (`hubSince`); null when the file is absent, unreadable or malformed, its
 * app is gone, or it names no run channel: an app that predates the field or whose server has not proved itself yet.
 * Never throws.
 */
export function readDesktopHub(filePath: string): DesktopHub | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const file = desktopFields(parsed);
    if (!file || file.pid === null || !ownProcessAlive(file.pid)) return null;
    if (typeof parsed.hubSince !== 'number' || !sinceBoot(parsed.hubSince)) return null;
    const channel = parsed?.runChannel;
    const runChannel =
      typeof channel?.path === 'string' && typeof channel?.token === 'string'
        ? parseRecordChannel(`${channel.path}#${channel.token}`)
        : null;
    if (!runChannel) return null;
    const send =
      typeof parsed?.send?.url === 'string' && typeof parsed?.send?.token === 'string'
        ? parsePairing(formatPairing({ url: parsed.send.url, token: parsed.send.token }))
        : null;
    const hub =
      typeof parsed?.hub?.url === 'string' && typeof parsed?.hub?.token === 'string'
        ? { url: parsed.hub.url as string, token: parsed.hub.token as string }
        : null;
    const projects: unknown[] = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const folders = projects.flatMap((project) => {
      const folder = (project as { path?: unknown } | null)?.path;
      return typeof folder === 'string' && path.isAbsolute(folder) ? [folder] : [];
    });
    return { pid: file.pid, runChannel, send, hub, folders };
  } catch {
    return null;
  }
}

/** The fields of the discovery file the readers use; `pid` is null when the file names none. */
function readDesktopFile(filePath: string): (DesktopConfig & { pid: number | null }) | null {
  try {
    return desktopFields(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

/** The fields the readers use of the discovery file's parsed content; null when it holds no address and token. */
function desktopFields(parsed: unknown): (DesktopConfig & { pid: number | null }) | null {
  const file = parsed as { url?: unknown; token?: unknown; pid?: unknown } | null;
  const url = file?.url;
  const token = file?.token;
  if (typeof url !== 'string' || !url) return null;
  if (typeof token !== 'string' || !token) return null;
  const pid = Number.isInteger(file?.pid) && (file!.pid as number) > 0 ? (file!.pid as number) : null;
  return { url, token, pid };
}
