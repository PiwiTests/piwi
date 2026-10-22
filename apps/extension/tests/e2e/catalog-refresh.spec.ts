import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, openOptions, optionsReady } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';

/**
 * A function added in the dashboard after the options page saved still reaches
 * the extension. Here a real HTTP server stands in for a Piwi instance and
 * *changes its catalog between requests*.
 *
 * The mock sends `Access-Control-Allow-Origin` so the fetch succeeds without
 * a granted host permission (Playwright can't accept the permission prompt).
 * Against a real instance that grant is what makes this work, which is why
 * the options page requests it inside the save/test click.
 */
function entry(id: number, name: string) {
  return {
    id,
    name,
    kind: 'helper',
    module: './helpers/x',
    receiver: null,
    importName: null,
    params: [],
    urlPattern: null,
    steps: [{ action: 'click', target: { testId: `t-${id}` } }],
    paramSources: [],
  };
}

let server: Server;
let baseUrl: string;
/** Mutated mid-test to model someone adding a function in the dashboard. */
let catalog = [entry(1, 'login')];
let requestCount = 0;
/** The `X-API-Key` of each catalog request, by the server it reached. */
let keysSent: Array<{ server: string; key: string | undefined }> = [];

/** Answers a catalog request with the current catalog, as a Piwi instance does. */
function catalogServer(name: string): Server {
  return createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // The client sends `X-API-Key`, which makes this a non-simple request, so
    // the browser preflights it. A real Piwi instance doesn't answer this —
    // which is exactly why the options page has to obtain a host permission
    // (that bypasses CORS for the extension); the mock answers it so this
    // test can exercise the refresh path without a permission prompt.
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.url?.includes('/test-functions')) {
      requestCount++;
      keysSent.push({ server: name, key: req.headers['x-api-key'] as string | undefined });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ items: catalog.map((e) => ({ id: e.id, name: e.name, entry: e })) }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
}

test.beforeAll(async () => {
  server = catalogServer('instance');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  keysSent = [];
});

test.describe.serial('catalog refresh', () => {
  test('a function added after connecting reaches the extension without re-saving options', async ({
    context,
    extensionId,
  }) => {
    catalog = [entry(1, 'login')];
    requestCount = 0;

    // An extension page can message the background worker, exactly as the
    // content-script panels do via `requestCatalogRefresh`.
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await page.evaluate(
      (url) =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            {
              piwiConnection: {
                instanceUrl: url,
                apiKey: 'pd_test',
                projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo' }],
              },
              // Start from a cache that predates the change, as a real user would.
              piwiCatalogCache: {},
            },
            resolve,
          );
        }),
      baseUrl,
    );

    const refresh = (force: boolean) =>
      page.evaluate(
        (f) =>
          chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: f }) as Promise<{
            ok: boolean;
            refreshed?: boolean;
            count?: number | null;
            error?: string;
          }>,
        force,
      );
    const cachedNames = () =>
      page.evaluate(async () => {
        const stored = await chrome.storage.local.get('piwiCatalogCache');
        const store = stored.piwiCatalogCache as Record<string, { entries: Array<{ name: string }> }>;
        return (store?.['1']?.entries ?? []).map((e) => e.name);
      });

    // A never-cached project counts as stale, so even an unforced call fills it.
    expect(await refresh(false)).toMatchObject({ ok: true, refreshed: true, count: 1 });
    expect(await cachedNames()).toEqual(['login']);

    // Someone adds a function in the dashboard.
    catalog = [entry(1, 'login'), entry(2, 'addToCart')];

    // No options save, no reconnect — just the refresh the panels issue on open.
    expect(await refresh(true)).toMatchObject({ ok: true, refreshed: true, count: 2 });
    expect(await cachedNames()).toEqual(['login', 'addToCart']);
  });

  test('an unforced refresh inside the TTL is skipped instead of re-hitting the instance', async ({
    context,
    extensionId,
  }) => {
    catalog = [entry(1, 'login')];
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await page.evaluate(
      (url) =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set(
            {
              piwiConnection: {
                instanceUrl: url,
                apiKey: 'pd_test',
                projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo' }],
              },
              piwiCatalogCache: {},
            },
            resolve,
          );
        }),
      baseUrl,
    );

    const refresh = (force: boolean) =>
      page.evaluate((f) => chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: f }), force);

    await refresh(false);
    const afterFirst = requestCount;
    expect(await refresh(false)).toMatchObject({ ok: true, refreshed: false });
    expect(requestCount, 'a fresh cache must not produce a second request').toBe(afterFirst);

    // Forcing bypasses the TTL — what the panel's Refresh button does.
    expect(await refresh(true)).toMatchObject({ ok: true, refreshed: true });
    expect(requestCount).toBe(afterFirst + 1);
  });

  test('the API key stays out of what content scripts read, and goes only to its instance', async ({
    context,
    extensionId,
  }) => {
    catalog = [entry(1, 'login')];
    const other = catalogServer('elsewhere');
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const elsewhere = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    try {
      const page = await context.newPage();
      await openOptions(page, extensionId);
      // Kept beside the settings, as an earlier version kept it.
      await page.evaluate(async (url) => {
        await chrome.storage.local.set({
          piwiConnection: {
            instanceUrl: url,
            apiKey: 'pd_test',
            projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo' }],
          },
          piwiCatalogCache: {},
        });
      }, baseUrl);
      const refresh = () =>
        page.evaluate(() => chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: true }));

      expect(await refresh()).toMatchObject({ ok: true, refreshed: true, count: 1 });
      expect(keysSent).toEqual([{ server: 'instance', key: 'pd_test' }]);
      // The worker moved it out of `chrome.storage.local` into its own IndexedDB.
      expect(await localStorageText(page)).not.toContain('pd_test');
      expect(await storedSecret(page, 'instance')).toEqual({ apiKey: 'pd_test', origin: baseUrl });

      // A content script rewrites the instance address: the worker still asks, but without the key.
      await page.evaluate(async (url) => {
        const stored = (await chrome.storage.local.get('piwiConnection')).piwiConnection as object;
        await chrome.storage.local.set({ piwiConnection: { ...stored, instanceUrl: url } });
      }, elsewhere);
      expect(await refresh()).toMatchObject({ ok: true, refreshed: true });
      expect(keysSent).toEqual([
        { server: 'instance', key: 'pd_test' },
        { server: 'elsewhere', key: undefined },
      ]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  test('the popup and the settings say whether the instance answered the worker’s last request', async ({
    context,
    extensionId,
  }) => {
    catalog = [entry(1, 'login')];
    const host = new URL(baseUrl).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(async (url) => {
      await chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: url,
          apiKey: 'pd_test',
          projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Demo' }],
        },
      });
    }, baseUrl);
    await page.reload();
    const line = page.locator('#connection-health');
    // Nothing has asked the instance yet.
    await expect(line).toBeHidden();
    const refresh = () =>
      page.evaluate(() => chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: true }));

    expect(await refresh()).toMatchObject({ ok: true, refreshed: true });
    // The open popup follows the record as it changes.
    await expect(line).toHaveText(`Connected to ${host}, checked now.`);
    await expect(line).not.toHaveClass(/failing/);

    // The instance moves: nothing answers at the address kept.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await page.evaluate(async (url) => {
      const stored = (await chrome.storage.local.get('piwiConnection')).piwiConnection as object;
      await chrome.storage.local.set({ piwiConnection: { ...stored, instanceUrl: url } });
    }, gone);
    // The record is of the other address: nothing is said of this one.
    await expect(line).toBeHidden();
    expect(await refresh()).toMatchObject({ ok: false });
    await expect(line).toHaveText(
      new RegExp(`^${new URL(gone).host.replace(/\./g, '\\.')} has not answered since .+, check the settings\\.$`),
    );
    await expect(line).toHaveClass(/failing/);

    // The settings say so beside the address, and the line's link opens them.
    const [options] = await Promise.all([
      context.waitForEvent('page'),
      line.getByRole('link', { name: 'check the settings' }).click(),
    ]);
    await expect(options).toHaveURL(new RegExp(`chrome-extension://${extensionId}/options.html`));
    await optionsReady(options);
    await expect(options.locator('#instance-health')).toHaveText(/^No answer since /);
    await expect(options.locator('#instance-health')).toHaveClass(/failing/);
  });

  test('a refresh with no connection configured fails cleanly rather than throwing', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          chrome.storage.local.set({ piwiConnection: { instanceUrl: '', apiKey: '', projectMappings: [] } }, resolve);
        }),
    );
    const result = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: true }),
    );
    expect(result).toMatchObject({ ok: false });
  });
});
