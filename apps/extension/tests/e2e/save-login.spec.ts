import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, test, expect, type BrowserContext, type Page } from '@playwright/test';
import { extensionWorker, launchWithEditedManifest } from './fixtures.js';
import { cookieOriginPatterns } from '../../src/shared/storage-state.js';

/**
 * A site with a login: `/login` sets an httpOnly session cookie and a token in
 * localStorage, and `/account` greets whoever has both. The login is saved
 * with the real extension and loaded into a new browser context as a
 * Playwright test would, with `storageState`.
 */
function startSite(): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/login') {
      response.setHeader('set-cookie', [
        'sid=s3cr3t; HttpOnly; Path=/; SameSite=Lax',
        'theme=dark; Path=/account; Max-Age=86400',
      ]);
      response.end(`<!doctype html><p>Logged in</p><script>localStorage.setItem('token', 'tok-42')</script>`);
      return;
    }
    const cookie = request.headers.cookie ?? '';
    const name = cookie.includes('sid=s3cr3t') ? 'Ada' : null;
    response.end(
      `<!doctype html><p id="who">${name ? `Hello ${name}` : 'Please log in'}</p>` +
        `<p id="token"></p><script>document.getElementById('token').textContent = localStorage.getItem('token') ?? 'no token'</script>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }),
    );
  });
}

/**
 * The extension with the grants a person gives in the click that saves: the cookies permission and the site's host,
 * the port aside.
 */
async function launchGranted(origin: string): Promise<{ context: BrowserContext; extensionId: string }> {
  const context = await launchWithEditedManifest((manifest) => ({
    ...manifest,
    permissions: [...manifest.permissions, 'cookies'],
    optional_permissions: [],
    host_permissions: cookieOriginPatterns(new URL(origin).hostname),
  }));
  return { context, extensionId: (await extensionWorker(context)).url().split('/')[2]! };
}

/** Save login for tests, opened for the tab showing `url`, as the Piwi panel opens it. */
async function openSaveLogin(context: BrowserContext, extensionId: string, url: string): Promise<Page> {
  const login = await context.newPage();
  await login.goto(`chrome-extension://${extensionId}/popup.html`);
  const tabId = await login.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url);
  await login.goto(`chrome-extension://${extensionId}/login.html?tabId=${tabId}&url=${encodeURIComponent(url)}`);
  return login;
}

test('saves the login as a storageState file a new context logs in with', async () => {
  const site = await startSite();
  const { context, extensionId } = await launchGranted(site.origin);
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await context.newPage();
    await page.goto(`${site.origin}/login`);
    await expect(page.getByText('Logged in')).toBeVisible();
    await page.goto(`${site.origin}/account`);
    await expect(page.locator('#who')).toHaveText('Hello Ada');

    const login = await openSaveLogin(context, extensionId, `${site.origin}/account`);
    await expect(login.getByRole('heading', { name: 'Save login for tests' })).toBeVisible();
    await expect(login.getByText(`Site: ${site.origin}`)).toBeVisible();
    await expect(login.getByRole('note')).toContainText('Use a test account');

    let downloads = 0;
    login.on('download', () => downloads++);
    const download = login.waitForEvent('download');
    // A double click saves one file.
    await login.getByRole('button', { name: 'Save login file' }).dblclick();
    const file = await (await download).path();
    expect((await download).suggestedFilename()).toBe('user.json');
    await expect(login.getByRole('status')).toHaveText('Saved user.json with 2 cookies. 1 localStorage entry.');
    // Long enough for a second save to have downloaded too.
    await login.waitForTimeout(500);
    expect(downloads).toBe(1);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    expect(state.cookies.find((c: { name: string }) => c.name === 'sid')).toMatchObject({
      value: 's3cr3t',
      httpOnly: true,
      expires: -1,
      sameSite: 'Lax',
    });
    expect(state.origins).toEqual([{ origin: site.origin, localStorage: [{ name: 'token', value: 'tok-42' }] }]);

    // What `test.use({ storageState })` does: a new context, logged in from the start.
    const fresh = await browser.newContext({ storageState: file });
    const account = await fresh.newPage();
    await account.goto(`${site.origin}/account`);
    await expect(account.locator('#who')).toHaveText('Hello Ada');
    await expect(account.locator('#token')).toHaveText('tok-42');
    const anonymous = await (await browser.newContext()).newPage();
    await anonymous.goto(`${site.origin}/account`);
    await expect(anonymous.locator('#who')).toHaveText('Please log in');
  } finally {
    await browser.close();
    await context.close();
    site.close();
  }
});

test('saves nothing once the tab shows another site than the one it was opened for', async () => {
  const site = await startSite();
  // Another port of the same host: the host permission covers it, the origin differs.
  const other = await startSite();
  const { context, extensionId } = await launchGranted(site.origin);
  try {
    const page = await context.newPage();
    await page.goto(`${site.origin}/login`);
    await page.goto(`${site.origin}/account`);
    const login = await openSaveLogin(context, extensionId, `${site.origin}/account`);
    await expect(login.getByText(`Site: ${site.origin}`)).toBeVisible();
    await page.goto(`${other.origin}/login`);
    await expect(page.getByText('Logged in')).toBeVisible();

    let downloads = 0;
    login.on('download', () => downloads++);
    await login.getByRole('button', { name: 'Save login file' }).click();
    await expect(login.getByRole('status')).toHaveText(
      `The tab shows another site now: go back to ${site.origin} in it, then save again.`,
    );
    await login.waitForTimeout(500);
    expect(downloads).toBe(0);
  } finally {
    await context.close();
    site.close();
    other.close();
  }
});
