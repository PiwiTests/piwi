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
  // Requests the server answered, by route: the HTTP cache answers the others.
  const hits = { fresh: 0, static: 0, staticCookie: 0, late: 0 };

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end("self.addEventListener('fetch', () => {});");
        return;
      }
      if (request.url === '/basic') {
        const authorization = request.headers.authorization;
        response.writeHead(authorization ? 200 : 401, {
          'content-type': 'text/html',
          ...(authorization ? {} : { 'www-authenticate': 'Basic realm="leak"' }),
        });
        response.end(`<p id="auth">${authorization ?? 'none'}</p>`);
        return;
      }
      // A service worker that caches every response it fetches, as offline-first apps do.
      if (request.url === '/caching-sw.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(`self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
          self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request).then(async (fetched) => {
            await (await caches.open('runtime')).put(event.request, fetched.clone());
            return fetched;
          })));`);
        return;
      }
      // A response the browser may serve again for ten minutes, and a static asset it may keep for a year.
      if (request.url === '/fresh') {
        response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=600' });
        response.end(String(++hits.fresh));
        return;
      }
      if (request.url === '/static.js') {
        hits.static++;
        response.writeHead(200, {
          'content-type': 'text/javascript',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        response.end('window.staticLoaded = true;');
        return;
      }
      // A static asset that sets a cookie, and a response the browser may serve again for ten minutes.
      if (request.url === '/static-cookie.js') {
        hits.staticCookie++;
        response.writeHead(200, {
          'content-type': 'text/javascript',
          'cache-control': 'public, max-age=31536000, immutable',
          'set-cookie': 'seen=1; Path=/',
        });
        response.end('window.staticLoaded = true;');
        return;
      }
      if (request.url === '/late') {
        response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=600' });
        response.end(String(++hits.late));
        return;
      }
      if (request.url === '/static-cookie-page') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<script src="/static-cookie.js"></script><p>static</p>');
        return;
      }
      if (request.url === '/static-page') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<script src="/static.js"></script><p>static</p>');
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

  test.describe('with a viewport and color scheme of its own', () => {
    test.use({ viewport: { width: 500, height: 400 }, colorScheme: 'dark' });

    test('runs with the options it asks for', async ({ page }) => {
      await page.goto(origin);
      const state = await page.evaluate(() => ({
        width: window.innerWidth,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      }));
      expect(state).toEqual({ width: 500, dark: true });
    });
  });

  test('starts with the configured viewport and media after a test that asked for others', async ({ page }) => {
    await page.goto(origin);
    const state = await page.evaluate(() => ({
      width: window.innerWidth,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
    }));
    expect(state).toEqual({ width: 1280, dark: false });
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

  // The browser keeps the credentials it sent to an origin for the context's life: the next test asks another one.
  const otherOrigin = () => origin.replace('127.0.0.1', 'localhost');

  test('leaves HTTP credentials behind', async ({ page, context }) => {
    await context.setHTTPCredentials({ username: 'user', password: 'secret' });
    await page.goto(`${origin}/basic`);
    await expect(page.locator('#auth')).not.toHaveText('none');
  });

  test('starts with no HTTP credentials for an origin', async ({ page }) => {
    await page.goto(`${otherOrigin()}/basic`);
    await expect(page.locator('#auth')).toHaveText('none');
  });

  const timezone = (page: Page) => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  let configuredTimezone: string;

  test('leaves emulation set through its own CDP session behind', async ({ page, context }) => {
    configuredTimezone = await timezone(page);
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Chatham' });
    expect(await timezone(page)).toBe('Pacific/Chatham');
  });

  test('starts with no emulation of the last test', async ({ page }) => {
    await page.goto(origin);
    expect(await timezone(page)).toBe(configuredTimezone);
  });

  const cachesLeft = (page: Page) => page.evaluate(() => caches.keys());

  test('leaves a page that keeps writing to its caches', async ({ page }) => {
    await page.goto(origin);
    await page.evaluate(() => setInterval(() => void caches.open('late'), 5));
  });

  test('starts with no cache the last page wrote after the test', async ({ page }) => {
    await page.goto(origin);
    expect(await cachesLeft(page)).toEqual([]);
  });

  test('leaves a service worker that caches what it fetches', async ({ page }) => {
    await page.goto(origin);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/caching-sw.js');
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => cachesLeft(page)).toEqual(['runtime']);
  });

  test("starts with no cache of the last test's service worker", async ({ page }) => {
    await page.goto(origin);
    expect(await cachesLeft(page)).toEqual([]);
  });

  test('closes its last page after writing to its caches', async ({ page }) => {
    await page.goto(origin);
    await page.evaluate(async () => void (await caches.open('closed')));
    await page.close();
  });

  test('starts with no cache of a page the last test closed', async ({ page }) => {
    await page.goto(origin);
    expect(await cachesLeft(page)).toEqual([]);
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

  /** Loads the page of the static asset, and returns how many times the server sent the asset. */
  async function loadStaticAsset(page: Page) {
    await page.goto(`${origin}/static-page`);
    await expect.poll(() => page.evaluate(() => (window as { staticLoaded?: boolean }).staticLoaded)).toBe(true);
    return hits.static;
  }

  let staticBefore = 0;
  let freshBefore = '';

  test('loads a static asset and nothing the browser could reuse without asking', async ({ page }) => {
    staticBefore = await loadStaticAsset(page);
  });

  test('gets that static asset from the cache only when the reset keeps static assets', async ({
    page,
    keepStaticCache,
  }) => {
    expect(await loadStaticAsset(page)).toBe(staticBefore + (keepStaticCache ? 0 : 1));
  });

  test('leaves a response the browser could serve again without asking, beside a static asset', async ({ page }) => {
    staticBefore = await loadStaticAsset(page);
    freshBefore = await page.evaluate(() => fetch('/fresh').then((response) => response.text()));
  });

  test('starts with neither of them cached', async ({ page }) => {
    expect(await loadStaticAsset(page)).toBe(staticBefore + 1);
    expect(await page.evaluate(() => fetch('/fresh').then((response) => response.text()))).not.toBe(freshBefore);
  });

  let cookieBefore = 0;

  test('loads a static asset that sets a cookie', async ({ page }) => {
    await page.goto(`${origin}/static-cookie-page`);
    await expect.poll(() => page.evaluate(() => (window as { staticLoaded?: boolean }).staticLoaded)).toBe(true);
    cookieBefore = hits.staticCookie;
  });

  test('gets that asset from the server again', async ({ page }) => {
    await page.goto(`${origin}/static-cookie-page`);
    await expect.poll(() => page.evaluate(() => (window as { staticLoaded?: boolean }).staticLoaded)).toBe(true);
    expect(hits.staticCookie).toBe(cookieBefore + 1);
  });

  for (const delay of [0, 20, 40]) {
    test(`leaves a reusable response that arrives once the test has ended (${delay} ms)`, async ({ page }) => {
      await page.goto(origin);
      await page.evaluate((after) => void setTimeout(() => fetch('/late'), after), delay);
    });

    test(`gets that response from the server (${delay} ms)`, async ({ page }) => {
      await page.goto(origin);
      const before = hits.late;
      await page.evaluate(() => fetch('/late').then((response) => response.text()));
      expect(hits.late).toBe(before + 1);
    });
  }

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
