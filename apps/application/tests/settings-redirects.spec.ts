import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

// `/setup`, `/mcp` and `/docs` answer with the Settings page that holds them, so links and bookmarks keep working.
const REDIRECTS = [
  ['/setup', '/settings/connect'],
  ['/mcp', '/settings/mcp'],
  ['/docs', '/settings/api'],
] as const;

test.describe('Settings redirects', () => {
  for (const [from, to] of REDIRECTS) {
    test(`${from} redirects to ${to}`, async ({ request, page }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      expect(new URL(res.headers()['location']!, 'http://localhost').pathname).toBe(to);

      await page.goto(from);
      await waitForHydration(page);
      await expect(page).toHaveURL(new RegExp(`${to}$`));
    });
  }

  test('POST /mcp is still the MCP server', async ({ request }) => {
    const res = await request.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: {} });
  });
});
