/**
 * Pairing Piwi Picker with an editor by code. Piwi Picker finds the editors of this computer on the ports they listen
 * on (`GET …/hello` on {@link VSCODE_PAIRING_PORTS} and {@link JETBRAINS_PAIRING_PORTS}), asks the one the person
 * chooses to pair (`POST …/pairings`), and shows the code the editor's request shows too. On **Allow** in the editor,
 * Piwi Picker's next poll (`GET …/pairings/<id>` with the secret the start gave it) receives the Send to editor token,
 * once; the address is the one it asked, `…/send` beside `…/pairings`. Both editors serve these routes beside
 * `…/send` and `…/live` (`@piwitests/core/editor-send`): VS Code under {@link VSCODE_PAIRING_BASE}, a JetBrains IDE's
 * built-in server under {@link JETBRAINS_PAIRING_BASE}.
 *
 * Only a browser extension starts a pairing: its `Origin` is an extension's, which a web page cannot claim, and its
 * body is JSON, which a page cannot send to another origin without the preflight the editors answer for extensions
 * alone. A local program can claim both; the person's **Allow** in the editor is what hands the token over.
 */
import { randomHex } from './hmac';
import { isExtensionOrigin } from './run-hub';

/** The loopback ports a VS Code window's Send to editor listener takes first, in order: 7247 spells PAIR on a keypad. */
export const VSCODE_PAIRING_PORTS: readonly number[] = [7247, 7248, 7249, 7250, 7251];

/** The ports of a JetBrains IDE's built-in server: 63342, then the next 19 for the IDEs open beside it. */
export const JETBRAINS_PAIRING_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => 63342 + i);

/** Where VS Code serves Piwi Picker's routes: `/piwi/send`, `/piwi/live`, `/piwi/hello`, `/piwi/pairings`. */
export const VSCODE_PAIRING_BASE = '/piwi';
/** Where a JetBrains IDE's built-in server serves them: `/api/piwi/send`, `/api/piwi/hello`, … */
export const JETBRAINS_PAIRING_BASE = '/api/piwi';

export const EDITOR_HELLO_PATH = '/hello';
export const EDITOR_PAIRINGS_PATH = '/pairings';
export const EDITOR_SEND_PATH = '/send';

/** How long a request waits for the person's answer in the editor. */
export const EDITOR_PAIRING_TTL_MS = 5 * 60_000;
/** Seconds Piwi Picker waits between polls. */
export const EDITOR_PAIRING_POLL_SECONDS = 2;
/** Requests waiting at once in one editor; one more is refused (429) until one is answered or expires. */
export const MAX_WAITING_EDITOR_PAIRINGS = 3;
/** How long a request answered or expired is still told as such to a poll, before it is forgotten (404). */
const ANSWERED_KEPT_MS = 60_000;

/** The header Piwi Picker polls a request with. */
export const EDITOR_PAIRING_SECRET_HEADER = 'x-pairing-secret';

export type EditorKind = 'vscode' | 'jetbrains';

/** What `GET …/hello` answers, with no token: which editor listens there, and the windows or projects it has open. */
export interface EditorHello {
  editor: EditorKind;
  /** The product: `Visual Studio Code`, `Cursor`, `WebStorm`. */
  product: string;
  /** The names of the workspaces (VS Code) or projects (JetBrains) open in it. */
  windows: string[];
}

/** An editor Piwi Picker found: where it serves the routes (`http://127.0.0.1:7247/piwi`), and what it said. */
export interface FoundEditor extends EditorHello {
  base: string;
}

/** The addresses Piwi Picker asks `…/hello` at, VS Code's first. */
export function editorPairingBases(): string[] {
  return [
    ...VSCODE_PAIRING_PORTS.map((port) => `http://127.0.0.1:${port}${VSCODE_PAIRING_BASE}`),
    ...JETBRAINS_PAIRING_PORTS.map((port) => `http://127.0.0.1:${port}${JETBRAINS_PAIRING_BASE}`),
  ];
}

/** The base of a Send to editor address (`http://127.0.0.1:7247/piwi/send` → `http://127.0.0.1:7247/piwi`); null for another. */
export function editorPairingBaseOf(sendUrl: string): string | null {
  return sendUrl.endsWith(EDITOR_SEND_PATH) ? sendUrl.slice(0, -EDITOR_SEND_PATH.length) : null;
}

/** The most windows a hello names, and the longest name of one, or of the product. */
const MAX_HELLO_WINDOWS = 8;
const MAX_HELLO_TEXT = 80;

/** A name an editor gave, as text to show: no control character, one space between words, cut to its limit. */
function shownName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HELLO_TEXT);
}

/** A hello as an editor answered it, its names cut to their limits; null unless it is one. */
export function parseEditorHello(body: unknown): EditorHello | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.editor !== 'vscode' && b.editor !== 'jetbrains') return null;
  const product = shownName(b.product);
  if (!product) return null;
  const windows = Array.isArray(b.windows) ? b.windows.map(shownName).filter(Boolean).slice(0, MAX_HELLO_WINDOWS) : [];
  return { editor: b.editor, product, windows };
}

/** The hello an editor answers, its names cut as {@link parseEditorHello} reads them. */
export function editorHello(editor: EditorKind, product: string, windows: readonly string[]): EditorHello {
  return parseEditorHello({ editor, product, windows }) ?? { editor, product: editor, windows: [] };
}

/** The letters of a code: consonants alone, none read as another. */
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

/** A new code, `BCDF-GHJK`: eight letters, drawn without bias from the 20 of {@link CODE_LETTERS}. */
export function newEditorPairingCode(): string {
  let letters = '';
  while (letters.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 240 is the largest multiple of 20 a byte holds: the bytes above it would favor the first letters.
      if (byte < 240 && letters.length < 8) letters += CODE_LETTERS[byte % CODE_LETTERS.length];
    }
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** One word of what Piwi Picker says it runs in: letters, digits, spaces, dots and dashes, 40 characters at most. */
function clientWord(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** "Chrome on macOS", from the start's `{ browser, os }`; "a browser" when it names none. */
export function editorPairingClient(body: unknown): string {
  const fields = body && typeof body === 'object' ? (body as { browser?: unknown; os?: unknown }) : {};
  const browser = clientWord(fields.browser) || 'a browser';
  const os = clientWord(fields.os);
  return os ? `${browser} on ${os}` : browser;
}

export type EditorPairingStatus = 'waiting' | 'allowed' | 'denied' | 'expired' | 'claimed';

/** What a start answers Piwi Picker: the code both sides show, and the secret only it polls with. */
export interface EditorPairingStart {
  id: string;
  secret: string;
  code: string;
  /** Seconds between polls. */
  interval: number;
  /** Seconds until the request expires. */
  expiresIn: number;
}

/** What a poll answers: the request's status, and the token once, the first time it is polled allowed. */
export interface EditorPairingPoll {
  status: EditorPairingStatus;
  token?: string;
}

/** What the editor shows of a request waiting for the person's answer. */
export interface EditorPairingRequestView {
  id: string;
  code: string;
  /** "Chrome on macOS". */
  client: string;
  createdAt: number;
  expiresAt: number;
}

/** An answer of the routes: the status code and the JSON body. */
export interface EditorPairingAnswer<T> {
  status: number;
  body: T | { error: string };
}

interface StoredRequest extends EditorPairingRequestView {
  /** The extension that asked: one request of it waits at a time. */
  origin: string;
  secret: string;
  status: EditorPairingStatus;
  token: string | null;
  /** When it was answered or expired, from which it is kept {@link ANSWERED_KEPT_MS}. */
  endedAt: number | null;
}

/** Whether two texts are the same, taking as long whatever character differs. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differ === 0;
}

/**
 * The pairing requests of one editor: started by Piwi Picker, answered by the person, polled until Piwi Picker has the
 * token or hears no. `changed` hears every change of the requests waiting, for the editor to draw them again.
 */
export class EditorPairingRequests {
  private readonly requests = new Map<string, StoredRequest>();

  constructor(private readonly options: { now?: () => number; changed?: () => void } = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Expires the requests past their time and forgets those answered long enough ago; true when one expired. */
  private sweep(): boolean {
    const now = this.now();
    let expired = false;
    for (const [id, request] of this.requests) {
      if (request.status === 'waiting' && request.expiresAt <= now) {
        request.status = 'expired';
        request.endedAt = now;
        expired = true;
      }
      if (request.endedAt !== null && now - request.endedAt > ANSWERED_KEPT_MS) this.requests.delete(id);
    }
    if (expired) this.options.changed?.();
    return expired;
  }

  /**
   * `POST …/pairings`: a new request, from a browser extension's `Origin` and a JSON object alone (403, 415 and 400
   * otherwise). It takes the place of a request the same extension made before and nobody answered yet; an extension
   * the person denied waits {@link ANSWERED_KEPT_MS} before it asks again, and none asks while
   * {@link MAX_WAITING_EDITOR_PAIRINGS} wait (429 both). `body` is the parsed JSON, or `undefined` when it did not parse.
   */
  start(
    origin: string | null | undefined,
    contentType: string | null | undefined,
    body: unknown,
  ): EditorPairingAnswer<EditorPairingStart> {
    if (!origin || !isExtensionOrigin(origin)) {
      return { status: 403, body: { error: 'only a browser extension can ask to pair' } };
    }
    if (!contentType?.toLowerCase().startsWith('application/json')) {
      return { status: 415, body: { error: 'the body must be application/json' } };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'the body must be a JSON object' } };
    }
    this.sweep();
    const now = this.now();
    const own = [...this.requests.values()].filter((r) => r.origin === origin);
    if (own.some((r) => r.status === 'denied')) {
      return { status: 429, body: { error: 'the person said no a moment ago' } };
    }
    for (const request of own) {
      if (request.status !== 'waiting') continue;
      request.status = 'expired';
      request.endedAt = now;
    }
    if (this.waiting().length >= MAX_WAITING_EDITOR_PAIRINGS) {
      return { status: 429, body: { error: 'too many pairing requests wait already' } };
    }
    const request: StoredRequest = {
      origin,
      id: randomHex(8),
      secret: randomHex(32),
      code: newEditorPairingCode(),
      client: editorPairingClient(body),
      createdAt: now,
      expiresAt: now + EDITOR_PAIRING_TTL_MS,
      status: 'waiting',
      token: null,
      endedAt: null,
    };
    this.requests.set(request.id, request);
    this.options.changed?.();
    return {
      status: 201,
      body: {
        id: request.id,
        secret: request.secret,
        code: request.code,
        interval: EDITOR_PAIRING_POLL_SECONDS,
        expiresIn: Math.round(EDITOR_PAIRING_TTL_MS / 1000),
      },
    };
  }

  /**
   * `GET …/pairings/<id>` with the start's secret: the request's status, and the token the first time it is polled
   * allowed, after which it is `claimed`. An unknown id or a wrong secret is a 404 alike.
   */
  poll(id: string, secret: string | null | undefined): EditorPairingAnswer<EditorPairingPoll> {
    this.sweep();
    const request = this.requests.get(id);
    if (!request || typeof secret !== 'string' || !sameText(secret, request.secret)) {
      return { status: 404, body: { error: 'no such pairing request' } };
    }
    if (request.status === 'allowed' && request.token) {
      const token = request.token;
      request.status = 'claimed';
      request.token = null;
      return { status: 200, body: { status: 'allowed', token } };
    }
    return { status: 200, body: { status: request.status } };
  }

  /** The person's answer to a waiting request: the token to hand over, or null for no. False when none waits. */
  answer(id: string, token: string | null): boolean {
    this.sweep();
    const request = this.requests.get(id);
    if (!request || request.status !== 'waiting') return false;
    request.status = token ? 'allowed' : 'denied';
    request.token = token || null;
    request.endedAt = this.now();
    this.options.changed?.();
    return true;
  }

  /** Unpair: the requests allowed and not polled yet hand over nothing, as if they had expired. */
  forgetTokens(): void {
    const now = this.now();
    for (const request of this.requests.values()) {
      if (request.status !== 'allowed') continue;
      request.status = 'expired';
      request.token = null;
      request.endedAt = now;
    }
  }

  /** The requests waiting for the person's answer, oldest first. */
  waiting(): EditorPairingRequestView[] {
    const now = this.now();
    return [...this.requests.values()]
      .filter((r) => r.status === 'waiting' && r.expiresAt > now)
      .map(({ id, code, client, createdAt, expiresAt }) => ({ id, code, client, createdAt, expiresAt }));
  }

  /** Ends the waits past their time; true when one ended, for the editor to draw them again. */
  expire(): boolean {
    return this.sweep();
  }
}

/** The id a poll's path names (`…/pairings/<id>`): 16 lowercase hex characters; null for any other path. */
export function editorPairingIdOf(path: string, base: string): string | null {
  const prefix = `${base}${EDITOR_PAIRINGS_PATH}/`;
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  return /^[0-9a-f]{16}$/.test(id) ? id : null;
}
