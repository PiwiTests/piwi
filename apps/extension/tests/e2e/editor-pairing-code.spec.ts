import { createServer, type Server } from 'node:http';
import type { Page } from '@playwright/test';
import { editorPairingProof } from '@piwitests/core/editor-pairing';
import { EDITOR_CHALLENGE_HEADER, EDITOR_PROOF_HEADER, editorTokenProof } from '@piwitests/core/editor-send';
import { test, expect, openOptions } from './fixtures.js';
import { localStorageText, storedSecret } from './secrets.js';

/**
 * Pairing with an editor from the settings: Pair asks the ports the editors of this computer listen on which editor
 * answers, asks it to pair, and shows the code its request shows; the next poll after Allow there carries the token,
 * kept with the address Pair asked. A local server on the last VS Code pairing port stands in for the editor, its
 * notification answering through `answer`.
 */
const PORT = 7251;
const BASE = `http://127.0.0.1:${PORT}/piwi`;
const TOKEN = 'editor-token-0123456789';
/** A code as the page shows it: Piwi Picker's own, never sent to the editor. */
const CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const PAIRING = '0123456789abcdef';
const SECRET = 'the-secret';

let server: Server;
/** What the person answers in the editor: `null` while the request waits. */
let answer: 'allow' | 'deny' | null = null;
/** The code the person types in the editor, which its proof is keyed by. */
let typed = '';
let starts: Array<{ origin: string | undefined; contentType: string; body: string }> = [];
let tokenHandedOut = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', EDITOR_PROOF_HEADER);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'OPTIONS') return res.end();
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/piwi/hello') {
        return json(200, { editor: 'vscode', product: 'Piwi test editor', windows: ['shop'] });
      }
      if (req.method === 'POST' && req.url === '/piwi/pairings') {
        starts.push({
          origin: req.headers.origin,
          contentType: req.headers['content-type'] ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        return json(201, { id: PAIRING, secret: SECRET, interval: 1, expiresIn: 60 });
      }
      if (req.method === 'GET' && req.url === `/piwi/pairings/${PAIRING}`) {
        if (req.headers['x-pairing-secret'] !== SECRET) return json(404, {});
        if (answer === 'deny') return json(200, { status: 'denied' });
        if (answer === 'allow') {
          tokenHandedOut++;
          const proof = await editorPairingProof(typed, PAIRING, TOKEN);
          return json(200, tokenHandedOut === 1 ? { status: 'allowed', token: TOKEN, proof } : { status: 'claimed' });
        }
        return json(200, { status: 'waiting' });
      }
      // The settings ask the editor to prove it holds the token once paired.
      if (req.method === 'GET' && req.url === '/piwi/live') {
        const challenge = String(req.headers[EDITOR_CHALLENGE_HEADER] ?? '');
        res.setHeader(EDITOR_PROOF_HEADER, await editorTokenProof(TOKEN, PORT, challenge));
        return json(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, { hubs: [] });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.beforeEach(() => {
  answer = null;
  typed = '';
  starts = [];
  tokenHandedOut = 0;
});

/** Answers the settings page's host-permission requests as granted: the prompt cannot be clicked from a test. */
async function openSettings(page: Page, extensionId: string): Promise<void> {
  await openOptions(page, extensionId);
  await page.evaluate(() => {
    chrome.permissions.request = (async () => true) as typeof chrome.permissions.request;
    chrome.permissions.remove = (async () => true) as typeof chrome.permissions.remove;
    chrome.permissions.contains = (async () => true) as typeof chrome.permissions.contains;
  });
}

/** The person types in the editor the code the page shows, then allows. */
async function typeTheCode(page: Page): Promise<string> {
  const shown = page.locator('#editor-code-line code');
  await expect(shown).toHaveText(CODE);
  typed = (await shown.textContent()) ?? '';
  answer = 'allow';
  return typed;
}

/** Clicks Pair, then this test's editor when Pair found more than one. */
async function pair(page: Page): Promise<void> {
  const card = page.locator('#editor-card');
  await card.getByRole('button', { name: 'Pair', exact: true }).click();
  const choice = card.getByRole('button', { name: 'Piwi test editor: shop' });
  await expect(choice.or(card.locator('#editor-pair-panel code'))).toBeVisible();
  if (await choice.isVisible()) await choice.click();
}

test.describe('Pair with an editor by code', () => {
  test('Pair finds the editor, shows the code its request shows, and Allow there pairs it', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#editor-card');
    await expect(card.locator('#editor-pill')).toHaveText('Not paired');
    await expect(card.locator('#editor-manual')).not.toHaveAttribute('open');

    await pair(page);
    await expect(card.locator('#editor-code-line')).toHaveText(
      /^Type this code in Piwi test editor: shop when it asks: [A-Z]{4}-[A-Z]{4}\.$/,
    );
    // Asked as an extension, with JSON naming the browser alone.
    expect(starts).toHaveLength(1);
    expect(starts[0]!.origin).toBe(`chrome-extension://${extensionId}`);
    expect(starts[0]!.contentType).toBe('application/json');
    expect(Object.keys(JSON.parse(starts[0]!.body)).sort()).toEqual(['browser', 'os']);
    await expect(card.getByRole('button', { name: 'Pair', exact: true })).toBeDisabled();

    await typeTheCode(page);
    await expect(card.locator('#editor-status')).toHaveText(`Paired with the editor at ${BASE}/send.`);
    await expect(card.locator('#editor-pair-panel')).toBeHidden();
    await expect(card.locator('#editor-pill')).toHaveText('Paired');
    await expect(card.getByRole('button', { name: 'Pair', exact: true })).toBeEnabled();
    // Kept where content scripts never read the token.
    expect(await localStorageText(page)).not.toContain(TOKEN);
    expect(await storedSecret(page, 'editor')).toEqual({ url: `${BASE}/send`, token: TOKEN });
    expect(tokenHandedOut).toBe(1);
    // The editor proves it holds the token: the status stays as it is.
    await page.waitForTimeout(500);
    await expect(card.locator('#editor-status')).toHaveClass('ok');
  });

  test('Deny in the editor pairs nothing, and says so', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#editor-card');
    await pair(page);
    await expect(card.locator('#editor-code-line code')).toHaveText(CODE);
    answer = 'deny';
    await expect(card.locator('#editor-status')).toHaveText('The editor said no: nothing was paired.');
    await expect(card.locator('#editor-pill')).toHaveText('Not paired');
    expect(await storedSecret(page, 'editor')).toBeNull();
  });

  test('keeps nothing when the code typed in the editor is not the one shown, as another program would answer', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#editor-card');
    await pair(page);
    const code = page.locator('#editor-code-line code');
    await expect(code).toHaveText(CODE);
    // Another code: a typo, or a program on the editor's port that never saw this one.
    typed = (await code.textContent())?.startsWith('B') ? 'CCCC-CCCC' : 'BBBB-BBBB';
    answer = 'allow';
    await expect(card.locator('#editor-status')).toHaveText(
      'The code typed in the editor is not the one shown here: nothing was paired. Click Pair to try again.',
    );
    await expect(card.locator('#editor-pill')).toHaveText('Not paired');
    expect(await storedSecret(page, 'editor')).toBeNull();
  });

  test('Cancel ends the wait, and pairs nothing', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#editor-card');
    await pair(page);
    await expect(card.locator('#editor-code-line code')).toHaveText(CODE);
    await card.locator('#editor-pair-panel').getByRole('button', { name: 'Cancel' }).click();
    await expect(card.locator('#editor-status')).toHaveText('Pairing cancelled.');
    await expect(card.locator('#editor-pair-panel')).toBeHidden();
    answer = 'allow';
    await page.waitForTimeout(1500);
    expect(tokenHandedOut).toBe(0);
    expect(await storedSecret(page, 'editor')).toBeNull();
  });

  test('gives back the ports it asked for and no pairing keeps, never one granted before', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const before = 'http://127.0.0.1:63342/*';
    await page.evaluate((granted) => {
      const removed: string[] = [];
      (window as unknown as { removed: string[] }).removed = removed;
      chrome.permissions.getAll = (async () => ({ origins: [granted] })) as typeof chrome.permissions.getAll;
      chrome.permissions.remove = (async ({ origins }: chrome.permissions.Permissions) => {
        removed.push(...(origins ?? []));
        return true;
      }) as typeof chrome.permissions.remove;
    }, before);
    const card = page.locator('#editor-card');
    await pair(page);
    await expect(card.locator('#editor-code-line code')).toHaveText(CODE);
    // While the request waits, nothing is given back.
    expect(await page.evaluate(() => (window as unknown as { removed: string[] }).removed)).toEqual([]);
    await typeTheCode(page);
    await expect(card.locator('#editor-status')).toHaveText(`Paired with the editor at ${BASE}/send.`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { removed: string[] }).removed.length)).toBe(23);
    const removed = await page.evaluate(() => (window as unknown as { removed: string[] }).removed);
    expect(removed).not.toContain(`http://127.0.0.1:${PORT}/*`);
    expect(removed).not.toContain(before);
    expect(removed).toContain('http://127.0.0.1:7247/*');
    expect(removed).toContain('http://127.0.0.1:63361/*');
  });

  test('lists the editors it finds, and Cancel there asks none', async ({ context, extensionId }) => {
    const other = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/piwi/hello')
        return res.end(JSON.stringify({ editor: 'vscode', product: 'Cursor', windows: [] }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => other.listen(PORT - 1, '127.0.0.1', resolve));
    try {
      const page = await context.newPage();
      await openSettings(page, extensionId);
      const card = page.locator('#editor-card');
      await card.getByRole('button', { name: 'Pair', exact: true }).click();
      await expect(card.getByText('Pair with which editor?')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Cursor', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Piwi test editor: shop' })).toBeVisible();
      await card.locator('#editor-choices').getByRole('button', { name: 'Cancel' }).click();
      await expect(card.locator('#editor-choices')).toBeHidden();
      await expect(card.getByRole('button', { name: 'Pair', exact: true })).toBeEnabled();
      await expect(card.locator('#editor-status')).toHaveText('');
      expect(starts).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  test('pairs with an address pasted, from the folded section', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openSettings(page, extensionId);
    const card = page.locator('#editor-card');
    await card.getByText('Pair with an address').click();
    await card.getByLabel('Pairing address').fill(`http://localhost:${PORT}/piwi/send#${TOKEN}`);
    await card.getByRole('button', { name: 'Use this address' }).click();
    // Kept on 127.0.0.1, whatever loopback name it was pasted with.
    await expect(card.locator('#editor-status')).toHaveText(`Paired with the editor at ${BASE}/send.`);
    await expect(card.locator('#editor-manual')).not.toHaveAttribute('open');
    expect(await storedSecret(page, 'editor')).toEqual({ url: `${BASE}/send`, token: TOKEN });
    expect(starts).toEqual([]);
  });
});
