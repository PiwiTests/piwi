import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The operator's notice: the token of PIWI_OPERATOR_TOKEN sets, reads and clears it, and every page shows it above
 * its content in the server render. Dismissing hides that notice in this browser until a different one replaces it; a
 * critical one cannot be dismissed.
 *
 * A notice shows on every page its server renders, so the spec runs against a server of its own, on port 3095, which
 * only CI starts (see playwright.config.ts); it is skipped elsewhere. To run it locally, start a server with the
 * token and point PIWI_NOTICE_TEST_URL at it.
 */

const BASE = process.env.PIWI_NOTICE_TEST_URL ?? 'http://localhost:3095';
const TOKEN = process.env.PIWI_OPERATOR_TOKEN!;
const OPERATOR = { Authorization: `Bearer ${TOKEN}` };
const NOTICE = `${BASE}/api/operator/notice`;
const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

test.describe('Operator notice', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !process.env.CI && !process.env.PIWI_NOTICE_TEST_URL,
    'The notice server only runs in CI (see playwright.config.ts webServer), or at PIWI_NOTICE_TEST_URL',
  );

  test.afterEach(async ({ request }) => {
    await request.delete(NOTICE, { headers: OPERATOR });
  });

  test('opens to the operator token only, and refuses a notice it cannot show', async ({ request }) => {
    const strangers: Record<string, string>[] = [{}, { Authorization: `Bearer ${TOKEN}x` }, { 'X-API-Key': TOKEN }];
    for (const headers of strangers) {
      expect((await request.get(NOTICE, { headers })).status(), JSON.stringify(headers)).toBe(401);
      const put = await request.put(NOTICE, { headers, data: { level: 'info', text: 'x' } });
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
      const put = await request.put(NOTICE, { headers: OPERATOR, data });
      expect(put.status(), JSON.stringify(data)).toBe(400);
    }
    expect(await (await request.get(NOTICE, { headers: OPERATOR })).json()).toEqual({ notice: null });
  });

  test('shows the notice above every page, until dismissed or replaced', async ({ page, request }) => {
    const warning = {
      level: 'warning',
      text: 'Maintenance tonight from 22:00 UTC.',
      link: { url: 'https://status.example.com/', label: 'Status page' },
      expiresAt: inAMinute(),
    };
    const set = await request.put(NOTICE, { headers: OPERATOR, data: warning });
    expect(set.status()).toBe(200);
    expect(set.headers()['cache-control']).toBe('no-store');
    const { notice } = await set.json();
    expect(notice).toMatchObject({ level: 'warning', audience: 'everyone', setAt: expect.any(String) });
    expect(await (await request.get(NOTICE, { headers: OPERATOR })).json()).toEqual({ notice });
    // The same notice set again keeps its setAt: a browser that dismissed it is not shown it again.
    const again = await (await request.put(NOTICE, { headers: OPERATOR, data: warning })).json();
    expect(again.notice.setAt).toBe(notice.setAt);

    // The browser asks for nothing: the server render carries it.
    const asked: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/notice') asked.push(sent.url());
    });
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    const banner = page.locator('[data-shot="operator-notice"]');
    await expect(banner).toContainText('Maintenance tonight from 22:00 UTC.');
    await expect(banner).toContainText('(status.example.com)');
    await expect(banner.getByRole('link', { name: 'Status page' })).toHaveAttribute(
      'href',
      'https://status.example.com/',
    );
    expect(asked).toEqual([]);

    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toBeHidden();
    // The server render leaves the banner out too, from the cookie the browser now sends.
    const html = await (await page.context().request.get(`${BASE}/`)).text();
    expect(html.includes('data-shot="operator-notice"'), 'the banner in the server render').toBe(false);

    const critical = await request.put(NOTICE, {
      headers: OPERATOR,
      data: { level: 'critical', text: 'Uploads are paused for an hour.', expiresAt: inAMinute() },
    });
    expect(critical.status()).toBe(200);
    await page.reload();
    await expect(banner).toContainText('Uploads are paused for an hour.');
    await expect(banner.getByRole('button', { name: 'Close' })).toHaveCount(0);

    await request.delete(NOTICE, { headers: OPERATOR });
    await page.reload();
    await expect(banner).toBeHidden();
  });

  test('shows a notice set again once the same one has ended, to a browser that dismissed it', async ({
    page,
    request,
  }) => {
    const weekly = { level: 'info', text: 'Weekly maintenance tonight.' };
    const first = await request.put(NOTICE, {
      headers: OPERATOR,
      data: { ...weekly, expiresAt: new Date(Date.now() + 1500).toISOString() },
    });
    const { notice } = await first.json();
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    const banner = page.locator('[data-shot="operator-notice"]');
    await banner.getByRole('button', { name: 'Close' }).click();
    await expect(banner).toBeHidden();

    await expect
      .poll(async () => (await (await page.context().request.get(`${BASE}/api/notice`)).json()).notice)
      .toBeNull();
    const next = await (await request.put(NOTICE, { headers: OPERATOR, data: weekly })).json();
    expect(next.notice.setAt).not.toBe(notice.setAt);
    await page.reload();
    await expect(banner).toContainText('Weekly maintenance tonight.');
  });
});
