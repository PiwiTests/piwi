import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The operator's notice: the token of PIWI_OPERATOR_TOKEN sets, reads and clears it, and every page shows it above
 * its content in the server render. Dismissing hides that notice in this browser until another replaces it; a
 * critical one cannot be dismissed. Each notice is set for a minute at most, and cleared at the end.
 */

const TOKEN = process.env.PIWI_OPERATOR_TOKEN!;
const OPERATOR = { Authorization: `Bearer ${TOKEN}` };
const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

test.describe('Operator notice', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ request }) => {
    await request.delete('/api/operator/notice', { headers: OPERATOR });
  });

  test('opens to the operator token only, and refuses a notice it cannot show', async ({ request }) => {
    const strangers: Record<string, string>[] = [{}, { Authorization: `Bearer ${TOKEN}x` }, { 'X-API-Key': TOKEN }];
    for (const headers of strangers) {
      expect((await request.get('/api/operator/notice', { headers })).status(), JSON.stringify(headers)).toBe(401);
      const put = await request.put('/api/operator/notice', { headers, data: { level: 'info', text: 'x' } });
      expect(put.status(), JSON.stringify(headers)).toBe(401);
    }

    const refused = [
      { level: 'info', text: 'x', link: { url: 'javascript:alert(1)' } },
      { level: 'info', text: 'x', link: { url: 'https://example.com/\u0000' } },
      { level: 'info', text: 'a\ud800b' },
      { level: 'info', text: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() },
      { level: 'info', text: 'x', expiresAt: '9999-12-31T23:59:59-23:59' },
      { level: 'loud', text: 'x' },
      { level: 'info', text: '' },
    ];
    for (const data of refused) {
      const put = await request.put('/api/operator/notice', { headers: OPERATOR, data });
      expect(put.status(), JSON.stringify(data)).toBe(400);
    }
    expect(await (await request.get('/api/operator/notice', { headers: OPERATOR })).json()).toEqual({ notice: null });
  });

  test('shows the notice above every page, until dismissed or replaced', async ({ page, request }) => {
    const warning = {
      level: 'warning',
      text: 'Maintenance tonight from 22:00 UTC.',
      link: { url: 'https://status.example.com/', label: 'Status page' },
      expiresAt: inAMinute(),
    };
    const set = await request.put('/api/operator/notice', { headers: OPERATOR, data: warning });
    expect(set.status()).toBe(200);
    expect(set.headers()['cache-control']).toBe('no-store');
    const { notice } = await set.json();
    expect(notice).toMatchObject({ level: 'warning', audience: 'everyone', setAt: expect.any(String) });
    expect(await (await request.get('/api/operator/notice', { headers: OPERATOR })).json()).toEqual({ notice });
    // The same notice set again keeps its setAt: a browser that dismissed it is not shown it again.
    const again = await (await request.put('/api/operator/notice', { headers: OPERATOR, data: warning })).json();
    expect(again.notice.setAt).toBe(notice.setAt);

    // The browser asks for nothing: the server render carries it.
    const asked: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/notice') asked.push(sent.url());
    });
    await page.goto('/');
    await waitForHydration(page);
    const banner = page.locator('[data-shot="operator-notice"]');
    await expect(banner).toContainText('Maintenance tonight from 22:00 UTC.');
    await expect(banner.getByRole('link', { name: 'Status page' })).toHaveAttribute(
      'href',
      'https://status.example.com/',
    );
    expect(asked).toEqual([]);

    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByText('Maintenance tonight from 22:00 UTC.')).toBeHidden();

    await request.put('/api/operator/notice', {
      headers: OPERATOR,
      data: { level: 'critical', text: 'Uploads are paused for an hour.', expiresAt: inAMinute() },
    });
    await page.reload();
    await expect(banner).toContainText('Uploads are paused for an hour.');
    await expect(banner.getByRole('button', { name: 'Close' })).toHaveCount(0);

    await request.delete('/api/operator/notice', { headers: OPERATOR });
    await page.reload();
    await expect(banner).toBeHidden();
  });
});
