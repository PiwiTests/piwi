import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { extensionWorker, launchWithEditedManifest } from './fixtures.js';
import { fireDevtoolsEvent, openDevtoolsPage } from './devtools-stub.js';

/** The shop: two buttons load the cart, by fetch and by XHR, and say how it went and how long it took. */
const SHOP = `<!doctype html><html><body>
<button id="fetch">Load with fetch</button><button id="xhr">Load with XHR</button>
<button id="image">Load the image</button>
<output id="result"></output><output id="elapsed"></output>
<script>
  const show = (text, started) => {
    document.getElementById('result').textContent = text;
    document.getElementById('elapsed').textContent = String(Math.round(performance.now() - started));
  };
  document.getElementById('fetch').onclick = () => {
    const started = performance.now();
    fetch('/api/cart?_=' + Date.now())
      .then((r) => (r.ok ? r.json().then((c) => show('total ' + c.total, started)) : show('error ' + r.status, started)))
      .catch(() => show('network error', started));
  };
  document.getElementById('image').onclick = () => {
    const started = performance.now();
    const img = new Image();
    img.onload = () => show('image loaded', started);
    img.onerror = () => show('image failed', started);
    img.src = '/pic.png?_=' + Date.now();
  };
  document.getElementById('xhr').onclick = () => {
    const started = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/cart?_=' + Date.now());
    xhr.onload = () => show(xhr.status === 200 ? 'total ' + JSON.parse(xhr.responseText).total : 'error ' + xhr.status, started);
    xhr.onerror = () => show('network error', started);
    xhr.send();
  };
</script></body></html>`;

/** A page under `/app/` whose base URL is `/api/`: its relative requests go to `/api/…`. */
const BASED = `<!doctype html><html><head><base href="/api/"></head><body>Orders</body></html>`;

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Fixtures {
  site: string;
  /** The same pages from a second server: another origin, which the extension also has access to. */
  otherSite: string;
  context: BrowserContext;
  extensionId: string;
  /** Whether the extension has `debugger`; without it, as in Firefox, the page's wrapper applies the conditions. */
  debuggingProtocol: boolean;
}

/** The shop's pages and its API. */
function serveShop(request: http.IncomingMessage, response: http.ServerResponse): void {
  if (request.url?.startsWith('/api/cart')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ total: 40 }));
    return;
  }
  if (request.url?.startsWith('/api/slow')) {
    response.setHeader('content-type', 'application/json');
    setTimeout(() => response.end('{}'), 3_000);
    return;
  }
  if (request.url?.startsWith('/app/')) {
    response.setHeader('content-type', 'text/html');
    response.end(BASED);
    return;
  }
  if (request.url?.startsWith('/pic.png')) {
    response.setHeader('content-type', 'image/png');
    response.end(PIXEL);
    return;
  }
  response.setHeader('content-type', 'text/html');
  response.end(SHOP);
}

/** The real extension, granted the local site as a person grants it from the panel's click. */
const test = base.extend<Fixtures>({
  debuggingProtocol: [true, { option: true }],
  site: async ({}, use) => {
    const server = http.createServer(serveShop);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.close();
  },
  otherSite: async ({}, use) => {
    const server = http.createServer(serveShop);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.close();
  },
  context: async ({ debuggingProtocol }, use) => {
    const context = await launchWithEditedManifest((manifest) => ({
      ...manifest,
      permissions: manifest.permissions.filter((p) => debuggingProtocol || p !== 'debugger'),
      host_permissions: ['http://127.0.0.1/*'],
    }));
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    await use((await extensionWorker(context)).url().split('/')[2]!);
  },
});

async function tabIdOf(context: BrowserContext, extensionId: string, url: string): Promise<number> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const id = await page.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, url);
  await page.close();
  return id;
}

async function load(shop: Page, via: 'fetch' | 'xhr' | 'image'): Promise<{ result: string; elapsed: number }> {
  await shop.evaluate(() => {
    document.getElementById('result')!.textContent = '';
  });
  await shop.locator(`#${via}`).click();
  await expect(shop.locator('#result')).not.toBeEmpty({ timeout: 10_000 });
  return {
    result: (await shop.locator('#result').textContent())!,
    elapsed: Number(await shop.locator('#elapsed').textContent()),
  };
}

test('slows down or fails the selected request in its tab only, and turns off', async ({
  context,
  extensionId,
  site,
}) => {
  const shop = await context.newPage();
  await shop.goto(`${site}/shop`);
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'total 40' });
  const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
  const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, { tabId });
  await panel.getByRole('tab', { name: 'Network' }).click();
  await expect(panel.getByText('Select a request to mock it, slow it down or make it fail.')).toBeVisible();
  const conditions = panel.getByRole('region', { name: 'Request conditions' });
  await expect(conditions).toBeHidden();
  await fireDevtoolsEvent(panel, 'requestFinished', {
    request: { method: 'GET', url: `${site}/api/cart?_=1695820800000` },
    response: { status: 200, content: { mimeType: 'application/json' } },
    time: 3,
    _resourceType: 'fetch',
    __body: '{"total":40}',
  });
  await panel.getByRole('list', { name: 'Network' }).getByRole('button').first().click();

  await panel.getByRole('button', { name: 'Fail with 500' }).click();
  await expect(conditions.getByRole('listitem')).toHaveText([/Answer GET \*\*\/api\/cart\?_=\* with a 500 error/]);
  await expect(shop.locator('#piwi-conditions-banner')).toBeAttached();
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'error 500' });
  expect(await load(shop, 'xhr')).toMatchObject({ result: 'error 500' });

  // A new condition on the same request takes the old one's place.
  await panel.getByRole('button', { name: 'Fail (network error)' }).click();
  await expect(conditions.getByRole('listitem')).toHaveText([/Fail GET .* as a network error/]);
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'network error' });
  expect(await load(shop, 'xhr')).toMatchObject({ result: 'network error' });

  await panel.getByRole('spinbutton', { name: 'Delay in seconds' }).fill('1.5');
  await panel.getByRole('button', { name: 'Slow down' }).click();
  await expect(conditions.getByRole('listitem')).toHaveText([/Slow down GET .* by 1\.5 s/]);
  const slow = await load(shop, 'fetch');
  expect(slow.result).toBe('total 40');
  expect(slow.elapsed).toBeGreaterThanOrEqual(1500);
  expect((await load(shop, 'xhr')).elapsed).toBeGreaterThanOrEqual(1500);

  // The tab's next pages keep it; another tab of the site does not have it.
  await shop.reload();
  expect((await load(shop, 'fetch')).elapsed).toBeGreaterThanOrEqual(1500);
  const other = await context.newPage();
  await other.goto(`${site}/shop`);
  expect((await load(other, 'fetch')).elapsed).toBeLessThan(1000);
  await expect(other.locator('#piwi-conditions-banner')).toHaveCount(0);

  const reloaded = shop.waitForEvent('load');
  await conditions.getByRole('button', { name: 'Turn all off and reload' }).click();
  await reloaded;
  await expect(conditions).toBeHidden();
  await expect(shop.locator('#piwi-conditions-banner')).toHaveCount(0);
  expect((await load(shop, 'fetch')).elapsed).toBeLessThan(1000);
});

/** Whether the extension holds a debugging session on the tab: a command goes through only then. */
async function attached(context: BrowserContext, tabId: number): Promise<boolean> {
  const worker = await extensionWorker(context);
  return worker.evaluate(async (id) => {
    try {
      await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' });
      return true;
    } catch {
      return false;
    }
  }, tabId);
}

test('through the debugging protocol: fails an image, takes the whole page offline, slows the CPU, and lets go', async ({
  context,
  extensionId,
  site,
}) => {
  const shop = await context.newPage();
  await shop.goto(`${site}/shop`);
  expect(await load(shop, 'image')).toMatchObject({ result: 'image loaded' });
  const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
  const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, { tabId });
  await panel.getByRole('tab', { name: 'Network' }).click();
  await fireDevtoolsEvent(panel, 'requestFinished', {
    request: { method: 'GET', url: `${site}/pic.png?_=1695820800000` },
    response: { status: 200, content: { mimeType: 'image/png' } },
    time: 2,
    _resourceType: 'image',
  });
  // An image is not an API call: it is listed with Every kind.
  const list = panel.getByRole('list', { name: 'Network' });
  await expect(list.getByRole('button')).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'Every kind' }).check();
  await list.getByRole('button').first().click();
  await panel.getByRole('button', { name: 'Fail with 500' }).click();
  const conditions = panel.getByRole('region', { name: 'Request conditions' });
  await expect(conditions.getByRole('listitem')).toHaveText([/Answer GET \*\*\/pic\.png\?_=\* with a 500 error/]);
  await expect(conditions).toContainText('through Chrome’s debugging protocol');
  expect(await load(shop, 'image')).toMatchObject({ result: 'image failed' });
  expect(await attached(context, tabId)).toBe(true);

  await panel.getByRole('combobox', { name: 'Network' }).selectOption({ label: 'The whole page offline' });
  await expect(conditions.getByRole('listitem')).toHaveText([/Answer GET/, 'The whole page offlineRemove']);
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'network error' });
  await panel.getByRole('combobox', { name: 'CPU' }).selectOption({ label: 'The CPU 4 times slower' });
  await expect(conditions.getByRole('listitem')).toHaveCount(3);
  await expect(shop.locator('#piwi-conditions-banner')).toBeAttached();

  // Offline removed on its own: the page's requests go out again, the image still fails.
  await conditions.getByRole('listitem').filter({ hasText: 'offline' }).getByRole('button', { name: 'Remove' }).click();
  await expect(conditions.getByRole('listitem')).toHaveCount(2);
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'total 40' });

  const reloaded = shop.waitForEvent('load');
  await conditions.getByRole('button', { name: 'Turn all off and reload' }).click();
  await reloaded;
  await expect(conditions).toBeHidden();
  expect(await load(shop, 'image')).toMatchObject({ result: 'image loaded' });
  await expect.poll(() => attached(context, tabId)).toBe(false);
});

/** An extension page to send the Piwi panel's messages from, as the panel does. */
async function extensionPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

function setConditions(sender: Page, message: Record<string, unknown>): Promise<unknown> {
  return sender.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'piwi-set-conditions', ...message });
}

const failCart = { id: 'cart', method: 'GET', pattern: '**/api/cart?_=*', kind: 'error', delayMs: 0 };

test('conditions set on a second tab let go of the first', async ({ context, extensionId, site }) => {
  const first = await context.newPage();
  await first.goto(`${site}/shop`);
  const second = await context.newPage();
  await second.goto(`${site}/shop?second`);
  const firstId = await tabIdOf(context, extensionId, `${site}/shop`);
  const secondId = await tabIdOf(context, extensionId, `${site}/shop?second`);

  const sender = await extensionPage(context, extensionId);
  expect(await setConditions(sender, { tabId: firstId, origin: site, conditions: [failCart] })).toEqual({ ok: true });
  expect(await load(first, 'fetch')).toMatchObject({ result: 'error 500' });
  expect(await setConditions(sender, { tabId: secondId, origin: site, conditions: [failCart] })).toEqual({ ok: true });
  expect(await load(second, 'fetch')).toMatchObject({ result: 'error 500' });

  await expect.poll(() => attached(context, firstId)).toBe(false);
  expect(await load(first, 'fetch')).toMatchObject({ result: 'total 40' });
  expect(await attached(context, secondId)).toBe(true);
});

test('conditions turned off while they are still being turned on end with nothing attached', async ({
  context,
  extensionId,
  site,
}) => {
  const shop = await context.newPage();
  await shop.goto(`${site}/shop`);
  const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
  const sender = await extensionPage(context, extensionId);
  await sender.evaluate(
    ([id, origin, condition]) =>
      Promise.all([
        chrome.runtime.sendMessage({ type: 'piwi-set-conditions', tabId: id, origin, conditions: [condition] }),
        chrome.runtime.sendMessage({ type: 'piwi-set-conditions', tabId: id, origin, conditions: [] }),
      ]),
    [tabId, site, failCart] as const,
  );
  await expect.poll(() => attached(context, tabId)).toBe(false);
  await shop.waitForLoadState();
  expect(await load(shop, 'fetch')).toMatchObject({ result: 'total 40' });
});

/** Waits until the page's wrapper holds the conditions with these ids. */
async function wrapperHolds(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (window as unknown as { __piwiRequestConditions?: { conditions: Array<{ id: string }> } })
            .__piwiRequestConditions?.conditions ?? []
        ).map((c) => c.id),
      ),
    )
    .toEqual(ids);
}

/** Sends an XHR for the cart and aborts it at once, as a typeahead drops a request it no longer needs: what the page sees. */
function sendAndAbort(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const xhr = new XMLHttpRequest();
        for (const type of ['readystatechange', 'load', 'error', 'abort', 'loadend']) {
          xhr.addEventListener(type, () => seen.push(`${type} ${xhr.readyState}`));
        }
        xhr.open('GET', `/api/cart?_=${Date.now()}`);
        xhr.send();
        xhr.abort();
        seen.push(`aborted ${xhr.readyState} ${xhr.status}`);
        // Past any delay: nothing more arrives.
        setTimeout(() => resolve(seen), 2_500);
      }),
  );
}

/** Sends the cart request on the page's one XHR, made on the first call: its state once opened, then as it ends. */
function sendAgain(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const w = window as unknown as { reused?: XMLHttpRequest };
        const xhr = (w.reused ??= new XMLHttpRequest());
        xhr.open('GET', `/api/cart?_=${Date.now()}`);
        const opened = `${xhr.readyState} ${xhr.status}`;
        xhr.onloadend = () => resolve(`${opened} → ${xhr.readyState} ${xhr.status} ${xhr.responseText}`);
        xhr.send();
      }),
  );
}

test('once the page is on another site, the strip names the site its conditions are for, and turns them off there', async ({
  context,
  extensionId,
  site,
}) => {
  const shop = await context.newPage();
  await shop.goto(`${site}/shop`);
  const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
  const sender = await extensionPage(context, extensionId);
  expect(await setConditions(sender, { tabId, origin: site, conditions: [failCart] })).toEqual({ ok: true });
  const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, { tabId });
  await panel.getByRole('tab', { name: 'Network' }).click();
  const conditions = panel.getByRole('region', { name: 'Request conditions' });
  await expect(conditions.getByRole('listitem')).toHaveText([/Answer GET/]);
  await expect(conditions).not.toContainText('Set for');

  // The same server under another name: another origin, which the extension has no access to.
  const elsewhere = site.replace('127.0.0.1', 'localhost');
  await shop.goto(`${elsewhere}/shop`);
  await fireDevtoolsEvent(panel, 'navigated', `${elsewhere}/shop`);
  await expect(conditions).toContainText(`Set for ${site}`);
  // The worker changes a tab's conditions only while it shows their site: all of them go, or none.
  await expect(conditions.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await conditions.getByRole('button', { name: 'Turn all off and reload' }).click();
  await expect(conditions).toBeHidden();
  expect(await sender.evaluate(() => chrome.storage.session.get('piwiRequestConditions'))).toEqual({});
});

test('a condition added once the page is on another site is that site’s own, without the first site’s', async ({
  context,
  extensionId,
  site,
  otherSite,
}) => {
  const shop = await context.newPage();
  await shop.goto(`${site}/shop`);
  const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
  const sender = await extensionPage(context, extensionId);
  expect(await setConditions(sender, { tabId, origin: site, conditions: [failCart], cpuRate: 4 })).toEqual({
    ok: true,
  });
  const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, { tabId });
  await panel.getByRole('tab', { name: 'Network' }).click();
  const conditions = panel.getByRole('region', { name: 'Request conditions' });
  await expect(conditions.getByRole('listitem')).toHaveText([/Answer GET/, /CPU/]);

  await shop.goto(`${otherSite}/shop`);
  await fireDevtoolsEvent(panel, 'navigated', `${otherSite}/shop`);
  await expect(conditions).toContainText(`Set for ${site}`);
  await fireDevtoolsEvent(panel, 'requestFinished', {
    request: { method: 'GET', url: `${otherSite}/api/slow?_=1695820800000` },
    response: { status: 200, content: { mimeType: 'application/json' } },
    time: 3,
    _resourceType: 'fetch',
    __body: '{}',
  });
  await panel.getByRole('list', { name: 'Network' }).getByRole('button').first().click();
  await panel.getByRole('button', { name: 'Slow down' }).click();
  await expect(conditions.getByRole('listitem')).toHaveText([/Slow down GET \*\*\/api\/slow/]);
  await expect(conditions).not.toContainText('Set for');
  const stored = (await sender.evaluate(() => chrome.storage.session.get('piwiRequestConditions'))) as {
    piwiRequestConditions: { origin: string; conditions: Array<{ kind: string }>; cpuRate?: number | null };
  };
  expect(stored.piwiRequestConditions.origin).toBe(otherSite);
  expect(stored.piwiRequestConditions.conditions.map((c) => c.kind)).toEqual(['delay']);
  expect(stored.piwiRequestConditions.cpuRate ?? null).toBeNull();
});

/** Sends a POST with a body and aborts it at once: what the XHR and its upload object fire, and its state. */
function postAndAbort(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const xhr = new XMLHttpRequest();
        for (const type of ['loadstart', 'readystatechange', 'load', 'error', 'abort', 'timeout', 'loadend']) {
          xhr.addEventListener(type, () => seen.push(`${type} ${xhr.readyState}`));
          if (type !== 'readystatechange') xhr.upload.addEventListener(type, () => seen.push(`upload ${type}`));
        }
        xhr.open('POST', `/api/cart?_=${Date.now()}`);
        xhr.send('{"sku":"SPRING-TEE"}');
        xhr.abort();
        seen.push(`aborted ${xhr.readyState} ${xhr.status}`);
        // Past any delay: nothing more arrives.
        setTimeout(() => resolve(seen), 2_500);
      }),
  );
}

interface Ended {
  seen: string[];
  elapsed: number;
  state: string;
  timeout: number;
}

/** Sends a GET with `timeout` set: the events it fires, how long it took to end, its state, and the timeout it reads. */
function getWithTimeout(page: Page, path: string, timeout: number): Promise<Ended> {
  return page.evaluate(
    ([url, ms]) =>
      new Promise<Ended>((resolve) => {
        const seen: string[] = [];
        const started = performance.now();
        const xhr = new XMLHttpRequest();
        for (const type of ['loadstart', 'load', 'error', 'abort', 'timeout', 'loadend']) {
          xhr.addEventListener(type, () => seen.push(type));
        }
        xhr.open('GET', `${url}?_=${Date.now()}`);
        xhr.timeout = ms;
        xhr.onloadend = () =>
          resolve({
            seen,
            elapsed: Math.round(performance.now() - started),
            state: `${xhr.readyState} ${xhr.status}`,
            timeout: xhr.timeout,
          });
        xhr.send();
      }),
    [path, timeout] as const,
  );
}

test.describe('without the debugging protocol, through the page’s wrapper', () => {
  test.use({ debuggingProtocol: false });

  test('a fetch held back rejects as soon as its signal aborts, and one already aborted gets no answer', async ({
    context,
    extensionId,
    site,
  }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
    const sender = await extensionPage(context, extensionId);
    const slowCart = { ...failCart, id: 'slow', kind: 'delay', delayMs: 1_500 };
    const failOther = { ...failCart, id: 'other', pattern: '**/api/other' };
    expect(await setConditions(sender, { tabId, origin: site, conditions: [slowCart, failOther] })).toEqual({
      ok: true,
    });
    await wrapperHolds(shop, ['slow', 'other']);
    const outcome = await shop.evaluate(async () => {
      const started = performance.now();
      const during = new AbortController();
      setTimeout(() => during.abort(), 200);
      const slow = await fetch(`/api/cart?_=${Date.now()}`, { signal: during.signal }).then(
        () => 'answered',
        (err: Error) => err.name,
      );
      const elapsed = Math.round(performance.now() - started);
      const before = new AbortController();
      before.abort();
      const failed = await fetch('/api/other', { signal: before.signal }).then(
        (r) => `answered ${r.status}`,
        (err: Error) => err.name,
      );
      return { slow, elapsed, failed };
    });
    expect(outcome).toMatchObject({ slow: 'AbortError', failed: 'AbortError' });
    expect(outcome.elapsed).toBeLessThan(1_000);
  });

  test('an XHR with a body, aborted while held back, fires what the browser fires, its upload’s events included', async ({
    context,
    extensionId,
    site,
  }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const native = await postAndAbort(shop);
    expect(native).toContain('upload abort');

    const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
    const sender = await extensionPage(context, extensionId);
    const slowPost = { ...failCart, id: 'slow', method: 'POST', kind: 'delay', delayMs: 1_500 };
    expect(await setConditions(sender, { tabId, origin: site, conditions: [slowPost] })).toEqual({ ok: true });
    await wrapperHolds(shop, ['slow']);
    expect(await postAndAbort(shop)).toEqual(native);
  });

  test('an XHR held back counts its timeout from send(), and one answered here starts as one sent does', async ({
    context,
    extensionId,
    site,
  }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
    const sender = await extensionPage(context, extensionId);
    const slowCart = { ...failCart, id: 'slow', kind: 'delay', delayMs: 1_500 };
    const slowSlow = { ...failCart, id: 'slower', pattern: '**/api/slow?_=*', kind: 'delay', delayMs: 600 };
    const failOther = { ...failCart, id: 'other', pattern: '**/api/other?_=*' };
    expect(await setConditions(sender, { tabId, origin: site, conditions: [slowCart, slowSlow, failOther] })).toEqual({
      ok: true,
    });
    await wrapperHolds(shop, ['slow', 'slower', 'other']);

    // The timeout ends it while it is held back.
    const held = await getWithTimeout(shop, '/api/cart', 500);
    expect(held).toMatchObject({ seen: ['loadstart', 'timeout', 'loadend'], state: '4 0', timeout: 500 });
    expect(held.elapsed).toBeLessThan(1_400);
    // Sent after its delay, to a server slower than what is left of its timeout: the browser's own timeout ends it.
    const sent = await getWithTimeout(shop, '/api/slow', 1_000);
    expect(sent).toMatchObject({ seen: ['loadstart', 'timeout', 'loadend'], state: '4 0', timeout: 1_000 });
    expect(sent.elapsed).toBeGreaterThanOrEqual(900);
    expect(sent.elapsed).toBeLessThan(1_500);
    // Answered here, without being sent.
    expect(await getWithTimeout(shop, '/api/other', 0)).toMatchObject({
      seen: ['loadstart', 'load', 'loadend'],
      state: '4 500',
    });
  });

  test('an XHR the page aborts while it is held back ends as the browser ends it', async ({
    context,
    extensionId,
    site,
  }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const native = await sendAndAbort(shop);
    expect(native).toEqual(['readystatechange 1', 'readystatechange 4', 'abort 4', 'loadend 4', 'aborted 0 0']);

    const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
    const sender = await extensionPage(context, extensionId);
    const slowCart = { ...failCart, id: 'slow', kind: 'delay', delayMs: 1_500 };
    expect(await setConditions(sender, { tabId, origin: site, conditions: [slowCart] })).toEqual({ ok: true });
    await wrapperHolds(shop, ['slow']);
    expect(await sendAndAbort(shop)).toEqual(native);
  });

  test('an XHR the wrapper answered starts afresh when the page opens it again', async ({
    context,
    extensionId,
    site,
  }) => {
    const shop = await context.newPage();
    await shop.goto(`${site}/shop`);
    const tabId = await tabIdOf(context, extensionId, `${site}/shop`);
    const sender = await extensionPage(context, extensionId);
    expect(await setConditions(sender, { tabId, origin: site, conditions: [failCart] })).toEqual({ ok: true });
    await wrapperHolds(shop, ['cart']);
    expect(await sendAgain(shop)).toBe('1 0 → 4 500 Internal Server Error');
    const failOther = { ...failCart, id: 'other', pattern: '**/api/other' };
    expect(await setConditions(sender, { tabId, origin: site, conditions: [failOther] })).toEqual({ ok: true });
    await wrapperHolds(shop, ['other']);
    expect(await sendAgain(shop)).toBe('1 0 → 4 200 {"total":40}');
  });

  test('a relative request is matched where it goes, against the page’s base URL', async ({
    context,
    extensionId,
    site,
  }) => {
    const orders = await context.newPage();
    await orders.goto(`${site}/app/orders`);
    const tabId = await tabIdOf(context, extensionId, `${site}/app/orders`);
    const sender = await extensionPage(context, extensionId);
    expect(await setConditions(sender, { tabId, origin: site, conditions: [failCart] })).toEqual({ ok: true });
    await wrapperHolds(orders, ['cart']);
    const statuses = await orders.evaluate(async () => {
      const viaFetch = (await fetch(`cart?_=${Date.now()}`)).status;
      const viaXhr = await new Promise<number>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `cart?_=${Date.now()}`);
        xhr.onloadend = () => resolve(xhr.status);
        xhr.send();
      });
      return [viaFetch, viaXhr];
    });
    expect(statuses).toEqual([500, 500]);
  });
});
