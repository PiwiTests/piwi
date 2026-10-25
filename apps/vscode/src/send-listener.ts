/**
 * The endpoint Piwi Picker sends to: an HTTP listener on the loopback
 * interface that accepts `POST /piwi/send` with the pairing token as a bearer
 * credential, and hands the payload to the extension to insert. With the same
 * token, `GET /piwi/live` lists the hubs of every editor service running on the
 * machine (`@piwitests/core/run-hub`'s `LiveAnswer`, from the services'
 * discovery files), so the one pairing reaches the runs of every editor window.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_SEND_BYTES, parseSendPayload, sendAuthorized, type EditorSendPayload } from '@piwitests/core/editor-send';
import type { LiveAnswer, LiveHub } from '@piwitests/core/run-hub';

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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Vary', 'Origin');
  }
}

function answer(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
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
  const server = http.createServer((req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url === LIVE_PATH && req.method === 'GET') {
      if (!sendAuthorized(req.headers.authorization, options.token())) return answer(res, 401, { error: 'not paired' });
      let hubs: LiveHub[] = [];
      try {
        hubs = options.live();
      } catch {
        // No folder to read: no hub.
      }
      return answer(res, 200, { hubs } satisfies LiveAnswer);
    }
    if (req.url !== SEND_PATH || req.method !== 'POST') return answer(res, 404, { error: 'not found' });
    if (!sendAuthorized(req.headers.authorization, options.token())) return answer(res, 401, { error: 'not paired' });
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
