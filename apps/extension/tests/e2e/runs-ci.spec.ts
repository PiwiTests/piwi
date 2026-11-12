import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import sharp from 'sharp';
import { LIVE_STREAM_TYPE, encodeLiveViewerMessage, type LiveViewerMessage } from '@piwitests/core/live-view';
import { test, expect, openOptions } from './fixtures.js';

/**
 * The Runs window's CI runs against a stand-in Piwi instance: the run in progress it lists, the tests its lanes run
 * from the run's own stream, and **Watch** on one of them, read-only, through one watch of the run on the instance with
 * the extension's key, another lane shown by a POST on the same watch, its end said in the view with **Watch on the
 * dashboard**.
 */

const KEY = 'pd_ci_watch';
let server: Server;
let baseUrl: string;
/** The run's streams open now, to send it events. */
let runStreams: ServerResponse[] = [];
/** The watches the window opened, with their query, key, response and whether they closed. */
let watches: Array<{ query: URLSearchParams; key: unknown; res: ServerResponse; closed: boolean }> = [];
let posts: Array<{ body: Record<string, unknown>; key: unknown }> = [];
let watchable = true;

const lane = (n: number, title: string, state = 'running') => ({
  id: { run: 78, shard: null, lane: n },
  state,
  worker: n + 4,
  test: state === 'running' ? { id: `t${n}`, title, retry: 0 } : null,
  stop: null,
  waiting: null,
  done: 2,
  failed: 0,
});

function sse(res: ServerResponse, type: string, data: unknown): void {
  res.write(`data: ${JSON.stringify({ type, data, seq: 1, timestamp: Date.now() })}\n\n`);
}

function live(message: LiveViewerMessage): void {
  watches[watches.length - 1]!.res.write(encodeLiveViewerMessage(message));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}') as Record<string, unknown>;
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
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
      res.end(
        JSON.stringify({
          items: [
            {
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
            },
          ],
        }),
      );
      return;
    }
    if (path === '/api/test-runs/78/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      sse(res, 'init', { id: 78, status: 'running' });
      sse(res, 'live-view', { enabled: watchable, keyed: true });
      sse(res, 'lane', lane(0, 'cart › pays with a coupon'));
      sse(res, 'lane', lane(1, 'checkout › ships abroad'));
      runStreams.push(res);
      req.on('close', () => (runStreams = runStreams.filter((r) => r !== res)));
      return;
    }
    if (path === '/api/test-runs/78/live-view/watch' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': LIVE_STREAM_TYPE });
      const watch = { query: new URLSearchParams(search), key: req.headers['x-api-key'], res, closed: false };
      watches.push(watch);
      req.on('close', () => (watch.closed = true));
      res.write(encodeLiveViewerMessage({ type: 'hello', watch: 'watch-0123456789ab' }));
      return;
    }
    if (path === '/api/test-runs/78/live-view/watch' && req.method === 'POST') {
      void readBody(req).then((body) => {
        posts.push({ body, key: req.headers['x-api-key'] });
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  for (const res of [...runStreams, ...watches.map((w) => w.res)]) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  runStreams = [];
  watches = [];
  posts = [];
  watchable = true;
});

/** Connected mode on the stand-in instance, its key kept, then the Runs window. */
async function openRuns(page: Page, extensionId: string): Promise<void> {
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
    [baseUrl, KEY] as const,
  );
  await page.goto(`chrome-extension://${extensionId}/runs.html`);
}

const jpeg = (color: string) =>
  sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
    .jpeg()
    .toBuffer();

test('Watch on a CI run’s running test shows its lane read-only, through one watch of the run', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await expect(run.getByRole('list', { name: 'Tests running now' })).toBeVisible();
  const second = run.getByRole('listitem').filter({ hasText: 'Worker 2' });
  await expect(second).toContainText('checkout › ships abroad');
  await expect(run.getByRole('listitem').filter({ hasText: 'Worker 1' })).toContainText('cart › pays with a coupon');

  await second.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => watches.length).toBe(1);
  expect(watches[0]!.key).toBe(KEY);
  expect(Object.fromEntries(watches[0]!.query)).toMatchObject({ worker: '5', slot: '1' });
  await expect(second.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  live({
    type: 'frame',
    shard: null,
    worker: 5,
    slot: 1,
    image: new Uint8Array(await jpeg('#3b82f6')),
    call: { title: "Click getByRole('button', { name: 'Ship' })" } as never,
    test: 'checkout › ships abroad',
  });
  const view = run.getByRole('img', { name: 'Live view of the CI test’s page, read-only' });
  await expect(view).toBeVisible();
  await expect(run.locator('.ci-view .live-badge')).toBeVisible();
  await expect(run.locator('.ci-view figcaption')).toContainText("Click getByRole('button', { name: 'Ship' })");
  // Read-only: nothing here steers the run, takes input or picks.
  for (const name of ['Interact', 'Pause', 'Pick on the image', 'Resume']) {
    await expect(run.getByRole('button', { name, exact: true })).toHaveCount(0);
  }

  // Watch on the dashboard opens the lane's view on the run's page.
  const opened = context.waitForEvent('page');
  await second.getByRole('button', { name: 'Watch on the dashboard' }).click();
  expect((await opened).url()).toBe(`${baseUrl}/test-runs/78?watch=2`);

  // Another lane of the run shows on the same watch.
  const first = run.getByRole('listitem').filter({ hasText: 'Worker 1' });
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    key: KEY,
    body: { watch: 'watch-0123456789ab', focus: { worker: 4, shard: null, slot: 0 }, width: 880, height: 550 },
  });
  expect(watches).toHaveLength(1);
  await expect(first.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(second.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'false');
  live({
    type: 'frame',
    shard: null,
    worker: 4,
    slot: 0,
    image: new Uint8Array(await jpeg('#22c55e')),
    call: null,
    test: 'cart › pays with a coupon',
  });
  await expect(run.locator('.ci-view figcaption')).toContainText('cart › pays with a coupon');

  // The instance ends the watch with the run: said in the view, with the dashboard's view beside it.
  live({ type: 'end', reason: 'run-ended' });
  await expect(run.locator('.ci-view')).toContainText('The CI run ended.');
  await expect(page.locator('#announce')).toHaveText('The CI run ended.');
  await expect(run.locator('.ci-view').getByRole('button', { name: 'Watch on the dashboard' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Watch', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => watches[0]!.closed).toBe(true);

  // Watched again, then turned off: the watch closes.
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => watches.length).toBe(2);
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => watches[1]!.closed).toBe(true);
  await expect(run.locator('.ci-view')).toHaveCount(0);

  // A hidden window watches nothing, and watches again as it shows.
  await first.getByRole('button', { name: 'Watch', exact: true }).click();
  await expect.poll(() => watches.length).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => watches[2]!.closed).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => watches.length).toBe(4);
  await page.close();
  await expect.poll(() => watches[3]!.closed).toBe(true);
  await expect.poll(() => runStreams.length).toBe(0);
});

test('a CI run whose project’s live view is off lists its tests without Watch, saying why', async ({
  context,
  extensionId,
}) => {
  watchable = false;
  const page = await context.newPage();
  await openRuns(page, extensionId);
  const run = page.getByRole('region', { name: 'CI run #78' });
  await expect(run.getByRole('listitem').filter({ hasText: 'Worker 1' })).toBeVisible();
  await expect(run).toContainText('This run’s tests cannot be watched');
  await expect(run.getByRole('button', { name: 'Watch', exact: true })).toHaveCount(0);
  await expect(run.getByRole('button', { name: 'Watch on the dashboard' })).toHaveCount(2);
});
