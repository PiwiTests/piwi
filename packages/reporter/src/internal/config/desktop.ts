import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
 * Read the desktop app's published connection details, or `null` when the app
 * is not running and the file is absent, unreadable or malformed.
 *
 * The app rewrites this file on every launch (its loopback port can change when
 * 3000 is taken) and deletes it on quit, so a readable file means "there is a
 * local app to talk to right now". A file that names the app's `pid` and whose
 * process is gone was left by a crash, and reads as no app. Never throws —
 * discovery is a convenience, and a truncated or hand-edited file must not take
 * a test run down.
 */
export function readDesktopConfig(filePath: string): DesktopConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const url = parsed?.url;
    const token = parsed?.token;
    if (typeof url !== 'string' || !url) return null;
    if (typeof token !== 'string' || !token) return null;
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && !processAlive(parsed.pid)) return null;
    return { url, token };
  } catch {
    return null;
  }
}
