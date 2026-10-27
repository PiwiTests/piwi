/**
 * Send to editor: Piwi Picker posts a picked locator or a recorded flow to an
 * editor on the same machine, which inserts it at the cursor. The editor
 * listens on the loopback interface and hands the user a pairing address
 * (`<endpoint URL>#<token>`) to paste in the extension's options once; every
 * request carries the token as a bearer credential. A test run the editor
 * starts gets the same address, and a locator picked while it is paused at a
 * breakpoint names that line (`at`), for the editor to replace the locator there.
 *
 * Before it sends the token, the extension checks that the program at the
 * address holds it: a request carrying a random challenge in
 * {@link EDITOR_CHALLENGE_HEADER} is answered, authorized or not, with
 * {@link editorTokenProof} in {@link EDITOR_PROOF_HEADER}, an HMAC of the
 * challenge keyed by the token for the loopback port the editor answers on.
 * Another program that took the port holds no token, and one that relays the
 * challenge to the editor on another port gets a proof for that other port.
 */
import { hmacSha256Hex, randomHex } from './hmac';

/** The request header carrying the challenge. */
export const EDITOR_CHALLENGE_HEADER = 'x-piwi-editor-challenge';

/** The response header carrying the proof. */
export const EDITOR_PROOF_HEADER = 'x-piwi-editor-proof';

/** Whether `value` is a challenge: 32 to 128 lowercase hex characters. */
export function isEditorChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,128}$/.test(value);
}

/** A new challenge: 32 random bytes, hex. */
export function newEditorChallenge(): string {
  return randomHex(32);
}

/** The proof, hex: HMAC-SHA256 keyed by the pairing's `token` over `piwi-editor-proof:<port>:<challenge>`. */
export function editorTokenProof(token: string, port: number, challenge: string): Promise<string> {
  return hmacSha256Hex(token, `piwi-editor-proof:${port}:${challenge}`);
}

/** Where a picked locator belongs: a file relative to the run's working directory, and its 1-based line. */
export interface EditorSendPlace {
  file: string;
  line: number;
}

/**
 * A request body: a locator line as the Picker renders it, with the line it replaces the locator of when the run
 * names one, or a steps document for the editor to render.
 */
export type EditorSendPayload =
  | { kind: 'locator'; text: string; at?: EditorSendPlace }
  | { kind: 'steps'; steps: unknown };

export interface EditorPairing {
  /** The editor's endpoint, `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`. */
  url: string;
  token: string;
}

/** The longest locator line an editor accepts. */
const MAX_SEND_TEXT = 4000;
/** The largest request body an editor accepts, in bytes. */
export const MAX_SEND_BYTES = 2_000_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The pairing address an editor shows. */
export function formatPairing(pairing: EditorPairing): string {
  return `${pairing.url}#${pairing.token}`;
}

/** Read a pasted pairing address; null unless it is an http URL on the loopback interface with a token. */
export function parsePairing(text: string): EditorPairing | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf('#');
  if (hash < 0) return null;
  const url = trimmed.slice(0, hash);
  const token = trimmed.slice(hash + 1);
  if (!/^[A-Za-z0-9_-]{16,}$/.test(token)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname) || !parsed.port) return null;
  return { url: `${parsed.origin}${parsed.pathname}`, token };
}

/** Whether `file` is a relative path that stays inside the directory it is relative to. */
export function isInsidePath(file: string): boolean {
  if (!file || file.length > 1000 || file.includes('\0')) return false;
  if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file)) return false;
  return file.split(/[\\/]/).every((part) => part !== '..');
}

/** Validate a request body; returns the payload or why it is refused. */
export function parseSendPayload(body: unknown): EditorSendPayload | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'the body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (b.kind === 'locator') {
    if (typeof b.text !== 'string' || !b.text.trim()) return { error: 'text must be a non-empty string' };
    if (b.text.length > MAX_SEND_TEXT) return { error: `text is at most ${MAX_SEND_TEXT} characters` };
    if (b.at === undefined || b.at === null) return { kind: 'locator', text: b.text };
    const at = b.at as Record<string, unknown>;
    if (typeof at !== 'object' || typeof at.file !== 'string' || !isInsidePath(at.file)) {
      return { error: 'at.file must be a path relative to the run, without ..' };
    }
    if (typeof at.line !== 'number' || !Number.isInteger(at.line) || at.line < 1) {
      return { error: 'at.line must be a positive integer' };
    }
    return { kind: 'locator', text: b.text, at: { file: at.file, line: at.line } };
  }
  if (b.kind === 'steps') {
    if (!b.steps || typeof b.steps !== 'object') return { error: 'steps must be a steps document' };
    return { kind: 'steps', steps: b.steps };
  }
  return { error: "kind must be 'locator' or 'steps'" };
}

/** Whether an `Authorization` header carries the token (compared in constant time). */
export function sendAuthorized(header: string | null | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  const given = match?.[1] ?? '';
  if (given.length !== token.length || !token) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
