import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, extensionWorker, launchWithExtension, openOptions, optionsReady } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';

/**
 * Connecting in one step, end to end against a stub instance that speaks the
 * device-authorization endpoints: Connect opens the instance's page in a tab,
 * Allow there hands the extension an API key through its next poll, the tab
 * closes, and the instance's URL patterns are read and shown.
 *
 * The stub answers CORS so the requests go through without a host permission
 * (Playwright cannot accept the permission prompt); the options page's
 * permission calls are stubbed to "granted" for the same reason.
 */
const USER_CODE = 'BCDF-GHJK';
const API_KEY = `pd_${'a'.repeat(64)}`;

let server: Server;
let baseUrl: string;
let approved = false;
let keysHandedOut = 0;
let connectBody: unknown = null;
let connectStarts = 0;
/** How long the instance takes to answer its URL patterns, and how many times it has answered them. */
let patternsDelayMs = 0;
let patternsAnswered = 0;
let patterns: Array<{
  pattern: string;
  environment: string | null;
  pathPrefix?: string | null;
  testPathPrefix?: string | null;
}> = [];
const addedPatterns: unknown[] = [];

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

const VERIFICATION_PAGE = `<!doctype html><html><body>
<h1>Connect Piwi Picker</h1><p>Code <code id="code">${USER_CODE}</code></p>
<button id="allow">Allow</button><p id="done"></p>
<script>
document.getElementById('allow').onclick = async () => {
  await fetch('/api/extension/connect/decision', { method: 'POST', body: JSON.stringify({ userCode: '${USER_CODE}', allow: true }) });
  document.getElementById('done').textContent = 'Allowed';
};
</script></body></html>`;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    void (async () => {
      const url = new URL(req.url ?? '/', baseUrl);
      if (req.method === 'POST' && url.pathname === '/api/extension/connect') {
        connectStarts++;
        connectBody = await readJson(req);
        return json(200, {
          deviceCode: `pdc_${'0'.repeat(64)}`,
          userCode: USER_CODE,
          verificationUrl: `${baseUrl}/extension/connect?code=${USER_CODE}`,
          interval: 1,
          expiresIn: 60,
        });
      }
      if (req.method === 'GET' && url.pathname === '/extension/connect') {
        res.setHeader('Content-Type', 'text/html');
        res.end(VERIFICATION_PAGE);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/extension/connect/decision') {
        approved = true;
        return json(200, { status: 'approved' });
      }
      if (req.method === 'POST' && url.pathname === '/api/extension/connect/token') {
        if (!approved) return json(200, { status: 'pending' });
        if (keysHandedOut > 0) return json(200, { status: 'expired' });
        keysHandedOut++;
        return json(200, { status: 'approved', apiKey: API_KEY, user: { name: 'Ada Lovelace' } });
      }
      // Everything below needs the key the flow handed out.
      if (req.headers['x-api-key'] !== API_KEY) return json(401, { message: 'Invalid or expired API key' });
      if (url.pathname === '/api/extension/url-patterns') {
        if (patternsDelayMs) await new Promise((resolve) => setTimeout(resolve, patternsDelayMs));
        patternsAnswered++;
        return json(200, {
          user: { name: 'Ada Lovelace' },
          items: patterns.map((p) => ({
            projectId: 1,
            projectName: 'shop',
            projectLabel: 'Shop',
            pattern: p.pattern,
            environment: p.environment,
            branch: null,
            pathPrefix: p.pathPrefix ?? null,
            testPathPrefix: p.testPathPrefix ?? null,
          })),
          projects: [{ id: 1, label: 'Shop', canEdit: true }],
        });
      }
      if (url.pathname === '/api/projects/menu') return json(200, { items: [{ id: 1, name: 'shop', label: 'Shop' }] });
      if (url.pathname === '/api/projects/1/test-functions') return json(200, { items: [] });
      if (req.method === 'POST' && url.pathname === '/api/projects/1/url-patterns') {
        const body = (await readJson(req)) as {
          pattern: string;
          environment?: string | null;
          pathPrefix?: string | null;
          testPathPrefix?: string | null;
        };
        addedPatterns.push(body);
        patterns.push({
          pattern: body.pattern,
          environment: body.environment ?? null,
          pathPrefix: body.pathPrefix,
          testPathPrefix: body.testPathPrefix,
        });
        return json(201, { items: [] });
      }
      return json(404, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Answers the options page's host-permission checks as granted: the prompt
 * cannot be clicked from a test. Each click is recorded with whether the
 * permission was requested while it was still being handled, which is the
 * only time Firefox shows the prompt.
 */
async function grantPermissions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const clicks: Array<{ id: string; requested: boolean }> = [];
    (window as unknown as { __clicks: typeof clicks }).__clicks = clicks;
    let requested = false;
    window.addEventListener('click', () => (requested = false), true);
    window.addEventListener('click', (event) => clicks.push({ id: (event.target as HTMLElement).id, requested }));
    chrome.permissions.contains = (async () => true) as typeof chrome.permissions.contains;
    chrome.permissions.request = (async () => {
      requested = true;
      return true;
    }) as typeof chrome.permissions.request;
  });
}

/** The clicks on the settings page so far, each with whether it requested the permission inside its own handling. */
function clicks(page: Page): Promise<Array<{ id: string; requested: boolean }>> {
  return page.evaluate(() => (window as unknown as { __clicks: Array<{ id: string; requested: boolean }> }).__clicks);
}

async function storedConnection(page: Page) {
  return page.evaluate(async () => (await chrome.storage.local.get('piwiConnection')).piwiConnection);
}

/** A connection kept as an earlier version kept it, the API key beside the settings. */
function seedConnection(page: Page, connection: Record<string, unknown>): Promise<void> {
  return page.evaluate(async (piwiConnection) => {
    await chrome.storage.local.set({ piwiConnection });
  }, connection);
}

function refreshCatalog(page: Page): Promise<{ ok: boolean; refreshed?: boolean; error?: string }> {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: 'piwi-refresh-catalog', projectId: 1, force: true }));
}

test.describe.serial('connect in one step', () => {
  test('Connect, Allow on the instance, and the extension holds a key and the instance’s patterns', async ({
    context,
    extensionId,
  }) => {
    approved = false;
    keysHandedOut = 0;
    patterns = [{ pattern: `${baseUrl}/shop/**`, environment: 'staging' }];

    const options = await context.newPage();
    await openOptions(options, extensionId);
    await grantPermissions(options);
    await options.getByLabel('Address of your Piwi instance').fill(baseUrl);

    const verificationTab = context.waitForEvent('page');
    await options.getByRole('button', { name: 'Connect', exact: true }).click();
    const verification = await verificationTab;
    await verification.waitForLoadState();
    expect(await clicks(options)).toEqual([{ id: 'connect', requested: true }]);

    // Both sides show the same code.
    await expect(options.locator('#connect-panel code')).toHaveText(USER_CODE);
    await expect(verification.locator('#code')).toHaveText(USER_CODE);
    expect(connectBody).toMatchObject({ browser: 'Chrome' });

    const closed = verification.waitForEvent('close');
    await verification.getByRole('button', { name: 'Allow' }).click();
    await closed;

    await expect(options.locator('#connected-as')).toHaveText('Connected as Ada Lovelace.');
    await expect(options.locator('#status')).toContainText('1 URL pattern from your instance.');
    // Beside the address: the instance answered the read of its patterns.
    await expect(options.locator('#instance-health')).toHaveText('Answered now');
    const serverRow = options.locator('#server-mappings .server-row');
    await expect(serverRow).toHaveCount(1);
    await expect(serverRow).toContainText(`${baseUrl}/shop/**`);
    await expect(serverRow).toContainText('Shop · staging');
    await expect(serverRow.locator('.source')).toHaveText('Piwi');

    const stored = await storedConnection(options);
    expect(stored).toMatchObject({
      instanceUrl: baseUrl,
      connectedAs: 'Ada Lovelace',
      serverMappings: [
        { urlPattern: `${baseUrl}/shop/**`, projectId: 1, projectLabel: 'Shop', environment: 'staging' },
      ],
      serverProjects: [{ id: 1, label: 'Shop', canEdit: true }],
    });
    // The key was handed out once; the fallback field shows it, folded away.
    expect(keysHandedOut).toBe(1);
    await expect(options.locator('#api-key-fallback')).not.toHaveAttribute('open', '');
    await expect(options.locator('#api-key')).toHaveValue(API_KEY);

    // The key is in the extension's own IndexedDB, bound to the instance, and in nothing a content script reads.
    expect(stored).not.toHaveProperty('apiKey');
    expect(await localStorageText(options)).not.toContain(API_KEY);
    expect(await storedSecret(options, 'instance')).toEqual({ apiKey: API_KEY, origin: baseUrl });
    // The background worker still sends it: the instance answers the catalog only with the key.
    expect(await refreshCatalog(options)).toMatchObject({ ok: true, refreshed: true });

    // Opening the settings again reads the patterns again.
    patterns.push({ pattern: `${baseUrl}/admin/**`, environment: null });
    await options.reload();
    await optionsReady(options);
    await expect(options.locator('#server-mappings .server-row')).toHaveCount(2);
    await expect(options.locator('#connected-as')).toHaveText('Connected as Ada Lovelace.');
  });

  test('a site the popup offers is added to the instance from the settings', async ({ context, extensionId }) => {
    const options = await context.newPage();
    // A connected browser whose instance has no pattern yet.
    await openOptions(options, extensionId);
    await options.evaluate(
      async ({ baseUrl, apiKey }) => {
        await chrome.storage.local.set({
          piwiConnection: {
            instanceUrl: baseUrl,
            apiKey,
            projectMappings: [],
            serverMappings: [],
            serverProjects: [],
            serverSyncedAt: 0,
            connectedAs: '',
          },
        });
      },
      { baseUrl, apiKey: API_KEY },
    );
    patterns = [];
    const site = 'https://staging.shop.example';
    // What the popup's "Add this site" opens: a new settings tab with the pattern in its address.
    await options.close();
    const settings = await context.newPage();
    await openOptions(settings, extensionId, `#add=${encodeURIComponent(`${site}/**`)}`);
    await grantPermissions(settings);

    await expect(settings.locator('#add-site')).toBeVisible();
    await expect(settings.locator('#add-pattern')).toHaveValue(`${site}/**`);
    await expect(settings.locator('#add-project')).toHaveValue('1');
    await settings.locator('#add-environment').fill('staging');
    // A path prefix with a query is refused before anything is sent.
    await settings.locator('#add-prefix').fill('/app?lang=fr');
    await expect(settings.locator('#add-prefix')).toHaveAttribute('aria-invalid', '');
    await settings.getByRole('button', { name: 'Add to Piwi' }).click();
    await expect(settings.locator('#mappings-status')).toContainText('/app?lang=fr is not a path prefix');
    await settings.locator('#add-prefix').fill('app/');
    await expect(settings.locator('#add-prefix')).not.toHaveAttribute('aria-invalid');
    await settings.locator('#add-test-prefix').fill('/v2');
    const addedBefore = addedPatterns.length;
    // A double click sends the pattern once.
    await settings.getByRole('button', { name: 'Add to Piwi' }).dblclick();

    await expect(settings.locator('#mappings-status')).toHaveText(`Added ${site}/** to Shop.`);
    expect(addedPatterns).toHaveLength(addedBefore + 1);
    expect(await clicks(settings)).toContainEqual({ id: 'add-to-server', requested: false });
    expect(addedPatterns[addedPatterns.length - 1]).toEqual({
      pattern: `${site}/**`,
      environment: 'staging',
      branch: null,
      pathPrefix: '/app',
      testPathPrefix: '/v2',
    });
    const serverRow = settings.locator('#server-mappings .server-row');
    await expect(serverRow).toContainText(`${site}/**`);
    await expect(serverRow).toContainText('Shop · staging · path prefix /app · tests’ path prefix /v2');
    expect(await storedConnection(settings)).toMatchObject({
      serverMappings: [
        expect.objectContaining({ urlPattern: `${site}/**`, pathPrefix: '/app', testPathPrefix: '/v2' }),
      ],
    });

    // Kept in this browser only: the line holds the prefix, which Save stores.
    await settings.locator('#add-pattern').fill('https://preview.shop.example/**');
    await settings.locator('#add-prefix').fill('/shop/eu/');
    await settings.getByRole('button', { name: 'Keep in this browser only' }).click();
    const line = settings.locator('#mappings .mapping-row').last();
    await expect(line.getByLabel('Path prefix', { exact: true })).toHaveValue('/shop/eu');
    await line.getByLabel('Path prefix', { exact: true }).fill('/shop/eu/fr');
    // The tests ran under /shop: a refused value stops Save, a plain path is kept.
    await line.getByLabel('Tests’ path prefix').fill('/shop/*');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.locator('#mappings-status')).toContainText('/shop/* is not a path prefix');
    await line.getByLabel('Tests’ path prefix').fill('shop');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.locator('#mappings-status')).toContainText('Saved');
    expect((await clicks(settings)).filter((click) => click.id === 'save')).toEqual([
      { id: 'save', requested: true },
      { id: 'save', requested: true },
    ]);
    expect(await storedConnection(settings)).toMatchObject({
      projectMappings: [
        expect.objectContaining({
          urlPattern: 'https://preview.shop.example/**',
          pathPrefix: '/shop/eu/fr',
          testPathPrefix: '/shop',
        }),
      ],
    });
  });

  test('the popup offers to add a site no pattern covers', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(async (baseUrl) => {
      await chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: baseUrl,
          apiKey: '',
          projectMappings: [],
          serverMappings: [{ urlPattern: 'https://shop.example/**', projectId: 1, projectLabel: 'Shop' }],
          serverProjects: [{ id: 1, label: 'Shop', canEdit: true }],
          serverSyncedAt: 1,
          connectedAs: '',
        },
      });
    }, baseUrl);
    // Opened as a tab, the popup is its own active tab: point it at a site instead.
    await popup.addInitScript(() => {
      chrome.tabs.query = (async () => [
        { id: 4242, url: 'https://staging.shop.example/cart', active: true },
      ]) as unknown as typeof chrome.tabs.query;
    });
    await popup.reload();

    const offer = popup.locator('#add-site-row');
    await expect(offer).toBeVisible();
    await expect(offer).toContainText('No project matches this site.');
    const opened = context.waitForEvent('page');
    await offer.getByRole('button', { name: 'Add this site' }).click();
    const settings = await opened;
    expect(settings.url()).toBe(
      `chrome-extension://${extensionId}/options.html#add=${encodeURIComponent('https://staging.shop.example/**')}`,
    );
  });

  test('the popup makes no offer on a site a server pattern covers', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(async (baseUrl) => {
      await chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: baseUrl,
          apiKey: '',
          projectMappings: [],
          serverMappings: [{ urlPattern: 'https://shop.example/**', projectId: 1, projectLabel: 'Shop' }],
          serverProjects: [],
          serverSyncedAt: 1,
          connectedAs: '',
        },
      });
    }, baseUrl);
    await popup.addInitScript(() => {
      chrome.tabs.query = (async () => [
        { id: 4242, url: 'https://shop.example/cart', active: true },
      ]) as unknown as typeof chrome.tabs.query;
    });
    await popup.reload();
    await expect(popup.locator('#active-project')).toBeVisible();
    await expect(popup.locator('#active-project option').nth(1)).toHaveText('Shop');
    await expect(popup.locator('#add-site-row')).toBeHidden();
  });
  test('a double click on Connect starts one connect, and Cancel ends it and closes the instance’s page', async ({
    context,
    extensionId,
  }) => {
    approved = false;
    connectStarts = 0;
    const options = await context.newPage();
    await openOptions(options, extensionId);
    await grantPermissions(options);
    await options.getByLabel('Address of your Piwi instance').fill(baseUrl);

    const verificationTab = context.waitForEvent('page');
    await options.getByRole('button', { name: 'Connect', exact: true }).dblclick();
    const verification = await verificationTab;
    await expect(options.locator('#connect-panel code')).toHaveText(USER_CODE);
    // Long enough for a second connect to have asked the instance too.
    await options.waitForTimeout(500);
    expect(connectStarts).toBe(1);
    expect(context.pages().filter((page) => page.url().includes('/extension/connect'))).toHaveLength(1);

    const closed = verification.waitForEvent('close');
    await options.locator('#connect-cancel').click();
    await closed;
    await expect(options.locator('#status')).toHaveText('Connecting was cancelled.');
    await expect(options.locator('#connect-panel')).toBeHidden();
    await expect(options.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  });

  test('Save and test and Refresh ask for the instance’s origin inside their click, and keep the key out of reach', async ({
    context,
    extensionId,
  }) => {
    patterns = [{ pattern: `${baseUrl}/shop/**`, environment: null }];
    const options = await context.newPage();
    await openOptions(options, extensionId);
    await grantPermissions(options);
    await options.getByLabel('Address of your Piwi instance').fill(baseUrl);
    await options.locator('#api-key-fallback summary').click();
    await options.locator('#api-key').fill(API_KEY);
    await options.getByRole('button', { name: 'Save and test' }).click();
    await expect(options.locator('#status')).toContainText('Connected: 1 project found.');
    await options.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(options.locator('#mappings-status')).toHaveText('1 URL pattern from your instance.');
    expect((await clicks(options)).filter((click) => click.id !== '')).toEqual([
      { id: 'api-key-save', requested: true },
      { id: 'refresh-server', requested: true },
    ]);
    expect(await localStorageText(options)).not.toContain(API_KEY);
    expect(await storedSecret(options, 'instance')).toEqual({ apiKey: API_KEY, origin: baseUrl });
  });

  test('Disconnect while the instance is still answering stays disconnected', async ({ context, extensionId }) => {
    patterns = [{ pattern: `${baseUrl}/shop/**`, environment: null }];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await seedConnection(page, {
      instanceUrl: baseUrl,
      apiKey: API_KEY,
      projectMappings: [],
      serverMappings: [{ urlPattern: `${baseUrl}/shop/**`, projectId: 1, projectLabel: 'Shop' }],
      serverProjects: [{ id: 1, label: 'Shop', canEdit: true }],
      serverSyncedAt: 1,
      connectedAs: 'Ada Lovelace',
    });
    const answered = patternsAnswered;
    patternsDelayMs = 1500;
    try {
      const options = await context.newPage();
      await openOptions(options, extensionId);
      // The page reads the instance's patterns as it opens; Disconnect comes before the answer.
      await options.getByRole('button', { name: 'Disconnect' }).click();
      await expect(options.locator('#status')).toHaveText('Disconnected.');
      await expect.poll(() => patternsAnswered, { timeout: 5_000 }).toBe(answered + 1);
      // Time for the page to handle the late answer.
      await options.waitForTimeout(500);
      expect(await storedConnection(options)).toBeUndefined();
      expect(await storedSecret(options, 'instance')).toBeNull();
      await expect(options.locator('#instance-pill')).toHaveText('Not connected');
      await expect(options.locator('#instance-health')).toBeHidden();
      await options.reload();
      await optionsReady(options);
      await expect(options.locator('#instance-pill')).toHaveText('Not connected');
    } finally {
      patternsDelayMs = 0;
    }
  });

  test('the Active project chosen on one site applies there only, and Disconnect forgets it with the branch chosen', async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.evaluate(async (baseUrl) => {
      await chrome.storage.local.set({
        piwiConnection: {
          instanceUrl: baseUrl,
          projectMappings: [],
          serverMappings: [
            { urlPattern: 'https://shop.example/**', projectId: 1, projectLabel: 'Shop' },
            { urlPattern: 'https://other.example/**', projectId: 2, projectLabel: 'Other' },
          ],
          serverProjects: [],
          serverSyncedAt: 1,
          connectedAs: '',
        },
        piwiLocatorIndexCache: { '2': { fetchedAt: Date.now(), index: { projectId: 2, locators: [], tests: [] } } },
      });
    }, baseUrl);
    // Opened as a tab, the popup is its own active tab: point it at the site the spec names.
    await popup.addInitScript(() => {
      chrome.tabs.query = (async () => [
        { id: 4242, url: sessionStorage.getItem('piwi-spec-tab') ?? 'https://shop.example/cart', active: true },
      ]) as unknown as typeof chrome.tabs.query;
    });
    await popup.reload();
    const select = popup.locator('#active-project');
    await expect(select).toHaveValue('');
    await select.selectOption({ label: 'Other' });
    await expect
      .poll(() =>
        popup.evaluate(
          async () => (await chrome.storage.session.get('piwiActiveProjectOverride')).piwiActiveProjectOverride,
        ),
      )
      .toBeTruthy();
    await popup.reload();
    await expect(select).toHaveValue('2');

    // Another site goes by its own patterns.
    await popup.evaluate(() => sessionStorage.setItem('piwi-spec-tab', 'https://other.example/account'));
    await popup.reload();
    await expect(select).toHaveValue('');

    // The branch Tested elements reads for a project, chosen in its panel.
    await popup.evaluate(() => chrome.storage.session.set({ piwiLocatorBranchOverride: { '2': 'feature/x' } }));

    const options = await context.newPage();
    await openOptions(options, extensionId);
    await options.getByRole('button', { name: 'Disconnect' }).click();
    await expect(options.locator('#status')).toHaveText('Disconnected.');
    expect(
      await options.evaluate(async () => ({
        override: (await chrome.storage.session.get('piwiActiveProjectOverride')).piwiActiveProjectOverride,
        branch: (await chrome.storage.session.get('piwiLocatorBranchOverride')).piwiLocatorBranchOverride,
        index: (await chrome.storage.local.get('piwiLocatorIndexCache')).piwiLocatorIndexCache,
      })),
    ).toEqual({});
  });
});

/**
 * An install that kept its secrets beside its settings in `chrome.storage.local`
 * (the API key, the desktop app's and the editor's tokens): the worker moves
 * them to its own IndexedDB as it starts, and connected mode goes on with them.
 */
test('the worker moves secrets kept in chrome.storage.local to its own IndexedDB as it starts', async () => {
  const context: BrowserContext = await launchWithExtension(undefined, { developerMode: true });
  try {
    const extensionId = (await extensionWorker(context)).url().split('/')[2]!;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.evaluate(
      async ({ baseUrl, apiKey }) => {
        await chrome.storage.local.set({
          piwiConnection: {
            instanceUrl: baseUrl,
            apiKey,
            projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Shop' }],
          },
          piwiDesktop: { url: 'http://127.0.0.1:4318', token: 'pd_desktop_token' },
          piwiEditorPairing: { url: 'http://127.0.0.1:47211/piwi/send', token: 'editor_token_0123456789' },
        });
      },
      { baseUrl, apiKey: API_KEY },
    );
    expect(await localStorageText(page)).toContain(API_KEY);

    // Reloading the extension starts a new worker.
    const restarted = context.waitForEvent('serviceworker');
    await page.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await restarted;
    const after = await context.newPage();
    await after.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect
      .poll(async () => {
        const text = await localStorageText(after);
        return [API_KEY, 'pd_desktop_token', 'editor_token_0123456789'].filter((secret) => text.includes(secret));
      })
      .toEqual([]);
    expect(await storedSecret(after, 'instance')).toEqual({ apiKey: API_KEY, origin: baseUrl });
    expect(await storedSecret(after, 'desktop')).toEqual({ url: 'http://127.0.0.1:4318', token: 'pd_desktop_token' });
    expect(await storedSecret(after, 'editor')).toEqual({
      url: 'http://127.0.0.1:47211/piwi/send',
      token: 'editor_token_0123456789',
    });
    // What content scripts read is otherwise unchanged: still connected, still paired with the editor.
    expect(await storedConnection(after)).toEqual({
      instanceUrl: baseUrl,
      projectMappings: [{ urlPattern: '**', projectId: 1, projectLabel: 'Shop' }],
    });
    expect(
      await after.evaluate(async () => (await chrome.storage.local.get('piwiEditorPairing')).piwiEditorPairing),
    ).toEqual({ url: 'http://127.0.0.1:47211/piwi/send' });
    // And the worker sends the key it moved: the instance answers the catalog only with it.
    expect(await refreshCatalog(after)).toMatchObject({ ok: true, refreshed: true });
  } finally {
    await context.close();
  }
});

test('Send to editor answers, rather than leaving the panel waiting, when the pairing kept is not one', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  // Kept as an earlier version kept it: the worker moves it to its own IndexedDB as it reads it.
  await page.evaluate(() =>
    chrome.storage.local.set({ piwiEditorPairing: { url: 'not an address', token: 'editor_token_0123456789' } }),
  );
  const answer = await page.evaluate(() =>
    Promise.race([
      chrome.runtime.sendMessage({
        type: 'piwi-send-to-editor',
        payload: { kind: 'locator', text: "getByRole('link')" },
      }),
      new Promise((resolve) => setTimeout(() => resolve('no answer'), 5_000)),
    ]),
  );
  expect(answer).toEqual({ ok: false, error: expect.stringContaining('This is not a pairing address') });
});
