/**
 * The Jira connect form against a mock Jira Cloud site on a random port: the
 * site is read from a pasted page URL and checked, "Check sign-in" reports the
 * account, the token kind and the projects before anything is saved, a refused
 * token comes with a hint, and connecting saves the site URL, not the page URL.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';

const NAME = 'Connect form e2e';
const GOOD_AUTH = `Basic ${Buffer.from('ci@piwi.dev:mock-token').toString('base64')}`;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/**
 * A mock Jira Cloud site: public `serverInfo`, then `myself` and a project search
 * behind one account. `_edge/tenant_info` answers 404, so a refused token never
 * sends the client on to the real api.atlassian.com gateway.
 */
function startMockJira(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url.startsWith('/rest/api/3/serverInfo')) {
      res.end(
        JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, deploymentType: 'Cloud', serverTitle: 'Mock Jira' }),
      );
      return;
    }
    const authed = req.headers.authorization === GOOD_AUTH;
    if (url.startsWith('/rest/api/3/myself')) {
      if (!authed) {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'Client must be authenticated to access this resource.' }));
        return;
      }
      res.end(JSON.stringify({ accountId: 'acct-1', displayName: 'Mock Jira User' }));
      return;
    }
    if (url.startsWith('/rest/api/3/project/search') && authed) {
      res.end(
        JSON.stringify({
          values: [
            { id: '1', key: 'ABC', name: 'Alpha' },
            { id: '2', key: 'DEF', name: 'Delta' },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errorMessages: ['Not found'] }));
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function removeConnection(request: import('@playwright/test').APIRequestContext) {
  const list = await request.get('/api/integrations/connections');
  const { connections } = (await list.json()) as { connections: Array<{ id: number; name: string }> };
  for (const c of connections.filter((c) => c.name === NAME)) {
    await request.delete(`/api/integrations/connections/${c.id}?deleteCredential=true`);
  }
}

test.describe.serial('Integrations — the Jira connect form', () => {
  test.describe.configure({ timeout: 90_000 });
  let mock: http.Server;
  let site = '';

  test.beforeAll(async () => {
    const port = await getFreePort();
    mock = startMockJira(port);
    site = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async ({ request }) => {
    await removeConnection(request);
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  });

  test('checks the site and the sign-in before saving, then saves the site URL', async ({ page, request }) => {
    await page.goto('/settings/integrations');
    const form = page.locator('[data-shot="jira-connection-form"]');
    await expect(async () => {
      await page.getByRole('button', { name: 'Connect Jira' }).first().click();
      await expect(form).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    await page.getByTestId('jira-site').fill(`${site}/browse/ABC-12`);
    await expect(form.getByText(`Piwi will use ${site}.`)).toBeVisible();
    await expect(page.getByTestId('jira-site-check')).toContainText('Jira Cloud site “Mock Jira”.');

    // A scoped token's steps name the scopes to pick.
    await form.getByText('Scoped token', { exact: true }).click();
    await expect(page.getByTestId('jira-token-steps')).toContainText('read:jira-work');

    await form.getByLabel('Account email').fill('ci@piwi.dev');
    await form.getByLabel('API token', { exact: true }).fill('wrong-token');
    await form.getByRole('button', { name: 'Check sign-in' }).click();
    await expect(page.getByTestId('jira-credential-check')).toContainText('Atlassian refused the email and token');

    await form.getByLabel('API token', { exact: true }).fill('mock-token');
    await form.getByRole('button', { name: 'Check sign-in' }).click();
    const result = page.getByTestId('jira-credential-check');
    await expect(result).toContainText('Signed in as Mock Jira User, with a classic token.');
    await expect(result).toContainText('Sees 2 projects: ABC, DEF');

    await form.getByLabel('Name').fill(NAME);
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText(NAME, { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('connection-credential').filter({ hasText: NAME })).toBeVisible();

    const list = await request.get('/api/integrations/connections');
    const { connections } = (await list.json()) as {
      connections: Array<{ name: string; baseUrl: string; config: Record<string, unknown> | null }>;
    };
    const saved = connections.find((c) => c.name === NAME);
    expect(saved?.baseUrl).toBe(site);
    expect(saved?.config?.tokenKind).toBe('classic');
  });

  test('the check endpoint reports an address with no Jira and a hint', async ({ request }) => {
    const res = await request.post('/api/integrations/connections/check', {
      data: { provider: 'jira', baseUrl: `${site}/nothing-here` },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { baseUrl: string; site: { ok: boolean } };
    expect(body.baseUrl).toBe(`${site}/nothing-here`);
    expect(body.site.ok).toBe(false);
  });
});
