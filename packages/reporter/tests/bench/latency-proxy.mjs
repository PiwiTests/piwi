import * as http from 'node:http';
import { createRequire } from 'node:module';

// Playwright's bundled `ws`, reached through `@playwright/test` and the packages it depends on.
const fromPlaywrightTest = createRequire(createRequire(import.meta.url).resolve('@playwright/test'));
const fromPlaywright = createRequire(fromPlaywrightTest.resolve('playwright'));
const { ws: WebSocket, wsServer: WebSocketServer } = fromPlaywright('playwright-core/lib/utilsBundle');
if (typeof WebSocket !== 'function' || typeof WebSocketServer !== 'function') {
  throw new Error('the installed Playwright no longer bundles `ws` in playwright-core/lib/utilsBundle');
}

/** Upgrade headers the proxy's own WebSocket client writes for itself. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

/**
 * A WebSocket proxy between Playwright's client and a browser server that holds
 * every message for `delayMs` (a whole number of milliseconds, as Node's timers
 * run) in each direction, so a round trip costs `2 × delayMs` more: a remote
 * browser at a set distance. It counts the protocol messages the client sends,
 * by method.
 *
 * Messages keep their order: each one waits the same delay, and Node runs
 * timers of the same duration in the order they were set.
 */
export async function startLatencyProxy(upstreamUrl, delayMs) {
  const counts = new Map();

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const delayed = (send) => (delayMs > 0 ? setTimeout(send, delayMs) : send());

  wss.on('connection', (client, request) => {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!HOP_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
    }
    const upstream = new WebSocket(upstreamUrl, [], { headers, perMessageDeflate: false });
    const toUpstream = [];
    upstream.on('open', () => {
      for (const { data, isBinary } of toUpstream.splice(0)) upstream.send(data, { binary: isBinary });
    });
    client.on('message', (data, isBinary) => {
      try {
        const method = JSON.parse(data.toString()).method;
        if (typeof method === 'string') counts.set(method, (counts.get(method) ?? 0) + 1);
      } catch {
        /* not a protocol message */
      }
      delayed(() => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else toUpstream.push({ data, isBinary });
      });
    });
    upstream.on('message', (data, isBinary) => {
      delayed(() => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
    });
    const closeBoth = () => {
      delayed(() => {
        client.close();
        upstream.close();
      });
    };
    client.on('close', closeBoth);
    upstream.on('close', closeBoth);
    client.on('error', closeBoth);
    upstream.on('error', closeBoth);
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  return {
    wsEndpoint: `ws://127.0.0.1:${port}/`,
    /** The protocol messages the client sent since the last reset, in all and by method. */
    stats() {
      return {
        messages: [...counts.values()].reduce((sum, n) => sum + n, 0),
        byMethod: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
      };
    },
    reset() {
      counts.clear();
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
