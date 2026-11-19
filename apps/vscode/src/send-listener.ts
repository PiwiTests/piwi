/**
 * The endpoint Piwi Picker sends to: an HTTP listener on the loopback
 * interface that accepts `POST /piwi/send` with the pairing token as a bearer
 * credential, and hands the payload to the extension to insert. With the same
 * token, `GET /piwi/live` lists the hubs of every editor service running on the
 * machine (`@piwitests/core/run-hub`'s `LiveAnswer`, from the services'
 * discovery files), so the one pairing reaches the runs of every editor window.
 * Without a token, `GET /piwi/hello` says which editor listens, and
 * `POST /piwi/pairings` asks the person to pair (`@piwitests/core/editor-pairing`):
 * the token goes to Piwi Picker only once they allow it.
 * It answers only a request naming it as `127.0.0.1:<port>` or
 * `localhost:<port>`, its own port or the one a remote window forwards to it
 * from the browser's machine (a page reached under another name gets a 403),
 * and every answer to a request carrying a challenge carries the proof that it
 * holds the token (`@piwitests/core/editor-send`) for the port the request
 * named, so Piwi Picker sends the token only to this listener.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  MAX_SEND_BYTES,
  editorTokenProof,
  isEditorChallenge,
  newEditorChallenge,
  parseSendPayload,
  sendAuthorized,
  type EditorPairing,
  type EditorSendPayload,
} from '@piwitests/core/editor-send';
import {
  EDITOR_HELLO_PATH,
  EDITOR_PAIRING_SECRET_HEADER,
  EDITOR_PAIRINGS_PATH,
  VSCODE_PAIRING_BASE,
  VSCODE_PAIRING_PORTS,
  editorPairingIdOf,
  parseEditorHello,
  type EditorHello,
  type EditorPairingAnswer,
  type EditorPairingRequests,
} from '@piwitests/core/editor-pairing';
import { HUB_PATH, hubHostPort, isExtensionOrigin, type LiveAnswer, type LiveHub } from '@piwitests/core/run-hub';

export const SEND_PATH = `${VSCODE_PAIRING_BASE}/send`;
export const LIVE_PATH = `${VSCODE_PAIRING_BASE}/live`;
export const HELLO_PATH = `${VSCODE_PAIRING_BASE}${EDITOR_HELLO_PATH}`;
export const PAIRINGS_PATH = `${VSCODE_PAIRING_BASE}${EDITOR_PAIRINGS_PATH}`;
/** The largest pairing request body the listener reads: Piwi Picker names a browser and a system. */
const MAX_PAIRING_BYTES = 4096;

export interface SendResult {
  inserted: boolean;
  /** The file the text went to; null for a new untitled editor. */
  file: string | null;
}

export interface SendListener {
  port: number;
  url: string;
  close(): Promise<void>;
}

function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  // Only the browser extensions' own origins; a web page never reaches the endpoint with the token anyway.
  if (origin && /^(chrome|moz)-extension:\/\//.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Authorization, Content-Type, ${EDITOR_CHALLENGE_HEADER}, ${EDITOR_PAIRING_SECRET_HEADER}`,
    );
    res.setHeader('Access-Control-Expose-Headers', EDITOR_PROOF_HEADER);
    res.setHeader('Vary', 'Origin');
  }
}

function answer(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * The proof, for a request carrying a challenge, that this listener holds the pairing's token, bound to `port`: the
 * port the request reached, or the forwarded one its `Host` names; null without a challenge or a token.
 */
async function proofFor(req: http.IncomingMessage, token: string, port: number): Promise<string | null> {
  const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
  if (!token || !port || !isEditorChallenge(challenge)) return null;
  return editorTokenProof(token, port, challenge);
}

/** The body of a request once it has all arrived; null as soon as it passes `limit` bytes, the rest read and dropped. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) resolve(null);
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** What the listener answers of Piwi Picker's pairing by code. */
export interface PickerPairingRoutes {
  /** Which editor listens here, and the folders of its window. */
  hello(): EditorHello;
  /** The requests the person answers in the editor. */
  requests: EditorPairingRequests;
}

/**
 * Listen on `127.0.0.1:<port>` (any free port with 0). Rejects when the port is
 * taken, so another editor window keeps the pairing it holds.
 */
export function startSendListener(options: {
  port: number;
  token: () => string;
  onPayload: (payload: EditorSendPayload) => Promise<SendResult>;
  /** The live hubs, read from the discovery files at each request. */
  live: () => LiveHub[] | Promise<LiveHub[]>;
  /** The port of the browser's machine a remote window forwards to the listener, read at each request. */
  forwarded?: () => readonly number[];
  /** Piwi Picker's pairing by code; without it, `…/hello` and `…/pairings` are not found. */
  pairing?: PickerPairingRoutes;
  /** Hears a request the token let through from a browser extension: Piwi Picker reached the pairing. */
  heard?: () => void;
}): Promise<SendListener> {
  const pairingAnswer = async (req: http.IncomingMessage, res: http.ServerResponse, pairing: PickerPairingRoutes) => {
    const path = req.url ?? '';
    let answered: EditorPairingAnswer<unknown>;
    if (path === HELLO_PATH && req.method === 'GET') {
      answered = { status: 200, body: pairing.hello() };
    } else if (path === PAIRINGS_PATH && req.method === 'POST') {
      const bytes = await readBody(req, MAX_PAIRING_BYTES);
      if (!bytes) {
        answer(res, 413, { error: 'too large' });
        return true;
      }
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString('utf-8'));
      } catch {
        body = undefined;
      }
      answered = pairing.requests.start(req.headers.origin, req.headers['content-type'], body);
    } else {
      const id = req.method === 'GET' ? editorPairingIdOf(path, VSCODE_PAIRING_BASE) : null;
      if (!id) return false;
      const secret = req.headers[EDITOR_PAIRING_SECRET_HEADER];
      answered = pairing.requests.poll(id, typeof secret === 'string' ? secret : null);
    }
    answer(res, answered.status, answered.body);
    return true;
  };
  /** A request the token let through: Piwi Picker's, when a browser extension sent it. */
  const heardFrom = (req: http.IncomingMessage) => {
    if (isExtensionOrigin(req.headers.origin)) options.heard?.();
  };
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const token = options.token();
    const reached = req.socket.localPort ?? 0;
    const named = hubHostPort(req.headers.host, reached, options.forwarded?.() ?? []);
    const proof = await proofFor(req, token, named ?? reached);
    if (proof) res.setHeader(EDITOR_PROOF_HEADER, proof);
    cors(req, res);
    // Another name for this machine (a page's DNS rebinding) is not this listener's.
    if (named === null) return answer(res, 403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (options.pairing && (await pairingAnswer(req, res, options.pairing))) return;
    if (req.url === LIVE_PATH && req.method === 'GET') {
      if (!sendAuthorized(req.headers.authorization, token)) return answer(res, 401, { error: 'not paired' });
      heardFrom(req);
      let hubs: LiveHub[] = [];
      try {
        hubs = await options.live();
      } catch {
        // No folder to read, or no service to ask: no hub.
      }
      return answer(res, 200, { hubs } satisfies LiveAnswer);
    }
    if (req.url !== SEND_PATH || req.method !== 'POST') return answer(res, 404, { error: 'not found' });
    if (!sendAuthorized(req.headers.authorization, token)) return answer(res, 401, { error: 'not paired' });
    heardFrom(req);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SEND_BYTES) {
        answer(res, 413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        return answer(res, 400, { error: 'the body must be JSON' });
      }
      const payload = parseSendPayload(body);
      if ('error' in payload) return answer(res, 400, payload);
      options.onPayload(payload).then(
        (result) => answer(res, 200, result),
        (e: Error) => answer(res, 422, { error: e.message }),
      );
    });
  };
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) answer(res, 500, { error: 'the editor could not answer' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}${SEND_PATH}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** What a window's pairing keeps between starts: the token in the secret store, the port in global state. */
export interface PairingStore {
  /** The token; empty before one was minted. */
  token: string;
  /** The port of the pairing Piwi Picker was given last; none before. */
  port: number | undefined;
  saveToken(token: string): PromiseLike<void>;
  savePort(port: number): PromiseLike<void>;
}

/**
 * The ports a window listens on for Piwi Picker, in order: the saved one, else the pairing ports Piwi Picker looks
 * at (`VSCODE_PAIRING_PORTS`).
 */
export function pairingPorts(
  saved: number | undefined,
  ports: readonly number[] = VSCODE_PAIRING_PORTS,
): readonly number[] {
  return saved ? [saved] : ports;
}

/**
 * The first of `ports` a listener starts on, else any free port; the listener another start made meanwhile, when one
 * did, so a window never holds two.
 */
async function listenOnFirst(
  running: () => SendListener | null,
  listen: (port: number) => Promise<SendListener>,
  ports: readonly number[],
): Promise<SendListener> {
  for (const port of ports) {
    const started = running();
    if (started) return started;
    try {
      return await listen(port);
    } catch {
      // Taken: the next one.
    }
  }
  return running() ?? listen(0);
}

/**
 * The Send to editor pairing of a window: its listener's loopback address and the token, the listener started and
 * the token minted when they are not. Piwi Picker's pairing (`saved: true`) starts it on the saved port, else on the
 * first free pairing port, else on any free one, and saves the port, so it outlives a restart; a run's pairing, which
 * the reporter uses only while the run lasts, takes the saved port or any free one when another window holds it, and
 * leaves the saved port to the pairing it names.
 */
export function sendPairing(options: {
  store: PairingStore;
  /** The listener running now, if any. */
  listener(): SendListener | null;
  listen(port: number): Promise<SendListener>;
  mint(): string;
  /** The pairing ports, `VSCODE_PAIRING_PORTS` unless a test names others. */
  ports?: readonly number[];
}): (saved: boolean) => Promise<EditorPairing> {
  const { store } = options;
  return async (saved) => {
    if (!store.token) {
      store.token = options.mint();
      await store.saveToken(store.token);
    }
    const ports = saved ? pairingPorts(store.port, options.ports) : store.port ? [store.port] : [];
    const listener = options.listener() ?? (await listenOnFirst(options.listener, options.listen, ports));
    if (saved && listener.port !== store.port) {
      store.port = listener.port;
      await store.savePort(listener.port);
    }
    return { url: listener.url, token: store.token };
  };
}

/**
 * Starts listeners one at a time: a start asked while another is on its way waits for that one, and gets its
 * listener, whatever port it asked.
 */
export function oneStartAtATime(
  start: (port: number) => Promise<SendListener>,
): (port: number) => Promise<SendListener> {
  let starting: Promise<SendListener> | null = null;
  return (port) => {
    starting ??= start(port).finally(() => {
      starting = null;
    });
    return starting;
  };
}

/** How often a window with no listener tries the saved port, which another window may hold. */
export const SAVED_PORT_RETRY_MS = 10_000;

/**
 * Takes the pairing's port once the window holding it lets it go: while this window has no listener, it tries now and
 * every `everyMs` the saved port (`saved`, read again at each try, since another window may pair meanwhile), else the
 * pairing ports in order, so Piwi Picker finds a window of this machine, and every window's hub through it, as long as
 * one is open. A pairing port another window of this editor holds (`held`: it proves it holds the same token) ends the
 * try, as the saved port does; one another program or another user holds is passed for the next. A window listening on another port for a
 * run's pairing keeps that listener. `started` hears each listener it starts.
 */
export function takeSavedPort(options: {
  /** The saved pairing as it stands now, read again at each try. */
  saved(): Promise<Pick<PairingStore, 'port' | 'token'>> | Pick<PairingStore, 'port' | 'token'>;
  listener(): SendListener | null;
  listen(port: number): Promise<SendListener>;
  /** Whether another window of this editor, which holds the same token, listens on `port`; none is, without it. */
  held?(port: number): Promise<boolean>;
  started?(listener: SendListener): void;
  everyMs?: number;
  /** The pairing ports, `VSCODE_PAIRING_PORTS` unless a test names others. */
  ports?: readonly number[];
}): { ready: Promise<void>; tryNow(): Promise<void>; dispose(): void } {
  let trying = false;
  const attempt = async (): Promise<void> => {
    if (trying || options.listener()) return;
    trying = true;
    try {
      const { port: saved } = await options.saved();
      for (const port of pairingPorts(saved, options.ports)) {
        if (options.listener()) return;
        try {
          const listener = await options.listen(port);
          // A start already on its way for a run's pairing may have answered on another port.
          if (listener.port === port) options.started?.(listener);
          return;
        } catch {
          // Another window holds the saved port still, or this pairing port: it keeps the pairing.
          if (saved || (await options.held?.(port).catch(() => false))) return;
        }
      }
    } finally {
      trying = false;
    }
  };
  const timer = setInterval(() => void attempt(), options.everyMs ?? SAVED_PORT_RETRY_MS);
  timer.unref?.();
  return { ready: attempt(), tryNow: attempt, dispose: () => clearInterval(timer) };
}

/** How long a listener of this machine may take to answer: a loopback answer takes milliseconds. */
const LOCAL_TIMEOUT_MS = 500;

/** What the listener on `port` of this machine says it is (`GET /piwi/hello`); null when none answers so. */
export async function helloAt(port: number, fetcher: typeof fetch = fetch): Promise<EditorHello | null> {
  try {
    const res = await fetcher(`http://127.0.0.1:${port}${HELLO_PATH}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    return res.ok ? parseEditorHello(await res.json()) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the listener on `port` of this machine holds `token`: its answer to a challenge on `GET /piwi/live` carries
 * the proof (`editorTokenProof`) for that port, as Piwi Picker asks it. Another user's editor, or a program that took
 * the port, proves nothing.
 */
export async function holdsToken(port: number, token: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!token) return false;
  const challenge = newEditorChallenge();
  try {
    const res = await fetcher(`http://127.0.0.1:${port}${LIVE_PATH}`, {
      headers: { [EDITOR_CHALLENGE_HEADER]: challenge },
      redirect: 'error',
      signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
    });
    return res.headers.get(EDITOR_PROOF_HEADER) === (await editorTokenProof(token, port, challenge));
  } catch {
    return false;
  }
}

/** The port of an `http:` address on `127.0.0.1` or `localhost`; null for any other address. */
export function loopbackPort(address: string): number | null {
  try {
    const url = new URL(address);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    return url.protocol === 'http:' && loopback && url.port ? Number(url.port) : null;
  } catch {
    return null;
  }
}

/**
 * A loopback `http:` address on `127.0.0.1`, where VS Code forwards it, whatever name it gave (`localhost`): the
 * address Piwi Picker pairs with, and the one it sends a token to. `localhost` may resolve to `[::1]`, where another
 * program could listen on the same port. Any other address as it is.
 */
export function onLoopback(address: string): string {
  const port = loopbackPort(address);
  if (port === null) return address;
  const url = new URL(address);
  return `http://127.0.0.1:${port}${url.pathname}${url.search}${url.hash}`;
}

/** What a remote window asks to list its service's hub where the browser's machine reaches it. */
export interface RemoteHub {
  /** The address of this window's service's hub (`piwi/hub`); null while it does not listen. */
  own(): Promise<string | null>;
  /** The address the browser's machine reaches an address of this one at (`vscode.env.asExternalUri`). */
  external(address: string): Promise<string>;
  /** Has the service's hub take the forwarded port in `Host` (`piwi/hub` with `forwarded`), answered once it does. */
  forward(port: number): Promise<void>;
}

/**
 * The live hubs `GET /piwi/live` lists. In a local window, those of every editor service on the machine. In a remote
 * window, whose services listen on the remote machine's loopback interface, this window's own alone, at the loopback
 * port of the browser's machine VS Code forwards to it, on `127.0.0.1` whatever name VS Code gives it, once its
 * service takes that port; the other windows' services take none this window forwards. None when the
 * forward is not a loopback `http:` address (Codespaces in the browser forwards to an `https` one) or the service
 * does not answer.
 */
export async function liveHubsHere(
  remoteName: string | undefined,
  read: () => LiveHub[],
  remote: RemoteHub,
): Promise<LiveHub[]> {
  if (!remoteName) return read();
  const own = await remote.own();
  const hub = own ? read().find((h) => h.url === own) : undefined;
  if (!hub) return [];
  const { port, pathname } = new URL(hub.url);
  const external = new URL(await remote.external(`http://127.0.0.1:${port}${pathname}`));
  const forwarded = loopbackPort(external.href);
  if (forwarded === null || pathname !== HUB_PATH) return [];
  await remote.forward(forwarded);
  return [{ ...hub, url: `ws://127.0.0.1:${forwarded}${HUB_PATH}` }];
}
