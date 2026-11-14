import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { test as turboTest } from '../../src/test';
import { expect } from '../../src/test';

// Pairs of tests for a reused context: the first leaves a kind of state behind, the second checks that the next test
// starts without it. Both spec files run them in order in one worker, each with its own kind of reset.
export function defineIsolationTests(test: typeof turboTest): void {
  test.describe.configure({ mode: 'default' });

  let server: Server;
  let origin: string;

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end("self.addEventListener('fetch', () => {});");
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<p>headers: ${JSON.stringify(request.headers['x-leak'] ?? null)}</p>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('leaves storage of every kind behind', async ({ page, context }) => {
    await page.goto(origin);
    await context.addCookies([{ name: 'leak', value: '1', url: origin }]);
    await page.evaluate(async () => {
      localStorage.setItem('leak', '1');
      sessionStorage.setItem('leak', '1');
      await new Promise<void>((resolve) => {
        const open = indexedDB.open('leak', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('leak');
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
      });
      await (await caches.open('leak')).put('/leak', new Response('1'));
    });
  });

  test('starts with no cookie, storage, database or cache', async ({ page, context }) => {
    expect(await context.cookies()).toEqual([]);
    await page.goto(origin);
    const left = await page.evaluate(async () => ({
      local: localStorage.getItem('leak'),
      session: sessionStorage.getItem('leak'),
      databases: (await indexedDB.databases()).map((database) => database.name),
      caches: await caches.keys(),
    }));
    expect(left).toEqual({ local: null, session: null, databases: [], caches: [] });
  });

  test('leaves pages that save to storage as they unload', async ({ page, context }) => {
    const save = () =>
      addEventListener('pagehide', () => {
        localStorage.setItem('unload', '1');
        sessionStorage.setItem('unload', '1');
      });
    await page.goto(origin);
    await page.evaluate(save);
    const popup = await context.newPage();
    await popup.goto(`${origin}/popup`);
    await popup.evaluate(save);
  });

  test('starts with no storage saved by the last pages', async ({ page }) => {
    await page.goto(origin);
    const left = await page.evaluate(() => [localStorage.getItem('unload'), sessionStorage.getItem('unload')]);
    expect(left).toEqual([null, null]);
  });

  test('leaves session storage and caches on an origin it navigated away from', async ({ page }) => {
    await page.goto(origin);
    await page.evaluate(async () => {
      sessionStorage.setItem('left', '1');
      await (await caches.open('left')).put('/left', new Response('1'));
    });
    await page.route('https://elsewhere.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>away' }),
    );
    await page.goto('https://elsewhere.test/');
  });

  test('starts with no session storage or caches of an origin the last test left', async ({ page }) => {
    await page.goto(origin);
    const left = await page.evaluate(async () => [sessionStorage.getItem('left'), await caches.keys()]);
    expect(left).toEqual([null, []]);
  });

  test('leaves permissions, geolocation, headers and offline mode behind', async ({ context }) => {
    await context.grantPermissions(['geolocation'], { origin });
    await context.setGeolocation({ latitude: 48.85, longitude: 2.35 });
    await context.setExtraHTTPHeaders({ 'x-leak': '1' });
    await context.setOffline(true);
  });

  test('starts with default permissions, no extra header and online', async ({ page }) => {
    await page.goto(origin);
    await expect(page.locator('p')).toHaveText('headers: null');
    const permission = await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
    );
    expect(permission).not.toBe('granted');
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  });

  test('leaves routes, init scripts and bindings behind', async ({ page, context }) => {
    await context.route('**/routed', (route) => route.fulfill({ body: 'leaked route' }));
    await page.route('**/page-routed', (route) => route.fulfill({ body: 'leaked page route' }));
    await context.addInitScript(() => ((window as unknown as { leak: number }).leak = 1));
    await context.exposeBinding('leakBinding', () => 1);
    await page.goto(origin);
  });

  test('starts with no route, init script or binding', async ({ page }) => {
    await page.goto(origin);
    const left = await page.evaluate(async () => ({
      initScript: (window as unknown as { leak?: number }).leak ?? null,
      binding: typeof (window as unknown as { leakBinding?: unknown }).leakBinding,
      route: await fetch('/routed').then((response) => response.text()),
      pageRoute: await fetch('/page-routed').then((response) => response.text()),
    }));
    expect(left.initScript).toBeNull();
    expect(left.binding).toBe('undefined');
    expect(left.route).not.toBe('leaked route');
    expect(left.pageRoute).not.toBe('leaked page route');
  });

  test('leaves the clock, viewport, media and extra pages behind', async ({ page, context }) => {
    await page.clock.install({ time: new Date('2001-02-03T04:05:06Z') });
    await page.setViewportSize({ width: 400, height: 300 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await context.newPage();
    await page.goto(origin);
  });

  test('starts with the real clock, the configured viewport and media, and one page', async ({ page, context }) => {
    await page.goto(origin);
    expect(context.pages()).toHaveLength(1);
    const state = await page.evaluate(() => ({
      year: new Date().getFullYear(),
      width: window.innerWidth,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
    }));
    expect(state.year).toBeGreaterThan(2020);
    expect(state.width).toBe(1280);
    expect(state.dark).toBe(false);
  });

  test('leaves a service worker behind', async ({ page }) => {
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    });
  });

  test('starts with no service worker', async ({ page }) => {
    await page.goto(origin);
    const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    expect(registrations).toBe(0);
  });

  // Compared by their protocol ids: the objects themselves are too large for a readable diff.
  const idOf = (context: unknown) => (context as { _guid: string })._guid;
  let previous: string;

  test('records its context', async ({ context }) => {
    previous = idOf(context);
  });

  test('gets the same context back', async ({ context }) => {
    expect(idOf(context)).toBe(previous);
  });

  const animated = `<style>#box{width:10px;transition:width 20s linear}#box.wide{width:300px}</style><div id="box"></div>
    <script>requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('wide')))</script>`;

  test.describe('with instantAnimations', () => {
    test.use({ instantAnimations: true });

    for (const which of ['the first test', 'the next test on the same tab']) {
      test(`runs a long transition at once in ${which}`, async ({ page }) => {
        await page.setContent(animated);
        await expect(page.locator('#box')).toHaveCSS('width', '300px', { timeout: 2000 });
      });
    }
  });

  test('runs animations at their own speed after a test that sped them up', async ({ page }) => {
    await page.setContent(animated);
    await page.waitForTimeout(300);
    expect(await page.locator('#box').evaluate((box) => box.getBoundingClientRect().width)).toBeLessThan(100);
  });

  const covered =
    '<style>#cover:hover{color:rgb(255, 0, 0)}</style><div id="cover" style="position:fixed;inset:0">x</div>';
  const hovered = (page: Page) =>
    page.locator('#cover').evaluate((cover) => getComputedStyle(cover).color === 'rgb(255, 0, 0)');

  test('leaves the mouse over the page', async ({ page }) => {
    await page.setContent(covered);
    await page.mouse.move(200, 200);
    await expect.poll(() => hovered(page)).toBe(true);
  });

  test('starts with the mouse away from the page', async ({ page }) => {
    await page.setContent(covered);
    // Chromium updates the hover state of a new layout a few frames later.
    await page.waitForTimeout(300);
    expect(await hovered(page)).toBe(false);
  });

  test.describe('with failFast', () => {
    test.use({ failFast: true });

    for (const which of ['the first test', 'the next test on the same context']) {
      test(`ends a failing assertion on an idle page in ${which}`, async ({ page }) => {
        await page.route('https://idle.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<p>idle' }));
        await page.goto('https://idle.test/');
        const started = Date.now();
        const error = await expect(page.locator('#missing'))
          .toBeVisible({ timeout: 5000 })
          .catch((caught: Error) => caught);
        expect(error).toBeTruthy();
        expect(Date.now() - started).toBeLessThan(2000);
      });
    }
  });
}
