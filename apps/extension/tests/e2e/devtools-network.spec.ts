import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { fireDevtoolsEvent, openDevtoolsPage } from './devtools-stub.js';

const ORIGIN = 'http://piwi-network.test';

/** The shop asks its API for the cart and shows the total, or says it could not. */
const SHOP = `<!doctype html><html><body><output id="total">…</output><script>
  fetch('/api/cart?_=' + Date.now())
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((cart) => { document.getElementById('total').textContent = 'Total: ' + cart.total; })
    .catch(() => { document.getElementById('total').textContent = 'The cart could not be loaded'; });
</script></body></html>`;

/** The server's own answer; the recorded one below differs, so a mock that works shows. */
/** Opens the panel's Network tab once the panel has its listeners, and waits for its list to be drawn. */
async function openNetworkTab(panel: Page): Promise<void> {
  await expect(panel.locator('html')).toHaveAttribute('data-ready', 'true');
  await panel.getByRole('tab', { name: 'Network' }).click();
  await expect(panel.getByRole('list', { name: 'Network' })).toBeVisible();
}

async function serveShop(page: Page): Promise<void> {
  await page.context().route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cart') return route.fulfill({ json: { items: [], total: 40 } });
    return route.fulfill({ contentType: 'text/html', body: SHOP });
  });
}

function har(url: string, type: string, status: number, mimeType: string, body: string | null) {
  return {
    request: { method: 'GET', url, headers: [{ name: 'Authorization', value: 'Bearer abc' }] },
    response: { status, content: { mimeType, size: body?.length ?? 0 }, headers: [] },
    time: 35.4,
    _resourceType: type,
    __body: body,
  };
}

const CART = JSON.stringify({ items: [{ sku: 'SPRING-TEE', qty: 1 }], total: 99, user: { authToken: 'secret-1' } });

/** Runs the code as the body of a test, with `page` as Playwright hands it. */
async function runAsTest(code: string, page: Page): Promise<void> {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (page: Page) => Promise<void>;
  await new AsyncFunction('page', code)(page);
}

test.describe('the Network tab', () => {
  test('lists the page’s API calls and writes a mock a real test runs', async ({ context, extensionId }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const shop = await context.newPage();
    await serveShop(shop);
    await shop.goto(`${ORIGIN}/cart`);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, {
      har: [har(`${ORIGIN}/cart`, 'document', 200, 'text/html', SHOP)],
    });
    await openNetworkTab(panel);
    await expect(panel.getByText('No request yet.')).toBeVisible();

    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${ORIGIN}/api/cart?_=1695820800000`, 'fetch', 200, 'application/json', CART),
    );
    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har('https://cdn.other.test/v1/flags', 'xhr', 200, 'application/json', '{}'),
    );
    const requests = panel.getByRole('list', { name: 'Network' }).getByRole('button');
    await expect(requests).toHaveCount(1);
    await expect(requests.first()).toContainText('GET/api/cart?_=1695820800000200');
    // The status sits at the right of its column, as its heading does, in the row's own weight.
    expect(
      await requests.first().evaluate((row) => {
        const [, path, status] = [...row.children] as HTMLElement[];
        const text = document.createRange();
        text.selectNodeContents(status!);
        return {
          gap: Math.round(status!.getBoundingClientRect().right - text.getBoundingClientRect().right),
          sameWeight: getComputedStyle(status!).fontWeight === getComputedStyle(path!).fontWeight,
        };
      }),
    ).toEqual({ gap: 0, sameWeight: true });
    await panel.getByRole('checkbox', { name: 'Other sites too' }).check();
    await expect(requests).toHaveCount(2);

    await requests.first().click();
    const mock = panel.getByRole('region', { name: 'Mock this response' });
    await expect(mock.getByRole('textbox', { name: 'URL pattern' })).toHaveValue('**/api/cart?_=*');
    await expect(mock.getByText('1 value hidden')).toBeVisible();
    await expect(mock.locator('pre')).toContainText('"authToken": "<hidden>"');
    await expect(mock.locator('pre')).not.toContainText('Bearer');

    await mock.getByRole('button', { name: 'Copy code' }).click();
    const code = await panel.evaluate(() => navigator.clipboard.readText());
    const test1 = await context.newPage();
    await runAsTest(code, test1);
    await test1.goto(`${ORIGIN}/cart`);
    await expect(test1.locator('#total')).toHaveText('Total: 99');

    // The same route, failing: the page shows its error state.
    await mock.getByRole('combobox', { name: 'Answer with' }).selectOption('abort');
    await expect(mock.locator('pre')).toContainText('route.abort()');
    await mock.getByRole('button', { name: 'Copy code' }).click();
    const test2 = await context.newPage();
    await runAsTest(await panel.evaluate(() => navigator.clipboard.readText()), test2);
    await test2.goto(`${ORIGIN}/cart`);
    await expect(test2.locator('#total')).toHaveText('The cart could not be loaded');

    await mock.getByRole('combobox', { name: 'Answer with' }).selectOption('response');
    await mock.getByRole('checkbox', { name: 'Show hidden values' }).check();
    await expect(mock.locator('pre')).toContainText('"authToken": "secret-1"');
  });

  test('writes a large body to a file, and says when DevTools kept none', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    await serveShop(shop);
    await shop.goto(`${ORIGIN}/cart`);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await openNetworkTab(panel);
    const rows = JSON.stringify({ rows: Array.from({ length: 6000 }, (_, i) => ({ id: i, name: `Row ${i}` })) });
    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${ORIGIN}/api/report`, 'fetch', 200, 'application/json', rows),
    );
    await fireDevtoolsEvent(panel, 'requestFinished', har(`${ORIGIN}/api/empty`, 'xhr', 204, '', null));
    const requests = panel.getByRole('list', { name: 'Network' }).getByRole('button');

    await requests.first().click();
    const mock = panel.getByRole('region', { name: 'Mock this response' });
    await expect(mock.locator('pre')).toContainText("path: 'mocks/report.json'");
    const download = panel.waitForEvent('download');
    await mock.getByRole('button', { name: 'Download report.json' }).click();
    expect((await download).suggestedFilename()).toBe('report.json');

    await requests.nth(1).click();
    await expect(mock.getByText('DevTools kept no body for this response.')).toBeVisible();
  });

  test('reads a body DevTools hands back as a promise, as Firefox does', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    await serveShop(shop);
    await shop.goto(`${ORIGIN}/cart`);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await openNetworkTab(panel);
    await fireDevtoolsEvent(panel, 'requestFinished', {
      ...har(`${ORIGIN}/api/cart`, 'xhr', 200, 'application/json', '{"total":40}'),
      __promise: true,
    });
    await panel.getByRole('list', { name: 'Network' }).getByRole('button').first().click();
    await expect(panel.getByRole('region', { name: 'Mock this response' }).locator('pre')).toContainText('"total": 40');
  });

  test('shows the request clicked last while DevTools still reads the one before', async ({ context, extensionId }) => {
    const shop = await context.newPage();
    await serveShop(shop);
    await shop.goto(`${ORIGIN}/cart`);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await openNetworkTab(panel);
    await fireDevtoolsEvent(panel, 'requestFinished', {
      ...har(`${ORIGIN}/api/slow`, 'fetch', 200, 'application/json', '{"slow":true}'),
      __delayMs: 1_000,
    });
    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${ORIGIN}/api/fast`, 'fetch', 200, 'application/json', '{}'),
    );
    const requests = panel.getByRole('list', { name: 'Network' }).getByRole('button');
    await requests.nth(0).click();
    await requests.nth(1).click();
    const title = panel.getByRole('region', { name: 'Mock this response' }).getByRole('heading');
    await expect(title).toHaveText(`GET ${ORIGIN}/api/fast`);
    // The first body arrives after the second click, and leaves the pane as it is.
    await panel.waitForTimeout(1_500);
    await expect(title).toHaveText(`GET ${ORIGIN}/api/fast`);
  });

  test('lists the requests of the site the inspected page moves to', async ({ context, extensionId }) => {
    const other = 'http://piwi-network-other.test';
    const shop = await context.newPage();
    await serveShop(shop);
    await context.route(`${other}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Orders</title>' }),
    );
    await shop.goto(`${ORIGIN}/cart`);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop);
    await openNetworkTab(panel);
    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${ORIGIN}/api/cart`, 'fetch', 200, 'application/json', CART),
    );
    const requests = panel.getByRole('list', { name: 'Network' }).getByRole('button');
    await expect(requests).toHaveText([/^GET\/api\/cart/]);

    await shop.goto(`${other}/orders`);
    await fireDevtoolsEvent(panel, 'navigated', `${other}/orders`);
    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${other}/api/orders`, 'fetch', 200, 'application/json', '[]'),
    );
    await expect(requests).toHaveText([/^GET\/api\/orders/]);
    await panel.getByRole('checkbox', { name: 'Other sites too' }).check();
    await expect(requests).toHaveText([
      /\/\/piwi-network\.test\/api\/cart/,
      /\/\/piwi-network-other\.test\/api\/orders/,
    ]);
  });

  test('a draw of the tab overtaken by a later one leaves the list to the later one', async ({
    context,
    extensionId,
  }) => {
    const other = 'http://piwi-network-other.test';
    const shop = await context.newPage();
    await serveShop(shop);
    await context.route(`${other}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Orders</title>' }),
    );
    await shop.goto(`${ORIGIN}/cart`);
    let held: Promise<void> | null = null;
    let release = () => {};
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop, {
      beforeEval: (expression) => (expression === 'location.origin' && held ? held : undefined),
    });
    await openNetworkTab(panel);
    await expect(panel.getByText('No request yet.')).toBeVisible();

    // Opened again while the page's origin is slow to come, and drawn once more as the page moves meanwhile.
    held = new Promise((resolve) => (release = resolve));
    await panel.getByRole('tab', { name: 'Record' }).click();
    await panel.getByRole('tab', { name: 'Network' }).click();
    await shop.goto(`${other}/orders`);
    await fireDevtoolsEvent(panel, 'navigated', `${other}/orders`);
    await expect(panel.getByText('No request yet.')).toBeVisible();
    release();
    held = null;
    await panel.waitForTimeout(300);

    await fireDevtoolsEvent(
      panel,
      'requestFinished',
      har(`${other}/api/orders`, 'fetch', 200, 'application/json', '[]'),
    );
    await expect(panel.getByRole('list', { name: 'Network' }).getByRole('button')).toHaveText([/^GET\/api\/orders/]);
  });
});
