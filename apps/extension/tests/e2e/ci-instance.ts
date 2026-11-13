import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { LIVE_STREAM_TYPE, encodeLiveViewerMessage, type LiveViewerMessage } from '@piwitests/core/live-view';
import { openOptions } from './fixtures.js';

/**
 * A stand-in Piwi instance with one CI run in progress (#78 of the project Shop, on main): its list, the run's own
 * stream with two running lanes, and the watches of its live view, whose live messages the spec sends.
 */
export interface CiInstance {
  url: string;
  /** The key the extension is connected with. */
  key: string;
  /** Whether the run's lanes can be watched, as its stream says as it opens. */
  watchable: boolean;
  /** The run's streams open now. */
  runStreams: ServerResponse[];
  /** The watches the extension opened, with their query, key, response and whether they closed. */
  watches: Array<{ query: URLSearchParams; key: unknown; res: ServerResponse; closed: boolean }>;
  /** What the extension posted to change a watch, with its key. */
  posts: Array<{ body: Record<string, unknown>; key: unknown }>;
  /** Send a live message on the latest watch. */
  live(message: LiveViewerMessage): void;
  close(): Promise<void>;
}

/** The two lanes the run's stream names: Playwright's worker index is the lane's plus four. */
export const CI_TESTS = ['cart › pays with a coupon', 'checkout › ships abroad'];

const lane = (n: number, title: string) => ({
  id: { run: 78, shard: null, lane: n },
  state: 'running',
  worker: n + 4,
  test: { id: `t${n}`, title, retry: 0 },
  stop: null,
  waiting: null,
  done: 2,
  failed: 0,
});

function sse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data, seq: 1, timestamp: Date.now() })}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}') as Record<string, unknown>;
}

export async function startCiInstance(): Promise<CiInstance> {
  const instance = {
    key: 'pd_ci_watch',
    watchable: true,
    runStreams: [],
    watches: [],
    posts: [],
  } as unknown as CiInstance;
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const [path, search] = (req.url ?? '').split('?');
    if (path === '/api/test-runs/recent') {
      res.setHeader('Content-Type', 'application/json');
      const run = {
        id: 78,
        projectId: 1,
        projectName: 'Shop',
        branch: 'main',
        status: 'running',
        startTime: new Date().toISOString(),
        origin: 'ci',
        totalTests: 9,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
        didNotRunTests: 0,
      };
      res.end(JSON.stringify({ items: [run] }));
      return;
    }
    if (path === '/api/test-runs/78/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      sse(res, 'init', { id: 78, status: 'running' });
      sse(res, 'live-view', { enabled: instance.watchable, keyed: true });
      CI_TESTS.forEach((title, n) => sse(res, 'lane', lane(n, title)));
      instance.runStreams.push(res);
      req.on('close', () => (instance.runStreams = instance.runStreams.filter((r) => r !== res)));
      return;
    }
    if (path === '/api/test-runs/78/live-view/watch' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': LIVE_STREAM_TYPE });
      const watch = { query: new URLSearchParams(search), key: req.headers['x-api-key'], res, closed: false };
      instance.watches.push(watch);
      req.on('close', () => (watch.closed = true));
      res.write(encodeLiveViewerMessage({ type: 'hello', watch: 'watch-0123456789ab' }));
      return;
    }
    if (path === '/api/test-runs/78/live-view/watch' && req.method === 'POST') {
      void readBody(req).then((body) => {
        instance.posts.push({ body, key: req.headers['x-api-key'] });
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  instance.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  instance.live = (message) =>
    instance.watches[instance.watches.length - 1]!.res.write(encodeLiveViewerMessage(message));
  instance.close = async () => {
    for (const res of [...instance.runStreams, ...instance.watches.map((w) => w.res)]) res.destroy();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // The extension's worker keeps its connections alive: they close with the instance.
    server.closeAllConnections();
    await closed;
  };
  return instance;
}

/** Connected mode on the instance, its key kept, for the project Shop. */
export async function connectTo(page: Page, extensionId: string, instance: CiInstance): Promise<void> {
  await openOptions(page, extensionId);
  await page.evaluate(
    ([url, key]) =>
      chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: url,
          apiKey: key,
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Shop' }],
        },
      }),
    [instance.url, instance.key] as const,
  );
}
