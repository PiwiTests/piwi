/**
 * The editors' discovery files: each editor service writes `~/.piwi/editors/<pid>.json` (`%USERPROFILE%\.piwi\editors`
 * on Windows; `PIWI_EDITORS_DIR` names another folder) once it listens, readable by its user only, and removes it as
 * it stops. A file names the service's process, its version and its client, the workspace's folders, the hub's
 * WebSocket with its token (`@piwitests/core/run-hub`), the run channel's socket with its token
 * (`@piwitests/core/run-channel`) and the recorder's bundle. A reader lists the folder (`readLiveEditors`): it skips,
 * and deletes, a file whose process is gone (a service that was killed), and skips one it cannot read. Readers ignore
 * fields they do not know. Pure: the reader takes the folder's operations from its caller.
 */

/** The environment variable naming another folder than `~/.piwi/editors`. */
export const EDITORS_DIR_ENV = 'PIWI_EDITORS_DIR';

/** The folder under the user's home folder, as its parts: `.piwi/editors`. */
export const EDITORS_DIR_PARTS: readonly string[] = ['.piwi', 'editors'];

/** A WebSocket address on this machine and the token its first message carries. */
export interface HubAddress {
  /** `ws://127.0.0.1:<port>/piwi/hub`. */
  url: string;
  token: string;
}

/** A local socket and the token its first line carries, as `PIWI_RUN_CHANNEL` names them (`<path>#<token>`). */
export interface ChannelAddress {
  path: string;
  token: string;
}

/** What `~/.piwi/editors/<pid>.json` holds. */
export interface EditorDiscovery {
  /** The editor service's process, which the file is named after. */
  pid: number;
  /** The service's version. */
  version: string;
  /** The editor running it, as it names itself (`Visual Studio Code`, `WebStorm`); null when it does not say. */
  client: string | null;
  /** When the service wrote the file, ISO 8601. */
  startedAt: string;
  /** The folders of the editor's workspace, absolute. */
  roots: string[];
  /** The hub's WebSocket, for Piwi Picker; null when it could not listen. */
  hub: HubAddress | null;
  /** The run channel the service's runs name, for a run started in a terminal; null when it could not listen. */
  runChannel: ChannelAddress | null;
  /** The recorder's bundle a test loads to record into the editor, absolute; null when the service ships none. */
  recorderBundle: string | null;
}

/** The operations `readLiveEditors` takes from its caller. */
export interface DiscoveryFolder {
  /** The names of the folder's entries; none when it does not exist. */
  names(): string[];
  /** A file's text; null when it cannot be read. */
  read(name: string): string | null;
  /** Whether a process with this id runs. */
  alive(pid: number): boolean;
  /** Delete a file, never throwing. */
  remove(name: string): void;
}

const NAME = /^([1-9]\d{0,9})\.json$/;
/** A token, as the editor service mints them: base64url, 16 characters at least. */
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HUB_URL = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/[\w/-]{0,64}$/;

/** The name of a service's file: `<pid>.json`. */
export function editorDiscoveryName(pid: number): string {
  return `${pid}.json`;
}

/** The process a file's name names; null for a name that is no service's file (a temporary file, another file). */
export function pidOfDiscoveryName(name: string): number | null {
  const m = NAME.exec(name);
  return m ? Number(m[1]) : null;
}

/** A file's text. */
export function formatEditorDiscovery(discovery: EditorDiscovery): string {
  return `${JSON.stringify(discovery, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : null;
}

function readHub(value: unknown): HubAddress | null {
  if (!isObject(value)) return null;
  const { url, token } = value;
  return typeof url === 'string' && HUB_URL.test(url) && typeof token === 'string' && TOKEN.test(token)
    ? { url, token }
    : null;
}

function readChannel(value: unknown): ChannelAddress | null {
  if (!isObject(value)) return null;
  const path = text(value.path, 4096);
  return path && typeof value.token === 'string' && TOKEN.test(value.token) ? { path, token: value.token } : null;
}

/** A file's content, checked field by field; null when it is not one. A field it cannot read is null or empty. */
export function parseEditorDiscovery(content: string): EditorDiscovery | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { pid } = value;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  const roots = Array.isArray(value.roots)
    ? value.roots
        .slice(0, 64)
        .map((root) => text(root, 4096))
        .filter((root): root is string => root !== null)
    : [];
  return {
    pid,
    version: text(value.version, 64) ?? '',
    client: text(value.client, 200),
    startedAt: text(value.startedAt, 64) ?? '',
    roots,
    hub: readHub(value.hub),
    runChannel: readChannel(value.runChannel),
    recorderBundle: text(value.recorderBundle, 4096),
  };
}

/**
 * The services whose files the folder holds and whose process runs, oldest first. A file whose process is gone is
 * deleted; one that cannot be read, or names another process than its name, is skipped.
 */
export function readLiveEditors(folder: DiscoveryFolder): EditorDiscovery[] {
  const found: EditorDiscovery[] = [];
  for (const name of folder.names()) {
    const pid = pidOfDiscoveryName(name);
    if (pid === null) continue;
    if (!folder.alive(pid)) {
      folder.remove(name);
      continue;
    }
    const content = folder.read(name);
    const discovery = content === null ? null : parseEditorDiscovery(content);
    if (discovery?.pid === pid) found.push(discovery);
  }
  return found.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.pid - b.pid);
}
