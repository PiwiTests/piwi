import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER, desktopTokenProof } from '@piwitests/core/desktop-proof';
import { test, expect, openOptions, optionsReady } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';

/**
 * Pairing with the desktop app from the settings: Pair asks the app, whose
 * window shows the same code and an Allow button; the next poll after Allow
 * carries the app's token, which the settings keep once it works. A local
 * server stands in for the desktop app, its window answering through `answer`.
 */
const TOKEN = 'pd_desktop';
const CODE = 'BCDF-GHJK';
const PAIRING = '0123456789abcdef';
const SECRET = 'the-secret';

let server: Server;
let desktop: string;
/** What the window answers: `null` while it waits. */
let answer: 'allow' | 'deny' | null = null;
let starts: Array<{ origin: string | undefined; contentType: string; body: string }> = [];
let tokenHandedOut = 0;
/** The key the app's own instance takes as an API key: its token, unless a test makes it refuse it. */
let instanceKey = TOKEN;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', DESKTOP_PROOF_HEADER);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') return res.end();
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/api/health') {
        const challenge = String(req.headers[DESKTOP_CHALLENGE_HEADER] ?? '');
        const port = (server.address() as AddressInfo).port;
        res.setHeader(DESKTOP_PROOF_HEADER, await desktopTokenProof(TOKEN, port, challenge));
        return json(200, { status: 'ok' });
      }
      if (req.method === 'POST' && req.url === '/api/desktop/picker-pairings') {
        starts.push({
          origin: req.headers.origin,
          contentType: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        return json(201, { id: PAIRING, secret: SECRET, code: CODE, interval: 1, expiresIn: 60, windowOpen: true });
      }
      if (req.method === 'GET' && req.url === `/api/desktop/picker-pairings/${PAIRING}`) {
        if (req.headers['x-pairing-secret'] !== SECRET) return json(404, {});
        if (answer === 'deny') return json(200, { status: 'denied' });
        if (answer === 'allow') {
          tokenHandedOut++;
          return json(200, tokenHandedOut === 1 ? { status: 'allowed', token: TOKEN } : { status: 'claimed' });
        }
        return json(200, { status: 'waiting' });
      }
      if (req.method === 'GET' && req.url === '/api/desktop/reporter-config') {
        return req.headers['x-piwi-token'] === TOKEN ? json(200, { url: desktop, token: TOKEN }) : json(401, {});
      }
      // The app's server is a Piwi instance too, answering requests that carry its token as an API key.
      if (req.method === 'GET' && (req.url === '/api/projects/menu' || req.url === '/api/extension/url-patterns')) {
        if (req.headers['x-api-key'] !== instanceKey) return json(401, { message: 'Desktop access token required' });
        return req.url === '/api/projects/menu'
          ? json(200, { items: [{ id: 1, name: 'shop', label: 'Shop' }] })
          : json(200, { user: null, items: [], projects: [{ id: 1, label: 'Shop', canEdit: true }] });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  desktop = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  answer = null;
  instanceKey = TOKEN;
  starts = [];
  tokenHandedOut = 0;
});

/** Answers the settings page's host-permission requests as granted: the prompt cannot be clicked from a test. */
async function openSettings(page: Page, extensionId: string): Promise<void> {
  await openOptions(page, extensionId);
  await page.evaluate(() => {
    chrome.permissions.request = (async () => true) as typeof chrome.permissions.request;
    chrome.permissions.remove = (async () => true) as typeof chrome.permissions.remove;
  });
}

/** The pairing kept: in the extension's IndexedDB, never where a content script reads. */
async function storedDesktop(page: Page): Promise<unknown> {
  expect(await localStorageText(page)).not.toContain(TOKEN);
  return storedSecret(page, 'desktop');
}

test.describe('Pair with the desktop app', () => {
  test('Pair shows the code the app’s window shows, and Allow there pairs it', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#desktop-card');
    await expect(card.locator('#desktop-pill')).toHaveText('Not paired');
    await expect(page.getByLabel('Address of the desktop app')).toHaveValue('http://127.0.0.1:3000');

    await page.getByLabel('Address of the desktop app').fill(`${desktop}/setup`);
    await card.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(card.locator('#desktop-pair-panel code')).toHaveText(CODE);
    // Asked as an extension, with JSON naming the browser.
    expect(starts).toHaveLength(1);
    expect(starts[0]!.origin).toBe(`chrome-extension://${extensionId}`);
    expect(starts[0]!.contentType).toBe('application/json');
    expect(JSON.parse(starts[0]!.body)).toMatchObject({ browser: 'Chrome' });
    expect(await storedDesktop(page)).toBeNull();

    answer = 'allow';
    await expect(card.locator('#desktop-status')).toHaveText(`Paired with the desktop app at ${desktop}.`);
    await expect(card.locator('#desktop-pair-panel')).toBeHidden();
    await expect(card.locator('#desktop-pill')).toHaveText('Paired');
    expect(await storedDesktop(page)).toEqual({ url: desktop, token: TOKEN });
    expect(tokenHandedOut).toBe(1);

    // Opening the settings again says so; Unpair forgets it.
    await page.reload();
    await optionsReady(page);
    await expect(card.locator('#desktop-status')).toHaveText(`Paired with the desktop app at ${desktop}.`);
    await page.evaluate(() => {
      chrome.permissions.remove = (async () => true) as typeof chrome.permissions.remove;
    });
    await card.getByRole('button', { name: 'Unpair' }).click();
    await expect(card.locator('#desktop-status')).toHaveText('The desktop app is no longer paired.');
    await expect(card.locator('#desktop-pill')).toHaveText('Not paired');
    await expect(card.getByRole('button', { name: 'Unpair' })).toBeHidden();
    expect(await storedDesktop(page)).toBeNull();
  });

  test('a double click on Pair asks the app once', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await page.getByLabel('Address of the desktop app').fill(desktop);
    const pair = page.locator('#desktop-card').getByRole('button', { name: 'Pair', exact: true });
    await pair.dblclick();
    await expect(page.locator('#desktop-pair-panel code')).toHaveText(CODE);
    // Long enough for a second pairing to have asked the app too.
    await page.waitForTimeout(500);
    expect(starts).toHaveLength(1);
    await expect(pair).toBeDisabled();
    answer = 'allow';
    await expect(page.locator('#desktop-status')).toHaveText(`Paired with the desktop app at ${desktop}.`);
    await expect(pair).toBeEnabled();
    expect(tokenHandedOut).toBe(1);
  });

  test('Deny in the app’s window pairs nothing, and says so', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await page.getByLabel('Address of the desktop app').fill(desktop);
    await page.locator('#desktop-card').getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.locator('#desktop-pair-panel code')).toHaveText(CODE);
    answer = 'deny';
    await expect(page.locator('#desktop-status')).toHaveText('Pairing was denied in the desktop app.');
    expect(await storedDesktop(page)).toBeNull();
  });

  test('an address where nothing answers, or not the desktop app, is said plainly', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const pair = page.locator('#desktop-card').getByRole('button', { name: 'Pair', exact: true });

    await page.getByLabel('Address of the desktop app').fill('https://desktop.example');
    await pair.click();
    await expect(page.locator('#desktop-status')).toHaveText(
      'Enter the desktop app’s own address, such as http://127.0.0.1:3000.',
    );

    // A closed port.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await page.getByLabel('Address of the desktop app').fill(gone);
    await pair.click();
    await expect(page.locator('#desktop-status')).toHaveText(
      `Nothing answers at ${gone}. Is the desktop app running? Its Setup page shows its address.`,
    );
  });

  test('Pair by hand keeps the address and the token once the app accepts them', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await page.getByLabel('Address of the desktop app').fill(desktop);
    await page.getByText('Pair by hand').click();
    await page.getByRole('button', { name: 'Save and test' }).last().click();
    await expect(page.locator('#desktop-status')).toHaveText('Paste the token from the app’s Setup page first.');

    await page.getByLabel('Token').fill('pd_wrong');
    await page.locator('#desktop-save').click();
    await expect(page.locator('#desktop-status')).not.toHaveText(/Paired/);
    expect(await storedDesktop(page)).toBeNull();

    await page.getByLabel('Token').fill(TOKEN);
    await page.locator('#desktop-save').click();
    await expect(page.locator('#desktop-status')).toHaveText(`Paired with the desktop app at ${desktop}.`);
    expect(await storedDesktop(page)).toEqual({ url: desktop, token: TOKEN });
  });
});

/** Records the origins the settings page gives back, answered as removed. */
async function recordRemovals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const removed: string[] = [];
    (window as unknown as { __removed: string[] }).__removed = removed;
    chrome.permissions.remove = (async ({ origins = [] }: chrome.permissions.Permissions) => {
      removed.push(...origins);
      return true;
    }) as typeof chrome.permissions.remove;
  });
}

function removals(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __removed: string[] }).__removed);
}

/** Pairs with the app by hand: its address and its token. */
async function pairByHand(page: Page): Promise<void> {
  await page.getByLabel('Address of the desktop app').fill(desktop);
  await page.getByText('Pair by hand').click();
  await page.getByLabel('Token').fill(TOKEN);
  await page.locator('#desktop-save').click();
  await expect(page.locator('#desktop-status')).toHaveText(`Paired with the desktop app at ${desktop}.`);
}

test.describe('the desktop app as the instance', () => {
  test('paired with no instance connected, one click connects to the app’s own instance', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await recordRemovals(page);
    const offer = page.locator('#desktop-offer');
    await expect(offer).toBeHidden();
    await pairByHand(page);
    await expect(offer).toBeVisible();
    await expect(page.locator('#desktop-pair-hint')).toBeHidden();

    await offer.getByRole('button', { name: 'Use the desktop app as your instance' }).click();
    // Its address is this computer's loopback: no word about plain HTTP.
    await expect(page.locator('#status')).toHaveText('Connected: 1 project found.');
    await expect(page.locator('#instance-pill')).toHaveText('Connected');
    await expect(page.getByLabel('Address of your Piwi instance')).toHaveValue(desktop);
    await expect(offer).toBeHidden();
    await expect(page.locator('#desktop-pair-hint')).toBeHidden();
    expect(await storedSecret(page, 'instance')).toEqual({ apiKey: TOKEN, origin: desktop });

    // Disconnect leaves the app its address, which Unpair gives back.
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.locator('#instance-pill')).toHaveText('Not connected');
    expect(await removals(page)).toEqual([]);
    await expect(offer).toBeVisible();
    await page.locator('#desktop-card').getByRole('button', { name: 'Unpair' }).click();
    await expect(page.locator('#desktop-status')).toHaveText('The desktop app is no longer paired.');
    expect(await removals(page)).toEqual([`${desktop}/*`]);
    await expect(offer).toBeHidden();
  });

  test('Unpair leaves the address to the instance connected there', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await recordRemovals(page);
    await pairByHand(page);
    await page.locator('#desktop-offer').getByRole('button', { name: 'Use the desktop app as your instance' }).click();
    await expect(page.locator('#instance-pill')).toHaveText('Connected');
    await page.locator('#desktop-card').getByRole('button', { name: 'Unpair' }).click();
    await expect(page.locator('#desktop-status')).toHaveText('The desktop app is no longer paired.');
    expect(await removals(page)).toEqual([]);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.locator('#instance-pill')).toHaveText('Not connected');
    expect(await removals(page)).toEqual([`${desktop}/*`]);
  });

  test('a token the app refuses leaves its address filled in and the key field waiting', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    await pairByHand(page);
    instanceKey = 'pd_another';
    await page.locator('#desktop-offer').getByRole('button', { name: 'Use the desktop app as your instance' }).click();
    await expect(page.locator('#status')).toHaveText('The instance rejected the API key: check it.');
    await expect(page.locator('#instance-pill')).toHaveText('Not connected');
    await expect(page.getByLabel('Address of your Piwi instance')).toHaveValue(desktop);
    await expect(page.locator('#api-key-fallback')).toHaveAttribute('open', '');
    await expect(page.locator('#api-key')).toBeFocused();
    await expect(page.locator('#api-key')).toHaveValue('');
    expect(await storedSecret(page, 'instance')).toBeNull();
  });

  test('an instance connected with no app paired points to the pairing', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    // The instance kept is the app itself, on this computer's loopback.
    await page.evaluate(
      (instanceUrl) => chrome.storage.local.set({ piwiConnection: { instanceUrl, projectMappings: [] } }),
      desktop,
    );
    await page.reload();
    await optionsReady(page);
    const hint = page.locator('#desktop-pair-hint');
    await expect(hint).toHaveText('To run bug reports with Playwright on this computer, pair the desktop app.');
    await expect(page.locator('#desktop-offer')).toBeHidden();
    await hint.getByRole('link', { name: 'pair the desktop app' }).click();
    await expect(page.getByLabel('Address of the desktop app')).toHaveValue(desktop);
    await expect(page.locator('#desktop-card').getByRole('button', { name: 'Pair', exact: true })).toBeFocused();
  });
});
