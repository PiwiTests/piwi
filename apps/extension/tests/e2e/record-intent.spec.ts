import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test as base, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { extensionWorker, launchWithEditedManifest } from './fixtures.js';
import { fireDevtoolsEvent, openDevtoolsPage, openNetworkTab, selectElement } from './devtools-stub.js';

/**
 * The intent "Record actions" parks while the browser asks for the site
 * (`RecordIntent`), against the real worker. A spec cannot click the browser's
 * prompt, so the site is granted from `chrome://extensions`, as its Site access
 * setting grants it: the manifest asks for the local sites, withheld until
 * each is allowed, and each grant fires `chrome.permissions.onAdded` as the
 * prompt's Allow does.
 */

/** `chrome.developerPrivate`, which only `chrome://extensions` has. */
interface DeveloperChrome {
  developerPrivate: {
    updateExtensionConfiguration(update: { extensionId: string; hostAccess: string }): Promise<void>;
    addHostPermission(extensionId: string, host: string): Promise<void>;
  };
}

interface Fixtures {
  site: string;
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  /** A page of the site, and its tab. */
  shop: { page: Page; tabId: number };
  /** `chrome://extensions`, with the site's access withheld. */
  extensions: Page;
}

const test = base.extend<Fixtures>({
  site: async ({}, use) => {
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Shop</title><button>Buy</button>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    server.close();
  },
  context: async ({}, use) => {
    const context = await launchWithEditedManifest(
      (manifest) => ({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }),
      { developerMode: true },
    );
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(await extensionWorker(context));
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
  shop: async ({ context, worker, site }, use) => {
    const page = await context.newPage();
    await page.goto(`${site}/shop`);
    // Read while the site is still granted: a withheld one hides the tab's address.
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]!.id!, `${site}/shop`);
    await use({ page, tabId });
  },
  // Set up after `shop`, whose tab is found while the site is granted.
  extensions: async ({ context, extensionId, shop: _shop }, use) => {
    const page = await context.newPage();
    await page.goto('chrome://extensions');
    await page.evaluate(
      (id) =>
        (chrome as unknown as DeveloperChrome).developerPrivate.updateExtensionConfiguration({
          extensionId: id,
          hostAccess: 'ON_CLICK',
        }),
      extensionId,
    );
    await use(page);
  },
});

/** What the popup's Record actions click parks before its prompt shows. */
async function parkIntent(worker: Worker, originPattern: string, tabId: number): Promise<void> {
  await worker.evaluate(
    ([pattern, id]) =>
      chrome.storage.session.set({
        piwiRecordIntent: { originPattern: pattern, tabId: id, mode: 'actions', createdAt: Date.now() },
      }),
    [originPattern, tabId] as const,
  );
}

async function parkedIntent(worker: Worker): Promise<unknown> {
  return worker.evaluate(async () => (await chrome.storage.session.get('piwiRecordIntent')).piwiRecordIntent ?? null);
}

async function recording(worker: Worker): Promise<boolean> {
  return worker.evaluate(async () => {
    const { piwiRecording } = (await chrome.storage.session.get('piwiRecording')) as {
      piwiRecording?: { active?: boolean };
    };
    return piwiRecording?.active === true;
  });
}

/** Allows the site as its prompt's Allow would, and waits until the extension holds it. */
async function grantSite(extensions: Page, worker: Worker, extensionId: string, pattern: string): Promise<void> {
  await extensions.evaluate(
    ([id, host]) => (chrome as unknown as DeveloperChrome).developerPrivate.addHostPermission(id, host),
    [extensionId, pattern] as const,
  );
  await expect.poll(() => worker.evaluate((p) => chrome.permissions.contains({ origins: [p] }), pattern)).toBe(true);
}

/** Long enough for the worker's `onAdded` to have run: a recording it started would be on by then. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

test.describe('a parked Record actions intent', () => {
  test('is picked up by the grant that answers its prompt, and the recording starts', async ({
    worker,
    extensionId,
    site,
    shop,
    extensions,
  }) => {
    await parkIntent(worker, `${site}/*`, shop.tabId);
    await grantSite(extensions, worker, extensionId, `${site}/*`);
    await expect.poll(() => recording(worker)).toBe(true);
    await expect.poll(() => parkedIntent(worker)).toBeNull();
  });

  test('goes when the popup opens again, and a later grant for the site starts nothing', async ({
    context,
    worker,
    extensionId,
    site,
    shop,
    extensions,
  }) => {
    await parkIntent(worker, `${site}/*`, shop.tabId);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect.poll(() => parkedIntent(worker)).toBeNull();
    // The popup's Replay a bug report asks for the same site.
    await grantSite(extensions, worker, extensionId, `${site}/*`);
    await settle(popup);
    expect(await recording(worker)).toBe(false);
  });

  test('goes when DevTools asks for the site, and its grant starts nothing', async ({
    context,
    worker,
    extensionId,
    site,
    shop,
    extensions,
  }) => {
    await parkIntent(worker, `${site}/*`, shop.tabId);
    const sidebar = await openDevtoolsPage(context, extensionId, 'devtools-sidebar.html', shop.page, {
      contentScript: false,
    });
    await selectElement(sidebar, shop.page, 'button');
    await sidebar.getByRole('button', { name: 'Allow on this site' }).click();
    await expect.poll(() => parkedIntent(worker)).toBeNull();
    await grantSite(extensions, worker, extensionId, `${site}/*`);
    await settle(sidebar);
    expect(await recording(worker)).toBe(false);
  });

  test('goes when the Network tab asks for the site to slow a request down', async ({
    context,
    worker,
    extensionId,
    site,
    shop,
    extensions: _extensions,
  }) => {
    await parkIntent(worker, `${site}/*`, shop.tabId);
    const panel = await openDevtoolsPage(context, extensionId, 'devtools-panel.html', shop.page, {
      tabId: shop.tabId,
    });
    await openNetworkTab(panel);
    await fireDevtoolsEvent(panel, 'requestFinished', {
      request: { method: 'GET', url: `${site}/api/cart` },
      response: { status: 200, content: { mimeType: 'application/json' } },
      time: 3,
      _resourceType: 'fetch',
      __body: '{"total":40}',
    });
    await panel.getByRole('list', { name: 'Network' }).getByRole('button').first().click();
    await panel.getByRole('button', { name: 'Slow down' }).click();
    await expect.poll(() => parkedIntent(worker)).toBeNull();
  });
});
