/**
 * The endpoint Piwi Picker sends to: an HTTP listener on the loopback
 * interface that accepts `POST /piwi/send` with the pairing token as a bearer
 * credential, and hands the payload to the extension to insert. With the same
 * token, `GET /piwi/live` lists the hubs of every editor service running on the
 * machine (`@piwitests/core/run-hub`'s `LiveAnswer`, from the services'
 * discovery files), so the one pairing reaches the runs of every editor window.
 * It answers only a request naming it as `127.0.0.1:<port>` or
 * `localhost:<port>` (a page reached under another name gets a 403), and every
 * answer to a request carrying a challenge carries the proof that it holds the
 * token (`@piwitests/core/editor-send`), so Piwi Picker sends the token only to
 * this listener.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  MAX_SEND_BYTES,
  editorTokenProof,
  isEditorChallenge,
  parseSendPayload,
  sendAuthorized,
  type EditorPairing,
  type EditorSendPayload,
} from '@piwitests/core/editor-send';
import { isHubHost, type LiveAnswer, type LiveHub } from '@piwitests/core/run-hub';

export const SEND_PATH = '/piwi/send';
export const LIVE_PATH = '/piwi/live';

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
    res.setHeader('Access-Control-Allow-Headers', `Authorization, Content-Type, ${EDITOR_CHALLENGE_HEADER}`);
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
 * The proof, for a request carrying a challenge, that this listener holds the pairing's token, bound to the port the
 * request reached; null without a challenge or a token.
 */
async function proofFor(req: http.IncomingMessage, token: string): Promise<string | null> {
  const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
  const port = req.socket.localPort;
  if (!token || !port || !isEditorChallenge(challenge)) return null;
  return editorTokenProof(token, port, challenge);
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
  live: () => LiveHub[];
}): Promise<SendListener> {
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const token = options.token();
    const proof = await proofFor(req, token);
    if (proof) res.setHeader(EDITOR_PROOF_HEADER, proof);
    cors(req, res);
    // Another name for this machine (a page's DNS rebinding) is not this listener's.
    if (!isHubHost(req.headers.host, req.socket.localPort ?? 0)) return answer(res, 403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url === LIVE_PATH && req.method === 'GET') {
      if (!sendAuthorized(req.headers.authorization, token)) return answer(res, 401, { error: 'not paired' });
      let hubs: LiveHub[] = [];
      try {
        hubs = options.live();
      } catch {
        // No folder to read: no hub.
      }
      return answer(res, 200, { hubs } satisfies LiveAnswer);
    }
    if (req.url !== SEND_PATH || req.method !== 'POST') return answer(res, 404, { error: 'not found' });
    if (!sendAuthorized(req.headers.authorization, token)) return answer(res, 401, { error: 'not paired' });
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
 * The Send to editor pairing of a window: its listener's loopback address and the token, the listener started (on
 * the saved port, else any free one, when another window holds it) and the token minted when they are not. Only the
 * pairing Piwi Picker is given (`saved: true`) saves the port, so it outlives a restart; a run's pairing, which
 * the reporter uses only while the run lasts, leaves the saved port to the pairing it names.
 */
export function sendPairing(options: {
  store: PairingStore;
  /** The listener running now, if any. */
  listener(): SendListener | null;
  listen(port: number): Promise<SendListener>;
  mint(): string;
}): (saved: boolean) => Promise<EditorPairing> {
  const { store } = options;
  return async (saved) => {
    if (!store.token) {
      store.token = options.mint();
      await store.saveToken(store.token);
    }
    const listener = options.listener() ?? (await options.listen(store.port ?? 0).catch(() => options.listen(0)));
    if (saved && listener.port !== store.port) {
      store.port = listener.port;
      await store.savePort(listener.port);
    }
    return { url: listener.url, token: store.token };
  };
}

/**
 * The live hubs `GET /piwi/live` lists: none in a remote window, whose services' loopback addresses are the remote
 * machine's, which the browser's machine does not reach.
 */
export function liveHubsHere(remoteName: string | undefined, read: () => LiveHub[]): LiveHub[] {
  return remoteName ? [] : read();
}
