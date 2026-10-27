import { test as base, expect, chromium, request, type BrowserContext, type Page } from '@playwright/test';
import * as childProcess from 'node:child_process';
import * as http from 'node:http';
import { extendPiwiFixtures } from '../../dist/index.js';

/**
 * The resource ledger against a live browser. Each `resources:` test opens
 * browsers, contexts, pages or API request contexts the way real suites do,
 * and closes them or leaves them open; `verify-reporter.ts` checks the
 * `piwi-resources` census each test attaches, and the findings reached from all
 * of them once the run is over: the leaky tests must produce exactly their
 * findings, the `clean` ones none. A `// site:<name>` comment marks each line
 * a check expects an object or a finding to point at.
 *
 * The tests run in file order on one worker: the hand-over, the listeners
 * piling up on the shared page and the server left listening are read across
 * tests.
 */
const test = extendPiwiFixtures(base).extend<{}, { sharedPage: Page; mockServer: string }>({
  // Worker-scoped, the "one page for the whole suite" pattern: what a test
  // opens from it, or adds to it, outlives the test.
  sharedPage: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      await use(await context.newPage()); // site:shared-page
      await context.close();
    },
    { scope: 'worker' },
  ],
  // Worker-scoped too: a server the worker keeps for its tests, started when
  // the first test that asks for it sets it up, inside that test's census.
  mockServer: [
    async ({}, use) => {
      const server = http.createServer((_req, res) => res.end('mock'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      await use(typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    { scope: 'worker' },
  ],
});

const PAGE_HTML = `<!doctype html>
<html>
  <body>
    <h1>Resources</h1>
    <button onclick="window.open('/popup')">Open</button>
  </body>
</html>`;

// A page that keeps its main thread busy, as a polling or animating page left open does.
const BUSY_HTML = `<!doctype html>
<html>
  <body>
    <h1>Busy</h1>
    <script>
      setInterval(() => {
        let sum = 0;
        for (let i = 0; i < 2e6; i++) sum += i;
        document.title = String(sum);
      }, 50);
    </script>
  </body>
</html>`;

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const html = req.url === '/busy' ? BUSY_HTML : PAGE_HTML;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('the fixture server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  // The pages the leaky tests left open still hold connections to it.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('resources: leaks a context', async ({ browser }) => {
  const context = await browser.newContext(); // site:context
  const page = await context.newPage();
  await page.goto(`${baseUrl}/busy`);
});

test('resources: leaks a page from browser.newPage', async ({ browser }) => {
  const page = await browser.newPage(); // site:new-page
  await page.goto(baseUrl);
});

test('resources: leaks an API request context', async () => {
  const api = await request.newContext(); // site:request
  expect((await api.get(baseUrl)).ok()).toBe(true);
});

test('resources: leaks a launched browser', async ({ launchOptions }) => {
  const browser = await chromium.launch(launchOptions); // site:launch
  const page = await browser.newPage();
  await page.goto(baseUrl);
});

test('resources: leaves a popup of a worker-scoped page open', async ({ sharedPage }) => {
  await sharedPage.goto(baseUrl);
  const popup = sharedPage.waitForEvent('popup');
  await sharedPage.getByRole('button', { name: 'Open' }).click(); // site:popup
  await (await popup).waitForLoadState();
});

for (const n of [1, 2, 3]) {
  test(`resources: adds a listener to a worker-scoped page ${n}`, async ({ sharedPage }) => {
    sharedPage.on('console', (message) => void message);
    await sharedPage.goto(baseUrl);
    await expect(sharedPage.getByRole('heading')).toHaveText('Resources');
  });
}

// Each adds elements the page keeps, as an app that appends a toast or a
// dialog and never removes it does; the page is never navigated after them.
for (const n of [1, 2, 3, 4]) {
  test(`resources: adds elements to a worker-scoped page ${n}`, async ({ sharedPage }) => {
    await sharedPage.evaluate(() => {
      const doc = (globalThis as Record<string, any>).document;
      for (let i = 0; i < 150; i++) doc.body.appendChild(doc.createElement('div'));
    });
  });
}

test.describe('resources: API checks under a page beforeEach', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (error) => console.error(error));
  });

  test('resources: opens a page it never uses', async ({ request: api }) => {
    expect((await api.get(baseUrl)).ok()).toBe(true);
  });
});

test('resources: leaves a server listening', async () => {
  const leftOpen = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => leftOpen.listen(0, '127.0.0.1', resolve)); // site:server
});

// The child process the next test leaves running, stopped once the file is done.
let leftRunning: childProcess.ChildProcess | null = null;
test.afterAll(() => {
  leftRunning?.kill();
});

test('resources: leaves a child process running', async () => {
  leftRunning = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); // site:child
  await new Promise((resolve) => leftRunning!.once('spawn', resolve));
});

test('resources: clean, waits for the child process it spawns', async () => {
  const child = childProcess.spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.once('exit', resolve));
});

test.describe('resources: a beforeAll context without afterAll', () => {
  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext(); // site:before-all
  });

  test('resources: uses the beforeAll context', async () => {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.close();
  });
});

test.describe('resources: clean, a beforeAll context closed in afterAll', () => {
  let context: BrowserContext;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext(); // site:before-all-closed
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('resources: clean, uses the beforeAll context', async () => {
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.close();
  });
});

test.describe('resources: clean, a context handed on', () => {
  let context: BrowserContext;

  test('resources: clean, opens a context for the next test', async ({ browser }) => {
    context = await browser.newContext(); // site:handed-on
    await (await context.newPage()).goto(baseUrl);
  });

  test('resources: clean, closes the context it was handed', async () => {
    await expect(context.pages()[0]!.getByRole('heading')).toHaveText('Resources');
    await context.close();
  });
});

test('resources: clean, uses a server a worker fixture started', async ({ mockServer }) => {
  const api = await request.newContext();
  expect(await (await api.get(mockServer)).text()).toBe('mock');
  await api.dispose();
});

test('resources: clean, evaluates on a page it never navigates', async ({ page }) => {
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
});

test('resources: clean, sets the content of its page', async ({ page }) => {
  await page.setContent('<h1>Resources</h1>');
  await expect(page.getByRole('heading')).toHaveText('Resources');
});

test('resources: clean, closes what it opens', async ({ browser, launchOptions }) => {
  const context = await browser.newContext();
  await (await context.newPage()).goto(baseUrl);
  await context.close();

  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.close();

  const api = await request.newContext();
  expect((await api.get(baseUrl)).ok()).toBe(true);
  await api.dispose();

  const launched = await chromium.launch(launchOptions);
  await launched.close();
});
